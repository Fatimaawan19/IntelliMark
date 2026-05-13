/**
 * Script: Populate CLO Performance Data
 * 
 * Fetches and populates StudentCLOPerformance collection with real-time data
 * from all submitted assessments.
 * 
 * Usage:
 *   node populate-clo-performance.js <courseId> [--force] [--dry-run]
 *   node populate-clo-performance.js --all-courses [--force] [--dry-run]
 * 
 * Arguments:
 *   <courseId>         Process specific course (MongoDB ObjectId)
 *   --all-courses      Process ALL courses with graded submissions
 * 
 * Options:
 *   --force            Clear existing records before populating
 *   --dry-run          Show what would happen without making changes
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

// Load environment variables
dotenv.config({ path: path.join(__dirname, "../.env") });

const Submission = require("../models/Submission");
const Assessment = require("../models/Assessment");
const CLO = require("../models/CLO");
const Question = require("../models/Question");
const StudentCLOPerformance = require("../models/StudentCLOPerformance");
const Course = require("../models/Course");
const SubmissionRaw = require("../models/SubmissionRaw");

// Import the CLO performance service
const cloPerformanceService = require("../utils/cloPerformanceService");

async function populateCourse(courseId, isForce, isDryRun) {
  // Verify course exists
  const course = await Course.findById(courseId);
  if (!course) {
    console.error(`❌ Course not found: ${courseId}`);
    return { success: false, courseId, error: "Course not found" };
  }

  console.log(`\n📖 Course: ${course.courseCode} - ${course.courseTitle}`);

  // Get all graded submissions for this course
  const allSubmissions = await Submission.find({
    courseId,
    status: "graded"
  }).lean();

  console.log(`   Graded submissions: ${allSubmissions.length}`);

  if (allSubmissions.length === 0) {
    console.log(`   ⏭️  Skipping (no graded submissions)`);
    return { success: true, courseId, submissionCount: 0 };
  }

  // Optionally clear existing records
  if (isForce && !isDryRun) {
    await StudentCLOPerformance.deleteMany({ courseId });
  }

  // Track statistics
  const stats = {
    totalSubmissions: allSubmissions.length,
    successfulSubmissions: 0,
    failedSubmissions: 0,
    totalCLOsUpdated: 0,
    errors: []
  };

  // Process each submission
  for (let i = 0; i < allSubmissions.length; i++) {
    const submission = allSubmissions[i];
    const progress = `[${i + 1}/${allSubmissions.length}]`;
    
    try {
      if (!isDryRun) {
        const updated = await cloPerformanceService.updateCLOPerformanceForSubmission(
          submission._id.toString()
        );
        
        stats.successfulSubmissions++;
        stats.totalCLOsUpdated += updated.length;
        
        if (updated.length > 0) {
          const cloInfo = updated.map(c => `CLO${c.cloNumber}`).join(",");
          console.log(`   ${progress} ✅ ${cloInfo}`);
        }
      }
    } catch (error) {
      stats.failedSubmissions++;
      stats.errors.push({
        submissionId: submission._id,
        error: error.message
      });
    }
  }

  // Get final statistics
  const cloRecords = await StudentCLOPerformance.countDocuments({ courseId });
  const studentCount = await StudentCLOPerformance.distinct("studentId", { courseId });

  return {
    success: true,
    courseId,
    courseCode: course.courseCode,
    submissionCount: allSubmissions.length,
    successfulSubmissions: stats.successfulSubmissions,
    failedSubmissions: stats.failedSubmissions,
    totalCLOsUpdated: stats.totalCLOsUpdated,
    cloRecordsCreated: cloRecords,
    studentCount: studentCount.length,
    errors: stats.errors
  };
}

async function main() {
  try {
    // Parse command line arguments
    const firstArg = process.argv[2];
    const args = process.argv.slice(3);
    const isForce = args.includes("--force");
    const isDryRun = args.includes("--dry-run");
    const isAllCourses = firstArg === "--all-courses";

    if (!firstArg) {
      console.error("❌ Usage: node populate-clo-performance.js <courseId> [--force] [--dry-run]");
      console.error("       or: node populate-clo-performance.js --all-courses [--force] [--dry-run]");
      process.exit(1);
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

    let coursesToProcess = [];

    if (isAllCourses) {
      // Get all courses with graded submissions
      console.log(`\n🔍 Finding courses with graded submissions...`);
      const coursesWithSubmissions = await Submission.distinct("courseId", {
        status: "graded"
      });
      
      if (coursesWithSubmissions.length === 0) {
        console.log(`⚠️  No courses with graded submissions found`);
        await mongoose.disconnect();
        process.exit(0);
      }

      coursesToProcess = coursesWithSubmissions;
      console.log(`   Found ${coursesToProcess.length} courses with graded submissions`);
    } else {
      // Single course mode
      const courseId = firstArg;
      
      if (!mongoose.Types.ObjectId.isValid(courseId)) {
        console.error(`❌ Invalid courseId: ${courseId}`);
        await mongoose.disconnect();
        process.exit(1);
      }

      coursesToProcess = [new mongoose.Types.ObjectId(courseId)];
    }

    // Show settings
    if (isForce) {
      console.log(`🗑️  Mode: FORCE (will clear existing records)`);
    }
    if (isDryRun) {
      console.log(`🔍 Mode: DRY RUN (no changes will be made)`);
    }

    // Process each course
    const globalStats = {
      totalCourses: coursesToProcess.length,
      successfulCourses: 0,
      failedCourses: 0,
      totalSubmissions: 0,
      totalCLOsUpdated: 0,
      totalRecordsCreated: 0,
      totalStudents: 0,
      courseResults: []
    };

    console.log(`\n${"=".repeat(70)}`);
    console.log(`PROCESSING ${coursesToProcess.length} COURSE(S)`);
    console.log(`${"=".repeat(70)}`);

    for (let i = 0; i < coursesToProcess.length; i++) {
      const courseId = coursesToProcess[i];
      console.log(`\n[${i + 1}/${coursesToProcess.length}]`);
      
      try {
        const result = await populateCourse(courseId, isForce, isDryRun);
        
        if (result.success && result.submissionCount > 0) {
          globalStats.successfulCourses++;
          globalStats.totalSubmissions += result.submissionCount;
          globalStats.totalCLOsUpdated += result.totalCLOsUpdated;
          globalStats.totalRecordsCreated += result.cloRecordsCreated;
          globalStats.totalStudents += result.studentCount;
          globalStats.courseResults.push(result);
        } else if (result.success) {
          globalStats.courseResults.push(result);
        } else {
          globalStats.failedCourses++;
        }
      } catch (error) {
        globalStats.failedCourses++;
        console.error(`   ❌ Error: ${error.message}`);
      }
    }

    // Display global summary
    console.log(`\n${"=".repeat(70)}`);
    console.log(`GLOBAL SUMMARY`);
    console.log(`${"=".repeat(70)}`);
    console.log(`Total Courses:            ${globalStats.totalCourses}`);
    console.log(`Successful:               ${globalStats.successfulCourses}`);
    console.log(`Failed:                   ${globalStats.failedCourses}`);
    console.log(`Total Submissions:        ${globalStats.totalSubmissions}`);
    console.log(`Total CLOs Updated:       ${globalStats.totalCLOsUpdated}`);
    console.log(`CLO Records Created:      ${globalStats.totalRecordsCreated}`);
    console.log(`Unique Students Affected: ${globalStats.totalStudents}`);
    console.log(`${"=".repeat(70)}`);

    // Show course details
    if (isAllCourses && globalStats.courseResults.length > 0) {
      console.log(`\n📚 Course Details:`);
      globalStats.courseResults.forEach((result, idx) => {
        if (result.submissionCount > 0) {
          console.log(
            `   ${idx + 1}. ${result.courseCode}: ` +
            `${result.submissionCount} submissions → ` +
            `${result.cloRecordsCreated} CLO records (${result.studentCount} students)`
          );
        } else {
          console.log(`   ${idx + 1}. ${result.courseCode}: No graded submissions`);
        }
      });
    }

    if (isDryRun) {
      console.log(`\n🔍 DRY RUN - No changes were made`);
    } else if (globalStats.successfulCourses > 0) {
      console.log(`\n✅ Successfully populated CLO performance for ${globalStats.successfulCourses} course(s)!`);
    }

    await mongoose.disconnect();
    process.exit(globalStats.failedCourses > 0 ? 1 : 0);

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
