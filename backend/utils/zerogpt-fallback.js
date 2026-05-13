/**
 * ZeroGPT API Fallback Handler
 *
 * When ZeroGPT API fails:
 * 1. Gracefully returns 0% AI score (no AI detection)
 * 2. Allows plagiarism check to continue
 * 3. Logs the failure for debugging
 */

const axios = require("axios");

const ZEROGPT_API_URL = "https://api.zerogpt.com/api/detect/detectText";
const ZEROGPT_API_KEY = process.env.ZEROGPT_API_KEY || "8272130c-6a68-4418-a109-e8dd13b86ea4";
const ZEROGPT_TIMEOUT = 15000; // 15 seconds max

/**
 * Attempt to detect AI-generated content via ZeroGPT API.
 * Returns safe defaults if API fails.
 *
 * @param {string} text - Text to analyze (max 4800 chars)
 * @returns {Promise<{aiScore: number, isGptGenerated: boolean, feedback: string, error?: string}>}
 */
async function detectAIContent(text) {
  try {
    if (!text || text.length < 50) {
      // Not enough text to analyze
      return { aiScore: 0, isGptGenerated: false, feedback: "", skipped: "Text too short" };
    }

    // Call ZeroGPT API
    const { data } = await axios.post(
      ZEROGPT_API_URL,
      { input_text: text.slice(0, 4800) },
      {
        headers: {
          ApiKey: ZEROGPT_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: ZEROGPT_TIMEOUT,
      }
    );

    // Parse successful response
    if (data?.success && data?.data) {
      return {
        aiScore: Math.round(Number(data.data.fake_percentage || 0)),
        isGptGenerated: Boolean(data.data.is_gpt_generated),
        feedback: String(data.data.additional_feedback || ""),
      };
    }

    // API returned error response
    console.warn(`[ZEROGPT] API error: ${data?.message || "Unknown error"}`);
    return {
      aiScore: 0,
      isGptGenerated: false,
      feedback: "",
      error: data?.message || "API returned error",
    };
  } catch (err) {
    // Log error but don't fail the plagiarism check
    const errorMsg = err.response?.data?.detail || err.message || "Unknown error";
    console.warn(`[ZEROGPT] API request failed: ${errorMsg}`);

    // Graceful fallback
    return {
      aiScore: 0,
      isGptGenerated: false,
      feedback: "",
      error: errorMsg,
      unavailable: true,
    };
  }
}

/**
 * Check if ZeroGPT API is available (for status reporting).
 */
async function isZeroGPTAvailable() {
  try {
    const response = await axios.get(ZEROGPT_API_URL, {
      timeout: 5000,
      validateStatus: () => true, // Accept any status
    });
    // 401/403 means invalid key, but API is up
    // 2xx/4xx means API is responding
    return response.status < 500;
  } catch {
    return false; // API is down
  }
}

module.exports = {
  detectAIContent,
  isZeroGPTAvailable,
};
