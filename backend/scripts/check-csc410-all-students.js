const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const Submission = require("../models/Submission");
const { checkPlagiarism } = require("../utils/plagiarismService");

const MONGO_URI = process.env.MONGO_URI;

const CSC410_STUDENTS = [
  { name: "Sofyan Abdullah", studentId: null },
  { name: "Omer Ali", studentId: null },
  { name: "Abdullah Mubeen", studentId: null },
];

const COURSE_CODE = "CSC410";
const ASSESSMENT_NAME = "PP_Assignment_01";

async function runChecks() {
  try {
    console.log("\n" + "=".repeat(80));
    console.log("CSC410 PLAGIARISM CHECK - ALL STUDENTS");
    console.log("=".repeat(80) + "\n");

    // Connect to MongoDB
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
    });
    console.log("✅ MongoDB connected\n");

    // Get submissions for all three students
    const submissions = await Submission.find({
      courseCode: COURSE_CODE,
      assessmentTitle: ASSESSMENT_NAME,
      studentName: { $in: CSC410_STUDENTS.map((s) => s.name) },
    }).lean();

    console.log(`Found ${submissions.length} submissions for CSC410\n`);

    // Run plagiarism check for each student
    for (const student of CSC410_STUDENTS) {
      const submission = submissions.find((s) => s.studentName === student.name);

      if (!submission) {
        console.log(`\n❌ No submission found for ${student.name}`);
        continue;
      }

      console.log("\n" + "─".repeat(80));
      console.log(`📋 STUDENT: ${student.name}`);
      console.log("─".repeat(80));
      console.log(`Submission ID: ${submission._id}`);
      console.log(`Original Grade: ${submission.grade}/${submission.maxGrade}`);
      console.log(`Assessment: ${submission.assessmentTitle}`);
      console.log("\n📊 Running plagiarism check...\n");

      try {
        const report = await checkPlagiarism(String(submission._id), {
          forceRefresh: true,
        });

        if (!report) {
          console.log("⚠️  Plagiarism check returned null (quiz type?)");
          continue;
        }

        // Display detailed results
        console.log("✅ PLAGIARISM CHECK COMPLETE\n");

        console.log("📈 PLAGIARISM SCORES:");
        console.log(
          `   Internal (Student-to-Student): ${report.internalScore ?? report.bestMatchPercent ?? 0}%`
        );
        console.log(`   External (Online/AI):           ${report.aiScore ?? 0}%`);
        console.log(
          `   Overall (Combined):             ${report.overallScore ?? Math.round(((report.internalScore ?? report.bestMatchPercent ?? 0) * 0.6 + (report.aiScore ?? 0) * 0.4))}%`
        );
        console.log(
          `   Risk Level:                     ${report.riskLevel ?? "unknown"}`
        );

        if (report.penalty) {
          console.log("\n🚨 PENALTY DECISION:");
          console.log(`   Band:    ${report.penalty.band || "N/A"}`);
          console.log(`   Penalty: ${report.penalty.penaltyPercent || 0}%`);
          console.log(`   Action:  ${report.penalty.action || "N/A"}`);
        }

        console.log("\n📄 GRADE ADJUSTMENT:");
        console.log(
          `   Grade Before:  ${submission.grade}/${submission.maxGrade}`
        );
        if (report.gradeAfterPlagiarism != null) {
          console.log(
            `   Grade After:   ${report.gradeAfterPlagiarism.toFixed(2)}/${submission.maxGrade}`
          );
          const reduction =
            submission.grade - report.gradeAfterPlagiarism;
          console.log(
            `   Reduction:     -${reduction.toFixed(2)} points (${((reduction / submission.grade) * 100).toFixed(1)}%)`
          );
        }

        if (report.matches && report.matches.length > 0) {
          console.log("\n👥 SIMILAR STUDENT SUBMISSIONS:");
          report.matches.forEach((match, idx) => {
            console.log(`   ${idx + 1}. ${match.studentName || match.studentId}`);
            console.log(`      Match: ${match.matchPercent}%`);
            if (match.snippet) {
              const snippet = match.snippet.slice(0, 100).replace(/\n/g, " ");
              console.log(`      Preview: "${snippet}..."`);
            }
          });
        } else {
          console.log("\n👥 SIMILAR STUDENT SUBMISSIONS: None found");
        }

        if (report.isGptGenerated) {
          console.log("\n⚠️  AI-GENERATED CONTENT DETECTED");
          if (report.aiAdditionalFeedback) {
            console.log(`   Feedback: ${report.aiAdditionalFeedback}`);
          }
        }

        if (report.meta) {
          console.log("\n ℹ️  METADATA:");
          console.log(`   Phase:       ${report.meta.phase || "N/A"}`);
          console.log(`   Computed At: ${report.computedAt || "N/A"}`);
        }
      } catch (err) {
        console.error(`\n❌ Error checking plagiarism: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log("✅ ALL CHECKS COMPLETE");
    console.log("=".repeat(80) + "\n");
  } catch (err) {
    console.error("Fatal error:", err.message);
    console.error(err.stack);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB disconnected\n");
    process.exit(0);
  }
}

runChecks();
