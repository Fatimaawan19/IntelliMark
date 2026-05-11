#!/usr/bin/env node
/**
 * Comprehensive diagnostic for AutoMark issues
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');
const Question = require('./models/Question');
const CLO = require('./models/CLO');
const Submission = require('./models/Submission');
const SubmissionRaw = require('./models/SubmissionRaw');

async function runDiagnostic() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI not set in .env');
    
    await mongoose.connect(mongoUri);
    console.log('✅ Connected\n');

    // 1. Check assessments and their questions
    console.log('📊 ASSESSMENT DIAGNOSTIC');
    console.log('========================\n');
    
    const allAssessments = await Assessment.find().lean();
    console.log(`Total assessments: ${allAssessments.length}`);
    
    // Check each assessment
    for (const assessment of allAssessments.slice(0, 3)) {
      console.log(`\n• "${assessment.title}" (${assessment._id})`);
      console.log(`  - Total marks: ${assessment.totalMarks}`);
      console.log(`  - Question count field: ${assessment.questionCount}`);
      console.log(`  - Questions array length: ${assessment.questions ? assessment.questions.length : 0}`);
      
      if (assessment.questionCount > 0 && (!assessment.questions || assessment.questions.length === 0)) {
        console.log(`  ⚠️  ISSUE: questionCount=${assessment.questionCount} but questions array is empty!`);
      }
      
      // Check if questions exist separately
      const questionsInDb = await Question.find({ assessmentId: assessment._id }).lean();
      console.log(`  - Questions in DB: ${questionsInDb.length}`);
      
      if (questionsInDb.length > 0) {
        const q = questionsInDb[0];
        console.log(`    • First question: "${String(q.questionText || '').slice(0, 40)}..."`);
        console.log(`    • Marks: ${q.marks ?? 'NOT SET'}`);
        console.log(`    • Type: ${q.questionType}`);
      }
      
      if (assessment.questionCount > 0 && questionsInDb.length === 0) {
        console.log(`  ❌ CRITICAL ISSUE: questionCount=${assessment.questionCount} but NO questions found in DB!`);
      }
    }

    // 2. Check submissions
    console.log('\n\n📝 SUBMISSION DIAGNOSTIC');
    console.log('========================\n');
    
    const allSubmissions = await Submission.find().lean().limit(3);
    console.log(`Sample submissions: ${allSubmissions.length}`);
    
    for (const sub of allSubmissions) {
      console.log(`\n• Student: ${sub.studentName || sub.studentId} (${sub._id})`);
      console.log(`  - Assessment: ${sub.assessmentId}`);
      console.log(`  - Extraction status: ${sub.faissIngestionStatus}`);
      console.log(`  - Max grade: ${sub.maxGrade}`);
      console.log(`  - Grade: ${sub.grade}`);
      console.log(`  - aiGradingSuggestion: ${sub.aiGradingSuggestion}`);
      console.log(`  - aiConfidence: ${sub.aiConfidence}`);
      console.log(`  - AI Analysis present: ${Boolean(String(sub.aiAnalysis || '').trim())}`);
      
      // Check SubmissionRaw
      const raw = await SubmissionRaw.findOne({ submissionId: sub._id }).lean();
      if (raw) {
        console.log(`  - Automark status: ${raw.automarkStatus}`);
        console.log(`  - Automark error: ${raw.automarkError || 'NONE'}`);
        console.log(`  - Total awarded marks: ${raw.totalAwardedMarks}`);
        console.log(`  - Per-question scores: ${raw.perQuestionScores ? raw.perQuestionScores.length : 0}`);
        
        if (raw.automarkReport) {
          const report = typeof raw.automarkReport === 'string' 
            ? JSON.parse(raw.automarkReport) 
            : raw.automarkReport;
          console.log(`  - Report totals: ${report?.totals?.awarded ?? 'NOT SET'}/${report?.totals?.max ?? 'NOT SET'}`);
          console.log(`  - Report questions: ${report?.questions?.length ?? 0}`);
          
          if (report?.questions && report.questions.length > 0) {
            const q = report.questions[0];
            console.log(`    • Q1: awarded=${q.awardedMarks}, max=${q.maxMarks}, conf=${q.confidence}`);
            console.log(`      mistakes: ${q.mistakes?.length || 0}, improvements: ${q.improvements?.length || 0}`);
            if (q.error) console.log(`      ERROR: ${q.error}`);
          }
        }
      } else {
        console.log(`  - SubmissionRaw: NOT FOUND`);
      }
    }

    // 3. Check for potential issues
    console.log('\n\n🔍 POTENTIAL ISSUES FOUND');
    console.log('=========================\n');
    
    const issues = [];
    
    // Issue 1: Assessments with no questions
    const emptyAssessments = allAssessments.filter(a => a.questionCount > 0 && (!a.questions || a.questions.length === 0));
    if (emptyAssessments.length > 0) {
      issues.push(`${emptyAssessments.length} assessments have questions marked but no questions array populated`);
    }
    
    // Issue 2: Check if any question marks are not set
    const allQuestions = await Question.find().lean();
    const questionsNoMarks = allQuestions.filter(q => !q.marks || q.marks === 0 || q.marks === null);
    if (questionsNoMarks.length > 0) {
      issues.push(`${questionsNoMarks.length} questions have no marks set or marks=0`);
    }
    
    // Issue 3: Check submissions with no extracted chunks
    const submissionsNoExtraction = allSubmissions.filter(s => 
      s.faissIngestionStatus !== 'completed' && s.faissIngestionStatus !== 'skipped'
    );
    if (submissionsNoExtraction.length > 0) {
      issues.push(`${submissionsNoExtraction.length} submissions haven't been extracted yet`);
    }
    
    if (issues.length === 0) {
      console.log('✅ No major issues detected!');
    } else {
      console.log('⚠️  Issues detected:\n');
      issues.forEach((issue, i) => {
        console.log(`${i + 1}. ${issue}`);
      });
    }

    console.log('\n\n💡 RECOMMENDATIONS');
    console.log('==================\n');
    console.log('If automark is not generating marks/suggestions/mistakes/reports:\n');
    console.log('1. Ensure Assessment has Questions populated (run query on assessments collection)');
    console.log('2. Ensure each Question has a "marks" field set (> 0)');
    console.log('3. Ensure Assessment has correct "totalMarks" value');
    console.log('4. Extract submissions first: Run "Extract Submissions" UI action');
    console.log('5. Check browser console for errors when clicking AutoMark');
    console.log('6. Check backend logs: npm run logs in backend/');
    console.log('7. Verify Ollama is running: curl http://localhost:11434/api/tags');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error?.message || String(error));
    console.error(error);
    process.exit(1);
  }
}

runDiagnostic();
