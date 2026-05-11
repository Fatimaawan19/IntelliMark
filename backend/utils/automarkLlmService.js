const AutomarkJob = require("../models/AutomarkJob");
const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");
const { queryCourseMaterialChunks } = require("./courseMaterialRetrievalService");
const { querySubmissionChunks } = require("./submissionRetrievalService");
const { queryAssessmentReferenceChunks } = require("./assessmentReferenceRetrievalService");

const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";
// IMPORTANT: AutoMark must NEVER use the auto-generation model (OLLAMA_MODEL).
// It must use its own model env var, otherwise it can accidentally run phi3:mini for marking.
const OLLAMA_MODEL = process.env.AUTOMARK_OLLAMA_MODEL || "llama3:latest";
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "5m";
const { withExclusiveOllamaModel } = require("./ollamaModelManager");

// ===== Cloud LLM (Groq) for AutoMark with fallback to local Ollama =====
const AUTOMARK_LLM_PROVIDER = String(process.env.AUTOMARK_LLM_PROVIDER || "groq").toLowerCase(); // "groq" | "ollama"
const GROQ_API_KEY =
  process.env.GROQ_API_AUTOMARK_KEY ||
  process.env.GROQ_API_AUTOMARK__KEY ||
  process.env.GROQ_API_KEY ||
  process.env.GROK_API_KEY ||
  "";
const GROQ_API_BASE = String(process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const GROQ_AUTOMARK_MODEL = String(process.env.GROQ_AUTOMARK_MODEL || "llama-3.1-8b-instant").trim() || "llama-3.1-8b-instant";
const GROQ_AUTOMARK_TEMPERATURE = Number(process.env.GROQ_AUTOMARK_TEMPERATURE || 0.2);
const GROQ_AUTOMARK_MAX_TOKENS = Number(process.env.GROQ_AUTOMARK_MAX_TOKENS || 60);
const GROQ_AUTOMARK_MAX_TOKENS_TIER2 = Number(process.env.GROQ_AUTOMARK_MAX_TOKENS_TIER2 || 200);
const GROQ_AUTOMARK_TIMEOUT_MS = Number(process.env.GROQ_AUTOMARK_TIMEOUT_MS || 60000) || 60000;

const AUTOMARK_TOPK_STUDENT = Number(process.env.AUTOMARK_TOPK_STUDENT || 5) || 5;
const AUTOMARK_TOPK_REFERENCE = Number(process.env.AUTOMARK_TOPK_REFERENCE || 4) || 4;
const AUTOMARK_TOPK_RUBRIC = Number(process.env.AUTOMARK_TOPK_RUBRIC || 4) || 4;
const AUTOMARK_TOPK_COURSE_MATERIAL = Number(process.env.AUTOMARK_TOPK_COURSE_MATERIAL || 4) || 4;
const AUTOMARK_TOPK_CLO = Number(process.env.AUTOMARK_TOPK_CLO || 3) || 3;

const AUTOMARK_CHUNK_CHAR_LIMIT = Number(process.env.AUTOMARK_CHUNK_CHAR_LIMIT || 600) || 600;
const AUTOMARK_EXTRACTED_TEXT_CHAR_LIMIT =
  Math.max(0, Number(process.env.AUTOMARK_EXTRACTED_TEXT_CHAR_LIMIT || 3000) || 3000);

function evaluateTier3Decision({ confidence, hasStudentEvidence, awardedMarks, maxMarks }) {
  const reasons = [];
  // New logic: minimize manual review. Only flag for review when confidence is very low.
  const tier3Threshold = Number(process.env.AUTOMARK_TIER3_CONFIDENCE_THRESHOLD || 30) || 30;
  if (Number.isFinite(confidence) && confidence < tier3Threshold) reasons.push("low_confidence");

  return {
    needsTeacherReview: reasons.length > 0,
    reviewReason: reasons.join(","),
  };
}

function __dbg(location, message, data, hypothesisId) {
  const payload = {
    sessionId: "afcd7a",
    runId: "pre-fix",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };

  // Primary: send to debug ingest (may be unavailable in some environments)
  fetch("http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "afcd7a" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Fallback: append to local NDJSON file so we still get runtime evidence.
    try {
      const fs = require("fs");
      const path = require("path");
      const logPath = path.join(__dirname, "..", "..", "..", "debug-afcd7a.log");
      fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
    } catch {}
  });
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  const raw = String(text);
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isCloudRetriableError(err, status) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (msg.includes("timeout")) return true;
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("econnreset")) return true;
  return false;
}

