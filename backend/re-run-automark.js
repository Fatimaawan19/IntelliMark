#!/usr/bin/env node
/**
 * Re-run AutoMark on a specific submission and display detailed results
 * Usage: node re-run-automark.js <submissionId>
 * Example: node re-run-automark.js 69e73e79ff23e0a5bde63a7f
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const mongoose = require('mongoose');
const Submission = require('./models/Submission');
const Assessment = require('./models/Assessment');
const Question = require('./models/Question');
const CLO = require('./models/CLO');
const SubmissionRaw = require('./models/SubmissionRaw');
const AssessmentReferenceRaw = require('./models/AssessmentReferenceRaw');
const CourseMaterial = require('./models/CourseMaterial');
const { automarkOneSubmission } = require('./utils/automarkLlmService');

function formatMistakes(mistakes) {
  if (!Array.isArray(mistakes) || mistakes.length === 0) {
    return '  (none)';
  }
  return mistakes.map((m, i) => {
    const lines = [];
    lines.push(`  ${i + 1}. [${m.type}] ${m.feedback || m.message || ''}`);
    if (m.text_span) lines.push(`     Evidence: "${m.text_span}"`);
    if (m.suggestion) lines.push(`     Suggestion: ${m.suggestion}`);
    return lines.join('\n');
  }).join('\n');
}

function formatCoverage(coverage) {
  if (!Array.isArray(coverage) || coverage.length === 0) {
    return '  (none)';
  }
  return coverage.map((c, i) => {
    const status = c.covered ? '✅' : '❌';
    const lines = [];
    lines.push(`  ${i + 1}. ${status} ${c.point || ''} (weight: ${c.weight})`);
    if (!c.covered && c.notes) lines.push(`     Note: ${c.notes}`);
    if (c.chunkRef) lines.push(`     Chunk ref: ${c.chunkRef}`);
    return lines.join('\n');
  }).join('\n');
}

function formatEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return '  (none)';
  }
  return evidence.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
}

async function main() {
  try {
    const submissionId = process.argv[2];
    if (!submissionId) {
      console.log('❌ Usage: node re-run-automark.js <submissionId>');
      console.log('   Example: node re-run-automark.js 69e73e79ff23e0a5bde63a7f');
      process.exit(1);
    }

    console.log(`🔗 Connecting to MongoDB...\n`);
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected\n');

    // Fetch submission
    console.log(`📝 Fetching submission: ${submissionId}...\n`);
    const submission = await Submission.findById(submissionId);
    if (!submission) {
      console.log(`❌ Submission not found: ${submissionId}`);
      process.exit(1);
    }

    console.log(`✅ Submission found:`);
    console.log(`   - Student: ${submission.studentName || submission.studentId}`);
    console.log(`   - Status: ${submission.status}`);
    console.log(`   - Current grade: ${submission.grade || 'not set'}`);
    console.log(`   - Max grade: ${submission.maxGrade || 'not set'}`);
    console.log(`   - Extraction status: ${submission.faissIngestionStatus}\n`);

    // Check if extraction is complete
    if (submission.faissIngestionStatus !== 'completed' && submission.faissIngestionStatus !== 'skipped') {
      console.log(`⚠️  WARNING: Submission extraction is not complete (status: ${submission.faissIngestionStatus})`);
      console.log(`   AutoMark may fail or produce poor results.`);
      console.log(`   Run "Extract Submissions" first.\n`);
    }

    // Fetch assessment
    console.log(`📊 Fetching assessment...\n`);
    const assessment = await Assessment.findById(submission.assessmentId).lean();
    
    if (!assessment) {
      console.log(`❌ Assessment not found`);
      process.exit(1);
    }

    // Fetch questions separately to avoid populate issues
    const questions = await Question.find({ assessmentId: assessment._id }).lean();
    assessment.questions = questions;

    console.log(`✅ Assessment found:`);
    console.log(`   - Title: ${assessment.title}`);
    console.log(`   - Type: ${assessment.type}`);
    console.log(`   - Total marks: ${assessment.totalMarks}`);
    console.log(`   - Questions: ${questions.length}\n`);

    // Check questions
    if (questions.length === 0) {
      console.log(`❌ Assessment has no questions. Cannot run AutoMark.`);
      process.exit(1);
    }

    // Verify all questions have marks
    const qsWithoutMarks = questions.filter(q => !q.marks || q.marks === 0);
    if (qsWithoutMarks.length > 0) {
      console.log(`⚠️  WARNING: ${qsWithoutMarks.length} questions have missing or zero marks`);
      console.log(`   AutoMark may produce incorrect results.\n`);
    }

    // Run AutoMark
    console.log(`🤖 Running AutoMark on submission...\n`);
    console.log(`   Model: llama3:latest`);
    console.log(`   Questions to grade: ${questions.length}\n`);
    
    const startTime = Date.now();
    const report = await automarkOneSubmission(submission, assessment, questions, null);
    const elapsedMs = Date.now() - startTime;

    console.log(`✅ AutoMark completed in ${elapsedMs}ms\n`);

    // Display results
    console.log(`\n${'='.repeat(80)}`);
    console.log(`AUTO MARK RESULTS`);
    console.log(`${'='.repeat(80)}\n`);

    // Overall summary
    console.log(`📋 OVERALL SUMMARY`);
    console.log(`─`.repeat(80));
    console.log(`  Assessment: ${assessment.title}`);
    console.log(`  Student: ${submission.studentName || submission.studentId}`);
    console.log(`  Total Awarded: ${report.totals?.awarded ?? 0} / ${report.totals?.max ?? 0}`);
    console.log(`  Average Confidence: ${report.confidence ?? 'N/A'}%`);
    console.log(`  Status: ${report.failed ? '❌ FAILED' : '✅ COMPLETED'}`);
    if (report.error) console.log(`  Error: ${report.error}`);
    console.log();

    // Per-question details
    console.log(`\n📝 PER-QUESTION DETAILS`);
    console.log(`─`.repeat(80));

    if (!Array.isArray(report.questions) || report.questions.length === 0) {
      console.log('  (no questions processed)');
    } else {
      for (let i = 0; i < report.questions.length; i++) {
        const q = report.questions[i];
        console.log(`\n  ▸ ${q.questionKey || `Q${i + 1}`}: ${String(q.questionText || '').slice(0, 60)}${String(q.questionText || '').length > 60 ? '...' : ''}`);
        console.log(`    Type: ${q.questionType || 'unknown'}`);
        
        if (q.error) {
          console.log(`    ❌ ERROR: ${q.error}`);
          continue;
        }

        console.log(`    Marks: ${q.awardedMarks} / ${q.maxMarks} (${q.confidence}% confidence)`);
        
        if (q.studentAnswerSummary) {
          console.log(`    Student Summary: ${q.studentAnswerSummary}`);
        }
        
        if (q.summary) {
          console.log(`    Assessment: ${q.summary}`);
        }

        if (Array.isArray(q.strengths) && q.strengths.length > 0) {
          console.log(`\n    ✅ STRENGTHS:`);
          q.strengths.forEach((s, idx) => {
            console.log(`       ${idx + 1}. ${s}`);
          });
        }

        if (Array.isArray(q.improvements) && q.improvements.length > 0) {
          console.log(`\n    📈 AREAS FOR IMPROVEMENT:`);
          q.improvements.forEach((imp, idx) => {
            console.log(`       ${idx + 1}. ${imp}`);
          });
        }

        if (Array.isArray(q.mistakes) && q.mistakes.length > 0) {
          console.log(`\n    ⚠️  MISTAKES / ISSUES:`);
          q.mistakes.forEach((m, idx) => {
            console.log(`       ${idx + 1}. [${m.type}] ${m.feedback}`);
            if (m.text_span) console.log(`          Quote: "${m.text_span}"`);
            if (m.suggestion) console.log(`          Suggestion: ${m.suggestion}`);
          });
        }

        if (Array.isArray(q.evidence) && q.evidence.length > 0) {
          console.log(`\n    📌 EVIDENCE CITED:`);
          q.evidence.forEach((e, idx) => {
            console.log(`       ${idx + 1}. ${e}`);
          });
        }

        if (Array.isArray(q.coverage) && q.coverage.length > 0) {
          console.log(`\n    📊 COVERAGE ANALYSIS:`);
          q.coverage.forEach((c, idx) => {
            const status = c.covered ? '✅' : '❌';
            console.log(`       ${idx + 1}. ${status} ${c.point} (weight: ${c.weight})`);
            if (c.evidenceQuote) console.log(`          Evidence: "${c.evidenceQuote}"`);
            if (!c.covered && c.notes) console.log(`          Note: ${c.notes}`);
          });
        }

        if (Array.isArray(q.rubricBreakdown) && q.rubricBreakdown.length > 0) {
          console.log(`\n    📋 RUBRIC BREAKDOWN:`);
          q.rubricBreakdown.forEach((rb, idx) => {
            console.log(`       ${idx + 1}. ${rb.criterion}: ${rb.awarded} / ${rb.max}`);
            if (rb.notes) console.log(`          ${rb.notes}`);
          });
        }

        console.log(`\n    Retrieval: ${q.retrieval?.studentChunksFound || 0} student chunks, ${q.retrieval?.sampleChunksFound || 0} reference chunks`);
      }
    }

    // Save report to SubmissionRaw
    console.log(`\n\n💾 Saving results to database...\n`);
    try {
      const { buildPerQuestionScoresFromReport } = require('./utils/automarkLlmService');
      const perQuestionScores = buildPerQuestionScoresFromReport(report);
      
      await SubmissionRaw.findOneAndUpdate(
        { submissionId: submission._id },
        {
          $setOnInsert: { submissionId: submission._id },
          $set: {
            assessmentId: submission.assessmentId,
            courseId: submission.courseId || null,
            teacherId: String(submission.teacherId || ''),
            studentId: String(submission.studentId || ''),
            automarkStatus: report.failed ? 'failed' : 'completed',
            automarkError: report.error || '',
            automarkReport: report,
            perQuestionScores,
            totalAwardedMarks: Number(report?.totals?.awarded ?? 0) || 0,
            automarkedAt: new Date(),
          },
        },
        { upsert: true }
      );
      console.log(`✅ Results saved to SubmissionRaw\n`);
    } catch (e) {
      console.log(`⚠️  Could not save to SubmissionRaw: ${e?.message}\n`);
    }

    console.log(`${'='.repeat(80)}`);
    console.log(`✅ AutoMark process complete!`);
    console.log(`${'='.repeat(80)}\n`);

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error?.message || String(error));
    console.error(error);
    process.exit(1);
  }
}

main();
