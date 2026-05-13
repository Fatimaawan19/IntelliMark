#!/usr/bin/env node
/**
 * Force re-run plagiarism checks on submissions with existing reports.
 * Uses the HTTP API to test the updated plagiarism detection logic.
 *
 * Usage:
 *   node scripts/force-rerun-plagiarism.js [--limit N] [--assessment-id ID]
 *
 * Examples:
 *   node scripts/force-rerun-plagiarism.js --limit 5
 *   node scripts/force-rerun-plagiarism.js --assessment-id 507f1f77bcf86cd799439011
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const axios = require("axios");
const Submission = require("../models/Submission");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/intelimark";
const API_BASE = process.env.API_URL || "http://localhost:5000";

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};
const limit = Number(getArg("--limit")) || 5;
const assessmentId = getArg("--assessment-id");

console.log("\n🔄 Force Re-Run Plagiarism Check Script");
console.log("=======================================\n");
console.log(`API Base: ${API_BASE}`);
console.log(`Limit: ${limit}\n`);

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find submissions with existing plagiarism reports
    const query = { plagiarismReport: { $exists: true, $ne: null } };
    if (assessmentId) query.assessmentId = assessmentId;

    const submissions = await Submission.find(query)
      .sort({ plagiarismCheckedAt: -1 })
      .limit(limit)
      .select("_id studentId studentName assessmentId assessmentTitle plagiarismBestMatchPercent plagiarismAiScore plagiarismReport plagiarismCheckedAt")
      .lean();

    console.log(`📊 Found ${submissions.length} submission(s) to re-check\n`);

    if (submissions.length === 0) {
      console.log("No plagiarism reports found.");
      process.exit(0);
    }

    const fmt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(1) : "—";
    };

    // Helper to extract teacher ID (from assessment or use default)
    const getTeacherId = async (assessmentId) => {
      const Assessment = require("../models/Assessment");
      const assessment = await Assessment.findById(assessmentId).select("teacherId").lean();
      return assessment?.teacherId || "default-teacher";
    };

    console.log("🔄 Re-running plagiarism checks...\n");
    console.log("━".repeat(130));
    console.log(
      `${"Student".padEnd(25)} | ${"Old Internal".padEnd(13)} | ${"New Internal".padEnd(13)} | ${"Old AI %".padEnd(10)} | ${"New AI %".padEnd(10)} | Status`
    );
    console.log("━".repeat(130));

    const results = [];

    for (const sub of submissions) {
      try {
        const teacherId = await getTeacherId(sub.assessmentId);
        const oldReport = sub.plagiarismReport || {};
        const oldInternal = Number(sub.plagiarismBestMatchPercent || 0);
        const oldExternal = Number(sub.plagiarismAiScore || 0);

        // Call the plagiarism check endpoint with force=true
        const response = await axios.post(
          `${API_BASE}/api/submissions/${sub._id}/plagiarism-check`,
          { teacherId, force: true },
          { timeout: 30000 }
        );

        if (!response.data?.success) {
          throw new Error(response.data?.error || "API returned success: false");
        }

        const newData = response.data;
        const newInternal = Number(newData.bestMatchPercent || 0);
        const newExternal = Number(newData.aiScore || 0);
        const newMatches = Array.isArray(newData.matches) ? newData.matches.length : 0;
        const newPenalty = Number(newData.penalty?.penaltyPercent || 0);

        // Determine status
        let status = "✅";
        if (oldInternal !== newInternal || oldExternal !== newExternal) {
          status = "🔄 Updated";
        }
        if (oldInternal > 0 && newMatches === 0) {
          status = "⚠️ Mismatch";
        }

        console.log(
          `${(sub.studentName || sub.studentId).slice(0, 24).padEnd(25)} | ${fmt(oldInternal).padEnd(13)} | ${fmt(newInternal).padEnd(13)} | ${fmt(oldExternal).padEnd(10)} | ${fmt(newExternal).padEnd(10)} | ${status}`
        );

        results.push({
          studentId: sub.studentId,
          studentName: sub.studentName,
          assessmentId: sub.assessmentId,
          old: { internal: oldInternal, external: oldExternal, matches: (oldReport.matches || []).length, penalty: oldReport.penalty?.penaltyPercent },
          new: { internal: newInternal, external: newExternal, matches: newMatches, penalty: newPenalty },
          newReport: newData,
        });
      } catch (err) {
        console.log(`${(sub.studentName || sub.studentId).slice(0, 24).padEnd(25)} | ${"—".padEnd(13)} | ${"—".padEnd(13)} | ${"—".padEnd(10)} | ${"—".padEnd(10)} | ❌ ${err.message}`);
      }
    }

    console.log("━".repeat(130));

    // Detailed comparison
    console.log("\n📋 Detailed Comparison");
    console.log("─────────────────────\n");

    for (const result of results) {
      const changed = result.old.internal !== result.new.internal || result.old.external !== result.new.external;
      const icon = changed ? "🔄" : "✅";
      console.log(`${icon} ${result.studentName || result.studentId}`);
      console.log(`   Internal:  ${fmt(result.old.internal)}% → ${fmt(result.new.internal)}%${result.old.internal !== result.new.internal ? ` (${result.new.internal - result.old.internal > 0 ? "+" : ""}${result.new.internal - result.old.internal})` : ""}`);
      console.log(`   External:  ${fmt(result.old.external)}% → ${fmt(result.new.external)}%${result.old.external !== result.new.external ? ` (${result.new.external - result.old.external > 0 ? "+" : ""}${result.new.external - result.old.external})` : ""}`);
      console.log(`   Matches:   ${result.old.matches} → ${result.new.matches}${result.old.matches !== result.new.matches ? ` ${result.new.matches > result.old.matches ? "✅ More found" : "⚠️ Less found"}` : ""}`);
      console.log(`   Penalty:   ${fmt(result.old.penalty)}% → ${fmt(result.new.penalty)}%`);

      // Show new data details
      if (result.new.matches > 0) {
        console.log(`   Top Match: ${result.newReport.matches?.[0]?.studentName || "Unknown"} (${fmt(result.newReport.matches?.[0]?.matchPercent)}%)`);
      } else if (result.new.internal > 0) {
        console.log(`   ⚠️ WARNING: Internal score ${result.new.internal}% but no matches found!`);
      }

      if (result.new.external > 0) {
        const aiFlag = result.newReport.isGptGenerated ? " (GPT-Generated)" : "";
        console.log(`   AI Flag: ${result.new.external}%${aiFlag}`);
      }
      console.log();
    }

    // Summary
    const withInternal = results.filter((r) => r.new.internal > 0).length;
    const withExternal = results.filter((r) => r.new.external > 0).length;
    const withMatches = results.filter((r) => r.new.matches > 0).length;
    const mismatchFlag = results.filter((r) => r.new.internal > 0 && r.new.matches === 0).length;

    console.log("\n📊 Summary");
    console.log("──────────");
    console.log(`Total re-checked: ${results.length}`);
    console.log(`  • With internal matches: ${withInternal} (${fmt((withInternal / results.length) * 100)}%)`);
    console.log(`  • With external (AI): ${withExternal} (${fmt((withExternal / results.length) * 100)}%)`);
    console.log(`  • With actual match details: ${withMatches} (${fmt((withMatches / results.length) * 100)}%)`);
    if (mismatchFlag > 0) {
      console.log(`  ⚠️  MISMATCH: ${mismatchFlag} submission(s) have internal score but NO matches found!`);
    }

    console.log("\n✅ Force re-run complete\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
