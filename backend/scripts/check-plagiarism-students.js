#!/usr/bin/env node
/**
 * Run plagiarism checks for specific students
 * Usage: node scripts/check-plagiarism-students.js
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const plagiarismService = require("../utils/plagiarismService");

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI not found in .env");
  process.exit(1);
}

const targetStudents = [
  { name: 'Sofyan Abdullah', courseCode: 'CSC410' },
  { name: 'Omer Ali', courseCode: 'CSC410' },
  { name: 'Abdullah Mubeen', courseCode: 'CSC410' }
];

console.log("\n📊 Plagiarism Check for CSC410 Students");
console.log("════════════════════════════════════════\n");

(async () => {
  let mongoConnection = null;
  try {
    // Connect with longer timeout
    mongoConnection = await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
    });
    console.log("✅ Connected to MongoDB\n");

    // Find submissions for these students
    const submissions = await Submission.find({
      studentName: { $in: targetStudents.map(s => s.name) },
      courseCode: 'CSC410',
      status: 'graded'
    }).select('_id studentName assessmentTitle grade maxGrade courseCode assessmentType');

    console.log(`Found ${submissions.length} submissions to check:\n`);

    let checkedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      console.log(`[${i + 1}/${submissions.length}] Checking ${sub.studentName}...`);

      try {
        // Run plagiarism check with force refresh
        const report = await plagiarismService.checkPlagiarism(sub._id.toString(), {
          forceRefresh: true
        });

        if (!report) {
          console.log(`   ⚠️  Not an assignment type - skipping\n`);
          continue;
        }

        console.log(`   ✅ Check complete`);
        console.log(`   Internal Plagiarism: ${report.internalScore}%`);
        console.log(`   External Plagiarism (AI): ${report.aiScore}%`);
        console.log(`   Overall Score: ${report.overallScore}%`);
        console.log(`   Risk Level: ${report.riskLevel}`);
        console.log(`   Top Matches: ${report.topMatches?.length || 0}`);

        if (report.topMatches && report.topMatches.length > 0) {
          console.log(`   Matching Students:`);
          report.topMatches.slice(0, 3).forEach((m, idx) => {
            console.log(`     ${idx + 1}. ${m.studentName} (${m.similarityPercent}%)`);
          });
        }
        console.log();
        checkedCount++;
      } catch (err) {
        console.error(`   ❌ Error: ${err.message}\n`);
        errorCount++;
      }
    }

    console.log("════════════════════════════════════════");
    console.log(`✅ Checked: ${checkedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`Total: ${submissions.length}\n`);

    if (checkedCount > 0) {
      console.log("✅ Next steps:");
      console.log("   1. Run migration: npm run fix-scores");
      console.log("   2. Check ViewReport.tsx to see score breakdown");
      console.log("   3. Verify external sources are displayed\n");
    }

    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal Error:", err.message);
    console.error(err);
    process.exit(1);
  } finally {
    if (mongoConnection) {
      await mongoose.disconnect();
    }
  }
})();
