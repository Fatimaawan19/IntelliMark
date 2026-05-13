#!/usr/bin/env node
/**
 * Fix failed automark extraction flags
 *
 * This script finds all AutomarkJob records where extraction failed
 * and tries to re-extract the chunks:
 * - sampleAnswerExtracted = false
 * - relevantCourseMaterialChunksExtracted = false
 *
 * Usage:
 *   node scripts/fix-failed-automark-extractions.js [--dry-run] [--assessment-id ID]
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const AutomarkJob = require("../models/AutomarkJob");
const Assessment = require("../models/Assessment");
const Course = require("../models/Course");
const {
  queryAssessmentReferenceChunks,
} = require("../utils/assessmentReferenceRetrievalService");
const { queryCourseMaterialChunks } = require("../utils/courseMaterialRetrievalService");

const MONGO_URI = process.env.MONGO_URI;
const isDryRun = process.argv.includes("--dry-run");
const assessmentIdIdx = process.argv.indexOf("--assessment-id");
const assessmentId = assessmentIdIdx >= 0 ? process.argv[assessmentIdIdx + 1] : null;

console.log("\n🔧 Fix Failed AutoMark Extractions");
console.log("═════════════════════════════════════\n");

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Build query
    let query = {
      $or: [
        { sampleAnswerExtracted: false },
        { relevantCourseMaterialChunksExtracted: false },
      ],
    };

    if (assessmentId) {
      query.assessmentId = assessmentId;
    }

    // Find failed jobs
    const jobs = await AutomarkJob.find(query).sort({ createdAt: -1 }).lean();
    console.log(`📊 Found ${jobs.length} job(s) with failed extractions\n`);

    if (jobs.length === 0) {
      console.log("✅ No failed extractions to fix\n");
      process.exit(0);
    }

    let fixedCount = 0;
    let unchangedCount = 0;
    let errorCount = 0;
    const fixes = [];

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const assessment = await Assessment.findById(job.assessmentId).lean();

      if (!assessment) {
        console.log(`⚠️  [${i + 1}/${jobs.length}] Assessment not found: ${job.assessmentId}`);
        errorCount++;
        continue;
      }

      const qTitle = String(assessment?.title || "Assessment").trim();
      const jobStatus = `[${i + 1}/${jobs.length}] ${job.assessmentTitle || qTitle}`;

      console.log(`${jobStatus}`);
      console.log(`   Sample extracted: ${job.sampleAnswerExtracted}`);
      console.log(`   Course material extracted: ${job.relevantCourseMaterialChunksExtracted}`);

      const updates = {};
      let didFix = false;

      // Try to extract sample answers
      if (!job.sampleAnswerExtracted) {
        try {
          const probe =
            String(assessment?.instructions || assessment?.title || "sample answer").trim() ||
            "sample answer";

          const sampleChunks = await queryAssessmentReferenceChunks(probe, {
            topK: 8,
            assessmentId: String(assessment._id),
            questionId: "ALL",
            referenceType: "sample_answer",
          }).catch(() => []);

          if (Array.isArray(sampleChunks) && sampleChunks.length > 0) {
            console.log(`   ✅ Sample answers found: ${sampleChunks.length} chunk(s)`);
            updates.sampleAnswerExtracted = true;
            didFix = true;
          } else {
            console.log(`   ❌ No sample answers found (may not be uploaded)`);
          }
        } catch (err) {
          console.log(`   ❌ Sample extraction error: ${err.message}`);
        }
      } else {
        console.log(`   ✅ Sample already extracted`);
      }

      // Try to extract course materials
      if (!job.relevantCourseMaterialChunksExtracted) {
        try {
          const courseId = String(assessment?.courseId || "").trim();
          if (!courseId) {
            console.log(`   ❌ No course ID found`);
          } else {
            const probe =
              String(assessment?.instructions || assessment?.title || "course material").trim() ||
              "course material";

            const matChunks = await queryCourseMaterialChunks(probe, {
              topK: 8,
              courseId,
            }).catch(() => []);

            if (Array.isArray(matChunks) && matChunks.length > 0) {
              console.log(`   ✅ Course materials found: ${matChunks.length} chunk(s)`);
              updates.relevantCourseMaterialChunksExtracted = true;
              didFix = true;
            } else {
              console.log(`   ❌ No course materials found (may not be ingested)`);
            }
          }
        } catch (err) {
          console.log(`   ❌ Course material extraction error: ${err.message}`);
        }
      } else {
        console.log(`   ✅ Course materials already extracted`);
      }

      // Update job if fixes were made
      if (didFix && Object.keys(updates).length > 0) {
        if (!isDryRun) {
          await AutomarkJob.findByIdAndUpdate(job._id, { $set: updates }).catch((err) => {
            console.log(`   ⚠️  Update error: ${err.message}`);
            errorCount++;
            return;
          });
        }

        fixes.push({
          jobId: job._id,
          assessment: qTitle,
          updates,
        });

        console.log(`   ✏️  Fixed: ${Object.keys(updates).join(", ")}`);
        fixedCount++;
      } else if (!didFix && Object.keys(updates).length === 0) {
        unchangedCount++;
      }

      console.log();
    }

    console.log(`${"═".repeat(100)}`);
    console.log("SUMMARY");
    console.log(`${"═".repeat(100)}\n`);

    console.log(`${isDryRun ? "🧪 DRY RUN (no changes)" : "✏️  LIVE MODE (changes applied)"}`);
    console.log(`✅ Fixed: ${fixedCount}`);
    console.log(`✅ Unchanged: ${unchangedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`Total: ${jobs.length}\n`);

    if (fixes.length > 0) {
      console.log(`${"═".repeat(100)}`);
      console.log("DETAILED FIXES");
      console.log(`${"═".repeat(100)}\n`);

      for (const fix of fixes) {
        console.log(`📝 ${fix.assessment}`);
        if (fix.updates.sampleAnswerExtracted) {
          console.log(`   ✅ sampleAnswerExtracted: false → true`);
        }
        if (fix.updates.relevantCourseMaterialChunksExtracted) {
          console.log(`   ✅ relevantCourseMaterialChunksExtracted: false → true`);
        }
        console.log();
      }
    }

    console.log(`${"═".repeat(100)}`);
    console.log("NEXT STEPS");
    console.log(`${"═".repeat(100)}\n`);

    if (fixedCount > 0) {
      console.log("✅ Extraction flags have been updated");
      console.log("📌 AutoMark jobs will now use extracted chunks");
      console.log("🔄 Re-run autoMark to use fixed extractions\n");

      if (isDryRun) {
        console.log("💡 Tip: Run without --dry-run to apply changes:");
        console.log("   node scripts/fix-failed-automark-extractions.js\n");
      }
    } else {
      console.log("📌 Check if sample answers are uploaded in assessment");
      console.log("📌 Check if course materials are ingested\n");
    }

    console.log("✅ Fix complete\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();
