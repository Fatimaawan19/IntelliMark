#!/usr/bin/env node
/**
 * Quick diagnostic script to test AutoMark functionality
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const mongoose = require('mongoose');

// Register all models to prevent schema issues
const Assessment = require('./models/Assessment');
const Question = require('./models/Question');
const CLO = require('./models/CLO');
const Submission = require('./models/Submission');
const SubmissionRaw = require('./models/SubmissionRaw');
const AssessmentReferenceRaw = require('./models/AssessmentReferenceRaw');
const CourseMaterial = require('./models/CourseMaterial');
const { automarkOneSubmission } = require('./utils/automarkLlmService');

async function runDiagnostic() {
  try {
    // Connect to MongoDB
    console.log('🔗 Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      throw new Error('MONGO_URI not set in .env');
    }
    
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Find a recent assessment with questions
    console.log('\n📋 Finding recent assessments with questions...');
    const assessment = await Assessment.findOne()
      .populate({ path: 'questions', populate: { path: 'cloId' } })
      .lean();

    if (!assessment) {
      console.log('❌ No assessments found');
      process.exit(0);
    }

    console.log(`✅ Found assessment: "${assessment.title}" (${assessment._id})`);
    console.log(`   - Total marks: ${assessment.totalMarks}`);
    console.log(`   - Questions: ${assessment.questions?.length || 0}`);
    
    if (assessment.questions && assessment.questions.length > 0) {
      const q = assessment.questions[0];
      console.log(`   - First question marks: ${q.marks ?? 'NOT SET'}`);
      console.log(`   - First question text: ${String(q.questionText || '').slice(0, 50)}...`);
    }

    // Find a submission for this assessment
    console.log('\n📝 Finding submissions for this assessment...');
    const submissions = await Submission.find({ assessmentId: assessment._id }).lean();
    console.log(`✅ Found ${submissions.length} submissions`);

    if (submissions.length === 0) {
      console.log('❌ No submissions found to test');
      process.exit(0);
    }

    const submission = submissions[0];
    console.log(`   - Submission ID: ${submission._id}`);
    console.log(`   - Student ID: ${submission.studentId}`);
    console.log(`   - Status: ${submission.status}`);
    console.log(`   - Extraction status: ${submission.faissIngestionStatus}`);

    // Check if submission has chunks
    console.log('\n🔎 Checking if submission has extracted chunks...');
    const subRaw = await SubmissionRaw.findOne({ submissionId: submission._id }).lean();
    if (!subRaw) {
      console.log('❌ No SubmissionRaw found - extraction may not be complete');
      console.log('   → Run "Extract Submissions" first');
    } else {
      console.log(`✅ SubmissionRaw found`);
      console.log(`   - Extraction status: ${subRaw.extractionStatus}`);
      console.log(`   - FAISS ingestion status: ${subRaw.faissIngestionStatus}`);
      console.log(`   - Chunk count: ${subRaw.faissChunkCount || subRaw.numChunks || 0}`);
      console.log(`   - Character count: ${subRaw.charCount || 0}`);
    }

    // Test automark on this submission
    console.log('\n🤖 Testing automark on this submission...');
    console.log(`   - Assessment: ${assessment.title}`);
    console.log(`   - Questions: ${assessment.questions.length}`);
    console.log(`   - Submission: ${submission.studentId}`);
    console.log(`   - Ollama model: ${process.env.AUTOMARK_OLLAMA_MODEL || 'llama3:latest'}`);

    const questions = Array.isArray(assessment.questions) ? assessment.questions : [];
    if (questions.length === 0) {
      console.log('❌ No questions found in assessment');
      process.exit(0);
    }

    console.log('\n⏳ Running automarkOneSubmission...');
    const report = await automarkOneSubmission(submission, assessment, questions, null);

    console.log('\n📊 AutoMark Report Generated:');
    console.log(`   - Total awarded: ${report.totals?.awarded ?? 'NOT SET'}`);
    console.log(`   - Total max: ${report.totals?.max ?? 'NOT SET'}`);
    console.log(`   - Confidence: ${report.confidence ?? 'NOT SET'}`);
    console.log(`   - Questions processed: ${report.questions?.length || 0}`);

    if (report.questions && report.questions.length > 0) {
      console.log('\n   Per-question results:');
      report.questions.forEach((q, idx) => {
        console.log(`   Q${idx + 1}:`);
        console.log(`      - Awarded: ${q.awardedMarks ?? 'NOT SET'} / ${q.maxMarks ?? 'NOT SET'}`);
        console.log(`      - Confidence: ${q.confidence ?? 'NOT SET'}`);
        console.log(`      - Summary: ${String(q.summary || q.studentAnswerSummary || '').slice(0, 50)}${String(q.summary || q.studentAnswerSummary || '').length > 50 ? '...' : ''}`);
        console.log(`      - Mistakes: ${Array.isArray(q.mistakes) ? q.mistakes.length : 0}`);
        console.log(`      - Strengths: ${Array.isArray(q.strengths) ? q.strengths.length : 0}`);
        console.log(`      - Improvements: ${Array.isArray(q.improvements) ? q.improvements.length : 0}`);
        if (q.error) {
          console.log(`      - ERROR: ${q.error}`);
        }
      });
    }

    if (report.failed) {
      console.log(`\n❌ Report indicates failure: ${report.error || 'Unknown error'}`);
    } else {
      console.log('\n✅ AutoMark completed successfully!');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error?.message || String(error));
    console.error(error);
    process.exit(1);
  }
}

runDiagnostic();