async function generateJsonViaGroq({ prompt, maxTokens }) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ API key");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GROQ_AUTOMARK_TIMEOUT_MS);
  const resolvedMaxTokens = Number(maxTokens || 0) > 0 ? Number(maxTokens) : GROQ_AUTOMARK_MAX_TOKENS;
  const body = {
    model: GROQ_AUTOMARK_MODEL,
    temperature: GROQ_AUTOMARK_TEMPERATURE,
    max_tokens: resolvedMaxTokens,
    messages: [
      {
        role: "system",
        content: "Return ONLY valid JSON. No markdown, no extra text.",
      },
      { role: "user", content: String(prompt || "") },
    ],
    response_format: { type: "json_object" },
  };

  const url = `${GROQ_API_BASE}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(t);
  }

  const text = await res.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const errMsg =
      String(json?.error?.message || json?.error || "").trim() ||
      `Groq error (${res.status})`;
    const e = new Error(errMsg);
    e.status = res.status;
    throw e;
  }

  const content = String(json?.choices?.[0]?.message?.content || "").trim();
  const parsed = extractFirstJsonObject(content);
  if (!parsed) throw new Error("Cloud model did not return valid JSON");
  return parsed;
}

async function pushAutomarkJobLog(jobId, message, level = "info") {
  if (!jobId) return;
  try {
    await AutomarkJob.updateOne(
      { _id: jobId },
      { $push: { logs: { ts: new Date(), level, message } } }
    );
  } catch (e) {
    console.error(`[AUTOMARK] Failed to push log for jobId ${jobId}:`, e.message);
  }
}

async function generateJsonWithRetries({ prompt, options, maxRetries = 2, cloudMaxTokens = null }) {
  let lastErr = null;
  let result = null;
  async function _generateViaOllama() {
    await withExclusiveOllamaModel(
      {
        purpose: "automark",
        targetModel: OLLAMA_MODEL,
        unloadModels: [process.env.OLLAMA_MODEL].filter(Boolean),
      },
      async () => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          let __t0Req = null;
          try {
            __t0Req = Date.now();
            __dbg(
              "automarkLlmService.js:generateJsonWithRetries",
              "ollama_request_attempt",
              {
                attempt,
                model: OLLAMA_MODEL,
                promptLen: String(prompt || "").length,
                timeoutMs:
                  Number(process.env.AUTOMARK_OLLAMA_TIMEOUT_MS || "") ||
                  Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 600000) ||
                  600000,
                options: options ? Object.keys(options) : [],
              },
              "H2"
            );

            const timeoutMs =
              Number(process.env.AUTOMARK_OLLAMA_TIMEOUT_MS || "") ||
              Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 600000) ||
              600000;
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(`${OLLAMA_API_URL}/api/generate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                keep_alive: OLLAMA_KEEP_ALIVE,
                options,
              }),
            });

            clearTimeout(t);
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
              throw new Error(data?.error || `Ollama error (${response.status})`);
            }

            const rawResp = String(data?.response || data?.message || "");
            __dbg(
              "automarkLlmService.js:generateJsonWithRetries",
              "ollama_response_received",
              { attempt, ok: response.ok, status: response.status, respLen: rawResp.length, ms: Date.now() - __t0Req },
              "H2"
            );

            const parsed = extractFirstJsonObject(rawResp);
            if (!parsed) {
              throw new Error("Model did not return valid JSON");
            }

            result = parsed;
            return;
          } catch (e) {
            lastErr = e?.name === "AbortError" ? new Error("Ollama request timed out") : e;
            __dbg(
              "automarkLlmService.js:generateJsonWithRetries",
              "ollama_request_error",
              { attempt, error: String(lastErr?.message || lastErr), ms: __t0Req ? Date.now() - __t0Req : null },
              "H2"
            );

            if (attempt === maxRetries) {
              throw lastErr;
            }
          }
        }
      }
    );
  }

  // Primary: Groq (cloud). Fallback: local Ollama.
  if (AUTOMARK_LLM_PROVIDER === "groq") {
    const t0 = Date.now();
    try {
      __dbg(
        "automarkLlmService.js:generateJsonWithRetries",
        "cloud_request_attempt",
        {
          provider: "groq",
          model: GROQ_AUTOMARK_MODEL,
          promptLen: String(prompt || "").length,
          timeoutMs: GROQ_AUTOMARK_TIMEOUT_MS,
          maxTokens: Number(cloudMaxTokens || 0) > 0 ? Number(cloudMaxTokens) : GROQ_AUTOMARK_MAX_TOKENS,
        },
        "H11"
      );
      result = await generateJsonViaGroq({ prompt, maxTokens: cloudMaxTokens });
      result.__provider = "groq";
      __dbg(
        "automarkLlmService.js:generateJsonWithRetries",
        "cloud_request_ok",
        { provider: "groq", ms: Date.now() - t0 },
        "H11"
      );
      return result;
    } catch (e) {
      const status = Number(e?.status || 0) || 0;
      __dbg(
        "automarkLlmService.js:generateJsonWithRetries",
        "cloud_request_error",
        { provider: "groq", status, error: String(e?.message || e), ms: Date.now() - t0, willFallback: isCloudRetriableError(e, status) },
        "H11"
      );
      if (!isCloudRetriableError(e, status)) throw e;
      // fall through to Ollama
    }
  }

  await _generateViaOllama();

  if (!result) {
    throw lastErr || new Error("Model failed after retries");
  }

  result.__provider = "ollama";
  return result;
}

function normalizeMistake(m) {
  if (!m || typeof m !== "object") return null;

  const type = String(m.type || "").trim() || "note";
  const startIdx = Number.isFinite(m?.start_index) ? Number(m.start_index) : null;
  const endIdx = Number.isFinite(m?.end_index) ? Number(m.end_index) : null;
  const textSpan = String(m?.text_span || "").trim();
  const feedback = String(m?.feedback || m?.message || "").trim();
  const suggestion = String(m?.suggestion || m?.suggestedCorrection || "").trim();

  const legacyStart = Number.isFinite(m?.spanStart) ? Number(m.spanStart) : null;
  const legacyEnd = Number.isFinite(m?.spanEnd) ? Number(m.spanEnd) : null;
  const legacySpan = String(m?.evidenceQuote || "").trim();

  return {
    type,
    text_span: textSpan || legacySpan || "",
    start_index: startIdx != null ? startIdx : legacyStart,
    end_index: endIdx != null ? endIdx : legacyEnd,
    feedback,
    suggestion,
  };
}

