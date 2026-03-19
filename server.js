import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, push, set, runTransaction, get } from "firebase/database";
import admin from "firebase-admin";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "")));

// Firebase client app config (for Realtime DB)
const firebaseConfig = {
  apiKey: "AIzaSyAf_NwYmTsoskojIuQ_0MQwfyvDb83Ydys",
  authDomain: "drop-dash-f40a0.firebaseapp.com",
  databaseURL: "https://drop-dash-f40a0-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "drop-dash-f40a0",
  storageBucket: "drop-dash-f40a0.firebasestorage.app",
  messagingSenderId: "245836274666",
  appId: "1:245836274666:web:cd0282c5a89a9d63413093",
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Firebase Admin SDK for UID verification
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS); // stored as JSON string in .env
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: firebaseConfig.databaseURL,
});

// --- Pay endpoint ---
app.post("/pay", async (req, res) => {
  try {
    const { idToken, walletId, mpin, amount, merchantId } = req.body;

    if (!idToken || !walletId || !mpin || !amount || !merchantId) {
      return res.status(400).json({ status: "FAILURE", error: "Missing required fields" });
    }

    // Verify Firebase ID token
    let uid;
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      uid = decodedToken.uid;
    } catch (err) {
      return res.status(401).json({ status: "FAILURE", error: "Invalid Firebase ID token" });
    }

    // Fetch wallet data from Firebase
    const userRef = ref(db, `wallets/${uid}`);
    const snapshot = await get(userRef);
    const userData = snapshot.val();

    if (!userData) {
      return res.status(404).json({ status: "FAILURE", error: "Wallet not found" });
    }

    // Verify walletId matches stored wallet
    if (userData.walletId !== walletId) {
      return res.status(403).json({ status: "FAILURE", error: "Wallet ID mismatch" });
    }

    // Verify MPIN securely
    const mpinValid = await bcrypt.compare(mpin, userData.mpinHash);
    if (!mpinValid) {
      return res.status(401).json({ status: "FAILURE", error: "Invalid MPIN" });
    }

    // Parse amount as number
    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      return res.status(400).json({ status: "FAILURE", error: "Invalid amount" });
    }

    // Deduct balance atomically
    let txnId = uuidv4();
    await runTransaction(userRef, (currentData) => {
      if (!currentData) return currentData;

      if (currentData.balance < payAmount) {
        return; // abort transaction
      }
      currentData.balance -= payAmount;
      return currentData;
    }).then((result) => {
      if (!result.committed) throw new Error("Insufficient balance");
    });

    // Save transaction record
    const txRef = push(ref(db, `transactions/${uid}`));
    await set(txRef, {
      id: txnId,
      amount: payAmount,
      status: "SUCCESS",
      merchantId,
      initiatedAt: Date.now(),
      completedAt: Date.now(),
    });

    res.json({ status: "SUCCESS", transactionId: txnId });
  } catch (err) {
    console.error("Pay endpoint error:", err);
    res.status(500).json({ status: "FAILURE", error: err.message || "Server error" });
  }
});

// --- Payment callback ---
app.post("/payment-callback", async (req, res) => {
  try {
    const { uid, amount, status, merchantId, transactionId, secret } = req.body;

    if (secret !== process.env.PAYMENT_CALLBACK_SECRET) {
      return res.status(403).json({ error: "Unauthorized callback" });
    }

    const txRef = push(ref(db, `transactions/${uid}`));
    await set(txRef, {
      id: transactionId,
      amount,
      status,
      merchantId,
      callbackReceivedAt: Date.now(),
    });

    console.log("Callback saved:", transactionId);
    res.sendStatus(200);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});