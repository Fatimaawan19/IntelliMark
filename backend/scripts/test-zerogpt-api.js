#!/usr/bin/env node
/**
 * Test ZeroGPT API for AI-generated content detection.
 * Verifies the external plagiarism detection is working.
 *
 * Usage:
 *   node scripts/test-zerogpt-api.js [--text "sample text"] [--aggressive]
 */

require("dotenv").config({ path: ".env" });
const axios = require("axios");

const ZEROGPT_API_URL = "https://api.zerogpt.com/api/detect/detectText";
const ZEROGPT_API_KEY = process.env.ZEROGPT_API_KEY || "8272130c-6a68-4418-a109-e8dd13b86ea4";

// Test samples
const samples = {
  human_short: `The water cycle is the continuous process of water moving between the Earth's surface and the atmosphere.
Water evaporates from oceans, lakes, and rivers, turning into water vapor. This vapor rises into the atmosphere where
it cools and condenses into clouds. Eventually, the water falls back to Earth as precipitation in the form of rain or snow.
This water then flows back to the oceans through rivers and streams, completing the cycle.`,

  human_long: `Throughout history, education has played a crucial role in shaping society and advancing human civilization.
The importance of learning cannot be overstated, as it provides individuals with the knowledge and skills necessary to
navigate an increasingly complex world. Different cultures have developed unique educational systems reflecting their values,
beliefs, and practical needs. In ancient Greece, education focused on developing well-rounded citizens through philosophy, rhetoric,
and physical training. During the Middle Ages, the Church became the primary educational institution, preserving knowledge and
teaching religious doctrine. The Renaissance brought a renewed emphasis on classical learning and humanism. In modern times,
education systems have become more standardized and accessible, though significant disparities remain between developed and
developing nations. Technology is increasingly transforming how we learn and teach, with online education and digital resources
becoming more prevalent. The future of education will likely involve a blend of traditional and digital approaches, emphasizing
critical thinking, creativity, and lifelong learning to prepare students for rapidly changing employment landscapes.`,

  gpt_sample: `The phenomenon of artificial intelligence has revolutionized numerous industries and continues to reshape our
world in profound and multifaceted ways. Machine learning algorithms, which constitute a pivotal component of contemporary AI systems,
enable computers to learn from data without being explicitly programmed. This paradigm shift has facilitated the development of
sophisticated neural networks that can perform tasks previously requiring human intelligence. Natural language processing, a
subfield of artificial intelligence, has achieved remarkable progress in recent years, enabling machines to comprehend and generate
human language with increasing sophistication. The applications of AI are ubiquitous, spanning from healthcare diagnostics to
autonomous vehicles, financial forecasting to content recommendation systems. However, the advancement of artificial intelligence
also raises important ethical considerations and societal implications. Issues such as algorithmic bias, data privacy, and workforce
displacement warrant careful examination and thoughtful policy-making. The trajectory of AI development necessitates collaboration
between technologists, policymakers, and society at large to ensure responsible innovation and equitable distribution of benefits.`,
};

console.log("\n🤖 ZeroGPT API Test Suite");
console.log("========================\n");
console.log(`API URL: ${ZEROGPT_API_URL}`);
console.log(`API Key: ${ZEROGPT_API_KEY.slice(0, 8)}...${ZEROGPT_API_KEY.slice(-8)}\n`);

