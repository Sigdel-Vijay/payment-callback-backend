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
// ✅ PAYMENT API (lookup by walletId)
// =============================
app.post("/pay", async (req, res) => {
  try {
    const { idToken, walletId, mpin, amount, merchantId, clientTxnId } = req.body;

    if (!idToken || !walletId || !mpin || !amount || !merchantId || !clientTxnId) {
      return res
        .status(400)
        .json({ status: "FAILURE", error: "Missing fields (clientTxnId required)" });
    }

    // ✅ Verify Firebase user
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error("Invalid amount");
    }

    // 🔥 Idempotency check using clientTxnId
    const globalTxRef = db.ref(`transactions_global/${clientTxnId}`);
    const existingTx = await globalTxRef.get();

    if (existingTx.exists()) {
      // If already exists, return success (no double charge)
      return res.json({ status: "SUCCESS", transactionId: clientTxnId });
    }

    // =============================
    // ✅ FETCH USER WALLET BY walletId
    // =============================
    const walletsRef = db.ref("wallets");
    const walletSnap = await walletsRef.orderByChild("walletId").equalTo(walletId).get();

    if (!walletSnap.exists()) {
      throw new Error("Wallet not found");
    }

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
    // ✅ CHECK MERCHANT
    // =============================
    const merchantRef = db.ref(`merchants/${merchantId}`);
    const merchantSnap = await merchantRef.get();

    if (!merchantSnap.exists()) {
      throw new Error("Merchant not found");
    }

    // =============================
    // ✅ DEBIT USER
    // =============================
    await userRef.transaction((data) => {
      if (!data) return data;
      if (data.balance < payAmount) return; // abort
      data.balance -= payAmount;
      return data;
    });

    // =============================
    // ✅ CREDIT MERCHANT
    // =============================
    try {
      await merchantRef.transaction((data) => {
        if (!data) return { balance: payAmount };
        data.balance = (data.balance || 0) + payAmount;
        return data;
      });
    } catch (err) {
      // 🔥 rollback user money
      await userRef.transaction((data) => {
        if (!data) return data;
        data.balance += payAmount;
        return data;
      });

      throw new Error("Merchant credit failed, refunded user");
    }

    // =============================
    // ✅ SAVE TRANSACTIONS
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
    await db.ref(`transactions/merchants/${merchantId}/${clientTxnId}`).set(txData);
    await globalTxRef.set(txData);

    // =============================
    // ✅ RESPONSE
    // =============================
    res.json({
      status: "SUCCESS",
      transactionId: clientTxnId,
    });
  } catch (err) {
    console.error("PAY ERROR full:", err);
    console.error(err.stack);

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
// ✅ START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});