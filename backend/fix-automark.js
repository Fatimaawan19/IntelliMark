#!/usr/bin/env node
/**
 * AutoMark Fix Script - Helps resolve data issues
 * Run AFTER reviewing AUTOMARK_ISSUES_ANALYSIS.md
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');
const Question = require('./models/Question');
const Submission = require('./models/Submission');
const SubmissionRaw = require('./models/SubmissionRaw');

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected\n');

    const action = process.argv[2];

    if (action === 'find-best-assessment') {
      console.log('🔍 Finding best assessment to test AutoMark...\n');
      
      // Find assessment with questions + extracted submissions
      const assessments = await Assessment.find()
        .lean()
        .limit(50);

      for (const assessment of assessments) {
        const questions = await Question.find({ assessmentId: assessment._id }).lean();
        const submissions = await Submission.find({ assessmentId: assessment._id }).lean();
        const extractedSubs = submissions.filter(s => s.faissIngestionStatus === 'completed');
        
        if (questions.length > 0 && extractedSubs.length > 0) {
          console.log(`✅ GOOD ASSESSMENT FOR TESTING:`);
          console.log(`   Assessment: "${assessment.title}" (${assessment._id})`);
          console.log(`   - Questions: ${questions.length}`);
          console.log(`   - Total marks: ${assessment.totalMarks}`);
          console.log(`   - Extracted submissions: ${extractedSubs.length}`);
          console.log(`\n   Question details:`);
          questions.forEach((q, i) => {
            console.log(`   Q${i+1}: marks=${q.marks}, type=${q.questionType}`);
          });
          console.log(`\n   Test submission: ${extractedSubs[0].studentName} (${extractedSubs[0]._id})`);
          console.log(`   Try automarking this: POST /api/submissions/${extractedSubs[0]._id}/automark`);
          break;
        }
      }
      
      if (!found) {
        console.log(`❌ No suitable assessment found.`);
        console.log(`   Need: assessment with questions + extracted submission`);
        console.log(`   Action: Create new assessment, add questions, add submission, extract`);
      }

    } else if (action === 'check-failed-submissions') {
      console.log('🔎 Finding submissions with failed automark...\n');
      
      const failed = await SubmissionRaw.find({ automarkStatus: 'failed' }).lean().limit(10);
      
      if (failed.length === 0) {
        console.log('✅ No failed submissions found!');
      } else {
        console.log(`Found ${failed.length} failed submissions:\n`);
        for (const sub of failed) {
          const subDoc = await Submission.findById(sub.submissionId).lean();
          console.log(`• ${subDoc?.studentName} - Error: ${sub.automarkError}`);
        }
      }

    } else if (action === 'check-extraction-status') {
      console.log('📊 Checking extraction status of all submissions...\n');
      
      const statuses = {};
      const submissions = await Submission.find().lean();
      
      for (const sub of submissions) {
        const status = sub.faissIngestionStatus || 'unknown';
        statuses[status] = (statuses[status] || 0) + 1;
      }
      
      console.log('Extraction Status Summary:');
      for (const [status, count] of Object.entries(statuses)) {
        console.log(`  ${status}: ${count}`);
      }
      
      // Find submissions ready for automark
      const ready = await Submission.find({ faissIngestionStatus: 'completed' }).lean().limit(3);
      console.log(`\n✅ Ready for automark (extracted): ${ready.length + ' submissions'}`);
      for (const sub of ready) {
        console.log(`   - ${sub.studentName}: ${sub.assessmentId}`);
      }

    } else if (action === 'check-questions') {
      console.log('🔍 Checking question marks across assessments...\n');
      
      const allQuestions = await Question.find().lean();
      const noMarks = allQuestions.filter(q => !q.marks || q.marks === 0);
      
      console.log(`Total questions: ${allQuestions.length}`);
      console.log(`Questions with marks: ${allQuestions.length - noMarks.length}`);
      console.log(`Questions missing/zero marks: ${noMarks.length}`);
      
      if (noMarks.length > 0) {
        console.log(`\n⚠️  Sample of questions with missing marks:`);
        for (const q of noMarks.slice(0, 5)) {
          console.log(`   - "${String(q.questionText).slice(0, 40)}..." marks=${q.marks}`);
        }
      }

    } else {
      console.log(`Usage: node fix-automark.js <action>`);
      console.log(`\nActions:`);
      console.log(`  find-best-assessment    - Find a good assessment to test automark`);
      console.log(`  check-failed-submissions - Show failed automark attempts`);
      console.log(`  check-extraction-status - Show submission extraction status`);
      console.log(`  check-questions         - Check if questions have marks set`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error?.message);
    console.error(error);
    process.exit(1);
  }
}

main();
