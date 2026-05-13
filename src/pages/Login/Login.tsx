import { useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "@/components/ui/input-otp";
import { GraduationCap, ShieldCheck, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import loginImage from "../../../robot.jfif";

import { auth, db } from "../../firebase";

import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from "firebase/auth";

import {
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
} from "firebase/firestore";

import { trackUserLogin } from "../../utils/loginTracker";

// Backend API base URL
const API_BASE = "http://localhost:5000/api";

export default function Login() {
  const navigate = useNavigate();
  const { toast } = useToast();

  // 🔐 OTP STATE
  const [showOtp, setShowOtp] = useState(false);
  const [otp, setOtp] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);

  // 🔑 Persist login info across re-renders
  const [pendingLogin, setPendingLogin] = useState<{
    email: string;
    role: string;
    user: any;
  } | null>(null);

  // 🔥 TIMER
  const [timer, setTimer] = useState(60);
  const [canResend, setCanResend] = useState(false);

  // -------------------------
  // TIMER LOGIC
  // -------------------------
  useEffect(() => {
    let interval: any;

    if (showOtp && timer > 0) {
      interval = setInterval(() => {
        setTimer((t) => t - 1);
      }, 1000);
    }

    if (timer === 0) setCanResend(true);

    return () => clearInterval(interval);
  }, [timer, showOtp]);

  // -------------------------
  // TRUSTED DEVICE
  // -------------------------
  const saveTrustedDevice = (uid: string) => {
    localStorage.setItem(
      "trusted_device",
      JSON.stringify({ uid, time: Date.now() })
    );
  };

  const checkTrustedDevice = (uid: string) => {
    const data = localStorage.getItem("trusted_device");
    if (!data) return false;

    const parsed = JSON.parse(data);

    return (
      parsed.uid === uid &&
      Date.now() - parsed.time < 7 * 24 * 60 * 60 * 1000
    );
  };

  // -------------------------
  // POST LOGIN (after OTP verified)
  // -------------------------
  const postLoginFlow = async (user: any, email: string, selectedRole: string) => {
    const usersRef = collection(db, "users");
    const q = query(usersRef, where("email", "==", email));
    const snap = await getDocs(q);

    let actualRole = "";

    if (!snap.empty) {
      const userData = snap.docs[0].data();
      actualRole = userData.role;
    } else {
      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        email,
        role: selectedRole,
        createdAt: new Date().toISOString(),
        displayName: email.split("@")[0],
      });
      actualRole = selectedRole;
    }

    // Validate: selected role must match actual role in Firestore
    if (actualRole !== selectedRole) {
      await auth.signOut();
      toast({
        variant: "destructive",
        title: "Access Denied",
        description: `Your account is registered as "${actualRole}". Please select the correct role.`,
      });
      return;
    }

    await trackUserLogin(user.uid, email);

    if (actualRole === "student") navigate("/student-dashboard");
    else if (actualRole === "teacher") navigate("/teacher-dashboard");
    else navigate("/admin-dashboard");
  };

  // -------------------------
  // SEND EMAIL OTP
  // -------------------------
  const sendEmailOtp = async (email: string) => {
    setSendingOtp(true);
    try {
      const res = await fetch(`${API_BASE}/otp/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Failed to send OTP");
      }

      setShowOtp(true);
      setTimer(60);
      setCanResend(false);
      setOtp("");

      toast({
        title: "OTP Sent",
        description: "Check your email for the 6-digit code.",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "OTP Error",
        description: err.message || "Failed to send OTP. Please try again.",
      });
    } finally {
      setSendingOtp(false);
    }
  };

  // -------------------------
  // LOGIN
  // -------------------------
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    const form = e.target as HTMLFormElement;

    const email = (form.elements.namedItem("email") as HTMLInputElement)
      .value.toLowerCase().trim();

    const password = (form.elements.namedItem("password") as HTMLInputElement)
      .value;

    const role = (form.elements.namedItem("role") as HTMLSelectElement)
      .value;

    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      const user = result.user;

      // Validate role BEFORE sending OTP
      const usersRef = collection(db, "users");
      const q = query(usersRef, where("email", "==", email));
      const snap = await getDocs(q);

      if (!snap.empty) {
        const userData = snap.docs[0].data();
        const actualRole = userData.role;

        if (actualRole !== role) {
          await auth.signOut();
          toast({
            variant: "destructive",
            title: "Access Denied",
            description: `Your account is registered as "${actualRole}". Please select the correct role.`,
          });
          return;
        }
      }

      // If trusted device, skip 2FA
      if (checkTrustedDevice(user.uid)) {
        await postLoginFlow(user, email, role);
        return;
      }

      // All correct — save login info and send OTP
      setPendingLogin({ email, role, user });
      await sendEmailOtp(email);

    } catch (err: any) {
      // If admin role selected and login failed, redirect to registration page
      if (role === "admin" && (
        err.code === "auth/wrong-password" ||
        err.code === "auth/user-not-found" ||
        err.code === "auth/invalid-credential"
      )) {
        toast({
          title: "Redirecting to Registration",
          description: "Admin account not found. Redirecting to registration page.",
        });
        navigate("/admin-register");
        return;
      }

      toast({
        variant: "destructive",
        title: "Login Failed",
        description: err.message,
      });
    }
  };

  // -------------------------
  // VERIFY OTP
  // -------------------------
  const verifyOtp = async () => {
    if (!pendingLogin || otp.length < 6) return;

    setVerifying(true);

    try {
      const res = await fetch(`${API_BASE}/otp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: pendingLogin.email,
          code: otp,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Invalid OTP");
      }

      // OTP verified — save trusted device and proceed
      saveTrustedDevice(pendingLogin.user.uid);
      await postLoginFlow(pendingLogin.user, pendingLogin.email, pendingLogin.role);

      setShowOtp(false);
      setOtp("");

      toast({
        title: "Success",
        description: "2FA Verified",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Verification Failed",
        description: err.message,
      });
    } finally {
      setVerifying(false);
    }
  };

  // -------------------------
  // RESEND OTP
  // -------------------------
  const resendOtp = async () => {
    if (!canResend || !pendingLogin) return;
    await sendEmailOtp(pendingLogin.email);
  };

  // -------------------------
  // PASSWORD RESET
  // -------------------------
  const handleForgotPassword = async () => {
    const emailInput =
      document.querySelector<HTMLInputElement>("#login-email");

    const email = emailInput?.value?.trim().toLowerCase();

    if (!email) {
      toast({
        variant: "destructive",
        title: "Email Required",
        description: "Please enter your email address first, then click Forgot Password.",
      });
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);

      toast({
        title: "Email Sent",
        description: "Check your email account",
      });
    } catch (err: any) {
      let message = err.message || "Something went wrong. Please try again.";

      if (err.code === "auth/user-not-found") {
        message = "No account found with this email address.";
      } else if (err.code === "auth/invalid-email") {
        message = "Please enter a valid email address.";
      } else if (err.code === "auth/too-many-requests") {
        message = "Too many attempts. Please wait a few minutes and try again.";
      }

      toast({
        variant: "destructive",
        title: "Password Reset Failed",
        description: message,
      });
    }
  };

  // -------------------------
  // UI
  // -------------------------
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50">

      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-xl overflow-hidden">

        <div className="grid md:grid-cols-2">

          {/* LEFT IMAGE SECTION */}
          <div className="hidden md:block relative">
            <img
              src={loginImage}
              className="h-full w-full object-cover"
              alt="login"
            />

            {/* Overlay */}
            <div className="absolute bottom-0 bg-white/90 p-6 w-full">
              <h2 className="text-xl font-bold text-gray-900">
                Smarter Assessment with AI
              </h2>
              <p className="text-sm text-gray-600 mt-2">
                IntelliMark helps automate grading, feedback, and analytics
              </p>
            </div>
          </div>

          {/* RIGHT FORM SECTION */}
          <div className="p-8 flex flex-col justify-center">

            {/* BRANDING */}
            <div className="text-center mb-4">
              <h1 className="text-3xl font-bold text-purple-600">
                IntelliMark
              </h1>
              <p className="text-sm text-gray-500">
                AI Powered Assessment System
              </p>
            </div>

            <div className="flex items-center justify-center mb-6 gap-2">
              <GraduationCap className="text-purple-600" />
              <h2 className="text-xl font-semibold">Login</h2>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">

              <div>
                <Label>Email</Label>
                <Input id="login-email" name="email" required />
              </div>

              <div>
                <Label>Password</Label>
                <Input name="password" type="password" required />
              </div>

              <div>
                <Label>Role</Label>
                <select name="role" className="w-full border p-2 rounded">
                  <option value="student">Student</option>
                  <option value="teacher">Teacher</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <Button className="w-full" disabled={sendingOtp}>
                {sendingOtp ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    Sending OTP...
                  </>
                ) : (
                  "Login"
                )}
              </Button>

              <Button
                type="button"
                variant="link"
                onClick={handleForgotPassword}
              >
                Forgot Password?
              </Button>
            </form>
          </div>
        </div>
      </div>

      {/* 🔐 OTP MODAL with shadcn InputOTP */}
      {showOtp && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">

          <div className="bg-white p-8 rounded-2xl w-[400px] text-center space-y-5 shadow-2xl animate-in fade-in zoom-in">

            <div className="flex justify-center">
              <div className="bg-purple-100 p-3 rounded-full">
                <ShieldCheck className="text-purple-600" size={28} />
              </div>
            </div>

            <h2 className="text-xl font-bold text-gray-900">2FA Verification</h2>

            <p className="text-sm text-gray-500">
              Enter the 6-digit code sent to<br />
              <strong className="text-gray-700">{pendingLogin?.email}</strong>
            </p>

            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={otp}
                onChange={(value) => setOtp(value)}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <Button
              onClick={verifyOtp}
              className="w-full"
              disabled={otp.length < 6 || verifying}
            >
              {verifying ? (
                <>
                  <Loader2 className="animate-spin mr-2" size={16} />
                  Verifying...
                </>
              ) : (
                "Verify & Login"
              )}
            </Button>

            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>
                {canResend ? "You can resend now" : `Resend in ${timer}s`}
              </span>
              <Button
                variant="link"
                size="sm"
                disabled={!canResend}
                onClick={resendOtp}
                className="text-xs p-0 h-auto"
              >
                Resend OTP
              </Button>
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowOtp(false);
                setOtp("");
                setPendingLogin(null);
                auth.signOut();
              }}
              className="text-gray-400 text-xs"
            >
              Cancel and go back
            </Button>

          </div>
        </div>
      )}
    </div>
  );
}