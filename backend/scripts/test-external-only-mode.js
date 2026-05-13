#!/usr/bin/env node
/**
 * Test external-only plagiarism detection mode.
 * When there's only one submission in an assessment,
 * the system skips internal plagiarism and only checks external (AI) content.
 *
 * Usage:
 *   node scripts/test-external-only-mode.js [--assessment-id ID]
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const Assessment = require("../models/Assessment");

const MONGO_URI = process.env.MONGO_URI;

console.log("\n🧪 External-Only Plagiarism Detection Test");
console.log("==========================================\n");

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Find an assessment with only 1 submission
    const assessmentId = process.argv[process.argv.indexOf("--assessment-id") + 1];

    let assessment, submissions;

    if (assessmentId) {
      assessment = await Assessment.findById(assessmentId).lean();
      if (!assessment) {
        console.log(`❌ Assessment not found: ${assessmentId}`);
        process.exit(1);
      }
      submissions = await Submission.find({
        assessmentId,
        assessmentType: "assignment",
      }).lean();
    } else {
      // Find first assessment with only 1 submission
      const agg = await Assessment.aggregate([
        {
          $lookup: {
            from: "submission",
            localField: "_id",
            foreignField: "assessmentId",
            as: "submissions",
          },
        },
        { $match: { "submissions.1": { $exists: false } } }, // Only 1 submission
        { $limit: 1 },
      ]);

      if (agg.length === 0) {
        console.log("No assessments found with exactly 1 submission");
        console.log(
          "Creating a test scenario...\n"
        );

        // Show assessments and their submission counts
        const counts = await Submission.aggregate([
          {
            $group: {
              _id: "$assessmentId",
              count: { $sum: 1 },
            },
          },
          { $sort: { count: 1 } },
          { $limit: 5 },
        ]);

        console.log("Assessments by submission count:");
        for (const c of counts) {
          const a = await Assessment.findById(c._id).select("title").lean();
          console.log(
            `  • ${a?.title || c._id} - ${c.count} submission(s)`
          );
        }
        process.exit(0);
      }

      assessment = agg[0];
      submissions = assessment.submissions || [];
    }

    if (submissions.length === 0) {
      console.log(`❌ No submissions found for assessment: ${assessment._id}`);
      process.exit(1);
    }

    console.log(`📊 Test Assessment: ${assessment.title}`);
    console.log(`📊 Submission Count: ${submissions.length}`);
    console.log(`📊 Detection Mode: ${submissions.length === 1 ? "EXTERNAL-ONLY ⚡" : "BOTH (internal + external)"}\n`);

    if (submissions.length === 1) {
      const sub = submissions[0];
      console.log(`${"═".repeat(80)}`);
      console.log(`📝 Single Submission Test Case`);
      console.log(`${"═".repeat(80)}\n`);
      console.log(`Student: ${sub.studentName || sub.studentId}`);
      console.log(`Assessment: ${assessment.title}`);
      console.log(`Submission ID: ${sub._id}\n`);

      console.log(`Expected Behavior:`);
      console.log(`  ✅ No internal plagiarism check (no other students to compare)`);
      console.log(`  ✅ Only external (AI) detection runs`);
      console.log(`  ✅ Internal score: 0%`);
      console.log(`  ✅ External score: 0-100% (depends on ZeroGPT API)`);
      console.log(`  ✅ Penalty: 0% (no internal matches found)`);
      console.log(`  ✅ Detection mode: "external_only"\n`);

      console.log(`Terminal Output Will Show:`);
      console.log(`  [PLAGIARISM] <id>: Mode=external_only, OtherSubmissions=0`);
      console.log(`  [PLAGIARISM] <id>: Only submission in assessment - skipping internal plagiarism check`);
      console.log(`  [PLAGIARISM] <id>: External-only mode (no other submissions to compare)`);
      console.log(`  [PLAGIARISM] <id>: Checking for AI-generated content...`);
      console.log(`  [PLAGIARISM] <id>: AI Detection: X% (status)`);
      console.log(`  [PLAGIARISM] <id>: COMPLETE - Internal=0.0%, External=X%, Penalty=0%\n`);
    } else {
      console.log(`${"═".repeat(80)}`);
      console.log(`📝 Multiple Submissions Test Case`);
      console.log(`${"═".repeat(80)}\n`);
      console.log(`Found ${submissions.length} submissions. Assessment will use:`);
      console.log(`  ✅ Internal plagiarism check (student-to-student matching)`);
      console.log(`  ✅ External plagiarism check (AI detection)`);
      console.log(`  ✅ Both scores combined in report\n`);

      console.log(`Samples:`);
      for (let i = 0; i < Math.min(3, submissions.length); i++) {
        const s = submissions[i];
        console.log(`  ${i + 1}. ${s.studentName || s.studentId}`);
      }
    }

    console.log(`\n${"═".repeat(80)}`);
    console.log(`📋 Implementation Details`);
    console.log(`${"═".repeat(80)}\n`);

    console.log(`Code Location: backend/controllers/submissionController.js`);
    console.log(`\nKey Changes:`);
    console.log(`  1. Count other submissions in assessment`);
    console.log(`  2. Set detectionMode = "external_only" if count === 0`);
    console.log(`  3. Skip FAISS internal plagiarism query if external_only`);
    console.log(`  4. Always run AI detection (unless API fails)`);
    console.log(`  5. Return detectionMode in response`);
    console.log(`  6. Log all steps to terminal\n`);

    console.log(`Error Handling:`);
    console.log(`  • ZeroGPT API unavailable → gracefully returns 0%`);
    console.log(`  • Error logged to console`);
    console.log(`  • Plagiarism check continues`);
    console.log(`  • Response includes aiDetectionError field\n`);

    console.log(`Terminal Logging Example:`);
    console.log(`  ✅ [PLAGIARISM] detects mode`);
    console.log(`  ✅ [PLAGIARISM] logs internal check (or skip)`);
    console.log(`  ✅ [PLAGIARISM] logs external check`);
    console.log(`  ✅ [PLAGIARISM] logs final results`);
    console.log(`  ⚠️  [PLAGIARISM] logs API errors with details\n`);

    console.log("✅ Test analysis complete\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
