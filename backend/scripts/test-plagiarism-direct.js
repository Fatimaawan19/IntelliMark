#!/usr/bin/env node
/**
 * Direct plagiarism check test (no HTTP timeout).
 * Tests the new plagiarism detection logic directly via function call.
 *
 * Usage:
 *   node scripts/test-plagiarism-direct.js [--limit N] [--skip-ai]
 */

require("dotenv").config({ path: ".env" });
const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");

const MONGO_URI = process.env.MONGO_URI;

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 3;
const skipAI = args.includes("--skip-ai");

console.log("\n🧪 Direct Plagiarism Check Test");
console.log("================================\n");
console.log(`Limit: ${limit}`);
console.log(`Skip AI Detection: ${skipAI}\n`);

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB\n");

    // Get submissions with plagiarism reports
    const submissions = await Submission.find({
      plagiarismReport: { $exists: true, $ne: null },
      assessmentType: "assignment",
    })
      .limit(limit)
      .lean();

    if (submissions.length === 0) {
      console.log("No submissions found with plagiarism reports.");
      process.exit(0);
    }

    console.log(`📊 Testing ${submissions.length} submission(s)\n`);

    const fmt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(1) : "—";
    };

    for (const sub of submissions) {
      console.log(`\n${"═".repeat(80)}`);
      console.log(`📝 ${sub.studentName || sub.studentId}`);
      console.log(`   Assessment: ${sub.assessmentTitle}`);
      console.log(`${"═".repeat(80)}`);

      // Get raw submission data
      const rawDoc = await SubmissionRaw.findOne({ submissionId: sub._id }).lean();
      const text = String(rawDoc?.rawText || rawDoc?.ocrText || sub.submissionText || "").trim();

      console.log(`\n📋 Submission Text:`);
      console.log(`   Length: ${text.length} characters`);
      console.log(`   Preview: ${text.slice(0, 100)}...`);

      // Old report
      const oldReport = sub.plagiarismReport || {};
      console.log(`\n📊 OLD Report (cached):`);
      console.log(`   Phase: ${oldReport.meta?.phase}`);
      console.log(`   Internal Score: ${fmt(sub.plagiarismBestMatchPercent)}%`);
      console.log(`   Penalty: ${fmt(oldReport.penalty?.penaltyPercent)}%`);
      console.log(`   Matches: ${Array.isArray(oldReport.matches) ? oldReport.matches.length : 0}`);
      if (Array.isArray(oldReport.matches) && oldReport.matches.length > 0) {
        console.log(`     Top: ${oldReport.matches[0].studentName} (${fmt(oldReport.matches[0].matchPercent)}%)`);
      } else {
        console.log(`     ⚠️  NO MATCHES`);
      }
      console.log(`   AI Score: ${fmt(oldReport.aiScore || 0)}%`);
      console.log(`   GPT Generated: ${oldReport.isGptGenerated ? "Yes ⚠️" : "No"}`);

      // Test new direct logic
      console.log(`\n🧪 Test: Extract answers only`);
      const extractAnswersOnly = (txt) => {
        const s = String(txt || "").replace(/\r\n/g, "\n").trim();
        if (!s) return "";
        const lines = s.split("\n").map((l) => String(l || "").trim()).filter(Boolean);
        const out = [];
        for (const line of lines) {
          const looksLikeQuestionPrefix =
            /^q\s*\d+\s*[:.)-]/i.test(line) ||
            /^question\s*\d+\s*[:.)-]/i.test(line) ||
            /^q\d+\s*[:.)-]/i.test(line);
          if (!looksLikeQuestionPrefix) {
            out.push(line);
            continue;
          }
          const qMarkIdx = line.indexOf("?");
          if (qMarkIdx !== -1 && qMarkIdx + 1 < line.length) {
            const after = line.slice(qMarkIdx + 1).trim();
            if (after) out.push(after);
            continue;
          }
          const m = line.match(/^(.+?)([:.)-])\s*(.*)$/);
          const after = String(m?.[3] || "").trim();
          if (after) out.push(after);
        }
        return out.join("\n").trim();
      };

      const answersOnly = extractAnswersOnly(text);
      console.log(`   Original length: ${text.length}`);
      console.log(`   Answers-only length: ${answersOnly.length}`);
      if (answersOnly.length > 0) {
        console.log(`   Preview: ${answersOnly.slice(0, 80)}...`);
      }

      // Test penalty logic
      console.log(`\n🧪 Test: Penalty calculation logic`);
      const oldBestMatch = Number(oldReport.bestMatchPercent || 0);
      const oldMatches = Array.isArray(oldReport.matches) ? oldReport.matches.length : 0;
      const oldPenalty = Number(oldReport.penalty?.penaltyPercent || 0);

      console.log(`   Old: matches=${oldMatches}, bestMatch=${fmt(oldBestMatch)}%, penalty=${fmt(oldPenalty)}%`);

      const shouldPenalize = oldMatches > 0;
      const testPenalty = shouldPenalize ? oldPenalty : 0;
      const correct = testPenalty === oldPenalty;

      console.log(`   Test: Only penalize if matches > 0?`);
      console.log(`     Matches found: ${oldMatches}`);
      console.log(`     Should penalize: ${shouldPenalize}`);
      console.log(`     Test penalty would be: ${fmt(testPenalty)}%`);
      console.log(
        correct
          ? `   ✅ CORRECT`
          : `   ❌ WRONG - old penalty (${fmt(oldPenalty)}%) doesn't match logic`
      );

      // AI detection test
      if (!skipAI && Number(oldReport.aiScore || 0) > 0) {
        console.log(`\n🧪 Test: AI-Generated Content Detection`);
        console.log(`   ZeroGPT Score: ${fmt(oldReport.aiScore)}%`);
        console.log(`   Is GPT-Generated: ${oldReport.isGptGenerated}`);
        if (String(oldReport.aiAdditionalFeedback || "").trim()) {
          console.log(`   Feedback: ${oldReport.aiAdditionalFeedback.slice(0, 60)}...`);
        }
      }

      console.log(`\n${"─".repeat(80)}`);
    }

    console.log("\n✅ Test complete\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
