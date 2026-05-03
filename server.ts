import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

// Load Firebase Config safely
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));

// Initialize Firebase Admin
if (getApps().length === 0) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Helper to get Firestore with correct DB ID
  const getDB = () => {
    if (firebaseConfig.firestoreDatabaseId) {
      return getFirestore(firebaseConfig.firestoreDatabaseId);
    }
    return getFirestore();
  };

  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET}`,
    "Content-Type": "application/json",
  };

  const rpName = "Unipay";
  const rpID = process.env.APP_URL ? new URL(process.env.APP_URL).hostname : "localhost";
  const origin = process.env.APP_URL || `http://localhost:${PORT}`;

  // Temporal store for challenges (In production, use Redis or a DB)
  const userChallenges = new Map<string, string>();

  // WebAuthn Routes
  app.post("/api/auth/register-options", async (req, res) => {
    const { userId, email, displayName } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const db = getDB();
    const userDoc = await db.collection("users").doc(userId).get();
    const userAuthenticators = userDoc.data()?.authenticators || [];

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: Buffer.from(userId),
      userName: email,
      userDisplayName: displayName || email,
      attestationType: "none",
      excludeCredentials: userAuthenticators.map((auth: any) => ({
        id: isoBase64URL.toBuffer(auth.credentialID),
        type: "public-key",
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    userChallenges.set(userId, options.challenge);
    res.json(options);
  });

  app.post("/api/auth/verify-registration", async (req, res) => {
    const { userId, body } = req.body;
    const expectedChallenge = userChallenges.get(userId);

    if (!expectedChallenge) return res.status(400).json({ error: "Challenge not found" });

    try {
      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });

      if (verification.verified && verification.registrationInfo) {
        const { credential } = verification.registrationInfo;
        const { id, publicKey, counter } = credential;
        
        const db = getDB();
        const userRef = db.collection("users").doc(userId);
        
        const newAuthenticator = {
          credentialID: isoBase64URL.fromBuffer(id as any),
          credentialPublicKey: isoBase64URL.fromBuffer(publicKey as any),
          counter,
          transports: body.response.transports,
        };

        await userRef.update({
          authenticators: FieldValue.arrayUnion(newAuthenticator),
          biometricsEnabled: true,
        });

        userChallenges.delete(userId);
        res.json({ verified: true });
      } else {
        res.status(400).json({ error: "Verification failed" });
      }
    } catch (error: any) {
      console.error(error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login-options", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const db = getDB();
    const usersSnap = await db.collection("users").where("email", "==", email).limit(1).get();
    
    if (usersSnap.empty) return res.status(404).json({ error: "User not found" });
    
    const userDoc = usersSnap.docs[0];
    const userData = userDoc.data();
    const userAuthenticators = userData.authenticators || [];

    if (userAuthenticators.length === 0) {
      return res.status(400).json({ error: "No biometrics registered for this email" });
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: userAuthenticators.map((auth: any) => ({
        id: isoBase64URL.toBuffer(auth.credentialID),
        type: "public-key",
        transports: auth.transports,
      })),
      userVerification: "preferred",
    });

    userChallenges.set(email, options.challenge);
    res.json(options);
  });

  app.post("/api/auth/verify-login", async (req, res) => {
    const { email, body } = req.body;
    const expectedChallenge = userChallenges.get(email);

    if (!expectedChallenge) return res.status(400).json({ error: "Challenge not found" });

    const db = getDB();
    const usersSnap = await db.collection("users").where("email", "==", email).limit(1).get();
    const userDoc = usersSnap.docs[0];
    const userData = userDoc.data();
    const userId = userDoc.id;
    
    const authenticator = userData.authenticators.find(
      (auth: any) => auth.credentialID === body.id
    );

    if (!authenticator) return res.status(400).json({ error: "Authenticator not found" });

    try {
      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: authenticator.credentialID,
          publicKey: isoBase64URL.toBuffer(authenticator.credentialPublicKey),
          counter: authenticator.counter,
        },
      });

      if (verification.verified) {
        // Update counter
        const updatedAuthenticators = userData.authenticators.map((auth: any) => {
          if (auth.credentialID === body.id) {
            return { ...auth, counter: verification.authenticationInfo.newCounter };
          }
          return auth;
        });
        await userDoc.ref.update({ authenticators: updatedAuthenticators });

        // Generate Firebase Custom Token
        const customToken = await getAuth().createCustomToken(userId);
        
        userChallenges.delete(email);
        res.json({ verified: true, customToken });
      } else {
        res.status(400).json({ error: "Verification failed" });
      }
    } catch (error: any) {
      console.error(error);
      res.status(400).json({ error: error.message });
    }
  });

  // 1. Initiate Payment (Initialize Transaction)
  app.post("/api/payments/initiate", async (req, res) => {
    try {
      const { amount, customerEmail, userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const reference = `unipay_ps_${uuidv4().replace(/-/g, "")}`;

      const payload = {
        amount: amount * 100, // Paystack uses kobo
        email: customerEmail,
        reference: reference,
        callback_url: `${process.env.APP_URL}/dashboard`,
        metadata: {
          userId: userId,
        },
      };

      const response = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        payload,
        { headers: paystackHeaders }
      );

      res.json({ 
        checkoutUrl: response.data.data.authorization_url, 
        reference 
      });
    } catch (error: any) {
      console.error("Paystack initiation error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to initiate payment" });
    }
  });

  // 2. Paystack Webhook
  app.post("/api/webhooks/paystack", async (req, res) => {
    try {
      const event = req.body;
      // In production, verify signature using x-paystack-signature
      
      if (event.event === "charge.success") {
        const transactionData = event.data;
        const { reference, amount, metadata } = transactionData;
        const userId = metadata?.userId;
        const amountPaid = amount / 100; // Convert back from kobo

        if (userId) {
          const db = getDB();
          const walletRef = db.collection("wallets").doc(userId);
          const txnRef = db.collection("transactions").doc(reference);

          await db.runTransaction(async (t) => {
            const walletDoc = await t.get(walletRef);
            const currentBalance = walletDoc.exists ? (walletDoc.data()?.balance || 0) : 0;
            
            t.set(walletRef, {
              userId,
              balance: currentBalance + amountPaid,
              currency: "NGN",
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });

            t.set(txnRef, {
              userId,
              amount: amountPaid,
              type: "FUNDING",
              status: "SUCCESS",
              reference: reference,
              description: "Wallet Funding via Paystack",
              createdAt: FieldValue.serverTimestamp(),
            });
          });

          console.log(`Successfully credited wallet for user ${userId}: +${amountPaid}`);
        }
      }
      
      res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error);
      res.sendStatus(500);
    }
  });

  // 3. Get Banks
  app.get("/api/banks", async (req, res) => {
    try {
      const response = await axios.get("https://api.paystack.co/bank?country=nigeria", {
        headers: paystackHeaders,
      });
      res.json(response.data.data);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch banks" });
    }
  });

  // 4. Verify Account
  app.post("/api/payments/verify-account", async (req, res) => {
    try {
      const { accountNumber, bankCode } = req.body;
      const response = await axios.get(
        `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        { headers: paystackHeaders }
      );
      res.json({ accountName: response.data.data.account_name });
    } catch (error: any) {
      res.status(400).json({ error: error.response?.data?.message || "Invalid account details" });
    }
  });

  // 5. Transfer Money (Payout)
  app.post("/api/payments/transfer", async (req, res) => {
    try {
      const { amount, bankCode, accountNumber, narration, userId, accountName } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const db = getDB();
      const walletRef = db.collection("wallets").doc(userId);
      const reference = `uni_ps_xfer_${uuidv4().replace(/-/g, "").substring(0, 10)}`;

      // 1. Deduct balance first (Atomic Transaction)
      try {
        await db.runTransaction(async (t) => {
          const walletDoc = await t.get(walletRef);
          if (!walletDoc.exists) throw new Error("Wallet not found");
          const balance = walletDoc.data()?.balance || 0;

          if (balance < amount) {
            throw new Error("Insufficient funds");
          }

          t.update(walletRef, {
            balance: balance - amount,
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }

      // 2. Create Transfer Recipient
      let recipientCode = "";
      try {
        const recipientResponse = await axios.post(
          "https://api.paystack.co/transferrecipient",
          {
            type: "nuban",
            name: accountName,
            account_number: accountNumber,
            bank_code: bankCode,
            currency: "NGN",
          },
          { headers: paystackHeaders }
        );
        recipientCode = recipientResponse.data.data.recipient_code;
      } catch (error: any) {
        console.error("Paystack Recipient error:", error.response?.data || error.message);
        // Rollback
        const currentWallet = await walletRef.get();
        await walletRef.update({
          balance: (currentWallet.data()?.balance || 0) + amount,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return res.status(500).json({ error: "Failed to create transfer recipient" });
      }

      // 3. Initiate Transfer
      try {
        await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",
            amount: amount * 100,
            recipient: recipientCode,
            reason: narration || "Unipay Transfer",
            reference: reference,
          },
          { headers: paystackHeaders }
        );

        // 4. Log transaction
        const txnRef = db.collection("transactions").doc(reference);
        await txnRef.set({
          userId,
          amount,
          type: "TRANSFER",
          status: "SUCCESS", // Paystack transfers are often async but for this demo we assume success or handle via webhook later
          reference,
          description: `Transfer to ${accountNumber} (${bankCode})`,
          createdAt: FieldValue.serverTimestamp(),
        });

        res.json({ message: "Transfer initiated successfully" });
      } catch (error: any) {
        console.error("Paystack Transfer error:", error.response?.data || error.message);
        // REVERSAL
        const currentWallet = await walletRef.get();
        await walletRef.update({
          balance: (currentWallet.data()?.balance || 0) + amount,
          updatedAt: FieldValue.serverTimestamp(),
        });

        res.status(500).json({ error: "Paystack transfer failed. Balance reversed." });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Transfer failed" });
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
