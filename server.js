import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

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
// ✅ PAYMENT API
// =============================
app.post("/pay", async (req, res) => {
  try {
    const { idToken, walletId, mpin, amount, merchantId } = req.body;

    if (!idToken || !walletId || !mpin || !amount || !merchantId) {
      return res.status(400).json({ status: "FAILURE", error: "Missing fields" });
    }

    // ✅ Verify Firebase user
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error("Invalid amount");
    }

    const txnId = uuidv4();

    // 🔥 Idempotency check
    const globalTxRef = db.ref(`transactions_global/${txnId}`);
    const existingTx = await globalTxRef.get();

    if (existingTx.exists()) {
      return res.json({ status: "SUCCESS", transactionId: txnId });
    }

    // =============================
    // ✅ FETCH USER WALLET
    // =============================
    const userRef = db.ref(`wallets/${uid}`);
    const userSnap = await userRef.get();

    if (!userSnap.exists()) {
      throw new Error("Wallet not found");
    }

    const userData = userSnap.val();

    if (userData.walletId !== walletId) {
      throw new Error("Invalid wallet ID");
    }

    if (!bcrypt.compareSync(mpin, userData.mpinHash)) {
      throw new Error("Invalid MPIN");
    }

    if (userData.balance < payAmount) {
      throw new Error("Insufficient balance");
    }

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

      if (data.balance < payAmount) {
        return; // abort
      }

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
      id: txnId,
      amount: payAmount,
      status: "SUCCESS",
      merchantId,
      userId: uid,
      createdAt: Date.now(),
    };

    await db.ref(`transactions/users/${uid}/${txnId}`).set(txData);
    await db.ref(`transactions/merchants/${merchantId}/${txnId}`).set(txData);
    await globalTxRef.set(txData);

    // =============================
    // ✅ RESPONSE
    // =============================
    res.json({
      status: "SUCCESS",
      transactionId: txnId,
    });

  } catch (err) {
    console.error("PAY ERROR:", err.message);

    // 🔥 Log failure
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
// ✅ CALLBACK API
// =============================
app.post("/payment-callback", async (req, res) => {
  try {
    const { uid, amount, status, merchantId, transactionId, secret } = req.body;

    if (secret !== process.env.PAYMENT_CALLBACK_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (!transactionId) {
      return res.status(400).json({ error: "Missing transactionId" });
    }

    const txRef = db.ref(`transactions_global/${transactionId}`);
    const snap = await txRef.get();

    if (snap.exists()) {
      return res.sendStatus(200); // already processed
    }

    const txData = {
      id: transactionId,
      amount,
      status,
      merchantId,
      userId: uid,
      callbackAt: Date.now(),
    };

    await db.ref(`transactions/users/${uid}/${transactionId}`).set(txData);
    await db.ref(`transactions/merchants/${merchantId}/${transactionId}`).set(txData);
    await txRef.set(txData);

    console.log("Callback stored:", transactionId);

    res.sendStatus(200);

  } catch (err) {
    console.error("CALLBACK ERROR:", err);
    res.status(500).send("Server error");
  }
});


// =============================
// ✅ START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});