function verifyMistakesAgainstExtractedText(mistakes, extractedText) {
  const text = String(extractedText || "");
  if (!Array.isArray(mistakes) || mistakes.length === 0) return [];
  if (!text.trim()) return [];

  const lower = text.toLowerCase();
  const out = [];

  const escapeRegExp = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tryLooseSpanMatch = (span) => {
    const tokens = String(span || "")
      .trim()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    // Need enough signal to avoid accidental matches.
    const strong = tokens.filter((t) => t.length >= 3);
    if (strong.length < 2) return null;
    const limited = strong.slice(0, 14); // keep regex safe
    const pattern = limited.map(escapeRegExp).join("\\s+");
    try {
      const re = new RegExp(pattern, "i");
      const m = re.exec(text);
      if (m && typeof m.index === "number" && m[0]) {
        return { start: m.index, end: m.index + m[0].length, matched: m[0] };
      }
    } catch {
      // ignore regex errors
    }
    return null;
  };

  for (const m of mistakes) {
    if (!m || typeof m !== "object") continue;
    const span = String(m?.text_span || "").trim();
    const s = Number.isFinite(m?.start_index) ? Number(m.start_index) : null;
    const e = Number.isFinite(m?.end_index) ? Number(m.end_index) : null;

    // Prefer index-based verification when provided.
    if (s != null && e != null && s >= 0 && e > s && e <= text.length) {
      const sub = text.slice(s, e).trim();
      if (!span || sub.toLowerCase() === span.toLowerCase()) {
        out.push(m);
        continue;
      }
    }

    // Fallback: quote search (case-insensitive) when span is present.
    if (span && span.length >= 6) {
      if (lower.includes(span.toLowerCase())) {
        out.push(m);
        continue;
      }
    }

    // OCR/text extraction often changes spacing/newlines. Try a loose match by allowing whitespace variation.
    if (span && span.length >= 6) {
      const loose = tryLooseSpanMatch(span);
      if (loose) {
        out.push({
          ...(m || {}),
          // Rewrite to a confirmed substring so frontend can highlight reliably.
          text_span: loose.matched,
          start_index: loose.start,
          end_index: loose.end,
        });
        continue;
      }
    }

    // If no evidence can be found, drop it (prevents false positives).
  }
  return out;
}

function buildPerQuestionScoresFromReport(report) {
  const qs = Array.isArray(report?.questions) ? report.questions : [];
  return qs.map((q) => {
    const fromLlmRaw = Array.isArray(q?.mistakes) ? q.mistakes : [];
    const fromLlm = fromLlmRaw.map(normalizeMistake).filter(Boolean);
    // IMPORTANT: Never fabricate mistakes from uncovered/improvements.
    // If the LLM didn't provide verified mistakes, return an empty list (0 mistakes).
    const mistakes = fromLlm.length > 0 ? fromLlm : [];

    return {
      questionKey: q?.questionKey || "",
      awardedMarks: Number(q?.awardedMarks ?? 0) || 0,
      maxMarks: Number(q?.maxMarks ?? 0) || 0,
      confidence: Number(q?.confidence ?? 0) || 0,
      summary: String(q?.summary || q?.studentAnswerSummary || "").trim(),
      feedback: String(q?.feedback || "").trim(),
      needsTeacherReview: Boolean(q?.needsTeacherReview),
      reviewReason: String(q?.reviewReason || "").trim(),
      mistakes,
    };
  });
}

/**
 * ========== MAIN FUNCTION — NOW GUARANTEES DATA PERSISTENCE ==========
 * 
 * Key change: Explicitly save SubmissionRaw AFTER all questions,
 * THEN update Submission. This ensures the report exists in the DB
 * before the model unloads.
 */