const testZeroGPT = async (text, label) => {
  try {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`📝 Test: ${label}`);
    console.log(`${"─".repeat(80)}`);
    console.log(`Text length: ${text.length} characters`);
    console.log(`Preview: ${text.slice(0, 100)}...\n`);

    console.log(`⏳ Calling ZeroGPT API...`);
    const startTime = Date.now();

    const { data } = await axios.post(
      ZEROGPT_API_URL,
      { input_text: text.slice(0, 4800) },
      {
        headers: {
          ApiKey: ZEROGPT_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Response received in ${duration}ms\n`);

    // Parse response
    console.log(`📊 Results:`);
    if (data?.data) {
      const result = data.data;
      const fakePercentage = Number(result.fake_percentage || 0);
      const isGptGenerated = Boolean(result.is_gpt_generated);
      const feedback = String(result.additional_feedback || "");

      console.log(`   AI-Generated Score: ${fakePercentage}%`);
      console.log(`   Is GPT Generated: ${isGptGenerated ? "✅ YES (Likely AI)" : "❌ NO (Human written)"}`);

      if (feedback) {
        console.log(`   Feedback: ${feedback.slice(0, 150)}${feedback.length > 150 ? "..." : ""}`);
      }

      // Interpretation
      console.log(`\n   Interpretation:`);
      if (fakePercentage >= 80) {
        console.log(`   🚨 VERY HIGH - Almost certainly AI-generated`);
      } else if (fakePercentage >= 60) {
        console.log(`   ⚠️  HIGH - Likely AI-generated or heavily AI-assisted`);
      } else if (fakePercentage >= 40) {
        console.log(`   ⚡ MODERATE - Possibly AI-generated or unusual writing style`);
      } else if (fakePercentage >= 20) {
        console.log(`   ℹ️  LOW - Likely human-written with some AI influence`);
      } else {
        console.log(`   ✅ VERY LOW - Appears to be human-written`);
      }

      return { success: true, score: fakePercentage, isGpt: isGptGenerated, duration };
    } else {
      console.log(`❌ Unexpected response format:`);
      console.log(JSON.stringify(data, null, 2));
      return { success: false, error: "Invalid response format" };
    }
  } catch (err) {
    console.log(`❌ Error: ${err.message}`);
    if (err.response?.data) {
      console.log(`Response: ${JSON.stringify(err.response.data, null, 2)}`);
    }
    return { success: false, error: err.message };
  }
};

(async () => {
  try {
    console.log(`🧪 Testing ${Object.keys(samples).length} samples...\n`);

    const results = [];

    // Test human-written short
    const r1 = await testZeroGPT(samples.human_short, "Human-Written (Short)");
    results.push({ name: "Human-Written (Short)", ...r1 });

    // Wait between requests
    await new Promise((r) => setTimeout(r, 2000));

    // Test human-written long
    const r2 = await testZeroGPT(samples.human_long, "Human-Written (Long)");
    results.push({ name: "Human-Written (Long)", ...r2 });

    // Wait between requests
    await new Promise((r) => setTimeout(r, 2000));

    // Test GPT-generated
    const r3 = await testZeroGPT(samples.gpt_sample, "GPT-Generated Sample");
    results.push({ name: "GPT-Generated Sample", ...r3 });

    // Summary
    console.log(`\n${"═".repeat(80)}`);
    console.log(`📊 Summary Report`);
    console.log(`${"═".repeat(80)}\n`);

    const successCount = results.filter((r) => r.success).length;
    console.log(`✅ Successful tests: ${successCount}/${results.length}`);

    if (successCount > 0) {
      console.log(`\nAPI Status: 🟢 WORKING\n`);

      console.log(`Sample Results:`);
      for (const r of results) {
        if (r.success) {
          const status = r.isGpt ? "🤖 AI" : "👤 Human";
          console.log(`  • ${r.name.padEnd(30)} - ${r.score}% ${status} (${r.duration}ms)`);
        }
      }

      // Verify discrimination
      const humanAvg = results
        .filter((r) => r.name.includes("Human") && r.success)
        .reduce((sum, r) => sum + r.score, 0) / results.filter((r) => r.name.includes("Human") && r.success).length;

      const gptScore = results.find((r) => r.name.includes("GPT") && r.success)?.score || 0;

      console.log(`\n📈 Quality Check:`);
      console.log(`   Human average: ${humanAvg.toFixed(1)}%`);
      console.log(`   GPT sample: ${gptScore}%`);

      if (gptScore > humanAvg + 20) {
        console.log(`   ✅ GOOD: Clear differentiation between human and AI`);
      } else if (gptScore > humanAvg) {
        console.log(`   ⚠️  WEAK: Some differentiation but could be improved`);
      } else {
        console.log(`   ❌ POOR: Cannot distinguish human from AI`);
      }

      console.log(`\n🎯 Recommendation:`);
      if (gptScore > humanAvg + 30) {
        console.log(`   ✅ ZeroGPT API is working well for detecting AI-generated content`);
      } else {
        console.log(`   ⚠️  ZeroGPT API may need tuning or different test samples`);
      }
    } else {
      console.log(`\nAPI Status: 🔴 NOT WORKING\n`);
      console.log(`All tests failed. Possible issues:`);
      console.log(`  • Invalid API key`);
      console.log(`  • API service is down`);
      console.log(`  • Network connectivity issues`);
      console.log(`  • Rate limiting`);
    }

    // Direct submission test
    console.log(`\n${"═".repeat(80)}`);
    console.log(`🔍 Test: Real Submission Text`);
    console.log(`${"═".repeat(80)}\n`);

    const mongoose = require("mongoose");
    const MONGO_URI = process.env.MONGO_URI;

    await mongoose.connect(MONGO_URI);
    const Submission = require("../models/Submission");
    const SubmissionRaw = require("../models/SubmissionRaw");

    const latestSub = await Submission.findOne({ assessmentType: "assignment" })
      .sort({ submittedAt: -1 })
      .select("_id studentName assessmentTitle")
      .lean();

    if (latestSub) {
      const raw = await SubmissionRaw.findOne({ submissionId: latestSub._id }).select("rawText").lean();
      const text = String(raw?.rawText || "").slice(0, 4800).trim();

      if (text && text.length > 50) {
        console.log(`Testing: ${latestSub.studentName} - ${latestSub.assessmentTitle}\n`);
        const r4 = await testZeroGPT(text, "Real Submission");

        if (r4.success) {
          console.log(`\n💡 Submission AI Score: ${r4.score}%`);
          if (r4.isGpt) {
            console.log(`   ⚠️  This submission may contain AI-generated content`);
          } else {
            console.log(`   ✅ This submission appears to be human-written`);
          }
        }
      }
    }

    await mongoose.disconnect();
    console.log("\n✅ Test suite complete\n");
    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
})();
