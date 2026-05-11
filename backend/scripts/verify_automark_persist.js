#!/usr/bin/env node
/**
 * Verify AutoMark persistence for a specific submission.
 *
 * Usage:
 *   node scripts/verify_automark_persist.js --submissionId <id>
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), override: true });

const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");

function parseArgs(argv) {
  const out = { submissionId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--submissionId") out.submissionId = argv[++i];
  }
  return out;
}

async function main() {
  const { submissionId } = parseArgs(process.argv);
  if (!submissionId) {
    console.error("Usage: node scripts/verify_automark_persist.js --submissionId <id>");
    process.exit(1);
  }

  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) throw new Error("Missing MONGO_URI in backend/.env");

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });

  const sub = await Submission.findById(String(submissionId)).lean();
  const raw = await SubmissionRaw.findOne({ submissionId: String(submissionId) }).lean();

  console.log("=== Submission ===");
  console.log({
    _id: sub?._id,
    status: sub?.status,
    grade: sub?.grade,
    maxGrade: sub?.maxGrade,
    aiGradingSuggestion: sub?.aiGradingSuggestion,
    aiConfidence: sub?.aiConfidence,
    needsTeacherReview: sub?.needsTeacherReview,
  });

  console.log("\n=== SubmissionRaw ===");
  console.log({
    _id: raw?._id,
    submissionId: raw?.submissionId,
    automarkStatus: raw?.automarkStatus,
    automarkError: raw?.automarkError,
    perQuestionScoresCount: Array.isArray(raw?.perQuestionScores) ? raw.perQuestionScores.length : 0,
    totalAwardedMarks: raw?.totalAwardedMarks,
    hasAutomarkReport: Boolean(raw?.automarkReport),
    reportNeedsReview: Boolean(raw?.automarkReport?.needsTeacherReview),
    reportNeedsReviewCount: raw?.automarkReport?.needsTeacherReviewCount ?? null,
    reportConfidence: raw?.automarkReport?.confidence ?? null,
  });

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("❌ FAILED:", e?.message || String(e));
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