async function automarkOneSubmission(subDoc, assessment, questions, jobId = null) {
  const assessmentId = String(assessment._id);
  const DEFAULT_MAX_MARKS_PER_QUESTION = Number(process.env.AUTOMARK_DEFAULT_MAX_MARKS || 10) || 10;
  const __t0Submission = Date.now();
  const sumQuestionMarks = (Array.isArray(questions) ? questions : []).reduce(
    (acc, q) => acc + (Number(q?.marks ?? 0) || DEFAULT_MAX_MARKS_PER_QUESTION),
    0
  );
  const assessmentTotalMarks = Number(assessment?.totalMarks ?? 0) || 0;
  const resolvedMaxTotal =
    sumQuestionMarks > 0 ? sumQuestionMarks : assessmentTotalMarks > 0 ? assessmentTotalMarks : Number(subDoc?.maxGrade ?? 0) || 0;

  const report = {
    submissionId: String(subDoc._id),
    assessmentId,
    assessmentTitle: assessment.title || "",
    generatedAt: new Date().toISOString(),
    model: OLLAMA_MODEL,
    questions: [],
    totals: {
      awarded: 0,
      max: resolvedMaxTotal,
    },
    confidence: null,
  };

  __dbg('automarkLlmService.js:automarkOneSubmission', 'start_submission', {
    submissionId: String(subDoc?._id || ''),
    assessmentId,
    questionCount: Array.isArray(questions) ? questions.length : 0,
    model: OLLAMA_MODEL,
    ollamaApi: OLLAMA_API_URL,
    timeoutMs:
      Number(process.env.AUTOMARK_OLLAMA_TIMEOUT_MS || "") ||
      Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || 600000) ||
      600000,
  }, 'H1');

  let confidenceSum = 0;
  let confidenceCount = 0;
  let needsTeacherReviewCount = 0;
  let hadAnyLlmError = false;
  let firstLlmError = "";

  // ===== MAIN LOOP: Grade each question =====
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    const qKey = `Q${i + 1}`;
    const maxMarks = Number(q.marks ?? 0) > 0 ? Number(q.marks) : DEFAULT_MAX_MARKS_PER_QUESTION;
    const questionText = String(q.questionText || "").trim();
    const questionType = String(q.questionType || "").trim();
    // Always include qKey so FAISS retrieval can latch onto multi-file Q-tagged chunks
    // (e.g., filenames like *_Q1_* become "question: Q1" headers during ingestion).
    const retrievalQuery = `${qKey} ${questionText || ""}`.trim() || `${assessment.title || "Assessment"} ${qKey}`;

    if (jobId) {
      await pushAutomarkJobLog(
        jobId,
        `${String(subDoc.studentName || subDoc.studentId || "Student")}: processing ${qKey}…`
      );
    }

    const isAssignment = String(assessment?.type || "").toLowerCase() === "assignment";

    // Retrieve chunks from all sources (Tier-1: keep context small)
    const courseIdForMaterials =
      subDoc.courseId && typeof subDoc.courseId === "object" && subDoc.courseId._id
        ? String(subDoc.courseId._id)
        : String(subDoc.courseId || "");

    const __t0Retrieval = Date.now();
    const [studentChunks, sampleChunks, rubricChunksForQ, rubricChunksAll, cloChunksAll, courseMaterialChunks] =
      await Promise.all([
      querySubmissionChunks(retrievalQuery, {
        topK: AUTOMARK_TOPK_STUDENT,
        submissionId: String(subDoc._id),
        assessmentId,
        studentId: String(subDoc.studentId || ""),
      }).catch((e) => {
        console.error(`[AUTOMARK] Failed to query student chunks for ${qKey}:`, e.message);
        return [];
      }),
      queryAssessmentReferenceChunks(retrievalQuery, {
        topK: AUTOMARK_TOPK_REFERENCE,
        assessmentId,
        questionId: qKey,
        referenceType: "sample_answer",
      }).catch((e) => {
        console.error(`[AUTOMARK] Failed to query sample chunks for ${qKey}:`, e.message);
        return [];
      }),
      isAssignment
        ? queryAssessmentReferenceChunks(retrievalQuery, {
            topK: AUTOMARK_TOPK_RUBRIC,
            assessmentId,
            questionId: qKey,
            referenceType: "rubric",
          }).catch((e) => {
            console.error(`[AUTOMARK] Failed to query rubric chunks for ${qKey}:`, e.message);
            return [];
          })
        : Promise.resolve([]),
      isAssignment
        ? queryAssessmentReferenceChunks(retrievalQuery, {
            topK: AUTOMARK_TOPK_RUBRIC,
            assessmentId,
            questionId: "ALL",
            referenceType: "rubric",
          }).catch((e) => {
            console.error(`[AUTOMARK] Failed to query all rubric chunks:`, e.message);
            return [];
          })
        : Promise.resolve([]),
      queryAssessmentReferenceChunks(retrievalQuery, {
        topK: AUTOMARK_TOPK_CLO,
        assessmentId,
        questionId: "ALL",
        referenceType: "clo",
      }).catch((e) => {
        console.error(`[AUTOMARK] Failed to query CLO chunks:`, e.message);
        return [];
      }),
      courseIdForMaterials
        ? queryCourseMaterialChunks(retrievalQuery, {
            topK: AUTOMARK_TOPK_COURSE_MATERIAL,
            courseId: courseIdForMaterials,
          }).catch((e) => {
            console.error(`[AUTOMARK] Failed to query course material chunks:`, e.message);
            return [];
          })
        : Promise.resolve([]),
    ]);

    __dbg(
      "automarkLlmService.js:automarkOneSubmission",
      "retrieval_done",
      {
        qKey,
        ms: Date.now() - __t0Retrieval,
        counts: {
          student: Array.isArray(studentChunks) ? studentChunks.length : 0,
          sample: Array.isArray(sampleChunks) ? sampleChunks.length : 0,
          rubricQ: Array.isArray(rubricChunksForQ) ? rubricChunksForQ.length : 0,
          rubricAll: Array.isArray(rubricChunksAll) ? rubricChunksAll.length : 0,
          cloAll: Array.isArray(cloChunksAll) ? cloChunksAll.length : 0,
        },
      },
      "H6"
    );

    __dbg(
      "automarkLlmService.js:automarkOneSubmission",
      "course_material_done",
      { qKey, count: Array.isArray(courseMaterialChunks) ? courseMaterialChunks.length : 0 },
      "H6"
    );

    // Get extracted text for highlighting
    let extractedTextForSpans = "";
    try {
      const raw = await SubmissionRaw.findOne({ submissionId: subDoc._id })
        .select("rawText ocrText")
        .lean()
        .catch(() => null);
      extractedTextForSpans = String(raw?.rawText || "").trim() || String(raw?.ocrText || "");
      if (AUTOMARK_EXTRACTED_TEXT_CHAR_LIMIT > 0 && extractedTextForSpans.length > AUTOMARK_EXTRACTED_TEXT_CHAR_LIMIT) {
        extractedTextForSpans = extractedTextForSpans.slice(0, AUTOMARK_EXTRACTED_TEXT_CHAR_LIMIT);
      }
    } catch (e) {
      console.error(`[AUTOMARK] Failed to fetch extracted text:`, e.message);
      extractedTextForSpans = "";
    }

    __dbg(
      "automarkLlmService.js:automarkOneSubmission",
      "extracted_text_loaded",
      { qKey, charCount: extractedTextForSpans.length, usedLimit: AUTOMARK_EXTRACTED_TEXT_CHAR_LIMIT },
      "H7"
    );

    // Build context strings
    const studentContext = (studentChunks || [])
      .slice(0, AUTOMARK_TOPK_STUDENT)
      .map(
        (c, idx) =>
          `[#${idx + 1} sim=${Number(c.similarity || 0).toFixed(3)}]\n${String(c.text || "").slice(0, AUTOMARK_CHUNK_CHAR_LIMIT)}`
      )
      .join("\n\n");

    const referenceContext = (sampleChunks || [])
      .slice(0, AUTOMARK_TOPK_REFERENCE)
      .map(
        (c, idx) =>
          `[#${idx + 1} sim=${Number(c.similarity || 0).toFixed(3)}]\n${String(c.text || "").slice(0, AUTOMARK_CHUNK_CHAR_LIMIT)}`
      )
      .join("\n\n");

    const mergedRubricChunks = [...(rubricChunksForQ || []), ...(rubricChunksAll || [])];
    const rubricContext = (mergedRubricChunks || [])
      .slice(0, AUTOMARK_TOPK_RUBRIC)
      .map(
        (c, idx) =>
          `[#${idx + 1} sim=${Number(c.similarity || 0).toFixed(3)}]\n${String(c.text || "").slice(0, AUTOMARK_CHUNK_CHAR_LIMIT)}`
      )
      .join("\n\n");

    const cloContext = (cloChunksAll || [])
      .slice(0, AUTOMARK_TOPK_CLO)
      .map((c, idx) => `[#${idx + 1} sim=${Number(c.similarity || 0).toFixed(3)}]\n${String(c.text || "").slice(0, 700)}`)
      .join("\n\n");

    const courseMaterialContext = (courseMaterialChunks || [])
      .slice(0, AUTOMARK_TOPK_COURSE_MATERIAL)
      .map(
        (c, idx) =>
          `[#${idx + 1} sim=${Number(c.similarity || 0).toFixed(3)}]\n${String(c.text || "").slice(0, AUTOMARK_CHUNK_CHAR_LIMIT)}`
      )
      .join("\n\n");

    // Tier-1 prompt: minimal output to keep the model fast and reliable.
    // For coding questions: if a rubric is present, treat it as REQUIRED.
    const prompt = `You are an automated grading assistant for a ${assessment.type || "quiz"}.
Return ONLY valid JSON. No markdown. No \`\`\`json. No extra keys. No text.

Task:
- Grade the student's answer for ${qKey}.
- Award marks between 0 and ${maxMarks} (can be decimal).
- Be strict but fair. If evidence is missing, reduce marks.
- Evidence rule: Only award marks if supported by STUDENT SUBMISSION chunks.
${isAssignment ? `- If a MARKING RUBRIC is present below, use it as guidance.` : ``}
${String(questionType || "").toLowerCase() === "coding" ? `- CODING QUESTION RULE: If a MARKING RUBRIC is present below, you MUST grade against it (required). Map rubric points to evidence in the student's submission. Do NOT guess missing work.` : ``}

