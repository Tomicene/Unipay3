import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import * as admin from "firebase-admin";

// Load Firebase Config safely
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));

// Initialize Firebase Admin
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Helper to get Firestore with correct DB ID
  const getDB = () => {
    // If a firestoreDatabaseId is provided, we use it.
    // In firebase-admin, you can access multiple databases in the same project
    if (firebaseConfig.firestoreDatabaseId) {
      return (admin.firestore as any)(firebaseConfig.firestoreDatabaseId);
    }
    return admin.firestore();
  };

  // 1. Get Monnify Access Token
  const getMonnifyToken = async () => {
    const apiKey = process.env.MONNIFY_API_KEY;
    const secretKey = process.env.MONNIFY_SECRET_KEY;
    if (!apiKey || !secretKey) {
      throw new Error("Monnify API keys are not configured.");
    }

    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
    const response = await axios.post(
      "https://sandbox.monnify.com/api/v1/auth/login",
      {},
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );
    return response.data.responseBody.accessToken;
  };

  // 2. Initiate Payment
  app.post("/api/payments/initiate", async (req, res) => {
    try {
      const { amount, customerName, customerEmail, userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const token = await getMonnifyToken();
      const reference = `unipay_${uuidv4().replace(/-/g, "")}`;

      const payload = {
        amount,
        customerName,
        customerEmail,
        paymentReference: reference,
        paymentDescription: "Unipay Wallet Funding",
        currencyCode: "NGN",
        contractCode: process.env.MONNIFY_CONTRACT_CODE,
        redirectUrl: `${process.env.APP_URL}/dashboard`,
        paymentMethods: ["CARD", "ACCOUNT_TRANSFER"],
        metaData: {
          userId: userId,
        },
      };

      const response = await axios.post(
        "https://sandbox.monnify.com/api/v1/merchant/transactions/init-transaction",
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      res.json({ ...response.data.responseBody, reference });
    } catch (error: any) {
      console.error("Payment initiation error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to initiate payment" });
    }
  });

  // 3. Monnify Webhook (to confirm payment)
  app.post("/api/webhooks/monnify", async (req, res) => {
    try {
      const transactionData = req.body;
      // In production, verify the SHA512 signature using MONNIFY_SECRET_KEY
      
      const { paymentReference, paymentStatus, amountPaid, metaData } = transactionData;
      const userId = metaData?.userId;
      
      if (paymentStatus === "PAID" && userId) {
        const db = getDB();
        const walletRef = db.collection("wallets").doc(userId);
        const txnRef = db.collection("transactions").doc(paymentReference);

        await db.runTransaction(async (t) => {
          const walletDoc = await t.get(walletRef);
          const currentBalance = walletDoc.exists ? (walletDoc.data()?.balance || 0) : 0;
          
          t.set(walletRef, {
            userId,
            balance: currentBalance + amountPaid,
            currency: "NGN",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          t.set(txnRef, {
            userId,
            amount: amountPaid,
            type: "FUNDING",
            status: "SUCCESS",
            reference: paymentReference,
            description: "Wallet Funding via Monnify",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        console.log(`Successfully credited wallet for user ${userId}: +${amountPaid}`);
      }
      
      res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error);
      res.sendStatus(500);
    }
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
