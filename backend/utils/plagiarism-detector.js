

const axios = require("axios");

// Service configurations
const SERVICES = {
  rapidapi: {
    name: "Rapid API",
    enabled: Boolean(process.env.RAPIDAPI_PLAGIARISM_KEY),
    timeout: 30000,
    weight: 0.6 // 60% of final score
  },
  zerogpt: {
    name: "ZeroGPT",
    enabled: Boolean(process.env.ZEROGPT_API_KEY),
    timeout: 20000,
    weight: 0.4 // 40% of final score
  }
};

/**
 * Main plagiarism detection function
 * Tries multiple services and combines results
 *
 * @param {string} text - Student answer text
 * @returns {Promise<{
 *   score: number,
 *   sources: Array,
 *   isPlagiarised: boolean,
 *   provider: string,
 *   error?: string
 * }>}
 */
async function detectPlagiarism(text) {
  if (!text || text.length < 50) {
    return {
      score: 0,
      sources: [],
      isPlagiarised: false,
      provider: "none",
      skipped: "Text too short"
    };
  }

  console.log(`[PLAGIARISM] Starting detection for ${text.length} characters`);

  const results = [];
  let bestResult = null;

  // Try Rapid API first (online source detection)
  if (SERVICES.rapidapi.enabled) {
    console.log(`[PLAGIARISM] Attempting Rapid API...`);
    try {
      const result = await detectViaRapidAPI(text);
      if (!result.error) {
        console.log(`[PLAGIARISM] ✅ Rapid API success: ${result.score}%`);
        results.push(result);
        bestResult = result;
      } else {
        console.warn(`[PLAGIARISM] ⚠️  Rapid API failed: ${result.error}`);
        if (result.error.includes("Too many requests")) {
          console.warn(`[PLAGIARISM] Rate limit hit. Trying alternative service...`);
        }
      }
    } catch (err) {
      console.error(`[PLAGIARISM] Rapid API error: ${err.message}`);
    }
  }

  // Fallback to ZeroGPT if Rapid API failed or unavailable
  if (!bestResult && SERVICES.zerogpt.enabled) {
    console.log(`[PLAGIARISM] Attempting ZeroGPT...`);
    try {
      const result = await detectViaZeroGPT(text);
      if (!result.error) {
        console.log(`[PLAGIARISM] ✅ ZeroGPT success: ${result.score}%`);
        results.push(result);
        bestResult = result;
      } else {
        console.warn(`[PLAGIARISM] ⚠️  ZeroGPT failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`[PLAGIARISM] ZeroGPT error: ${err.message}`);
    }
  }

  // If all services failed, return safe default
  if (!bestResult) {
    console.warn(`[PLAGIARISM] ⚠️  All services failed. Returning safe default.`);
    return {
      score: 0,
      sources: [],
      isPlagiarised: false,
      provider: "fallback",
      error: "All plagiarism detection services unavailable. Please try again later.",
      allServicesFailed: true
    };
  }

  return bestResult;
}

/**
 * Detect via Rapid API
 */
async function detectViaRapidAPI(text) {
  try {
    const response = await axios.post(
      "https://plagiarism-checker-and-auto-citation-generator.p.rapidapi.com/plagiarism",
      {
        text: text.slice(0, 50000),
        language: "en"
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Host": "plagiarism-checker-and-auto-citation-generator.p.rapidapi.com",
          "X-RapidAPI-Key": process.env.RAPIDAPI_PLAGIARISM_KEY
        },
        timeout: SERVICES.rapidapi.timeout
      }
    );

    const data = response.data || {};
    const sources = Array.isArray(data.sources) ? data.sources.slice(0, 10).map(s => ({
      url: String(s.url || ""),
      title: String(s.title || s.source || "Online Source"),
      matchPercentage: Number(s.percentage || 0)
    })) : [];
    return {
      score: Math.round(Number(data.score || 0)),
      sources,
      isPlagiarised: Boolean(data.isPlagiarised),
      provider: "rapidapi",
      error: null
    };
  } catch (err) {
    const statusCode = err.response?.status;
    const statusText = err.response?.statusText;
    const errorMsg = err.response?.data?.message || err.message;

    let userMessage = errorMsg;

    if (statusCode === 429) {
      userMessage = "Too many requests - Rapid API rate limit hit";
    } else if (statusCode === 401) {
      userMessage = "Invalid Rapid API key";
    } else if (statusCode >= 500) {
      userMessage = "Rapid API service temporarily unavailable";
    }

    return {
      score: 0,
      sources: [],
      isPlagiarised: false,
      provider: "rapidapi",
      error: userMessage,
      statusCode
    };
  }
}

/**
 * Detect via ZeroGPT (AI-generated content)
 */
async function detectViaZeroGPT(text) {
  try {
    const response = await axios.post(
      "https://api.zerogpt.com/api/detect/detectText",
      {
        input_text: text.slice(0, 4800)
      },
      {
        headers: {
          ApiKey: process.env.ZEROGPT_API_KEY,
          "Content-Type": "application/json"
        },
        timeout: SERVICES.zerogpt.timeout
      }
    );

    const data = response.data || {};
    if (data.success && data.data) {
      return {
        score: Math.round(Number(data.data.fake_percentage || 0)),
        sources: [],  // ZeroGPT doesn't provide source URLs
        isPlagiarised: Boolean(data.data.is_gpt_generated),
        provider: "zerogpt",
        error: null,
        feedback: String(data.data.additional_feedback || "")
      };
    }

    return {
      score: 0,
      sources: [],
      isPlagiarised: false,
      provider: "zerogpt",
      error: data.message || "Unknown API error"
    };
  } catch (err) {
    return {
      score: 0,
      sources: [],
      isPlagiarised: false,
      provider: "zerogpt",
      error: err.message,
      feedback: ""
    };
  }
}

/**
 * Check which services are available
 */
async function getAvailableServices() {
  const services = [];

  if (SERVICES.rapidapi.enabled) {
    services.push({
      name: "Rapid API",
      available: await isServiceAvailable("rapidapi"),
      priority: 1
    });
  }

  if (SERVICES.zerogpt.enabled) {
    services.push({
      name: "ZeroGPT",
      available: await isServiceAvailable("zerogpt"),
      priority: 2
    });
  }

  return services;
}

async function isServiceAvailable(serviceName) {
  try {
    if (serviceName === "rapidapi") {
      await axios.head(
        "https://plagiarism-checker-and-auto-citation-generator.p.rapidapi.com/plagiarism",
        {timeout: 5000, validateStatus: () => true}
      );
      return true;
    } else if (serviceName === "zerogpt") {
      await axios.head("https://api.zerogpt.com", {timeout: 5000, validateStatus: () => true});
      return true;
    }
  } catch {
    return false;
  }
}

module.exports = {
  detectPlagiarism,
  getAvailableServices,
  SERVICES
};
