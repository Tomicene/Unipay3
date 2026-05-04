import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import axios from "axios";
import crypto from "crypto";
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
  initializeApp();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Helper to get Firestore with correct DB ID
  const getDB = () => {
    try {
      if (firebaseConfig.firestoreDatabaseId) {
        return getFirestore(firebaseConfig.firestoreDatabaseId);
      }
    } catch (e) {
      console.warn("Explicit DB ID initialization failed, falling back to default", e);
    }
    return getFirestore();
  };

  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  const paystackHeaders = {
    Authorization: `Bearer ${PAYSTACK_SECRET}`,
    "Content-Type": "application/json",
  };

  const rpName = "Unipay";
  // Dynamically determine rpID and origin to support multiple domains (custom domains + dev URLs)
  const getWebAuthnConfig = (req: express.Request) => {
    const host = req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    const currentOrigin = `${proto}://${host}`;
    
    // rpID must be the domain without port
    const currentRpID = host.split(":")[0];
    
    console.log("WebAuthn Config:", { currentRpID, currentOrigin });
    return { currentRpID, currentOrigin };
  };

  // Temporal store for challenges (In production, use Redis or a DB)
  const userChallenges = new Map<string, string>();

  // WebAuthn Routes
  app.post("/api/auth/register-options", async (req, res) => {
    try {
      const { userId, email, displayName } = req.body;
      if (!userId) return res.status(400).json({ error: "userId required" });

      const { currentRpID } = getWebAuthnConfig(req);

      const db = getDB();
      const userDoc = await db.collection("users").doc(userId).get();
      const userAuthenticators = userDoc.data()?.authenticators || [];

      const options = await generateRegistrationOptions({
        rpName,
        rpID: currentRpID,
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
    } catch (error: any) {
      console.error("Register options error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/auth/verify-registration", async (req, res) => {
    const { userId, body } = req.body;
    const expectedChallenge = userChallenges.get(userId);

    const { currentRpID, currentOrigin } = getWebAuthnConfig(req);

    if (!expectedChallenge) return res.status(400).json({ error: "Challenge not found. Please try again." });

    try {
      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: currentOrigin,
        expectedRPID: currentRpID,
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
        res.status(400).json({ error: "Biometric verification failed" });
      }
    } catch (error: any) {
      console.error("Verify registration error:", error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/login-options", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const { currentRpID } = getWebAuthnConfig(req);

      const db = getDB();
      const usersSnap = await db.collection("users").where("email", "==", email).limit(1).get();
      
      if (usersSnap.empty) return res.status(404).json({ error: "No user found with this email" });
      
      const userDoc = usersSnap.docs[0];
      const userData = userDoc.data();
      const userAuthenticators = userData.authenticators || [];

      if (userAuthenticators.length === 0) {
        return res.status(400).json({ error: "No biometrics registered for this email. Please log in with password and enable biometrics in profile." });
      }

      const options = await generateAuthenticationOptions({
        rpID: currentRpID,
        allowCredentials: userAuthenticators.map((auth: any) => ({
          id: isoBase64URL.toBuffer(auth.credentialID),
          type: "public-key",
          transports: auth.transports,
        })),
        userVerification: "preferred",
      });

      userChallenges.set(email, options.challenge);
      res.json(options);
    } catch (error: any) {
      console.error("Login options error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/auth/verify-login", async (req, res) => {
    try {
      const { email, body } = req.body;
      const expectedChallenge = userChallenges.get(email);

      const { currentRpID, currentOrigin } = getWebAuthnConfig(req);

      if (!expectedChallenge) return res.status(400).json({ error: "Challenge expired. Please refresh and try again." });

      const db = getDB();
      const usersSnap = await db.collection("users").where("email", "==", email).limit(1).get();
      
      if (usersSnap.empty) return res.status(404).json({ error: "User not found" });
      
      const userDoc = usersSnap.docs[0];
      const userData = userDoc.data();
      const userId = userDoc.id;
      
      const authenticator = (userData.authenticators || []).find(
        (auth: any) => auth.credentialID === body.id
      );

      if (!authenticator) {
        console.error("Authenticator not matches stored credentials", { bodyId: body.id, stored: userData.authenticators?.map((a:any)=>a.id) });
        return res.status(400).json({ error: "This biometric key is not registered to your account." });
      }

      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: currentOrigin,
        expectedRPID: currentRpID,
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
        res.status(400).json({ error: "Biometric authentication failed" });
      }
    } catch (error: any) {
      console.error("Verify login error:", error);
      res.status(400).json({ error: error.message });
    }
  });

  // 1. Initiate Payment (Initialize Transaction)
  app.post("/api/payments/initiate", async (req, res) => {
    try {
      const { amount, customerEmail, userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required" });
      
      const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
      if (!PAYSTACK_SECRET) {
        console.error("PAYSTACK_SECRET_KEY is missing in environment variables");
        return res.status(500).json({ error: "Server configuration error: Paystack key missing" });
      }

      const reference = `unipay_ps_${uuidv4().replace(/-/g, "")}`;
      const appUrl = process.env.APP_URL || origin;

      const payload = {
        amount: Math.round(Number(amount) * 100), // Paystack uses kobo
        email: customerEmail,
        reference: reference,
        callback_url: `${appUrl}/dashboard`,
        metadata: {
          userId: userId,
        },
      };

      console.log("Initiating Paystack payment with payload:", JSON.stringify(payload));

      const response = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        payload,
        { 
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET}`,
            "Content-Type": "application/json",
          }
        }
      );

      console.log("Paystack response:", JSON.stringify(response.data));
      
      if (!response.data.status) {
        return res.status(400).json({ 
          error: "Paystack initiation failed", 
          details: response.data.message 
        });
      }

      if (!response.data.data?.authorization_url) {
        return res.status(500).json({ 
          error: "Internal error", 
          details: "No authorization URL returned from Paystack" 
        });
      }

      res.json({ 
        checkoutUrl: response.data.data.authorization_url, 
        reference 
      });
    } catch (error: any) {
      console.error("Paystack initiation error details:", {
        message: error.message,
        response: error.response?.data,
        config: error.config ? { url: error.config.url, data: error.config.data } : "No config"
      });
      res.status(500).json({ 
        error: "Failed to initiate payment", 
        details: error.response?.data?.message || error.message 
      });
    }
  });

  // Webhook Endpoint for Paystack
  app.post("/api/webhooks/paystack", async (req, res) => {
    try {
      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (hash !== req.headers["x-paystack-signature"]) {
        console.error("Invalid Paystack signature");
        return res.sendStatus(400);
      }

      const event = req.body;
      console.log("Paystack Webhook Event:", event.event);

      if (event.event === "charge.success") {
        const data = event.data;
        const userId = data.metadata?.userId;
        const amountPaid = data.amount / 100;
        const reference = data.reference;

        if (userId) {
          const db = getDB();
          const walletRef = db.collection("wallets").doc(userId);
          const txnRef = db.collection("transactions").doc(reference);

          await db.runTransaction(async (t) => {
            const txnDoc = await t.get(txnRef);
            // Prevent double-crediting
            if (txnDoc.exists && txnDoc.data()?.status === "SUCCESS") {
              console.log(`Transaction ${reference} already processed.`);
              return;
            }

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
              description: "Wallet Funding (via Webhook)",
              createdAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          });
          
          console.log(`Successfully credited ${amountPaid} to user ${userId} via webhook`);
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Webhook processing error:", error);
      res.sendStatus(500);
    }
  });

  // manual report and auto-fix endpoint
  app.post("/api/payments/report-missing", async (req, res) => {
    try {
      const { reference, userId, email } = req.body;
      if (!reference) return res.status(400).json({ error: "Reference is required" });

      const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
      
      // 1. Verify with Paystack
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
      );

      const data = response.data.data;
      const db = getDB();

      // Log the report regardless of outcome
      await db.collection("support_reports").add({
        userId,
        email,
        reference,
        paystackStatus: data.status,
        reportedAt: FieldValue.serverTimestamp(),
        resolved: data.status === "success"
      });

      if (data.status === "success") {
        const amountPaid = data.amount / 100;
        const walletRef = db.collection("wallets").doc(userId);
        const txnRef = db.collection("transactions").doc(reference);

        let alreadyProcessed = false;

        await db.runTransaction(async (t) => {
          const txnDoc = await t.get(txnRef);
          if (txnDoc.exists && txnDoc.data()?.status === "SUCCESS") {
            alreadyProcessed = true;
            return;
          }

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
            description: "Wallet Funding (via Manual Report)",
            createdAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        });

        if (alreadyProcessed) {
          return res.json({ status: "already_processed", message: "This payment was already credited to your account." });
        }

        return res.json({ status: "success", message: `Found! ₦${amountPaid} has been added to your balance.` });
      } else {
        return res.status(400).json({ 
          status: "failed", 
          message: `Paystack returns: ${data.gateway_response || "Unsuccessful payment"}. Please ensure the reference is correct.` 
        });
      }
    } catch (error: any) {
      console.error("Report processing error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to process report. Please try again later." });
    }
  });

  // Verification Endpoint (Manual fallback)
  app.get("/api/payments/verify/:reference", async (req, res) => {
    try {
      const { reference } = req.params;
      const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
      
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
      );

      const data = response.data.data;
      if (data.status === "success") {
        const userId = data.metadata?.userId;
        const amountPaid = data.amount / 100;

        if (userId) {
          const db = getDB();
          const walletRef = db.collection("wallets").doc(userId);
          const txnRef = db.collection("transactions").doc(reference);

          await db.runTransaction(async (t) => {
            const txnDoc = await t.get(txnRef);
            // Only update if not already processed successfully
            if (txnDoc.exists && txnDoc.data()?.status === "SUCCESS") {
              return; 
            }

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
              description: "Wallet Funding via Paystack (Verified)",
              createdAt: FieldValue.serverTimestamp(),
            }, { merge: true });
          });

          return res.json({ status: "success", amount: amountPaid });
        }
      }
      
      res.json({ status: data.status, message: data.gateway_response });
    } catch (error: any) {
      console.error("Verification error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to verify transaction" });
    }
  });

  // Profile Update Endpoint
  app.post("/api/user/profile", async (req, res) => {
    try {
      const { userId, displayName, phone } = req.body;
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const db = getDB();
      const userRef = db.collection("users").doc(userId);

      console.log(`Updating profile for user ${userId}:`, { displayName, phone });

      await userRef.set({
        displayName,
        phone,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      res.json({ message: "Profile updated successfully" });
    } catch (error: any) {
      console.error("Profile update error detail:", {
        message: error.message,
        code: error.code,
        details: error.details,
        stack: error.stack
      });
      res.status(500).json({ error: `Failed to update profile: ${error.message}` });
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
