#!/usr/bin/env node
/**
 * Test Groq (OpenAI-compatible) API key for AutoMark.
 *
 * Uses:
 * - model: llama3-70b-8192
 * - temperature: 0.2
 * - max_tokens: 400
 *
 * Env:
 * - GROQ_API_KEY (preferred) or GROK_API_KEY
 * - GROQ_API_BASE (optional) default: https://api.groq.com/openai/v1
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

function now() {
  return Date.now();
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

async function main() {
  const apiKey =
    process.env.GROQ_API_AUTOMARK__KEY ||
    process.env.GROQ_API_AUTOMARK_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.GROK_API_KEY;
  if (!apiKey) {
    console.error(
      "❌ Missing GROQ_API_AUTOMARK_KEY (or GROQ_API_AUTOMARK__KEY / GROQ_API_KEY / GROK_API_KEY) in backend/.env or environment."
    );
    process.exit(1);
  }

  const base = String(process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const model = "llama-3.1-8b-instant";
  const temperature = 0.2;
  const max_tokens = 400;

  const payload = {
    model,
    temperature,
    max_tokens,
    messages: [
      {
        role: "system",
        content:
          "Return ONLY valid JSON. No markdown fences. No extra text. JSON schema: {\"awardedMarks\": number, \"confidence\": number}.",
      },
      {
        role: "user",
        content:
          "Question: Explain overfitting in ML.\nStudent answer: Overfitting is when model memorizes training data and performs poorly on new data.\nMax marks: 10\nReturn JSON only.",
      },
    ],
    response_format: { type: "json_object" },
  };

  console.log("=== Groq AutoMark API Key Test ===");
  console.log("Base:", base);
  console.log("Model:", model);
  console.log("temperature:", temperature, "max_tokens:", max_tokens);

  const f = await getFetch();
  const t0 = now();
  let res;
  try {
    res = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("❌ Network error calling Groq:", e?.message || String(e));
    process.exit(2);
  }

  const ms = now() - t0;
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep null
  }

  console.log("HTTP:", res.status, res.ok ? "(ok)" : "(not ok)", `latencyMs=${ms}`);
  if (!res.ok) {
    console.log("Response body:");
    console.log(text.slice(0, 2000));
    process.exit(3);
  }

  const content = json?.choices?.[0]?.message?.content ?? "";
  console.log("Usage:", safeJson(json?.usage || {}));
  console.log("Raw content:", String(content).slice(0, 800));

  // Validate JSON-only contract quickly
  try {
    const parsed = JSON.parse(String(content));
    const awardedMarks = Number(parsed?.awardedMarks);
    const confidence = Number(parsed?.confidence);
    console.log("Parsed:", safeJson({ awardedMarks, confidence }));
    console.log("✅ Groq key works and JSON parsed.");
    process.exit(0);
  } catch (e) {
    console.log("⚠️  Could not parse model content as JSON:", e?.message || String(e));
    process.exit(4);
  }
}

main().catch((e) => {
  console.error("❌ Unexpected error:", e?.message || String(e));
  process.exit(10);
});

