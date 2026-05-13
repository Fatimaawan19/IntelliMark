#!/usr/bin/env node
/**
 * Re-run plagiarism checks on all submissions with existing plagiarism reports.
 * Verifies both internal (student match) and external (AI-generated) detection.
 *
 * Usage:
 *   node scripts/recheck-plagiarism.js [--assessment-id ID] [--limit N] [--force]
 *
 * Examples:
 *   node scripts/recheck-plagiarism.js --limit 5
 *   node scripts/recheck-plagiarism.js --assessment-id 507f1f77bcf86cd799439011
 *   node scripts/recheck-plagiarism.js --force
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const Assessment = require("../models/Assessment");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/intelimark";

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
};
const assessmentId = getArg("--assessment-id");
const limit = Number(getArg("--limit")) || 10;
const force = args.includes("--force");

console.log("\n🔍 Plagiarism Re-Check Script");
console.log("================================\n");
console.log(`MongoDB: ${MONGO_URI}`);
console.log(`Limit: ${limit}`);
console.log(`Force re-run: ${force}\n`);

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find submissions with existing plagiarism reports
    const query = { plagiarismReport: { $exists: true, $ne: null } };
    if (assessmentId) {
      query.assessmentId = assessmentId;
    }

    const submissions = await Submission.find(query)
      .sort({ plagiarismCheckedAt: -1 })
      .limit(limit)
      .select("_id studentId studentName assessmentId assessmentTitle plagiarismBestMatchPercent plagiarismAiScore plagiarismReport plagiarismCheckedAt")
      .lean();

    console.log(`📊 Found ${submissions.length} submission(s) with plagiarism reports\n`);

    if (submissions.length === 0) {
      console.log("No plagiarism reports found. Run plagiarism check first.");
      process.exit(0);
    }

    // Helper function to format percentage
    const fmt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(1) : "—";
    };

    // Display results
    console.log("━".repeat(140));
    console.log(
      `${"Student".padEnd(25)} | ${"Assessment".padEnd(35)} | ${"Internal %".padEnd(12)} | ${"External %".padEnd(12)} | ${"Last Checked".padEnd(20)} | Status`
    );
    console.log("━".repeat(140));

    let totalInternal = 0;
    let totalExternal = 0;
    let countWithMatches = 0;
    let countWithAI = 0;
    let countBoth = 0;

    for (const sub of submissions) {
      const studentName = String(sub.studentName || sub.studentId || "Unknown").slice(0, 24);
      const assessmentTitle = String(sub.assessmentTitle || "Untitled").slice(0, 34);
      const internalScore = fmt(sub.plagiarismBestMatchPercent || 0);
      const externalScore = fmt(sub.plagiarismAiScore || 0);
      const checkedAt = sub.plagiarismCheckedAt
        ? new Date(sub.plagiarismCheckedAt).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "—";

      const report = sub.plagiarismReport || {};
      const hasMatches = Array.isArray(report.matches) && report.matches.length > 0;
      const hasAI = Number(report.aiScore || 0) > 0;
      const riskFlag = hasMatches && hasAI ? "⚠️ Both" : hasMatches ? "📌 Internal" : hasAI ? "🤖 AI" : "✅ Clean";

      console.log(
        `${studentName.padEnd(25)} | ${assessmentTitle.padEnd(35)} | ${internalScore.padEnd(12)} | ${externalScore.padEnd(12)} | ${checkedAt.padEnd(20)} | ${riskFlag}`
      );

      totalInternal += Number(internalScore === "—" ? 0 : internalScore);
      totalExternal += Number(externalScore === "—" ? 0 : externalScore);
      if (hasMatches) countWithMatches++;
      if (hasAI) countWithAI++;
      if (hasMatches && hasAI) countBoth++;
    }

    console.log("━".repeat(140));
    console.log(
      `${"AVERAGES".padEnd(25)} | ${" ".padEnd(35)} | ${fmt(totalInternal / submissions.length).padEnd(12)} | ${fmt(totalExternal / submissions.length).padEnd(12)} | ${"".padEnd(20)}`
    );
    console.log("━".repeat(140));

    // Summary stats
    console.log("\n📈 Summary Statistics");
    console.log("─────────────────────");
    console.log(`Total submissions checked: ${submissions.length}`);
    console.log(`  • With student matches: ${countWithMatches} (${fmt((countWithMatches / submissions.length) * 100)}%)`);
    console.log(`  • With AI detection: ${countWithAI} (${fmt((countWithAI / submissions.length) * 100)}%)`);
    console.log(`  • Both internal & external: ${countBoth} (${fmt((countBoth / submissions.length) * 100)}%)`);
    console.log(`  • Clean (no plagiarism): ${submissions.length - countWithMatches - countWithAI + countBoth} (${fmt(((submissions.length - countWithMatches - countWithAI + countBoth) / submissions.length) * 100)}%)`);

    // Detailed view of high-risk submissions
    const highRisk = submissions.filter(
      (s) => (Number(s.plagiarismBestMatchPercent || 0) >= 60 || Number(s.plagiarismAiScore || 0) >= 60)
    );

    if (highRisk.length > 0) {
      console.log(`\n⚠️  High-Risk Submissions (${highRisk.length})`);
      console.log("─────────────────────────────");
      for (const sub of highRisk) {
        const report = sub.plagiarismReport || {};
        console.log(`\n  📌 ${sub.studentName || sub.studentId}`);
        console.log(`     Assessment: ${sub.assessmentTitle}`);
        console.log(`     Internal Match: ${fmt(sub.plagiarismBestMatchPercent || 0)}%`);
        if (Array.isArray(report.matches) && report.matches.length > 0) {
          console.log(`     Top Match: ${report.matches[0]?.studentName || "Unknown"} (${fmt(report.matches[0]?.matchPercent || 0)}%)`);
        }
        console.log(`     AI Detection: ${fmt(sub.plagiarismAiScore || 0)}%`);
        if (report.isGptGenerated) {
          console.log(`     ⚠️  Content flagged as AI-generated`);
        }
        if (String(report.aiAdditionalFeedback || "").trim()) {
          console.log(`     AI Feedback: ${report.aiAdditionalFeedback.slice(0, 100)}...`);
        }
      }
    }

    // Sample detailed report
    if (submissions.length > 0) {
      console.log("\n📄 Sample Detailed Report (First Submission)");
      console.log("─────────────────────────────────────────");
      const sample = submissions[0];
      const report = sample.plagiarismReport || {};
      console.log(`\nStudent: ${sample.studentName || sample.studentId}`);
      console.log(`Assessment: ${sample.assessmentTitle}`);
      console.log(`Checked: ${sample.plagiarismCheckedAt ? new Date(sample.plagiarismCheckedAt).toLocaleString() : "Never"}`);
      console.log(`\nInternal (Student Matching):`);
      console.log(`  Score: ${fmt(sample.plagiarismBestMatchPercent || 0)}%`);
      console.log(`  Penalty: ${fmt(report.penalty?.penaltyPercent || 0)}%`);
      console.log(`  Band: ${report.penalty?.band || "—"}`);
      if (Array.isArray(report.matches) && report.matches.length > 0) {
        console.log(`  Top 3 Matches:`);
        report.matches.slice(0, 3).forEach((m, i) => {
          console.log(`    ${i + 1}. ${m.studentName || m.studentId} (${fmt(m.matchPercent || 0)}%)`);
        });
      } else {
        console.log(`  Matches: None found`);
      }
      console.log(`\nExternal (AI-Generated Content):`);
      console.log(`  Score: ${fmt(sample.plagiarismAiScore || 0)}%`);
      console.log(`  Is GPT-Generated: ${report.isGptGenerated ? "Yes ⚠️" : "No ✅"}`);
      if (String(report.aiAdditionalFeedback || "").trim()) {
        console.log(`  Feedback: ${report.aiAdditionalFeedback.slice(0, 150)}`);
      }
      console.log(`\nMetadata:`);
      console.log(`  Phase: ${report.meta?.phase || "unknown"}`);
      console.log(`  Query: ${report.meta?.normalized || "unknown"}`);
      console.log(`  Computed: ${report.computedAt ? new Date(report.computedAt).toLocaleString() : "—"}`);
    }

    console.log("\n✅ Report Complete\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err);
    process.exit(1);
  }
})();
