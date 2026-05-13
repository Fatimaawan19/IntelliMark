const express = require("express");
const adminController = require("../controllers/adminController");
const { admin, firestore } = require("../config/firebase");

const router = express.Router();

// Admin dashboard: academic performance aggregates from MongoDB
router.get("/academic-performance", adminController.getAcademicPerformance);

// Update user email/password in Firebase Auth + Firestore
router.put("/update-user/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const { email, password } = req.body;

    if (!uid) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    if (!email && !password) {
      return res.status(400).json({ success: false, message: "At least email or password must be provided" });
    }

    // Build update object for Firebase Auth
    const authUpdate = {};
    if (email) authUpdate.email = email.toLowerCase().trim();
    if (password) authUpdate.password = password;

    // Update Firebase Auth
    await admin.auth().updateUser(uid, authUpdate);
    console.log(`✅ Firebase Auth updated for user ${uid}`);

    // Update Firestore if email changed
    if (email) {
      const userRef = firestore.collection("users").doc(uid);
      await userRef.update({ email: email.toLowerCase().trim() });
      console.log(`✅ Firestore email updated for user ${uid}`);
    }

    res.json({
      success: true,
      message: `User updated successfully${email ? " (email" : ""}${email && password ? " + " : ""}${password ? "password" : ""}${email || password ? ")" : ""}`,
    });

  } catch (err) {
    console.error("❌ Update user error:", err.message);

    let message = "Failed to update user.";
    if (err.code === "auth/email-already-exists") {
      message = "This email is already used by another account.";
    } else if (err.code === "auth/invalid-email") {
      message = "Invalid email address.";
    } else if (err.code === "auth/weak-password" || (err.message && err.message.includes("password"))) {
      message = "Password must be at least 6 characters.";
    } else if (err.code === "auth/user-not-found") {
      message = "User not found in Firebase Auth.";
    }

    res.status(400).json({ success: false, message });
  }
});

module.exports = router;
