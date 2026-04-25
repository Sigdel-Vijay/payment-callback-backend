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
  const { idToken, walletId, mpin, merchantId, orderId, amount, clientTxnId } =
    req.body;

  if (
    !idToken ||
    !walletId ||
    !mpin ||
    !merchantId ||
    !orderId ||
    !amount ||
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
    // 🔒 IDEMPOTENCY LOCK
    // =============================
    const lockResult = await globalTxRef.transaction((current) => {
      if (current) return; // already exists
      return {
        status: "PROCESSING",
        createdAt: Date.now(),
      };
    });

    if (!lockResult.committed) {
      const existing = (await globalTxRef.get()).val();

      return res.json({
        status: existing?.status || "SUCCESS",
        transactionId: clientTxnId,
      });
    }

    // =============================
    // ✅ CHECK AMOUNT
    // =============================

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
    // 📦 CHECK ORDER EXISTS
    // =============================
    const orderRef = db.ref(`orders/${orderId}`);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists()) {
      throw new Error("Order not found");
    }

    const orderData = orderSnap.val();

    // Optional: extra validation (recommended)
    if (orderData.merchantId !== merchantId) {
      throw new Error("Order does not belong to this merchant");
    }
    if (orderData.paymentStatus === "PAID") {
      const paidTime = new Date(orderData.paidAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kathmandu",
      });

      throw new Error(`Order ${orderId} already paid at ${paidTime}`);
    }

    // =============================
    // 💸 DEBIT USER
    // =============================F
    const debitResult = await userRef.transaction((data) => {
      if (!data) return data; // keep unchanged

      if (data.balance < payAmount) {
        return data; // DO NOT return undefined
      }

      data.balance -= payAmount;
      return data;
    });

    if (!debitResult.committed) {
      const latest = debitResult.snapshot.val();

      if (!latest || latest.balance < payAmount) {
        throw new Error("Insufficient balance (race condition)");
      }

      throw new Error("Transaction conflict, retry");
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
      // rollback
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
      orderId,
      userId: userKey,
      createdAt: Date.now(),
      notificationSent: false,
    };

    await db.ref(`transactions/users/${userKey}/${clientTxnId}`).set(txData);
    await db
      .ref(`transactions/merchants/${merchantId}/${clientTxnId}`)
      .set(txData);

    // ⚠️ IMPORTANT: use update, NOT set
    await globalTxRef.update(txData);

    // =============================
    // 📦 UPDATE ORDER STATUS
    // =============================
    await orderRef.update({
      paymentStatus: "PAID",
      paidAmount: payAmount,
      transactionId: clientTxnId,
      paidAt: Date.now(),
    });

    // =============================
    // 🔔 SAFE NOTIFICATION
    // =============================
    const txSnap = await globalTxRef.get();
    const tx = txSnap.val();

    if (!tx.notificationSent) {
      const userTokensSnap = await db.ref(`fcmTokens/users/${userKey}`).get();
      const merchantTokensSnap = await db
        .ref(`fcmTokens/merchants/${merchantUid}`)
        .get();

      let merchantTokens = [];

      let userTokens = [];

      if (merchantTokensSnap.exists()) {
        const tokensObj = merchantTokensSnap.val();
        merchantTokens = Object.keys(tokensObj);
      }

      const tasks = [];

      if (userTokensSnap.exists()) {
        const tokensObj = userTokensSnap.val();
        userTokens = Object.keys(tokensObj);
      }

      if (userTokens.length > 0) {
        tasks.push({
          type: "user",
          tokens: userTokens,
          promise: admin.messaging().sendEachForMulticast({
            tokens: userTokens,
            data: toStringData({
              title: "Payment Successful",
              body: `Paid NPR ${payAmount.toFixed(2)} to ${merchantData.businessName}`,
              type: "payment",
              orderId: orderId,
              transactionId: clientTxnId,
            }),
          }),
        });
      }

      if (merchantTokens.length > 0) {
        tasks.push({
          type: "merchant",
          tokens: merchantTokens,
          promise: admin.messaging().sendEachForMulticast({
            tokens: merchantTokens,
            data: toStringData({
              title: "Payment Received",
              body: `Received NPR ${payAmount.toFixed(2)} from ${userData.email}`,
              type: "payment",
              orderId: orderId,
              transactionId: clientTxnId,
            }),
          }),
        });
      }

      try {
        const results = await Promise.all(tasks.map((t) => t.promise));

        // cleanup
        results.forEach((res, i) => {
          const { type, tokens } = tasks[i];

          res.responses.forEach((r, idx) => {
            if (!r.success) {
              const badToken = tokens[idx];

              if (type === "user") {
                db.ref(`fcmTokens/users/${userKey}/${badToken}`).remove();
              } else {
                db.ref(
                  `fcmTokens/merchants/${merchantUid}/${badToken}`,
                ).remove();
              }
            }
          });
        });

        await globalTxRef.update({ notificationSent: true });
      } catch (err) {
        console.error("Notification failed:", err);

        await globalTxRef.update({
          notificationError: err.message,
        });
      }
    }

    // =============================
    // ✅ RESPONSE
    // =============================
    res.json({
      status: "SUCCESS",
      transactionId: clientTxnId,
    });
  } catch (err) {
    console.error("❌ PAY ERROR:", err);

    await globalTxRef.update({
      status: "FAILED",
      error: err.message,
    });

    await db.ref(`transactions_failed`).push({
      error: err.message,
      body: req.body,
      timestamp: Date.now(),
    });

    res.status(500).json({
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
