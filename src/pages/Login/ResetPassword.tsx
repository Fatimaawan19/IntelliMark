import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import { auth } from "../../firebase";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GraduationCap, Lock, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const oobCode = searchParams.get("oobCode");

  // Verify the reset code on page load
  useEffect(() => {
    const verifyCode = async () => {
      if (!oobCode) {
        setError("Invalid or missing password reset link. Please request a new one.");
        setVerifying(false);
        return;
      }

      try {
        const userEmail = await verifyPasswordResetCode(auth, oobCode);
        setEmail(userEmail);
        setVerifying(false);
      } catch (err: any) {
        setError(
          err.code === "auth/expired-action-code"
            ? "This password reset link has expired. Please request a new one."
            : err.code === "auth/invalid-action-code"
            ? "This password reset link is invalid or has already been used."
            : "Something went wrong. Please request a new password reset."
        );
        setVerifying(false);
      }
    };

    verifyCode();
  }, [oobCode]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword.length < 6) {
      toast({
        variant: "destructive",
        title: "Weak Password",
        description: "Password must be at least 6 characters long.",
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords Don't Match",
        description: "Please make sure both passwords are the same.",
      });
      return;
    }

    setLoading(true);

    try {
      await confirmPasswordReset(auth, oobCode!, newPassword);
      setSuccess(true);
      toast({
        title: "Password Reset Successful",
        description: "You can now log in with your new password.",
      });
    } catch (err: any) {
      let message = "Failed to reset password. Please try again.";

      if (err.code === "auth/expired-action-code") {
        message = "This reset link has expired. Please request a new one.";
      } else if (err.code === "auth/weak-password") {
        message = "Password is too weak. Please choose a stronger password.";
      }

      toast({
        variant: "destructive",
        title: "Reset Failed",
        description: message,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden p-8">

        {/* Branding */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-purple-600">IntelliMark</h1>
          <p className="text-sm text-gray-500">AI Powered Assessment System</p>
        </div>

        <div className="flex items-center justify-center mb-6 gap-2">
          <Lock className="text-purple-600" size={20} />
          <h2 className="text-xl font-semibold">Reset Password</h2>
        </div>

        {/* Loading / Verifying */}
        {verifying && (
          <div className="text-center py-8">
            <Loader2 className="animate-spin mx-auto text-purple-600 mb-3" size={32} />
            <p className="text-gray-500">Verifying your reset link...</p>
          </div>
        )}

        {/* Error State */}
        {!verifying && error && (
          <div className="text-center py-8 space-y-4">
            <XCircle className="mx-auto text-red-500" size={48} />
            <p className="text-red-600 font-medium">{error}</p>
            <Button onClick={() => navigate("/")} className="mt-4">
              Back to Login
            </Button>
          </div>
        )}

        {/* Success State */}
        {!verifying && success && (
          <div className="text-center py-8 space-y-4">
            <CheckCircle className="mx-auto text-green-500" size={48} />
            <p className="text-green-700 font-medium">
              Your password has been reset successfully!
            </p>
            <Button onClick={() => navigate("/")} className="mt-4">
              Go to Login
            </Button>
          </div>
        )}

        {/* Reset Form */}
        {!verifying && !error && !success && (
          <>
            <p className="text-sm text-gray-500 text-center mb-4">
              Resetting password for <strong>{email}</strong>
            </p>

            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <Label>New Password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                  required
                  minLength={6}
                />
              </div>

              <div>
                <Label>Confirm Password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                  minLength={6}
                />
              </div>

              <Button className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    Resetting...
                  </>
                ) : (
                  "Reset Password"
                )}
              </Button>
            </form>
          </>
        )}

        {/* Back to Login link */}
        {!success && (
          <div className="text-center mt-4">
            <Button variant="link" onClick={() => navigate("/")}>
              ← Back to Login
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