QUESTION (${qKey}) [type=${questionType || "unknown"}] [maxMarks=${maxMarks}]
${questionText}

CLO / LEARNING OUTCOME (RAG chunks)
${cloContext || "NO_CLO_FOUND"}

COURSE MATERIALS (RAG chunks)
${courseMaterialContext || "NO_COURSE_MATERIAL_FOUND"}

${isAssignment ? `MARKING RUBRIC (RAG chunks)\n${rubricContext || "NO_RUBRIC_FOUND"}` : ""}

REFERENCE SAMPLE ANSWER (RAG chunks)
${referenceContext || "NO_REFERENCE_FOUND"}

STUDENT SUBMISSION (RAG chunks)
${studentContext || "NO_SUBMISSION_TEXT_FOUND"}

STUDENT EXTRACTED TEXT (for exact spanStart/spanEnd highlighting)
IMPORTANT:
- If you include start_index/end_index in mistakes, they MUST be character indices into THIS exact text block.
- start_index is inclusive, end_index is exclusive.
- The substring studentText[start_index:end_index] MUST exactly match text_span (after trimming) when start/end are provided.
${extractedTextForSpans ? extractedTextForSpans : "NO_EXTRACTED_TEXT_FOUND"}

Output JSON schema (MUST match exactly):
{"awardedMarks": number, "confidence": number}`;

    let awardedMarks = 0;
    let confidence = 0;
    let feedback = "";
    let needsTeacherReview = false;
    let reviewReason = "";
    let summary = "";
    let strengths = [];
    let improvements = [];
    let evidence = [];
    let studentAnswerSummary = "";
    let keyPoints = [];
    let coverage = [];
    let rubricBreakdown = [];
    let mistakes = [];
    let error = "";
    let tier1Provider = "ollama";

    // ===== LLM CALL (Tier-1 scoring) =====
    try {
      const llmStartedAt = Date.now();

      const parsed = await generateJsonWithRetries({
        prompt,
        options: {
          temperature: 0.2,
          top_p: 0.9,
          num_ctx: Math.max(512, Number(process.env.AUTOMARK_NUM_CTX || 2048) || 2048),
        },
        maxRetries: 2,
        cloudMaxTokens: GROQ_AUTOMARK_MAX_TOKENS,
      });

      const llmMs = Date.now() - llmStartedAt;
      tier1Provider = String(parsed?.__provider || "").trim().toLowerCase() || "ollama";

      awardedMarks = Number(parsed.awardedMarks ?? 0) || 0;
      const boundedMax = maxMarks;
      // Some models return confidence in [0,1]. Normalize to [0,100].
      const rawConf = Number(parsed.confidence ?? 50);
      const normalizedConf = Number.isFinite(rawConf) ? (rawConf <= 1 ? rawConf * 100 : rawConf) : 50;
      confidence = Math.max(0, Math.min(100, normalizedConf || 50));
      // Tier-1: keep extra fields empty to avoid overloading model output
      summary = "";
      studentAnswerSummary = "";
      strengths = [];
      improvements = [];
      evidence = [];
      mistakes = [];
      keyPoints = [];
      coverage = [];
      rubricBreakdown = [];

      const clampMax = Number.isFinite(boundedMax) ? boundedMax : maxMarks;
      awardedMarks = Math.max(0, Math.min(clampMax, awardedMarks));

      // ===== TIER 3 (teacher review): decision helper (no duplicated logic) =====
      const hasStudentEvidence =
        (Array.isArray(studentChunks) && studentChunks.length > 0) &&
        String(studentContext || "").trim() &&
        String(studentContext || "").trim() !== "NO_SUBMISSION_TEXT_FOUND";
      const tier3 = evaluateTier3Decision({ confidence, hasStudentEvidence, awardedMarks, maxMarks });
      needsTeacherReview = Boolean(tier3.needsTeacherReview);
      reviewReason = String(tier3.reviewReason || "");
      if (needsTeacherReview) needsTeacherReviewCount += 1;

      if (jobId) {
        await pushAutomarkJobLog(
          jobId,
          `${String(subDoc.studentName || subDoc.studentId || "Student")}: ${qKey} done (${awardedMarks}/${maxMarks}, ${llmMs}ms)`
        );
      }

      __dbg('automarkLlmService.js:automarkOneSubmission', 'parsed_result', {
        submissionId: String(subDoc?._id || ''),
        qKey,
        awardedMarks,
        maxMarks,
        confidence,
      }, 'H5');

    } catch (e) {
      error = e?.message || String(e);
      awardedMarks = 0;
      confidence = 0;
      needsTeacherReview = false;
      reviewReason = "";
      hadAnyLlmError = true;

      if (!firstLlmError) {
        firstLlmError = String(error || "");
      }

      console.error(`[AUTOMARK] LLM failed for ${qKey}: ${error}`);

      if (jobId) {
        await pushAutomarkJobLog(
          jobId,
          `${String(subDoc.studentName || subDoc.studentId || "Student")}: ${qKey} failed: ${error}`,
          "error"
        );
      }

      __dbg('automarkLlmService.js:automarkOneSubmission', 'llm_failed_for_question', {
        submissionId: String(subDoc?._id || ''),
        qKey,
        error: String(error || ''),
      }, 'H2');
    }

    // ===== TIER-2 FEEDBACK: one-sentence feedback + 1-5 mistakes =====
    // For assignments: always.
    // For quizzes: run when the answer isn't full marks (or confidence is low), so teachers get explanations.
    // If this fails, keep feedback/mistakes empty (do not fail the whole grading).
    const shouldRunTier2 =
      Boolean(isAssignment) ||
      // For quizzes: if marks were deducted, always produce feedback (even if retrieval is weak).
      Number(awardedMarks ?? 0) < Number(maxMarks ?? 0) ||
      Number(confidence ?? 0) < 55;

    if (shouldRunTier2) {
      try {
        const feedbackPrompt = `You are an automated grading assistant.
