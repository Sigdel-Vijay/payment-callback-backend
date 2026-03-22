import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// 🔥 INIT FIREBASE ADMIN
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// =============================
// ✅ HELPER: SANITIZE DATA FOR FCM
// =============================
const toStringData = (obj) => {
  const result = {};
  for (const key in obj) {
    result[key] = String(obj[key] ?? "");
  }
  return result;
};

// =============================
// ✅ PAYMENT API
// =============================
app.post("/pay", async (req, res) => {
  try {
    const { idToken, walletId, mpin, amount, merchantId, clientTxnId } =
      req.body;

    if (
      !idToken ||
      !walletId ||
      !mpin ||
      !amount ||
      !merchantId ||
      !clientTxnId
    ) {
      return res.status(400).json({
        status: "FAILURE",
        error: "Missing fields",
      });
    }

    // ✅ Verify Firebase user
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error("Invalid amount");
    }

    // =============================
    // 🔒 IDEMPOTENCY CHECK
    // =============================
    const globalTxRef = db.ref(`transactions_global/${clientTxnId}`);
    const existingTx = await globalTxRef.get();

    if (existingTx.exists()) {
      return res.json({
        status: "SUCCESS",
        transactionId: clientTxnId,
      });
    }

    // =============================
    // 👤 GET USER WALLET
    // =============================
    const walletSnap = await db
      .ref("wallets")
      .orderByChild("walletId")
      .equalTo(walletId)
      .get();

    if (!walletSnap.exists()) throw new Error("Wallet not found");

    let userData, userKey;
    walletSnap.forEach((snap) => {
      userData = snap.val();
      userKey = snap.key;
    });

    if (!bcrypt.compareSync(mpin, userData.mpinHash)) {
      throw new Error("Invalid MPIN");
    }

    if (userData.balance < payAmount) {
      throw new Error("Insufficient balance");
    }

    const userRef = db.ref(`wallets/${userKey}`);

    // =============================
    // 🏪 GET MERCHANT
    // =============================
    const merchantRef = db.ref(`merchants/${merchantId}`);
    const merchantSnap = await merchantRef.get();

    if (!merchantSnap.exists()) throw new Error("Merchant not found");

    const merchantData = merchantSnap.val();
    const merchantUid = merchantData.uid;

    // =============================
    // 💸 DEBIT USER
    // =============================
    const debitResult = await userRef.transaction((data) => {
      if (!data) return data;
      if (data.balance < payAmount) return;
      data.balance -= payAmount;
      return data;
    });

    if (!debitResult.committed) {
      throw new Error("Failed to debit user");
    }

    // =============================
    // 💰 CREDIT MERCHANT
    // =============================
    try {
      await merchantRef.transaction((data) => {
        if (!data) return { balance: payAmount };
        data.balance = (data.balance || 0) + payAmount;
        return data;
      });
    } catch (err) {
      // 🔥 rollback
      await userRef.transaction((data) => {
        if (!data) return data;
        data.balance += payAmount;
        return data;
      });

      throw new Error("Merchant credit failed, refunded user");
    }

    // =============================
    // 🧾 SAVE TRANSACTION
    // =============================
    const txData = {
      id: clientTxnId,
      amount: payAmount,
      status: "SUCCESS",
      merchantId,
      userId: userKey,
      createdAt: Date.now(),
    };

    await db.ref(`transactions/users/${userKey}/${clientTxnId}`).set(txData);
    await db
      .ref(`transactions/merchants/${merchantId}/${clientTxnId}`)
      .set(txData);
    await globalTxRef.set(txData);

    // =============================
    // 🔔 SEND NOTIFICATIONS
    // =============================

    const sendNotifications = async () => {
      const userTokenSnap = await db.ref(`fcmTokens/users/${userKey}`).get();
      const merchantTokenSnap = await db.ref(`fcmTokens/merchants/${merchantUid}`).get();

      const notifications = [];

      if (userTokenSnap.exists()) {
        notifications.push(
          admin.messaging().send({
            token: userTokenSnap.val(),
            data: toStringData({
              title: "Payment Successful",
              body: `Your payment of NPR ${payAmount.toFixed(
                2
              )} to ${merchantData.businessName} was completed successfully. The amount has been securely deducted from your wallet.`,
              type: "payment",
              amount: payAmount.toFixed(2),
              senderName: userData.name || "You",
              receiverName: merchantData.businessName || "Merchant",
              transactionType: "sent",
              transactionId: clientTxnId,
            }),
          })
        );
      }

      if (merchantTokenSnap.exists()) {
        notifications.push(
          admin.messaging().send({
            token: merchantTokenSnap.val(),
            data: toStringData({
              title: "Payment Received",
              body: `You have successfully received NPR ${payAmount.toFixed(
                2
              )} from ${userData.name}. The amount has been credited to your account.`,
              type: "payment",
              amount: payAmount.toFixed(2),
              senderName: userData.name || "Customer",
              receiverName: merchantData.businessName || "You",
              transactionType: "received",
              transactionId: clientTxnId,
            }),
          })
        );
      }

      await Promise.all(notifications);
    };

    await sendNotifications();

    // =============================
    // ✅ RESPONSE
    // =============================
    res.json({
      status: "SUCCESS",
      transactionId: clientTxnId,
    });
  } catch (err) {
    console.error("❌ PAY ERROR:", err);

    await db.ref(`transactions_failed`).push({
      error: err.message,
      stack: err.stack,
      body: req.body,
      timestamp: Date.now(),
    });

    res.status(500).json({
      status: "FAILURE",
      error: err.message,
      stack: err.stack,
    });
  }
});

// =============================
// 🚀 START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
