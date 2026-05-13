// routes/otpRoutes.js — Email-based 2FA OTP
const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();

// In-memory OTP store (key: email, value: { code, expiresAt })
const otpStore = new Map();

// OTP config
const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Generate random OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Create email transporter
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.OTP_EMAIL_USER,
      pass: process.env.OTP_EMAIL_PASS,
    },
  });
}

// ==================== SEND OTP ====================
router.post('/send', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    // Generate OTP
    const code = generateOTP();
    const expiresAt = Date.now() + OTP_EXPIRY_MS;

    // Store OTP
    otpStore.set(email.toLowerCase(), { code, expiresAt, attempts: 0 });

    // Send email
    const transporter = createTransporter();

    const mailOptions = {
      from: `"IntelliMark 2FA" <${process.env.OTP_EMAIL_USER}>`,
      to: email,
      subject: 'IntelliMark - Your Login OTP Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 30px; background: #f8f9fa; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #7c3aed; margin: 0; font-size: 28px;">IntelliMark</h1>
            <p style="color: #6b7280; font-size: 14px; margin-top: 4px;">AI Powered Assessment System</p>
          </div>

          <div style="background: white; padding: 24px; border-radius: 8px; text-align: center;">
            <h2 style="color: #1f2937; font-size: 20px; margin: 0 0 8px;">Login Verification</h2>
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 20px;">Use the code below to complete your login</p>

            <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; letter-spacing: 8px; font-size: 32px; font-weight: bold; color: #7c3aed;">
              ${code}
            </div>

            <p style="color: #9ca3af; font-size: 12px; margin-top: 16px;">
              This code expires in 5 minutes. Do not share it with anyone.
            </p>
          </div>

          <p style="color: #9ca3af; font-size: 11px; text-align: center; margin-top: 16px;">
            If you did not request this code, please ignore this email.
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    console.log(`✅ OTP sent to ${email}`);

    res.json({ success: true, message: 'OTP sent successfully' });

  } catch (err) {
    console.error('❌ OTP send error:', err.message);
    console.error('   Code:', err.code);
    console.error('   Response:', err.response);
    console.error('   Email User:', process.env.OTP_EMAIL_USER);
    console.error('   Email Pass length:', process.env.OTP_EMAIL_PASS?.length || 'NOT SET');
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP. Please try again.',
    });
  }
});

// ==================== VERIFY OTP ====================
router.post('/verify', (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and OTP code are required' });
    }

    const stored = otpStore.get(email.toLowerCase());

    if (!stored) {
      return res.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' });
    }

    // Check expiry
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(email.toLowerCase());
      return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
    }

    // Check attempts (max 5)
    if (stored.attempts >= 5) {
      otpStore.delete(email.toLowerCase());
      return res.status(400).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
    }

    // Verify code
    if (stored.code !== code) {
      stored.attempts += 1;
      return res.status(400).json({ success: false, message: 'Invalid OTP. Please try again.' });
    }

    // Success — remove OTP
    otpStore.delete(email.toLowerCase());

    console.log(`✅ OTP verified for ${email}`);

    res.json({ success: true, message: 'OTP verified successfully' });

  } catch (err) {
    console.error('❌ OTP verify error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

module.exports = router;
