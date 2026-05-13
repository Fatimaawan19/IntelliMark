/**
 * Script: Sync CLO Performance Data
 * 
 * Re-syncs ALL StudentCLOPerformance records with latest data from Submission collection.
 * Pulls real-time marks and feedback from Submission and SubmissionRaw collections.
 * 
 * Usage:
 *   node sync-clo-performance.js [options]
 * 
 * Options:
 *   --courseId <id>     Sync only specific course (default: all)
 *   --studentId <id>    Sync only specific student (default: all)
 *   --dry-run          Show what would happen without making changes
 *   --clear            Clear and rebuild from scratch
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables
dotenv.config({ path: path.join(__dirname, "../.env") });

const StudentCLOPerformance = require("../models/StudentCLOPerformance");
const Submission = require("../models/Submission");
const Course = require("../models/Course");

// Import service
const cloPerformanceService = require("../utils/cloPerformanceService");

async function main() {
  try {
    // Parse arguments
    const args = process.argv.slice(2);
    let courseId = null;
    let studentId = null;
    const isDryRun = args.includes("--dry-run");
    const isClear = args.includes("--clear");

    // Parse courseId
    const courseIdIdx = args.indexOf("--courseId");
    if (courseIdIdx !== -1 && courseIdIdx + 1 < args.length) {
      courseId = args[courseIdIdx + 1];
    }

    // Parse studentId
    const studentIdIdx = args.indexOf("--studentId");
    if (studentIdIdx !== -1 && studentIdIdx + 1 < args.length) {
      studentId = args[studentIdIdx + 1];
    }

    // Connect to MongoDB
    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) {
      console.error("❌ MONGO_URI not set in environment");
      process.exit(1);
    }

    console.log(`📚 Connecting to MongoDB...`);
    await mongoose.connect(MONGO_URI);
    console.log(`✅ Connected to MongoDB`);

    // Build query for CLO performance records to sync
    const query = {};
    if (courseId) {
      if (!mongoose.Types.ObjectId.isValid(courseId)) {
        console.error(`❌ Invalid courseId: ${courseId}`);
        await mongoose.disconnect();
        process.exit(1);
      }
      query.courseId = new mongoose.Types.ObjectId(courseId);
    }
    if (studentId) {
      query.studentId = studentId;
    }

    // Get CLO performance records to sync
    console.log(`\n🔍 Finding CLO performance records to sync...`);
    const records = await StudentCLOPerformance.find(query).lean();
    console.log(`   Found ${records.length} CLO performance records`);

    if (records.length === 0) {
      console.log(`⚠️  No CLO performance records found`);
      await mongoose.disconnect();
      process.exit(0);
    }

    // Show filters applied
    if (courseId) {
      const course = await Course.findById(courseId);
      console.log(`   Filter: Course = ${course?.courseCode || courseId}`);
    }
    if (studentId) {
      console.log(`   Filter: Student = ${studentId}`);
    }

    // Optionally clear records
    if (isClear && !isDryRun) {
      console.log(`\n🗑️  Clearing records before sync...`);
      const deleteResult = await StudentCLOPerformance.deleteMany(query);
      console.log(`   Deleted ${deleteResult.deletedCount} records`);
    }

    // Statistics
    const stats = {
      totalRecords: records.length,
      synced: 0,
      errors: [],
      startTime: Date.now()
    };

    // Get all relevant submissions
    console.log(`\n📊 Fetching all relevant submissions...`);
    const submissionQuery = { status: "graded" };
    if (courseId) {
      submissionQuery.courseId = new mongoose.Types.ObjectId(courseId);
    }
    if (studentId) {
      submissionQuery.studentId = studentId;
    }

    const submissions = await Submission.find(submissionQuery).select("_id").lean();
    console.log(`   Found ${submissions.length} graded submissions`);

    // Process each submission to update CLO performance
    console.log(`\n🔄 Syncing CLO performance...`);
    
    for (let i = 0; i < submissions.length; i++) {
      const submission = submissions[i];
      const progress = `[${i + 1}/${submissions.length}]`;

      try {
        if (isDryRun) {
          console.log(`   ${progress} DRY RUN: Would sync ${submission._id}`);
        } else {
          const updated = await cloPerformanceService.updateCLOPerformanceForSubmission(
            submission._id.toString()
          );
          stats.synced++;

          if (updated.length > 0) {
            const summary = updated
              .map(c => `CLO${c.cloNumber}@${c.percentage}%`)
              .join(", ");
            console.log(`   ${progress} ✅ Synced: ${summary}`);
          } else {
            console.log(`   ${progress} ⏭️  Skipped (no CLOs updated)`);
          }
        }
      } catch (error) {
        stats.errors.push({
          submissionId: submission._id,
          error: error.message
        });
        console.error(`   ${progress} ❌ Error: ${error.message}`);
      }

      // Show progress every 10 records
      if ((i + 1) % 10 === 0) {
        console.log(`   ... Progress: ${i + 1}/${submissions.length}`);
      }
    }

    // Final statistics
    const endTime = Date.now();
    const durationMs = endTime - stats.startTime;
    const durationSec = Math.round(durationMs / 1000);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`SYNC SUMMARY`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Total Submissions Processed: ${stats.synced}`);
    console.log(`Successful:                 ${stats.synced - stats.errors.length}`);
    console.log(`Errors:                     ${stats.errors.length}`);
    console.log(`Duration:                   ${durationSec}s`);
    console.log(`Average per submission:     ${Math.round(durationMs / submissions.length)}ms`);
    console.log(`${"=".repeat(60)}`);

    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors encountered:`);
      stats.errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. ${err.submissionId}: ${err.error}`);
      });
    }

    if (isDryRun) {
      console.log(`\n🔍 DRY RUN - No changes were made`);
    } else {
      console.log(`\n✅ Successfully synced ${stats.synced} submissions!`);
    }

    // Show sync status
    const synced = await StudentCLOPerformance.countDocuments({ isSynced: true, ...query });
    const unsynced = await StudentCLOPerformance.countDocuments({ isSynced: false, ...query });
    console.log(`\n📊 Current sync status:`);
    console.log(`   Synced records:   ${synced}`);
    console.log(`   Unsynced records: ${unsynced}`);

    await mongoose.disconnect();
    process.exit(stats.errors.length > 0 ? 1 : 0);

  } catch (error) {
    console.error("❌ Fatal error:", error);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});
