
const axios = require("axios");

const RAPIDAPI_HOST = "plagiarism-checker-and-auto-citation-generator.p.rapidapi.com";
const RAPIDAPI_KEY = process.env.RAPIDAPI_PLAGIARISM_KEY || "2b8f5fe721msh4de1ee6dce3969cp15803ejsn2b05096db";
const RAPIDAPI_URL = `https://${RAPIDAPI_HOST}/plagiarism`;
const TIMEOUT = 30000; // 30 seconds

/**
 * Detect plagiarism using Rapid API
 *
 * @param {string} text - Text to check for plagiarism (max 50,000 words)
 * @returns {Promise<{plagiarismScore: number, sources: Array, isplagarised: boolean, error?: string}>}
 */
async function detectPlagiarism(text) {
  try {
    if (!text || text.length < 50) {
      return {
        plagiarismScore: 0,
        sources: [],
        isPlagiarised: false,
        skipped: "Text too short"
      };
    }

    console.log(`[RAPIDAPI] Checking plagiarism for ${text.length} characters...`);

    const response = await axios.post(
      RAPIDAPI_URL,
      {
        text: text.slice(0, 50000), // Max 50,000 words
        language: "en"
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Host": RAPIDAPI_HOST,
          "X-RapidAPI-Key": RAPIDAPI_KEY
        },
        timeout: TIMEOUT
      }
    );

    const data = response.data || {};

    console.log(`[RAPIDAPI] Response status: ${response.status}`);
    console.log(`[RAPIDAPI] Plagiarism score: ${data.score || 0}%`);

    return {
      plagiarismScore: Math.round(Number(data.score || 0)),
      sources: Array.isArray(data.sources) ? data.sources.slice(0, 5) : [], // Top 5 sources
      isPlagiarised: Boolean(data.isPlagiarised),
      citations: data.citations || "",
      error: null,
      provider: "rapidapi"
    };
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message || "Unknown error";
    console.warn(`[RAPIDAPI] Plagiarism check failed: ${errorMsg}`);
    console.warn(`[RAPIDAPI] Status: ${err.response?.status}`);

    return {
      plagiarismScore: 0,
      sources: [],
      isPlagiarised: false,
      error: errorMsg,
      provider: "rapidapi",
      unavailable: true
    };
  }
}

/**
 * Check if Rapid API is available
 */
async function isRapidAPIAvailable() {
  try {
    const response = await axios.post(
      RAPIDAPI_URL,
      {
        text: "Test",
        language: "en"
      },
      {
        headers: {
          "X-RapidAPI-Host": RAPIDAPI_HOST,
          "X-RapidAPI-Key": RAPIDAPI_KEY
        },
        timeout: 5000,
        validateStatus: () => true
      }
    );
    return response.status < 500;
  } catch {
    return false;
  }
}

module.exports = {
  detectPlagiarism,
  isRapidAPIAvailable
};
