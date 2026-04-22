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
// 🔔 SEND NOTIFICATIONS (SAFE)
// =============================
const sendNotifications = async ({
  userKey,
  merchantUid,
  userData,
  merchantData,
  payAmount,
  clientTxnId,
}) => {
  const userTokenSnap = await db.ref(`fcmTokens/users/${userKey}`).get();
  const merchantTokenSnap = await db
    .ref(`fcmTokens/merchants/${merchantUid}`)
    .get();

  const promises = [];

  // ✅ ONLY DATA PAYLOAD (prevents duplicate notifications)
  if (userTokenSnap.exists()) {
    promises.push(
      admin.messaging().send({
        token: userTokenSnap.val(),
        data: toStringData({
          title: "Payment Successful",
          body: `Paid NPR ${payAmount.toFixed(2)} to ${merchantData.businessName}`,
          type: "payment",
          transactionType: "sent",
          transactionId: clientTxnId,
        }),
      }),
    );
  }

  if (merchantTokenSnap.exists()) {
    promises.push(
      admin.messaging().send({
        token: merchantTokenSnap.val(),
        data: toStringData({
          title: "Payment Received",
          body: `Received NPR ${payAmount.toFixed(2)} from ${userData.name}`,
          type: "payment",
          transactionType: "received",
          transactionId: clientTxnId,
        }),
      }),
    );
  }

  await Promise.all(promises);
};

// =============================
// ✅ PAYMENT API
// =============================
app.post("/pay", async (req, res) => {
  const { idToken, walletId, mpin, amount, merchantId, clientTxnId } = req.body;

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

  const globalTxRef = db.ref(`transactions_global/${clientTxnId}`);

  try {
    // =============================
    // 🔒 IDEMPOTENCY LOCK (CRITICAL)
    // =============================
    const lock = await globalTxRef.transaction((current) => {
      if (current) return; // already processed
      return {
        status: "PROCESSING",
        createdAt: Date.now(),
      };
    });

    // 👉 If already processed
    if (!lock.committed) {
      const existing = (await globalTxRef.get()).val();

      return res.json({
        status: existing?.status || "SUCCESS",
        transactionId: clientTxnId,
      });
    }

    // =============================
    // ✅ VERIFY USER
    // =============================
    const decoded = await admin.auth().verifyIdToken(idToken);
    const payAmount = parseFloat(amount);

    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error("Invalid amount");
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
    const debit = await userRef.transaction((data) => {
      if (!data || data.balance < payAmount) return;
      data.balance -= payAmount;
      return data;
    });

    if (!debit.committed) {
      throw new Error("Debit failed");
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

      throw new Error("Merchant credit failed");
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
      notificationSent: false,
    };

    await db.ref(`transactions/users/${userKey}/${clientTxnId}`).set(txData);
    await db
      .ref(`transactions/merchants/${merchantId}/${clientTxnId}`)
      .set(txData);

    await globalTxRef.update(txData);

    // =============================
    // 🔔 SEND NOTIFICATION ONCE
    // =============================
    const txSnap = await globalTxRef.get();
    const tx = txSnap.val();

    if (!tx.notificationSent) {
      await sendNotifications({
        userKey,
        merchantUid,
        userData,
        merchantData,
        payAmount,
        clientTxnId,
      });

      await globalTxRef.update({
        notificationSent: true,
      });
    }

    // =============================
    // ✅ RESPONSE
    // =============================
    return res.json({
      status: "SUCCESS",
      transactionId: clientTxnId,
    });
  } catch (err) {
    console.error("❌ PAY ERROR:", err);

    await globalTxRef.update({
      status: "FAILED",
      error: err.message,
    });

    await db.ref("transactions_failed").push({
      error: err.message,
      body: req.body,
      timestamp: Date.now(),
    });

    return res.status(500).json({
      status: "FAILURE",
      error: err.message,
    });
  }
});

// =============================
// 🚀 START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
