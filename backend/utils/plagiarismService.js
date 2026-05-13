const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const PlagiarismReport = require("../models/PlagiarismReport");
const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");

const RAG_DIR = path.join(__dirname, "..", "rag_marking");
const SUBMISSIONS_INDEX_DIR = path.join(RAG_DIR, "faiss_submissions_index");

// ZeroGPT API — AI-generated content detection
const ZEROGPT_API_URL = "https://api.zerogpt.com/api/detect/detectText";
const ZEROGPT_API_KEY = process.env.ZEROGPT_API_KEY || "8272130c-6a68-4418-a109-e8dd13b86ea4";

// Score weighting: 60% internal student-match, 40% AI-generated
const INTERNAL_WEIGHT = 0.6;
const AI_WEIGHT = 0.4;

function resolvePythonExecutable() {
  const envPython = (process.env.PYTHON_BIN || "").trim();
  if (envPython) {
    const abs = path.isAbsolute(envPython) ? envPython : path.join(__dirname, "..", envPython);
    if (fs.existsSync(abs)) return abs;
  }
  const venv = path.join(__dirname, "..", "..", ".venv-1", "Scripts", "python.exe");
  if (fs.existsSync(venv)) return venv;
  return "python";
}

/**
 * Search FAISS submissions index for chunks similar to `text`,
 * excluding the submitting student and restricting to the same assessment.
 * Returns array of { submissionId, studentId, assessmentId, similarity, matchedText }.
 */
