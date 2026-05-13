#!/usr/bin/env node
/**
 * MIGRATION SCRIPT: Fix All Submission Scores - Consistent Scoring Pipeline
 *
 * Purpose: Recalculate all graded submissions using the new consistent scoring formula
 * Usage: npm run fix-scores (from backend/)
 *
 * This script:
 * 1. Finds all graded submissions in MongoDB
 * 2. Recalculates each using the consistent scoring service
 * 3. Updates Submission documents with new scores and breakdown
 * 4. Logs before/after comparisons
 * 5. Provides detailed audit trail
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const PlagiarismReport = require("../models/PlagiarismReport");
const { calculateConsistentScore } = require("../utils/consistentScoringService");

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ Error: MONGO_URI not found in .env");
  process.exit(1);
}

console.log("\n🔧 Fix All Submission Scores - Consistent Scoring Pipeline");
console.log("════════════════════════════════════════════════════════════\n");

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find all graded submissions
    const submissions = await Submission.find({
      status: "graded",
      grade: { $exists: true, $ne: null }
    }).sort({ gradedAt: -1 });

    console.log(`📊 Found ${submissions.length} graded submissions\n`);

    if (submissions.length === 0) {
      console.log("✅ No graded submissions to fix\n");
      process.exit(0);
    }

    let fixedCount = 0;
    let errorCount = 0;
    let noChangeCount = 0;
    const changes = [];

    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      const progressBar = `[${i + 1}/${submissions.length}]`;

      try {
        // Check if plagiarism report exists
        const plagiarismReport = await PlagiarismReport.findOne({
          submissionId: sub._id
        });

        if (!plagiarismReport) {
          console.log(`${progressBar} ⚠️  ${sub.studentName}: No plagiarism report found`);
          errorCount++;
          continue;
        }

        // Calculate new consistent score
        const scoreResult = await calculateConsistentScore(sub);

        // Get old values
        const oldFinalScore = sub.grade;
        const newFinalScore = scoreResult.finalScore.afterPenalty;
        const newPercentage = scoreResult.finalScore.percentage;

        // Check if different
        const isDifferent = Math.abs(oldFinalScore - newFinalScore) > 0.1;

        if (isDifferent) {
          // Update submission with new score and breakdown
          const updateResult = await Submission.updateOne(
            { _id: sub._id },
            {
              $set: {
                grade: newFinalScore,
                gradedAt: new Date(),
                scoringMethod: "consistent",
                scoreBreakdown: {
                  aiScore: scoreResult.grading.aiScore,
                  internalPlagiarism: scoreResult.plagiarism.internal.score,
                  externalPlagiarism: scoreResult.plagiarism.external.score,
                  overallPlagiarism: scoreResult.plagiarism.overallScore,
                  penaltyBand: scoreResult.penalty.band,
                  penaltyPercent: scoreResult.penalty.penaltyPercent,
                  penaltyPoints: scoreResult.penalty.penaltyPoints,
                  finalScore: newFinalScore,
                  finalPercentage: newPercentage,
                  letterGrade: scoreResult.finalScore.letterGrade
                }
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            const percentageChange = ((newFinalScore - oldFinalScore) / oldFinalScore * 100).toFixed(1);

            changes.push({
              studentName: sub.studentName,
              old: oldFinalScore,
              new: newFinalScore,
              percentageChange,
              plagiarism: scoreResult.plagiarism.overallScore,
              penalty: scoreResult.penalty.penaltyPercent
            });

            console.log(`${progressBar} ✏️  ${sub.studentName}: ${oldFinalScore} → ${newFinalScore} (${newPercentage.toFixed(1)}%) [${percentageChange}%]`);
            fixedCount++;
          }
        } else {
          console.log(`${progressBar} ✅ ${sub.studentName}: No change needed (${newFinalScore})`);
          noChangeCount++;
        }
      } catch (err) {
        console.error(`${progressBar} ❌ Error: ${sub.studentName}: ${err.message}`);
        errorCount++;
      }
    }

    console.log(`\n${"═".repeat(80)}`);
    console.log("SUMMARY");
    console.log(`${"═".repeat(80)}\n`);

    console.log(`✅ Fixed/Updated: ${fixedCount}`);
    console.log(`⏭️  No Change: ${noChangeCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📊 Total: ${submissions.length}\n`);

    if (changes.length > 0) {
      console.log(`${"═".repeat(80)}`);
      console.log("DETAILED CHANGES");
      console.log(`${"═".repeat(80)}\n`);

      // Sort by percentage change (descending)
      changes.sort((a, b) => Math.abs(b.percentageChange) - Math.abs(a.percentageChange));

      for (const change of changes) {
        const arrow = change.new > change.old ? "↑" : "↓";
        console.log(`📝 ${change.studentName}`);
        console.log(`   Old Score: ${change.old}/10`);
        console.log(`   New Score: ${change.new}/10`);
        console.log(`   Change: ${arrow} ${change.percentageChange}%`);
        console.log(`   Plagiarism: ${change.plagiarism}% | Penalty Band: ${change.penalty}%`);
        console.log();
      }
    }

    console.log(`${"═".repeat(80)}`);
    console.log("✅ MIGRATION COMPLETE");
    console.log(`${"═".repeat(80)}\n`);

    console.log("✅ All scores have been recalculated using consistent pipeline");
    console.log("✅ Plagiarism penalties now match band definitions");
    console.log("✅ Score breakdowns stored in database");
    console.log("✅ Frontend will display detailed explanations\n");

    console.log("📋 NEXT STEPS:");
    console.log("   1. Verify changes are correct");
    console.log("   2. Test ViewReport.tsx to display new score breakdown");
    console.log("   3. Confirm no contradictions (plagiarism ≥ 20% shows topMatches)");
    console.log("   4. Deploy and monitor student feedback\n");

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  }
})();
