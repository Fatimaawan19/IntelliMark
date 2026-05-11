#!/usr/bin/env node

/**
 * QuickDiagnose: Check where grades are lost
 * Usage: node quickDiagnose.js <submissionId>
 * Example: node quickDiagnose.js 69e73e79ff23e0a5bde63a7f
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Submission = require('../models/Submission');
const SubmissionRaw = require('../models/SubmissionRaw');
const QuestionGrade = require('../models/QuestionGrade');

async function diagnose(submissionId) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // ========================================================================
    // STEP 1: Check Submission document
    // ========================================================================
    console.log('STEP 1: Checking Submission document');
    console.log('─'.repeat(60));

    const submission = await Submission.findById(submissionId).lean();
    if (!submission) {
      console.error('❌ Submission not found!');
      process.exit(1);
    }

    console.log(`Submission._id: ${submission._id}`);
    console.log(`Submission.status: ${submission.status}`);
    console.log(`Submission.grade: ${submission.grade} ← Should be > 0`);
    console.log(`Submission.maxGrade: ${submission.maxGrade}`);
    console.log(`Submission.aiConfidence: ${submission.aiConfidence}`);
    console.log(`Submission.gradedAt: ${submission.gradedAt}`);

    if (submission.aiAnalysis) {
      try {
        const analysis = JSON.parse(submission.aiAnalysis);
        console.log(`Submission.aiAnalysis:
  - questions: ${analysis.questions ? analysis.questions.length : 0}
  - totals.awarded: ${analysis.totals?.awarded || 0}
  - totals.max: ${analysis.totals?.max || 0}
  - failed: ${analysis.failed || false}
  - error: ${analysis.error || 'none'}`);
      } catch (e) {
        console.warn(`⚠️  aiAnalysis is corrupted JSON`);
      }
    } else {
      console.warn(`⚠️  aiAnalysis is empty/null`);
    }

    // ========================================================================
    // STEP 2: Check SubmissionRaw document
    // ========================================================================
    console.log('\n\nSTEP 2: Checking SubmissionRaw document');
    console.log('─'.repeat(60));

    const submissionRaw = await SubmissionRaw.findOne({ submissionId }).lean();
    if (!submissionRaw) {
      console.error('❌ SubmissionRaw not found!');
    } else {
      console.log(`SubmissionRaw._id: ${submissionRaw._id}`);
      console.log(`SubmissionRaw.automarkStatus: ${submissionRaw.automarkStatus}`);
      console.log(`SubmissionRaw.automarkError: ${submissionRaw.automarkError || 'none'}`);
      console.log(`SubmissionRaw.totalAwardedMarks: ${submissionRaw.totalAwardedMarks}`);
      console.log(`SubmissionRaw.automarkedAt: ${submissionRaw.automarkedAt}`);

      if (submissionRaw.automarkReport) {
        const report = submissionRaw.automarkReport;
        console.log(`SubmissionRaw.automarkReport:
  - questions: ${report.questions ? report.questions.length : 0}
  - totals.awarded: ${report.totals?.awarded || 0}
  - totals.max: ${report.totals?.max || 0}
  - confidence: ${report.confidence || 0}
  - failed: ${report.failed || false}
  - error: ${report.error || 'none'}`);

        // Check first question details
        if (report.questions && report.questions[0]) {
          const q = report.questions[0];
          console.log(`\n  Question 1 details:
    - key: ${q.questionKey}
    - awardedMarks: ${q.awardedMarks}
    - maxMarks: ${q.maxMarks}
    - confidence: ${q.confidence}
    - error: ${q.error || 'none'}`);
        }
      } else {
        console.warn(`⚠️  automarkReport is empty/null`);
      }

      if (submissionRaw.perQuestionScores) {
        console.log(`\nSubmissionRaw.perQuestionScores: ${submissionRaw.perQuestionScores.length} questions`);
        submissionRaw.perQuestionScores.forEach((score, i) => {
          console.log(`  [${i}] ${score.questionKey}: ${score.awardedMarks}/${score.maxMarks}`);
        });
      }
    }

    // ========================================================================
    // STEP 3: Check QuestionGrade collection
    // ========================================================================
    console.log('\n\nSTEP 3: Checking QuestionGrade documents');
    console.log('─'.repeat(60));

    const questionGrades = await QuestionGrade.find({ submissionId }).lean();
    if (questionGrades.length === 0) {
      console.warn(`⚠️  No QuestionGrade records found`);
    } else {
      console.log(`Found ${questionGrades.length} QuestionGrade record(s)`);
      questionGrades.forEach((qg, i) => {
        console.log(`  [${i}] ${qg.questionKey}: ${qg.awardedMarks}/${qg.maxMarks} (status: ${qg.status})`);
      });
    }

    // ========================================================================
    // DIAGNOSIS
    // ========================================================================
    console.log('\n\nDIAGNOSIS');
    console.log('═'.repeat(60));

    const issues = [];

    // Check 1: Data in SubmissionRaw?
    if (!submissionRaw) {
      issues.push({
        severity: 'CRITICAL',
        issue: 'SubmissionRaw not saved',
        cause: 'Retrieval or LLM phase failed',
        fix: 'Check logs for [AUTOMARK] errors during grading',
      });
    } else if (submissionRaw.automarkStatus === 'failed') {
      issues.push({
        severity: 'CRITICAL',
        issue: 'SubmissionRaw marked as failed',
        cause: submissionRaw.automarkError || 'Unknown error',
        fix: 'Check what the automarkError message says',
      });
    } else if (!submissionRaw.automarkReport || submissionRaw.automarkReport.failed) {
      issues.push({
        severity: 'HIGH',
        issue: 'SubmissionRaw has invalid report',
        cause: 'LLM returned bad JSON or report marked as failed',
        fix: 'Check automarkReport.error field for details',
      });
    }

    // Check 2: Grades in SubmissionRaw but NOT in Submission?
    if (submissionRaw && submissionRaw.totalAwardedMarks > 0 && submission.grade === 0) {
      issues.push({
        severity: 'CRITICAL',
        issue: 'DATA LOST: Grades in SubmissionRaw but not in Submission',
        cause: 'Submission.updateOne() failed or never ran',
        fix: 'See "RECOVERY" section below',
      });
    }

    // Check 3: Status inconsistency
    if (submission.status === 'graded' && submission.grade === 0) {
      issues.push({
        severity: 'HIGH',
        issue: 'Submission status="graded" but grade=0',
        cause: 'Status was set but grade was not',
        fix: 'Indicates partial write or race condition',
      });
    }

    // Check 4: LLM errors
    if (
      submissionRaw?.automarkReport?.questions?.some(
        (q) => q.error !== null && q.error !== undefined
      )
    ) {
      const failedQuestions = submissionRaw.automarkReport.questions.filter(
        (q) => q.error
      );
      issues.push({
        severity: 'HIGH',
        issue: `LLM failed on ${failedQuestions.length} question(s)`,
        cause: failedQuestions.map((q) => `${q.questionKey}: ${q.error}`).join('; '),
        fix: 'Check if Ollama model is running and responsive',
      });
    }

    if (issues.length === 0) {
      console.log('✅ No critical issues found! Data looks consistent.');
    } else {
      console.log(`Found ${issues.length} issue(s):\n`);
      issues.forEach((issue, i) => {
        console.log(`${i + 1}. [${issue.severity}] ${issue.issue}`);
        console.log(`   Cause: ${issue.cause}`);
        console.log(`   Fix: ${issue.fix}\n`);
      });
    }

    // ========================================================================
    // RECOVERY
    // ========================================================================
    if (
      submissionRaw &&
      submissionRaw.totalAwardedMarks > 0 &&
      submission.grade === 0
    ) {
      console.log('\nRECOVERY: Copy grades from SubmissionRaw → Submission');
      console.log('─'.repeat(60));

      console.log(`\nRun this in MongoDB shell:\n`);
      console.log(`
db.submissions.updateOne(
  { _id: ObjectId("${submission._id}") },
  {
    $set: {
      grade: ${submissionRaw.totalAwardedMarks},
      aiGradingSuggestion: ${submissionRaw.totalAwardedMarks},
      aiConfidence: ${submissionRaw.automarkReport?.confidence || 0},
      aiAnalysis: '${JSON.stringify(submissionRaw.automarkReport)
        .replace(/'/g, "\\'")
        .substring(0, 100)}...',
      status: "graded",
      gradedAt: new Date()
    }
  }
);
      `);

      console.log(`\nOr use the sync helper from improvedBatchController.js:`);
      console.log(`
const { syncOneSubmissionGrades } = require('./improvedBatchController');
await syncOneSubmissionGrades("${submissionId}");
      `);
    }

    // ========================================================================
    // NEXT STEPS
    // ========================================================================
    console.log('\n\nNEXT STEPS');
    console.log('═'.repeat(60));

    if (submission.grade === 0 && submissionRaw?.totalAwardedMarks > 0) {
      console.log(`\n1. IMMEDIATE: Sync the grades (see RECOVERY section above)`);
      console.log(`2. INVESTIGATE: Check backend logs for [AUTOMARK] errors`);
      console.log(`3. FIX: Replace automarkLlmService.js with _FIXED version`);
      console.log(`4. DEPLOY: Use improvedBatchController.js with sync + retry`);
    } else if (submissionRaw?.automarkStatus === 'failed') {
      console.log(`\n1. Check SubmissionRaw.automarkError: "${submissionRaw.automarkError}"`);
      console.log(`2. Verify Ollama is running: curl http://127.0.0.1:11434/api/tags`);
      console.log(`3. Check if model is loaded: ps aux | grep ollama`);
      console.log(`4. Re-run marking for this submission`);
    } else if (!submissionRaw) {
      console.log(`\n1. SubmissionRaw was never created (critical failure)`);
      console.log(`2. Check server logs during marking - likely DB write error`);
      console.log(`3. Verify MongoDB connection is working`);
      console.log(`4. Check if SubmissionRaw collection exists and is writable`);
    } else {
      console.log(`\n✅ Data appears to be consistent, no recovery needed`);
      console.log(`If grades still don't show in UI, check:`);
      console.log(`  - Is the UI reading from the correct collection?`);
      console.log(`  - Are there any API filters hiding grade=0 records?`);
    }

  } catch (error) {
    console.error('Fatal error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
  }
}

const submissionId = process.argv[2];
if (!submissionId) {
  console.error('Usage: node quickDiagnose.js <submissionId>');
  console.error('Example: node quickDiagnose.js 69e73e79ff23e0a5bde63a7f');
  process.exit(1);
}

diagnose(submissionId).catch(console.error);