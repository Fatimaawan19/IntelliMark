/**
 * Diagnostic script to trace where AutoMark data is lost
 * Run: node diagnoseAutomarkDataLoss.js <submissionId>
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");

async function diagnose(submissionId) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✓ Connected to MongoDB\n");

    // Fetch both documents
    const submission = await Submission.findById(submissionId).lean();
    const submissionRaw = await SubmissionRaw.findOne({ submissionId }).lean();

    if (!submission) {
      console.error("❌ Submission document not found!");
      process.exit(1);
    }

    console.log("═══════════════════════════════════════════════════════════");
    console.log("SUBMISSION DOCUMENT (Main grades collection)");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`_id: ${submission._id}`);
    console.log(`submissionId (ref): ${submission.submissionId || "❌ MISSING"}`);
    console.log(`status: ${submission.status}`);
    console.log(`grade: ${submission.grade} (❌ Should be >0)`);
    console.log(`maxGrade: ${submission.maxGrade}`);
    console.log(`aiGradingSuggestion: ${submission.aiGradingSuggestion}`);
    console.log(`aiConfidence: ${submission.aiConfidence}`);
    console.log(`gradedAt: ${submission.gradedAt}`);
    console.log(`aiAnalysis length: ${submission.aiAnalysis ? submission.aiAnalysis.length : 0} chars`);

    if (submission.aiAnalysis) {
      try {
        const parsed = JSON.parse(submission.aiAnalysis);
        console.log(`aiAnalysis.questions: ${parsed.questions ? parsed.questions.length : 0} questions`);
        console.log(`aiAnalysis.totals.awarded: ${parsed.totals?.awarded}`);
        console.log(`aiAnalysis.totals.max: ${parsed.totals?.max}`);
        console.log(`aiAnalysis.failed: ${parsed.failed}`);
        console.log(`aiAnalysis.error: ${parsed.error || "none"}`);
      } catch (e) {
        console.error(`❌ aiAnalysis JSON is corrupted: ${e.message}`);
      }
    }

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("SUBMISSION_RAW DOCUMENT (Processing/logs collection)");
    console.log("═══════════════════════════════════════════════════════════");

    if (!submissionRaw) {
      console.error("❌ SubmissionRaw document not found!");
    } else {
      console.log(`_id: ${submissionRaw._id}`);
      console.log(`submissionId: ${submissionRaw.submissionId}`);
      console.log(`automarkStatus: ${submissionRaw.automarkStatus}`);
      console.log(`automarkError: ${submissionRaw.automarkError || "none"}`);
      console.log(`totalAwardedMarks: ${submissionRaw.totalAwardedMarks}`);
      console.log(`automarkedAt: ${submissionRaw.automarkedAt}`);
      console.log(`automarkReport exists: ${!!submissionRaw.automarkReport}`);

      if (submissionRaw.automarkReport) {
        const report = submissionRaw.automarkReport;
        console.log(`  - report.questions: ${report.questions ? report.questions.length : 0}`);
        console.log(`  - report.totals.awarded: ${report.totals?.awarded}`);
        console.log(`  - report.totals.max: ${report.totals?.max}`);
        console.log(`  - report.failed: ${report.failed}`);
        console.log(`  - report.error: ${report.error || "none"}`);

        if (Array.isArray(report.questions) && report.questions.length > 0) {
          console.log("\n  Question details:");
          report.questions.forEach((q, i) => {
            console.log(`    [${i}] ${q.questionKey}: ${q.awardedMarks}/${q.maxMarks} (${q.error ? "ERROR" : "OK"})`);
            if (q.error) {
              console.log(`        Error: ${q.error}`);
            }
          });
        }
      }

      if (submissionRaw.perQuestionScores) {
        console.log(`\nperQuestionScores: ${submissionRaw.perQuestionScores.length} questions`);
        submissionRaw.perQuestionScores.forEach((score, i) => {
          console.log(`  [${i}] ${score.questionKey}: ${score.awardedMarks}/${score.maxMarks}`);
        });
      }
    }

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("DIAGNOSIS");
    console.log("═══════════════════════════════════════════════════════════");

    const issues = [];

    // Check 1: Does SubmissionRaw exist?
    if (!submissionRaw) {
      issues.push("❌ SubmissionRaw not saved at all (retrieval or LLM failed?)");
    } else {
      // Check 2: Did LLM complete?
      if (submissionRaw.automarkStatus === "failed") {
        issues.push(`❌ LLM grading failed: ${submissionRaw.automarkError}`);
      } else if (submissionRaw.automarkStatus === "completed") {
        // Check 3: Does SubmissionRaw have valid report?
        if (!submissionRaw.automarkReport || submissionRaw.automarkReport.failed) {
          issues.push("❌ SubmissionRaw.automarkReport is invalid or marked as failed");
        } else {
          // Check 4: Are grades in SubmissionRaw but NOT in Submission?
          const rawGrades = submissionRaw.automarkReport.totals?.awarded || 0;
          const subGrades = submission.grade || 0;

          if (rawGrades > 0 && subGrades === 0) {
            issues.push(
              `⚠️  DATA LOST IN TRANSFER: SubmissionRaw has grades (${rawGrades}) but Submission has grade=0`
            );
            issues.push(
              "   → The Submission.updateOne() either didn't run or failed silently"
            );
            issues.push(
              "   → Check batch controller logs for: 'Updated Submission' or error messages"
            );
          }
        }
      }
    }

    // Check 5: Submission document status
    if (submission.status === "graded" && submission.grade === 0) {
      issues.push("❌ Status is 'graded' but grade is 0 (inconsistent state)");
    }

    if (issues.length === 0) {
      console.log("✓ No issues detected! Data is consistent.");
    } else {
      console.log("\nFound issues:\n");
      issues.forEach((issue, i) => {
        console.log(`${i + 1}. ${issue}`);
      });
    }

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("NEXT STEPS");
    console.log("═══════════════════════════════════════════════════════════");

    if (submissionRaw?.automarkStatus === "completed" && submissionRaw.totalAwardedMarks > 0 && submission.grade === 0) {
      console.log("\n⚡ QUICK FIX: Manually sync SubmissionRaw → Submission\n");
      console.log("Run this in MongoDB shell:\n");
      console.log(`
db.submissions.updateOne(
  { _id: ObjectId("${submission._id}") },
  {
    $set: {
      grade: ${submissionRaw.totalAwardedMarks},
      aiGradingSuggestion: ${submissionRaw.totalAwardedMarks},
      aiConfidence: ${submissionRaw.automarkReport?.confidence || 0},
      aiAnalysis: '${JSON.stringify(submissionRaw.automarkReport).replace(/'/g, "\\'")}',
      status: "graded",
      gradedAt: new Date()
    }
  }
);
      `);

      console.log("\nThen check if the grade updates in the UI.\n");
    }

    console.log("If grade still doesn't appear:");
    console.log("1. Check batch controller logs for 'Updated Submission' message");
    console.log("2. Verify Submission collection has write permissions");
    console.log("3. Check if there's a validation error in the Submission schema");
    console.log("4. Look for 'Submission update returned not ok' in logs");

  } catch (error) {
    console.error("Fatal error:", error);
  } finally {
    await mongoose.connection.close();
  }
}

const submissionId = process.argv[2];
if (!submissionId) {
  console.error("Usage: node diagnoseAutomarkDataLoss.js <submissionId>");
  process.exit(1);
}

diagnose(submissionId);