function queryInternalSimilarity(text, excludeStudentId, assessmentId, topK = 15) {
  return new Promise((resolve) => {
    const pythonExec = resolvePythonExecutable();
    const escapedRagDir = RAG_DIR.replace(/\\/g, "\\\\");
    const escapedIndexDir = SUBMISSIONS_INDEX_DIR.replace(/\\/g, "\\\\");

    const code = `
import json, sys
from pathlib import Path
sys.path.insert(0, r'${escapedRagDir}')

query_text = ${JSON.stringify(String(text || "").slice(0, 2000))}
exclude_student = ${excludeStudentId ? JSON.stringify(String(excludeStudentId)) : "None"}
filter_assessment = ${assessmentId ? JSON.stringify(String(assessmentId)) : "None"}
top_k = ${Number(topK)}
index_dir = Path(r'${escapedIndexDir}')

try:
    from faiss_vector_store import FAISSVectorStore
    store = FAISSVectorStore(index_dir=index_dir)
    result = store.query(query_text, top_k=top_k * 3)
    matches = result.get('matches', []) or []

    out = []
    for m in matches:
        md = m.get('metadata') or {}
        sid = str(md.get('student_id', ''))
        aid = str(md.get('assessment_id', ''))
        if exclude_student and sid == str(exclude_student):
            continue
        if filter_assessment and aid != str(filter_assessment):
            continue
        out.append({
            'submissionId': str(md.get('submission_id', '')),
            'studentId': sid,
            'assessmentId': aid,
            'similarity': float(m.get('score') or 0.0),
            'matchedText': (m.get('text') or '')[:300],
        })
        if len(out) >= ${Number(topK)}:
            break

    print(json.dumps({'success': True, 'results': out}))
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e), 'results': []}))
`;

    const proc = spawn(pythonExec, ["-c", code], {
      cwd: RAG_DIR,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    const timer = setTimeout(() => { proc.kill(); resolve([]); }, 60000);

    proc.stdout.on("data", d => (stdout += d.toString()));
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.results || []);
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Call ZeroGPT API to detect AI-generated content percentage.
 * Returns { aiScore: 0-100, isGptGenerated: bool, additionalFeedback: string, sources: [], provider: string }
 */
async function detectAIContent(text) {
  try {
    const { data } = await axios.post(
      ZEROGPT_API_URL,
      { input_text: text.slice(0, 4800) },
      {
        headers: { ApiKey: ZEROGPT_API_KEY, "Content-Type": "application/json" },
        timeout: 20000,
      }
    );
    return {
      aiScore: Math.round(Number(data?.data?.fake_percentage || 0)),
      isGptGenerated: Boolean(data?.data?.is_gpt_generated),
      additionalFeedback: String(data?.data?.additional_feedback || ""),
      sources: [],  // ZeroGPT doesn't return sources, only AI percentage
      provider: 'zerogpt'
    };
  } catch (err) {
    console.warn("[PLAGIARISM] ZeroGPT API error:", err.message);
    return {
      aiScore: 0,
      isGptGenerated: false,
      additionalFeedback: "",
      sources: [],
      provider: 'zerogpt'
    };
  }
}

/**
 * Run (or return cached) plagiarism check for a submission.
 *
 * Determinism guarantee: once a report is stored, re-runs return the
 * exact same scores. Pass { forceRefresh: true } to recompute.
 *
 * Only processes assignment-type submissions; returns null for quizzes.
 */
async function checkPlagiarism(submissionId, { forceRefresh = false } = {}) {
  // Return cached result immediately (ensures deterministic repeated calls)
  if (!forceRefresh) {
    const cached = await PlagiarismReport.findOne({ submissionId }).lean();
    if (cached) return { ...cached, isCached: true };
  }

  const submission = await Submission.findById(submissionId).lean();
  if (!submission) throw new Error(`Submission ${submissionId} not found`);

  // Plagiarism check is assignment-only
  if (submission.assessmentType !== "assignment") return null;

  // Get extracted text (already done by AutoMark pipeline)
  const raw = await SubmissionRaw.findOne({ submissionId }).lean();
  const text = String(
    raw?.rawText || raw?.ocrText || submission.submissionText || ""
  ).trim();

  if (!text || text.length < 50) {
    const fallback = {
      submissionId, internalScore: 0, aiScore: 0, overallScore: 0,
      riskLevel: "low", error: "Insufficient text extracted",
    };
    return fallback;
  }

  const [internalMatches, aiResult] = await Promise.all([
    queryInternalSimilarity(text, submission.studentId, submission.assessmentId?.toString(), 15),
    detectAIContent(text),
  ]);

  // Top 5 most similar submissions
  const sortedMatches = [...internalMatches].sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  const internalScore = sortedMatches.length > 0
    ? Math.round(sortedMatches[0].similarity * 100)
    : 0;

  // Enrich matches with student names from Submission collection
  const topMatches = await Promise.all(
    sortedMatches.map(async (m) => {
      if (!m.submissionId) return m;
      try {
        const s = await Submission.findById(m.submissionId)
          .select("studentName studentId assessmentTitle")
          .lean();
        return {
          submissionId:      m.submissionId,
          studentId:         m.studentId,
          studentName:       s?.studentName || m.studentId,
          assessmentTitle:   s?.assessmentTitle || "",
          similarityPercent: Math.round(m.similarity * 100),
          matchedText:       m.matchedText,
        };
      } catch {
        return {
          submissionId:      m.submissionId,
          studentId:         m.studentId,
          similarityPercent: Math.round(m.similarity * 100),
          matchedText:       m.matchedText,
        };
      }
    })
  );

  const overallScore = Math.round(internalScore * INTERNAL_WEIGHT + aiResult.aiScore * AI_WEIGHT);
  const riskLevel = overallScore >= 60 ? "high" : overallScore >= 30 ? "medium" : "low";

  const report = await PlagiarismReport.findOneAndUpdate(
    { submissionId },
    {
      submissionId,
      assessmentId:         submission.assessmentId,
      studentId:            submission.studentId,
      courseId:             submission.courseId,
      textLength:           text.length,
      internalScore,
      topMatches,
      aiScore:              aiResult.aiScore,
      isGptGenerated:       aiResult.isGptGenerated,
      aiAdditionalFeedback: aiResult.additionalFeedback,
      overallScore,
      riskLevel,
      sources:              aiResult.sources || [],  // Add external sources (e.g., from Rapid API)
      provider:             aiResult.provider || 'zerogpt',  // Track which service detected external plagiarism
      checkedAt:            new Date(),
    },
    { upsert: true, new: true }
  );

  console.log(`[PLAGIARISM] ${submissionId} → overall=${overallScore}% (internal=${internalScore}%, AI=${aiResult.aiScore}%) [${riskLevel}]`);
  return report.toObject();
}

/**
 * Get all plagiarism reports for an assessment (for teacher dashboard).
 */
async function getAssessmentPlagiarismReports(assessmentId) {
  return PlagiarismReport.find({ assessmentId }).sort({ overallScore: -1 }).lean();
}

/**
 * Get a student's plagiarism reports across all their submissions.
 */
async function getStudentPlagiarismReports(studentId) {
  return PlagiarismReport.find({ studentId }).sort({ checkedAt: -1 }).lean();
}

module.exports = {
  checkPlagiarism,
  getAssessmentPlagiarismReports,
  getStudentPlagiarismReports,
};
