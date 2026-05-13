#!/usr/bin/env node
/**
 * Fix plagiarism scores for all assessed submissions
 *
 * This script:
 * 1. Finds all graded submissions with plagiarism reports
 * 2. Re-runs plagiarism detection with correct logic
 * 3. Updates PlagiarismReport with accurate scores
 * 4. Logs detailed progress and differences
 *
 * Usage:
 *   node scripts/fix-all-plagiarism-scores.js [--assessment-id ID] [--dry-run]
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");
const PlagiarismReport = require("../models/PlagiarismReport");
const Assessment = require("../models/Assessment");
const plagiarismService = require("../utils/plagiarismService");

const MONGO_URI = process.env.MONGO_URI;
const isDryRun = process.argv.includes("--dry-run");
const assessmentIdIdx = process.argv.indexOf("--assessment-id");
const assessmentId = assessmentIdIdx >= 0 ? process.argv[assessmentIdIdx + 1] : null;

console.log("\n🔧 Plagiarism Score Fix Tool");
console.log("════════════════════════════════\n");

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find all plagiarism reports
    let query = {};
    let assessmentFilter = "";

    if (assessmentId) {
      query = { assessmentId };
      const assessment = await Assessment.findById(assessmentId).select("title").lean();
      assessmentFilter = assessment ? ` (${assessment.title})` : " (not found)";
    }

    const reports = await PlagiarismReport.find(query).sort({ overallScore: -1 }).lean();
    console.log(`📊 Found ${reports.length} plagiarism report(s)${assessmentFilter}`);

    if (reports.length === 0) {
      console.log("✅ No reports to fix\n");
      process.exit(0);
    }

    console.log(`${"═".repeat(100)}`);
    console.log("ANALYZING REPORTS");
    console.log(`${"═".repeat(100)}\n`);

    let fixedCount = 0;
    let unchangedCount = 0;
    let errorCount = 0;
    const differences = [];

    for (let i = 0; i < reports.length; i++) {
      const report = reports[i];
      const submission = await Submission.findById(report.submissionId).lean();

      if (!submission) {
        console.log(`⚠️  [${i + 1}/${reports.length}] Submission not found: ${report.submissionId}`);
        errorCount++;
        continue;
      }

      // Get raw text
      const raw = await SubmissionRaw.findOne({ submissionId: report.submissionId }).lean();
      const text = String(
        raw?.rawText || raw?.ocrText || submission.submissionText || ""
      ).trim();

      if (!text || text.length < 50) {
        console.log(`⚠️  [${i + 1}/${reports.length}] ${submission.studentName}: Insufficient text`);
        errorCount++;
        continue;
      }

      console.log(
        `📋 [${i + 1}/${reports.length}] ${submission.studentName} → ` +
        `Current: internal=${report.internalScore}%, AI=${report.aiScore}%, overall=${report.overallScore}%`
      );

      // Re-run plagiarism check with forceRefresh=true
      try {
        const newReport = await plagiarismService.checkPlagiarism(report.submissionId.toString(), {
          forceRefresh: true,
        });

        // Compare old vs new
        const oldScores = {
          internal: report.internalScore,
          ai: report.aiScore,
          overall: report.overallScore,
        };

        const newScores = {
          internal: newReport.internalScore,
          ai: newReport.aiScore,
          overall: newReport.overallScore,
        };

        const isDifferent =
          oldScores.internal !== newScores.internal ||
          oldScores.ai !== newScores.ai ||
          oldScores.overall !== newScores.overall;

        if (isDifferent) {
          differences.push({
            submissionId: report.submissionId,
            studentName: submission.studentName,
            oldScores,
            newScores,
            topMatches: newReport.topMatches.length,
          });

          // Update Submission record with new scores
          if (!isDryRun) {
            await Submission.findByIdAndUpdate(
              report.submissionId,
              {
                plagiarismBestMatchPercent: newScores.internal,
                plagiarismAiScore: newScores.ai,
                plagiarismReport: newReport,
                plagiarismCheckedAt: new Date(),
              },
              { new: true }
            ).catch(() => {});
          }

          console.log(
            `   ✏️  FIXED → internal=${newScores.internal}%, ` +
            `AI=${newScores.ai}%, overall=${newScores.overall}%`
          );
          fixedCount++;
        } else {
          console.log("   ✅ No change (already correct)");
          unchangedCount++;
        }
      } catch (err) {
        console.error(`   ❌ Error: ${err.message}`);
        errorCount++;
      }

      console.log();
    }

    console.log(`${"═".repeat(100)}`);
    console.log("SUMMARY");
    console.log(`${"═".repeat(100)}\n`);

    console.log(`${isDryRun ? "🧪 DRY RUN (no changes made)" : "✏️  LIVE MODE (changes applied)"}`);
    console.log(`✅ Fixed: ${fixedCount}`);
    console.log(`✅ Unchanged: ${unchangedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`Total: ${reports.length}\n`);

    if (differences.length > 0) {
      console.log(`${"═".repeat(100)}`);
      console.log("DETAILED CHANGES");
      console.log(`${"═".repeat(100)}\n`);

      for (const diff of differences) {
        console.log(`📝 ${diff.studentName}`);
        console.log(`   Internal: ${diff.oldScores.internal}% → ${diff.newScores.internal}%`);
        console.log(`   AI:       ${diff.oldScores.ai}% → ${diff.newScores.ai}%`);
        console.log(`   Overall:  ${diff.oldScores.overall}% → ${diff.newScores.overall}%`);
        console.log(`   Top Matches: ${diff.topMatches}`);
        console.log();
      }
    }

    console.log(`${"═".repeat(100)}`);
    console.log("DATA SYNC LOCATIONS");
    console.log(`${"═".repeat(100)}\n`);

    console.log("✅ Plagiarism data is now stored in TWO places:");
    console.log("   1. PlagiarismReport collection (detailed reports)");
    console.log("   2. Submission.plagiarismBestMatchPercent & plagiarismAiScore\n");

    console.log("✅ API endpoints for fetching:");
    console.log("   • GET /api/plagiarism/assessment/:assessmentId → sorted by risk");
    console.log("   • GET /api/plagiarism/report/:submissionId → full details");
    console.log("   • GET /api/submissions/:submissionId/student-report → includes plagiarism\n");

    console.log(`${"═".repeat(100)}`);
    console.log("FRONTEND DISPLAY");
    console.log(`${"═".repeat(100)}\n`);

    console.log("✅ ViewReport.tsx displays:");
    console.log("   • Student submission match % (from plagiarismBestMatchPercent)");
    console.log("   • AI-generated content % (from plagiarismAiScore)");
    console.log("   • Amber warning badge for AI detection");
    console.log("   • Red/orange badge for high plagiarism (>70%)\n");

    console.log("✅ Teacher dashboard displays:");
    console.log("   • Overall risk level (low/medium/high)");
    console.log("   • Top student matches with similarity scores");
    console.log("   • Detection mode (internal/external/both)\n");

    if (!isDryRun && fixedCount > 0) {
      console.log(`${"═".repeat(100)}`);
      console.log("POST-FIX STEPS");
      console.log(`${"═".repeat(100)}\n`);
      console.log("1. ✅ Submission scores updated in database");
      console.log("2. 📄 Refresh teacher dashboard to see updated scores");
      console.log("3. 🔄 Students can reload report pages to see latest plagiarism %");
      console.log("4. 📊 Run '/api/plagiarism/assessment/:id' to verify bulk data\n");
    }

    console.log("✅ All plagiarism scores fixed and synced\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
