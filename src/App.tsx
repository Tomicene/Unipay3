/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  signOut, 
  User,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile
} from "firebase/auth";
import { 
  doc, 
  setDoc, 
  onSnapshot, 
  collection, 
  query, 
  where, 
  orderBy,
  serverTimestamp 
} from "firebase/firestore";
import { 
  Wallet, 
  Plus, 
  ArrowUpRight, 
  ArrowDownLeft, 
  History, 
  LogOut, 
  CreditCard,
  Loader2,
  TrendingUp,
  ShieldCheck,
  Mail,
  Lock,
  User as UserIcon,
  Phone,
  Fingerprint
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import axios from "axios";
import { auth, db, googleProvider, handleFirestoreError, OperationType } from "./lib/firebase";
import { signInWithCustomToken } from "firebase/auth";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

// Types
interface WalletData {
  balance: number;
  currency: string;
}

interface Transaction {
  id: string;
  amount: number;
  type: "FUNDING" | "TRANSFER" | "WITHDRAWAL";
  status: "PENDING" | "SUCCESS" | "FAILED";
  description: string;
  createdAt: any;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isFundModalOpen, setIsFundModalOpen] = useState(false);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [fundAmount, setFundAmount] = useState("");
  const [fundingLoading, setFundingLoading] = useState(false);
  
  // Send Money Form State
  const [banks, setBanks] = useState<{name: string, code: string}[]>([]);
  const [recipientAccount, setRecipientAccount] = useState("");
  const [recipientBank, setRecipientBank] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNarration, setTransferNarration] = useState("");
  const [transferLoading, setTransferLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  
  // Auth Form State
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [isBiometricsAvailable, setIsBiometricsAvailable] = useState(false);
  const [enablingBiometrics, setEnablingBiometrics] = useState(false);

  useEffect(() => {
    // Check if WebAuthn is supported
    if (window.PublicKeyCredential) {
      setIsBiometricsAvailable(true);
    }
  }, []);

  useEffect(() => {
    // Fetch banks list
    const fetchBanks = async () => {
      try {
        const res = await axios.get("/api/banks");
        setBanks(res.data);
      } catch (e) {
        console.error("Failed to fetch banks", e);
      }
    };
    fetchBanks();
  }, []);

  // Verify Account Logic
  useEffect(() => {
    if (recipientAccount && recipientAccount.length === 10 && recipientBank) {
      const verify = async () => {
        setIsVerifying(true);
        setRecipientName("");
        try {
          const res = await axios.post("/api/payments/verify-account", {
            accountNumber: recipientAccount,
            bankCode: recipientBank
          });
          setRecipientName(res.data.accountName);
        } catch (e) {
          console.error("Verification failed", e);
        } finally {
          setIsVerifying(false);
        }
      };
      verify();
    }
  }, [recipientAccount, recipientBank]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUser(user);
        // Ensure user document exists
        const userRef = doc(db, "users", user.uid);
        try {
          await setDoc(userRef, {
            email: user.email,
            displayName: user.displayName || fullName || "Unipay User",
            photoURL: user.photoURL,
            phone: user.phoneNumber || phone,
            createdAt: serverTimestamp(),
          }, { merge: true });
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, "users");
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [fullName, phone]);

  useEffect(() => {
    if (!user) return;

    // Listen to wallet
    const walletRef = doc(db, "wallets", user.uid);
    const unsubWallet = onSnapshot(walletRef, (snap) => {
      if (snap.exists()) {
        setWallet(snap.data() as WalletData);
      } else {
        setWallet({ balance: 0, currency: "NGN" });
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, "wallets"));

    // Listen to transactions
    const txnsQuery = query(
      collection(db, "transactions"),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsubTxns = onSnapshot(txnsQuery, (snap) => {
      const txs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Transaction));
      setTransactions(txs);
    }, (err) => handleFirestoreError(err, OperationType.GET, "transactions"));

    return () => {
      unsubWallet();
      unsubTxns();
    };
  }, [user]);

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      console.error("Login failed", e);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    try {
      if (isSignup) {
        const userCred = await createUserWithEmailAndPassword(auth, email, password);
        if (fullName) {
          await updateProfile(userCred.user, { displayName: fullName });
        }
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (e: any) {
      console.error("Auth error", e);
      alert(e.message || "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleBiometricLogin = async () => {
    if (!email) {
      alert("Please enter your email first to login with biometrics");
      return;
    }
    setAuthLoading(true);
    try {
      const optionsRes = await axios.post("/api/auth/login-options", { email });
      const authResp = await startAuthentication(optionsRes.data);
      const verifyRes = await axios.post("/api/auth/verify-login", {
        email,
        body: authResp,
      });

      if (verifyRes.data.verified && verifyRes.data.customToken) {
        await signInWithCustomToken(auth, verifyRes.data.customToken);
      }
    } catch (e: any) {
      console.error("Biometric login failed", e);
      alert(e.response?.data?.error || "Biometric login failed. Make sure you have registered biometrics for this device.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleEnableBiometrics = async () => {
    if (!user) return;
    setEnablingBiometrics(true);
    try {
      const optionsRes = await axios.post("/api/auth/register-options", {
        userId: user.uid,
        email: user.email,
        displayName: user.displayName,
      });
      
      const regResp = await startRegistration(optionsRes.data);
      const verifyRes = await axios.post("/api/auth/verify-registration", {
        userId: user.uid,
        body: regResp,
      });

      if (verifyRes.data.verified) {
        alert("Biometrics enabled successfully!");
      }
    } catch (e: any) {
      console.error("Failed to enable biometrics", e);
      alert(e.response?.data?.error || "Failed to enable biometrics. Ensure you are in a secure context and have biometrics set up on your device.");
    } finally {
      setEnablingBiometrics(false);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleFundWallet = async () => {
    if (!fundAmount || isNaN(Number(fundAmount)) || Number(fundAmount) < 100) {
      alert("Minimum funding amount is ₦100");
      return;
    }

    setFundingLoading(true);
    try {
      const response = await axios.post("/api/payments/initiate", {
        amount: Number(fundAmount),
        customerName: user?.displayName || "Unipay User",
        customerEmail: user?.email,
        userId: user?.uid,
      });

      const { checkoutUrl } = response.data;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
      } else {
        throw new Error("No checkout URL returned");
      }
    } catch (e) {
      console.error("Funding failed", e);
      alert("Failed to initiate funding. Please try again.");
    } finally {
      setFundingLoading(false);
    }
  };

  const handleSendMoney = async () => {
    if (!transferAmount || isNaN(Number(transferAmount)) || Number(transferAmount) < 100) {
      alert("Minimum transfer amount is ₦100");
      return;
    }
    if (!recipientName) {
      alert("Please verify recipient account");
      return;
    }
    if ((wallet?.balance || 0) < Number(transferAmount)) {
      alert("Insufficient balance");
      return;
    }

    setTransferLoading(true);
    try {
      await axios.post("/api/payments/transfer", {
        amount: Number(transferAmount),
        bankCode: recipientBank,
        accountNumber: recipientAccount,
        accountName: recipientName,
        narration: transferNarration,
        userId: user?.uid,
      });
      alert("Transfer successful!");
      setIsSendModalOpen(false);
      // Reset form
      setRecipientAccount("");
      setRecipientBank("");
      setRecipientName("");
      setTransferAmount("");
      setTransferNarration("");
    } catch (e: any) {
      console.error("Transfer failed", e);
      alert(e.response?.data?.error || "Transfer failed");
    } finally {
      setTransferLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-opacity-5">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full space-y-8"
        >
          <div className="text-center space-y-2">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-xl shadow-blue-200">
                <Wallet className="w-8 h-8 text-white" />
              </div>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Unipay</h1>
            <p className="text-slate-500 font-medium">{isSignup ? "Create your secure account" : "Welcome back to Unipay"}</p>
          </div>
          
          <form onSubmit={handleEmailAuth} className="space-y-4">
            {isSignup && (
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 ml-1">FULL NAME</label>
                <div className="relative">
                  <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input 
                    type="text" 
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="John Doe"
                    className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 pl-11 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>
              </div>
            )}
            
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 ml-1">EMAIL ADDRESS</label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="email" 
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 pl-11 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            {isSignup && (
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 ml-1">PHONE NUMBER (OPTIONAL)</label>
                <div className="relative">
                  <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input 
                    type="tel" 
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+234..."
                    className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 pl-11 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 ml-1">PASSWORD</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="password" 
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 pl-11 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            <button 
              type="submit"
              disabled={authLoading}
              className="w-full bg-blue-600 text-white font-bold py-3.5 rounded-xl shadow-lg shadow-blue-100 hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
            >
              {authLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (isSignup ? "Create Account" : "Sign In")}
            </button>
            
            {!isSignup && isBiometricsAvailable && (
              <button 
                type="button"
                onClick={handleBiometricLogin}
                disabled={authLoading}
                className="w-full bg-slate-100 text-slate-700 font-bold py-3.5 rounded-xl hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
              >
                <Fingerprint className="w-5 h-5" />
                Sign in with Biometrics
              </button>
            )}
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-100"></div></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-4 text-slate-400 font-bold">Or continue with</span></div>
          </div>

          <button 
            onClick={handleGoogleLogin}
            className="w-full bg-white border border-slate-200 text-slate-900 font-bold py-3 rounded-xl hover:bg-slate-50 transition-all flex items-center justify-center gap-3"
          >
            <img src="https://www.google.com/favicon.ico" className="w-4 h-4" alt="Google" />
            Google
          </button>
          
          <p className="text-center text-sm text-slate-500">
            {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
            <button 
              onClick={() => setIsSignup(!isSignup)}
              className="text-blue-600 font-bold hover:underline"
            >
              {isSignup ? "Log In" : "Sign Up"}
            </button>
          </p>

          <p className="text-[10px] text-center text-slate-400 px-8">
            By continuing, you agree to Unipay's Terms of Service and Privacy Policy. Securely integrated with Paystack.
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Wallet className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight">Unipay</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold text-slate-900">{user.displayName || "User"}</p>
              <p className="text-[10px] text-slate-500">{user.email}</p>
            </div>
            <button 
              onClick={handleLogout}
              className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-8 space-y-6">
        {/* Balance Card */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-blue-600 rounded-3xl p-8 text-white relative overflow-hidden shadow-2xl shadow-blue-200"
        >
          <div className="relative z-10">
            <p className="text-blue-100 text-sm font-medium mb-1">Total Balance</p>
            <h2 className="text-4xl font-bold flex items-baseline gap-2">
              <span className="text-2xl font-normal opacity-80">₦</span>
              {wallet?.balance.toLocaleString() || "0.00"}
            </h2>
            <div className="mt-8 flex gap-4">
              <button 
                onClick={() => setIsFundModalOpen(true)}
                className="flex-1 bg-white text-blue-600 font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-blue-50 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Fund
              </button>
              <button 
                onClick={() => setIsSendModalOpen(true)}
                className="flex-1 bg-blue-500/50 backdrop-blur-sm text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-white/20 transition-colors"
              >
                <ArrowUpRight className="w-5 h-5" />
                Send
              </button>
            </div>
          </div>
          {/* Abstract background shapes */}
          <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-white opacity-10 rounded-full blur-3xl"></div>
          <div className="absolute -left-10 -top-10 w-32 h-32 bg-blue-400 opacity-20 rounded-full blur-2xl"></div>
        </motion.div>

        {/* Info Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
            <div className="bg-emerald-100 p-2 rounded-lg text-emerald-600">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[10px] text-slate-500 font-medium">Income</p>
              <p className="font-bold text-sm">₦12k</p>
            </div>
          </div>
          <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3 text-slate-400 grayscale opacity-50">
            <div className="bg-slate-100 p-2 rounded-lg">
              <History className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[10px] font-medium">Coming Soon</p>
              <p className="font-bold text-sm">Savings</p>
            </div>
          </div>
        </div>

        {/* Biometrics Toggle */}
        {isBiometricsAvailable && (
          <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-blue-50 p-2 rounded-lg text-blue-600">
                <Fingerprint className="w-5 h-5" />
              </div>
              <div>
                <p className="text-sm font-bold">Biometric Login</p>
                <p className="text-[10px] text-slate-500">Fast login with Touch/Face ID</p>
              </div>
            </div>
            <button 
              onClick={handleEnableBiometrics}
              disabled={enablingBiometrics}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                (user as any)?.biometricsEnabled 
                ? "bg-slate-100 text-slate-400 cursor-not-allowed" 
                : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {enablingBiometrics ? <Loader2 className="w-4 h-4 animate-spin" /> : ((user as any)?.biometricsEnabled ? "Enabled" : "Enable")}
            </button>
          </div>
        )}

        {/* Transactions */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg flex items-center gap-2">
              <History className="w-5 h-5 text-blue-600" />
              Transactions
            </h3>
            <button className="text-xs font-semibold text-blue-600 hover:underline">View All</button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden divide-y divide-slate-50">
            {(!transactions || transactions.length === 0) ? (
              <div className="p-8 text-center">
                <p className="text-sm text-slate-400">No transactions yet</p>
              </div>
            ) : (
              transactions.map((tx) => (
                <div key={tx.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-full ${
                      tx.status === "SUCCESS" 
                        ? (tx.type === "FUNDING" ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600") 
                        : tx.status === "PENDING" ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-400"
                    }`}>
                      {tx.type === "FUNDING" ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                    </div>
                    <div>
                      <p className="text-sm font-bold truncate max-w-[150px]">{tx.description}</p>
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] text-slate-400">
                          {tx.createdAt?.toDate ? tx.createdAt.toDate().toLocaleDateString() : "Just now"}
                        </p>
                        <span className="text-[10px] text-slate-300">•</span>
                        <div 
                          title={
                            tx.status === "PENDING" ? "Transfer is being processed by the bank. Please wait." : 
                            tx.status === "SUCCESS" ? "Transaction successfully completed." : 
                            "Transaction failed. Any deducted funds will be reversed."
                          }
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider cursor-help ${
                            tx.status === "SUCCESS" ? "bg-green-50 text-green-700" :
                            tx.status === "PENDING" ? "bg-amber-50 text-amber-700 animate-pulse" :
                            "bg-red-50 text-red-700"
                          }`}
                        >
                          {tx.status === "PENDING" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                          {tx.status}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold ${
                      tx.type === "FUNDING" ? "text-green-600" : "text-slate-900"
                    }`}>
                      {tx.type === "FUNDING" ? "+" : "-"}₦{tx.amount.toLocaleString()}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* Fund Modal */}
      <AnimatePresence>
        {isFundModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsFundModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white w-full max-w-sm rounded-3xl p-6 relative z-10 shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold">Fund Wallet</h3>
                <button onClick={() => setIsFundModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <Plus className="w-6 h-6 rotate-45" />
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Amount (₦)</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-slate-400">₦</span>
                    <input 
                      type="number" 
                      value={fundAmount}
                      onChange={(e) => setFundAmount(e.target.value)}
                      placeholder="Min 100"
                      className="w-full bg-slate-50 border border-slate-100 rounded-xl py-4 pl-10 pr-4 font-bold text-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                </div>

                <div className="p-4 bg-blue-50 rounded-xl border border-blue-100 flex items-start gap-3">
                  <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0" />
                  <p className="text-[10px] text-blue-800 leading-relaxed">
                    Payments are securely processed by Paystack. Your card details are never stored on Unipay.
                  </p>
                </div>

                <button 
                  onClick={handleFundWallet}
                  disabled={fundingLoading}
                  className="w-full bg-blue-600 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all flex items-center justify-center gap-2"
                >
                  {fundingLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <CreditCard className="w-5 h-5" />
                      Proceed to Checkout
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Send Money Modal */}
      <AnimatePresence>
        {isSendModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSendModalOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white w-full max-w-sm rounded-3xl p-6 relative z-10 shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold">Send Money</h3>
                <button onClick={() => setIsSendModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <Plus className="w-6 h-6 rotate-45" />
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider ml-1">Select Bank</label>
                  <select 
                    value={recipientBank}
                    onChange={(e) => setRecipientBank(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 px-4 font-medium text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  >
                    <option value="">Choose a bank</option>
                    {banks.map(bank => (
                      <option key={bank.code} value={bank.code}>{bank.name}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider ml-1">Account Number</label>
                  <input 
                    type="text" 
                    maxLength={10}
                    value={recipientAccount}
                    onChange={(e) => setRecipientAccount(e.target.value.replace(/\D/g, ""))}
                    placeholder="10 digit account number"
                    className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 px-4 font-bold text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                  {isVerifying ? (
                    <p className="text-[10px] text-blue-500 animate-pulse mt-1">Verifying account...</p>
                  ) : recipientName ? (
                    <p className="text-[10px] text-green-600 font-bold mt-1">Verified: {recipientName}</p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider ml-1">Amount (₦)</label>
                  <input 
                    type="number" 
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    placeholder="Amount to send"
                    className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 px-4 font-bold text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider ml-1">Narration (Optional)</label>
                  <input 
                    type="text" 
                    value={transferNarration}
                    onChange={(e) => setTransferNarration(e.target.value)}
                    placeholder="What is this for?"
                    className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>

                <div className="pt-2">
                  <button 
                    onClick={handleSendMoney}
                    disabled={transferLoading || !recipientName || isVerifying}
                    className="w-full bg-slate-900 text-white font-bold py-4 rounded-xl shadow-lg hover:bg-slate-800 disabled:bg-slate-200 disabled:shadow-none transition-all flex items-center justify-center gap-2"
                  >
                    {transferLoading ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <>
                        <ArrowUpRight className="w-5 h-5" />
                        Send Money
                      </>
                    )}
                  </button>
                </div>

                <p className="text-[10px] text-center text-slate-400">
                  Transactions are final once initiated. Ensure recipient details are correct.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
