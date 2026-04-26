import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// =============================
// 🔥 FIREBASE INIT
// =============================
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// =============================
// 🔧 HELPERS
// =============================
const toStringData = (obj) => {
  const res = {};
  for (const k in obj) res[k] = String(obj[k] ?? "");
  return res;
};

// =============================
// 💳 PAYMENT API (PRODUCTION SAFE)
// =============================
app.post("/pay", async (req, res) => {
  const {
    walletId,
    mpin,
    merchantId,
    orderId,
    amount,
    clientTxnId,
  } = req.body;

  if (!walletId || !mpin || !merchantId || !orderId || !amount || !clientTxnId) {
    return res.status(400).json({ status: "FAILURE", error: "Missing fields" });
  }

  const globalRef = db.ref(`transactions_global/${clientTxnId}`);

  try {
    // =====================================================
    // 1️⃣ IDEMPOTENCY LOCK (ONLY ONCE - FIXED)
    // =====================================================
    const lock = await globalRef.transaction((current) => {
      if (current) return; // already exists
      return {
        status: "PROCESSING",
        createdAt: Date.now(),
      };
    });

    if (!lock.committed) {
      const existing = (await globalRef.get()).val();
      return res.json({
        status: existing?.status || "SUCCESS",
        transactionId: clientTxnId,
      });
    }

    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error("Invalid amount");
    }

    // =====================================================
    // 2️⃣ USER WALLET CHECK
    // =====================================================
    const walletSnap = await db
      .ref("wallets")
      .orderByChild("walletId")
      .equalTo(walletId)
      .get();

    if (!walletSnap.exists()) throw new Error("Wallet not found");

    let userData, userKey;
    walletSnap.forEach((s) => {
      userData = s.val();
      userKey = s.key;
    });

    const isMatch = bcrypt.compareSync(mpin, userData.mpinHash);
    if (!isMatch) throw new Error("Invalid MPIN");

    if (userData.balance < payAmount) throw new Error("Insufficient balance");

    const userRef = db.ref(`wallets/${userKey}`);

    // =====================================================
    // 3️⃣ MERCHANT CHECK
    // =====================================================
    const merchantRef = db.ref(`merchants/${merchantId}`);
    const merchantSnap = await merchantRef.get();

    if (!merchantSnap.exists()) throw new Error("Merchant not found");

    const merchantData = merchantSnap.val();
    const merchantUid = merchantData.uid;

    // =====================================================
    // 4️⃣ ORDER CHECK
    // =====================================================
    const orderRef = db.ref(`orders/${orderId}`);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists()) throw new Error("Order not found");

    const orderData = orderSnap.val();

    if (orderData.paymentStatus === "PAID") {
      throw new Error("Order already paid");
    }

    // =====================================================
    // 5️⃣ DEBIT USER (TRANSACTION SAFE)
    // =====================================================
    const debit = await userRef.transaction((data) => {
      if (!data || data.balance < payAmount) return;
      data.balance -= payAmount;
      return data;
    });

    if (!debit.committed) throw new Error("Debit failed");

    // =====================================================
    // 6️⃣ CREDIT MERCHANT
    // =====================================================
    try {
      await merchantRef.transaction((data) => {
        if (!data) return { balance: payAmount };
        data.balance = (data.balance || 0) + payAmount;
        return data;
      });
    } catch (e) {
      // rollback user
      await userRef.transaction((d) => {
        if (!d) return d;
        d.balance += payAmount;
        return d;
      });
      throw new Error("Merchant credit failed");
    }

    // =====================================================
    // 7️⃣ SAVE TRANSACTION
    // =====================================================
    const txData = {
      id: clientTxnId,
      amount: payAmount,
      status: "SUCCESS",
      merchantId,
      orderId,
      userId: userKey,
      createdAt: Date.now(),
    };

    await db.ref(`transactions/users/${userKey}/${clientTxnId}`).set(txData);
    await db.ref(`transactions/merchants/${merchantId}/${clientTxnId}`).set(txData);

    await globalRef.update({
      ...txData,
      notificationStatus: "PENDING",
    });

    // =====================================================
    // 8️⃣ UPDATE ORDER
    // =====================================================
    await orderRef.update({
      paymentStatus: "PAID",
      paidAmount: payAmount,
      transactionId: clientTxnId,
      paidAt: Date.now(),
    });

    // =====================================================
    // 9️⃣ NOTIFICATION FLOW (FIXED)
    // =====================================================
    await globalRef.update({
      notificationStatus: "SENDING",
      notificationStartedAt: Date.now(),
    });

    const userTokensSnap = await db.ref(`fcmTokens/users/${userKey}`).get();
    const merchantTokensSnap = await db
      .ref(`fcmTokens/merchants/${merchantUid}`)
      .get();

    const tasks = [];

    const userTokens = userTokensSnap.exists()
      ? Object.keys(userTokensSnap.val())
      : [];

    const merchantTokens = merchantTokensSnap.exists()
      ? Object.keys(merchantTokensSnap.val())
      : [];

    if (userTokens.length) {
      tasks.push(
        admin.messaging().sendEachForMulticast({
          tokens: userTokens,
          data: toStringData({
            title: "Payment Successful",
            body: `Paid NPR ${payAmount} to ${merchantData.businessName}`,
            type: "payment",
            transactionId: clientTxnId,
          }),
        })
      );
    }

    if (merchantTokens.length) {
      tasks.push(
        admin.messaging().sendEachForMulticast({
          tokens: merchantTokens,
          data: toStringData({
            title: "Payment Received",
            body: `Received NPR ${payAmount} from ${userData.email}`,
            type: "payment",
            transactionId: clientTxnId,
          }),
        })
      );
    }

    const results = await Promise.allSettled(tasks);

    let failed = false;

    results.forEach((r) => {
      if (r.status === "rejected") failed = true;
    });

    await globalRef.update({
      notificationStatus: failed ? "FAILED" : "SENT",
      notificationCompletedAt: Date.now(),
    });

    // =====================================================
    // 🔟 RESPONSE
    // =====================================================
    return res.json({
      status: "SUCCESS",
      transactionId: clientTxnId,
    });
  } catch (err) {
    console.error("PAY ERROR:", err);

    await globalRef.update({
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
  console.log(`Server running on http://localhost:${PORT}`);
});