Return ONLY valid JSON. No markdown. No \`\`\`json. No extra keys. No text.

Task:
- Write exactly ONE helpful sentence of feedback to the student for ${qKey}.
- Also list 1-5 mistakes in a "mistakes" array.
- Each mistake MUST point to the exact text span in STUDENT EXTRACTED TEXT (below) using either:
  - start_index/end_index (character indices), OR
  - text_span (exact quote to find).
- Keep each field short.
- Keep it short and actionable.
- Base it on the student's submission evidence below and the reference (sample answer).
${String(questionType || "").toLowerCase() === "coding" ? `- CODING QUESTION RULE: If a rubric is present, list mistakes that correspond to missing/incorrect rubric points (required).` : `- If a rubric is present, use it as guidance.`}

QUESTION (${qKey}) [maxMarks=${maxMarks}]
${questionText}

MARKING RUBRIC (optional)
${rubricContext || "NO_RUBRIC_FOUND"}

REFERENCE SAMPLE ANSWER
${referenceContext || "NO_REFERENCE_FOUND"}

STUDENT SUBMISSION (evidence)
${studentContext || "NO_SUBMISSION_TEXT_FOUND"}

STUDENT EXTRACTED TEXT (for exact spanStart/spanEnd highlighting)
IMPORTANT:
- If you include start_index/end_index, they MUST be character indices into THIS exact text block.
- start_index is inclusive, end_index is exclusive.
- The substring studentText[start_index:end_index] MUST exactly match text_span (after trimming) when start/end are provided.
${extractedTextForSpans ? extractedTextForSpans : "NO_EXTRACTED_TEXT_FOUND"}

Output JSON schema (MUST match exactly):
{"feedback": string, "mistakes": [{"text_span": string, "start_index": number|null, "end_index": number|null, "explanation": string, "why_wrong": string, "correct_answer": string|null}]}`;

        const parsed2 = await generateJsonWithRetries({
          prompt: feedbackPrompt,
          options: {
            temperature: 0.2,
            top_p: 0.9,
            num_ctx: Math.max(512, Number(process.env.AUTOMARK_NUM_CTX || 2048) || 2048),
          },
          maxRetries: 1,
          cloudMaxTokens: GROQ_AUTOMARK_MAX_TOKENS_TIER2,
        });
        feedback = String(parsed2?.feedback || "").trim();
        if (feedback.length > 220) feedback = feedback.slice(0, 220);
        const tier2MistakesRaw = Array.isArray(parsed2?.mistakes) ? parsed2.mistakes.slice(0, 5) : [];
        const tier2Mistakes = tier2MistakesRaw
          .map((m) => {
            if (m && typeof m === "object") {
              const textSpan = String(m?.text_span || m?.textSpan || "").trim();
              const start = Number.isFinite(m?.start_index) ? Number(m.start_index) : null;
              const end = Number.isFinite(m?.end_index) ? Number(m.end_index) : null;
              const explanation = String(m?.explanation || "").trim();
              const whyWrong = String(m?.why_wrong || m?.whyWrong || "").trim();
              const correct = String(m?.correct_answer || m?.correctAnswer || "").trim();
              if (!explanation) return null;
              return {
                type: "mistake",
                text_span: textSpan,
                start_index: start,
                end_index: end,
                feedback: explanation,
                why_wrong: whyWrong,
                suggestion: correct,
              };
            }
            const msg = String(m || "").trim();
            if (!msg) return null;
            return {
              type: "note",
              text_span: "",
              start_index: null,
              end_index: null,
              feedback: msg,
              why_wrong: "",
              suggestion: "",
            };
          })
          .filter(Boolean);

        if (tier2Mistakes.length) {
          mistakes = [...(Array.isArray(mistakes) ? mistakes : []), ...tier2Mistakes];
        }
      } catch (e) {
        // Keep feedback/mistakes empty, but log so "missing analysis" isn't silent.
        if (jobId) {
          await pushAutomarkJobLog(
            jobId,
            `${String(subDoc.studentName || subDoc.studentId || "Student")}: ${qKey} feedback/mistakes failed: ${e?.message || String(e)}`,
            "warning"
          ).catch(() => {});
        }
      }
    }

    // ===== VERIFICATION LAYER: remove ungrounded mistakes =====
    // Only keep mistakes we can confirm exist in the extracted student text.
    // This reduces false positives (e.g., hallucinated issues not present in code).
    try {
      mistakes = verifyMistakesAgainstExtractedText(Array.isArray(mistakes) ? mistakes : [], extractedTextForSpans).slice(0, 10);
    } catch {
      // best-effort only
    }

    // ===== APPEND RESULT TO REPORT =====
    report.questions.push({
      questionKey: qKey,
      questionId: q?._id ? String(q._id) : null,
      questionType: questionType || null,
      questionText,
      awardedMarks,
      maxMarks,
      confidence,
      feedback,
      needsTeacherReview,
      reviewReason,
      studentAnswerSummary,
      summary,
      strengths,
      improvements,
      evidence,
      keyPoints,
      coverage,
      rubricBreakdown,
      mistakes,
      llmProvider: String(tier1Provider || "ollama"),
      retrieval: {
        studentChunksFound: Array.isArray(studentChunks) ? studentChunks.length : 0,
        sampleChunksFound: Array.isArray(sampleChunks) ? sampleChunks.length : 0,
      },
      error: error || null,
    });

    report.totals.awarded += awardedMarks;
    confidenceSum += confidence;
    confidenceCount += 1;

    // ===== PERSIST PROGRESS AFTER EACH QUESTION =====
    // This is critical: save after each question so we don't lose data if the process crashes
    try {
      const perQuestionScoresSoFar = buildPerQuestionScoresFromReport(report);
      const updateResult = await SubmissionRaw.updateOne(
        { submissionId: subDoc._id },
        {
          $setOnInsert: { submissionId: subDoc._id },
          $set: {
            assessmentId: subDoc.assessmentId || assessment?._id || null,
            courseId: subDoc.courseId || null,
            teacherId: String(subDoc.teacherId || ""),
            studentId: String(subDoc.studentId || ""),
            automarkStatus: "processing",
            automarkError: "",
            automarkReport: report,
            perQuestionScores: perQuestionScoresSoFar,
            totalAwardedMarks: Number(report?.totals?.awarded ?? 0) || 0,
            automarkedAt: new Date(),
          },
        },
        { upsert: true }
      );

      const acknowledged = updateResult?.acknowledged;
      if (acknowledged === false) {
        console.warn(`[AUTOMARK] SubmissionRaw.updateOne not acknowledged`, updateResult);
      }

    } catch (e) {
      console.error(`[AUTOMARK] Failed to persist progress after ${qKey}:`, e.message);
      // Log but continue — we don't want to fail the entire grading due to a DB issue
    }
  }

  // ===== FINALIZE TOTALS =====
  const maxTotal = Number(report.totals.max || 0) || 0;
  if (maxTotal > 0 && report.totals.awarded > maxTotal) {
    report.totals.awarded = maxTotal;
  }
  const avgConfidence = confidenceCount ? Math.round(confidenceSum / confidenceCount) : null;
  report.confidence = avgConfidence;
  report.needsTeacherReviewCount = needsTeacherReviewCount;
  report.needsTeacherReview = needsTeacherReviewCount > 0;

  // ===== UPDATE MAIN SUBMISSION DOCUMENT =====
  // ONLY if there were NO LLM errors. Otherwise we mark as failed so UI can retry.
  let submissionUpdateResult = null;

  if (!hadAnyLlmError) {
    try {
      const submissionMistakes = (Array.isArray(report?.questions) ? report.questions : [])
        .map((q) => ({
          questionKey: String(q?.questionKey || "").trim(),
          confidence: Number(q?.confidence ?? 0) || 0,
          feedback: String(q?.feedback || "").trim(),
          needsTeacherReview: Boolean(q?.needsTeacherReview),
          reviewReason: String(q?.reviewReason || "").trim(),
          mistakes: Array.isArray(q?.mistakes) ? q.mistakes.map((m) => String(m?.feedback || "").trim()).filter(Boolean).slice(0, 10) : [],
        }))
        .filter((x) => x.questionKey);

      const anyNeedsReview = needsTeacherReviewCount > 0;
      submissionUpdateResult = await Submission.updateOne(
        { _id: subDoc._id },
        {
          $set: {
            // Always mark as graded; if low-confidence, keep a review flag (UI shows "Review Needed").
            grade: report.totals.awarded,
            gradedAt: new Date(),
            aiGradingSuggestion: report.totals.awarded,
            aiConfidence: avgConfidence,
            aiAnalysis: JSON.stringify(report),
            mistakes: submissionMistakes,
            needsTeacherReview: anyNeedsReview,
            status: "graded",
            ...(Number(subDoc?.maxGrade ?? 0) > 0 ? {} : { maxGrade: Number(report?.totals?.max ?? 0) || 0 }),
          },
        }
      );

      if (submissionUpdateResult?.acknowledged !== false) {
        console.log(`[AUTOMARK] Updated Submission ${subDoc._id}: ${report.totals.awarded}/${report.totals.max}`);
      } else {
        console.warn(`[AUTOMARK] Submission update not acknowledged`, submissionUpdateResult);
      }

    } catch (e) {
      console.error(`[AUTOMARK] Failed to update Submission:`, e.message);
      hadAnyLlmError = true;
      if (!firstLlmError) firstLlmError = `Failed to save grades: ${e.message}`;
    }
  } else {
    console.warn(`[AUTOMARK] Skipping Submission update due to LLM errors`);
  }

  // ===== FINALIZE SubmissionRaw WITH COMPLETION STATUS =====
  try {
    const perQuestionScores = buildPerQuestionScoresFromReport(report);
    const finalUpdateResult = await SubmissionRaw.updateOne(
      { submissionId: subDoc._id },
      {
        $setOnInsert: { submissionId: subDoc._id },
        $set: {
          assessmentId: subDoc.assessmentId || assessment?._id || null,
          courseId: subDoc.courseId || null,
          teacherId: String(subDoc.teacherId || ""),
          studentId: String(subDoc.studentId || ""),
          automarkStatus: hadAnyLlmError ? "failed" : "completed",
          automarkError: hadAnyLlmError ? (firstLlmError || "LLM failed") : "",
          automarkReport: report,
          perQuestionScores,
          totalAwardedMarks: Number(report?.totals?.awarded ?? 0) || 0,
          automarkedAt: new Date(),
        },
      },
      { upsert: true }
    );

    if (finalUpdateResult?.acknowledged !== false) {
      console.log(`[AUTOMARK] Finalized SubmissionRaw ${subDoc._id}: status=${hadAnyLlmError ? "failed" : "completed"}`);
    } else {
      console.warn(`[AUTOMARK] Final SubmissionRaw update not acknowledged`, finalUpdateResult);
    }

  } catch (e) {
    console.error(`[AUTOMARK] Failed to finalize SubmissionRaw:`, e.message);
  }

  // ===== RETURN RESULT =====
  report.failed = Boolean(hadAnyLlmError);
  report.error = hadAnyLlmError ? String(firstLlmError || "LLM failed") : "";
  report.provider =
    String(report?.questions?.[0]?.llmProvider || "").trim().toLowerCase() ||
    (AUTOMARK_LLM_PROVIDER === "groq" ? "groq" : "ollama");

  console.log(
    `[AUTOMARK] automarkOneSubmission completed: submission=${String(subDoc._id)}, ` +
    `grade=${report.totals.awarded}/${report.totals.max}, failed=${report.failed}`
  );

  return report;
}

module.exports = {
  OLLAMA_API_URL,
  OLLAMA_MODEL,
  extractFirstJsonObject,
  generateJsonWithRetries,
  pushAutomarkJobLog,
  automarkOneSubmission,
  buildPerQuestionScoresFromReport,
};