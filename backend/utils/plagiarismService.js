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
const ZEROGPT_API_KEY = process.env.ZEROGPT_API_KEY || null;

// ═══════════════════════════════════════════════════════════════════════════
// PLAGIARISM DETECTION CONFIGURATION 
// ═══════════════════════════════════════════════════════════════════════════

// Risk level thresholds 
const RISK_THRESHOLDS = {
  high: 80,    
  medium: 50,  
  low: 0       
};

// Similarity filtering
const MIN_SIMILARITY_PERCENT = 15;      
const MIN_MATCH_WORD_COUNT = 20;        
const BLOCK_DETECTION_THRESHOLD = 100;  
const CODE_BLOCK_LINE_THRESHOLD = 10;   

// Score weighting: combine internal and external plagiarism
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
 * Remove non-original content from text to reduce false positives.
 * Filters out: questions, references, citations, headers, common templates, etc.
 */
function filterNonOriginalContent(text) {
  let filtered = text;

  // Remove question/prompt patterns
  filtered = filtered.replace(/^Question[\s:]+.*/gim, "");
  filtered = filtered.replace(/^(Task|Assignment|Problem)[\s:]+.*/gim, "");
  filtered = filtered.replace(/^Instructions?[\s:]+.*/gim, "");
  
  // Remove common header/footer patterns
  filtered = filtered.replace(/^(References|Bibliography|Citations|Sources|Works Cited|Appendix)[\s:]*\n[\s\S]*?(?=\n[A-Z]|\n\n|$)/gim, "");
  filtered = filtered.replace(/^(Author|Due Date|Date|Name|Student|Course|Class)[\s:]+.*/gim, "");
  
  // Remove common template markers
  filtered = filtered.replace(/\[.*?\]/g, "");  // Remove [bracketed placeholders]
  filtered = filtered.replace(/\{.*?\}/g, "");  // Remove {braced placeholders}
  filtered = filtered.replace(/TODO|FIXME|XXX|NOTE|HACK/gi, "");
  
  // Remove URLs and email addresses
  filtered = filtered.replace(/https?:\/\/[^\s]+/g, "");
  filtered = filtered.replace(/\S+@\S+\.\S+/g, "");
  
  // Clean up excessive whitespace
  filtered = filtered.replace(/\n\n\n+/g, "\n\n").trim();
  
  return filtered;
}

/**
 * Count words in text
 */
function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Detect large consecutive blocks of copied content.
 * Flags submissions with 100+ consecutive words or 10+ consecutive code lines from single source.
 */
function detectCopiedBlocks(matchedText, threshold = BLOCK_DETECTION_THRESHOLD) {
  if (!matchedText) return null;

  // Check word count for prose
  const wordCount = countWords(matchedText);
  if (wordCount >= threshold) {
    return {
      type: "prose_block",
      wordCount,
      description: `Large copied block detected: ${wordCount} consecutive words`
    };
  }

  // Check line count for code
  const lines = (matchedText || "").split(/\n/).filter(l => l.trim().length > 0);
  if (lines.length >= CODE_BLOCK_LINE_THRESHOLD) {
    return {
      type: "code_block",
      lineCount: lines.length,
      description: `Large copied code block detected: ${lines.length} consecutive lines`
    };
  }

  return null;
}

/**
 * Filter matches to exclude low similarity and short text.
 * Returns filtered array and optionally flags large consecutive blocks.
 */
function filterAndFlagMatches(matches) {
  const filtered = [];
  const largeBlocks = [];

  for (const match of matches) {
    const similarity = match.similarity || 0;
    const similarityPercent = similarity * 100;
    
    // Skip matches below minimum similarity threshold
    if (similarityPercent < MIN_SIMILARITY_PERCENT) {
      continue;
    }

    // Skip matches with insufficient word count
    const wordCount = countWords(match.matchedText);
    if (wordCount < MIN_MATCH_WORD_COUNT) {
      continue;
    }

    // Check for large copied blocks (even if overall similarity is low)
    const blockInfo = detectCopiedBlocks(match.matchedText);
    if (blockInfo) {
      largeBlocks.push({
        submissionId: match.submissionId,
        block: blockInfo,
        match
      });
    }

    filtered.push(match);
  }

  return { filtered, largeBlocks };
}

/**
 * Calculate average similarity from top N matches.
 * More realistic than using maximum similarity (reduces false positives).
 */
function calculateAverageSimilarity(matches, topN = 3) {
  if (!matches || matches.length === 0) return 0;

  const top = matches.slice(0, Math.min(topN, matches.length));
  const sum = top.reduce((acc, m) => acc + (m.similarity || 0), 0);
  return sum / top.length;
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
  // If no API key configured, skip AI detection
  if (!ZEROGPT_API_KEY) {
    console.warn("[PLAGIARISM] ZeroGPT API key not configured - skipping AI detection");
    return {
      aiScore: 0,
      isGptGenerated: false,
      additionalFeedback: "AI detection disabled (no API key configured)",
      sources: [],
      provider: 'zerogpt',
      unavailable: true
    };
  }

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
      additionalFeedback: `AI detection failed: ${err.message}`,
      sources: [],
      provider: 'zerogpt',
      unavailable: true
    };
  }
}

/**
 * Run (or return cached) plagiarism check for a submission.
 *
 * Improvements for accuracy:
 * - Uses average of top 3 matches (not max) to reduce false positives
 * - Filters out low similarity matches (<15%) and short matches (<20 words)
 * - Removes non-original content (questions, references, citations)
 * - Detects and flags large consecutive copied blocks
 * - Separates plagiarism score from AI detection score
 * - Uses higher risk thresholds (80%/50% instead of 60%/30%)
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
  let text = String(
    raw?.rawText || raw?.ocrText || submission.submissionText || ""
  ).trim();

  if (!text || text.length < 50) {
    const fallback = {
      submissionId, 
      internalScore: 0, 
      aiScore: 0, 
      plagiarismScore: 0,
      riskLevel: "low", 
      error: "Insufficient text extracted",
    };
    return fallback;
  }

  // Filter non-original content to reduce false positives
  const originalText = filterNonOriginalContent(text);
  const analysisText = originalText.length > 50 ? originalText : text;

  // Run similarity and AI detection in parallel
  const [internalMatches, aiResult] = await Promise.all([
    queryInternalSimilarity(analysisText, submission.studentId, submission.assessmentId?.toString(), 15),
    detectAIContent(analysisText),
  ]);

  // Filter matches: exclude low similarity and short matches
  const { filtered: relevantMatches, largeBlocks } = filterAndFlagMatches(internalMatches);

  // Sort by similarity and take top 5 for display
  const sortedMatches = [...relevantMatches]
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
    .slice(0, 5);

  // Calculate similarity using AVERAGE of top 3 (not max) for less harsh scoring
  const avgSimilarity = calculateAverageSimilarity(sortedMatches, 3);
  const internalScore = Math.round(avgSimilarity * 100);

  // Check for flagged large copied blocks (even if overall score is low)
  let blockDetectionFlag = null;
  if (largeBlocks.length > 0) {
    blockDetectionFlag = {
      detected: true,
      count: largeBlocks.length,
      blocks: largeBlocks.map(b => ({
        submission: b.submissionId,
        type: b.block.type,
        description: b.block.description,
        similarityPercent: Math.round((b.match.similarity || 0) * 100),
      }))
    };
  }

  // Combine internal and AI scores
  const overallScore = Math.round(internalScore * INTERNAL_WEIGHT + aiResult.aiScore * AI_WEIGHT);
  
  // Determine risk level based on combined score
  let riskLevel = "low";
  if (overallScore >= RISK_THRESHOLDS.high) {
    riskLevel = "high";
  } else if (overallScore >= RISK_THRESHOLDS.medium) {
    riskLevel = "medium";
  }

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
          wordCount:         countWords(m.matchedText),
        };
      } catch {
        return {
          submissionId:      m.submissionId,
          studentId:         m.studentId,
          similarityPercent: Math.round(m.similarity * 100),
          matchedText:       m.matchedText,
          wordCount:         countWords(m.matchedText),
        };
      }
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  const report = await PlagiarismReport.findOneAndUpdate(
    { submissionId },
    {
      submissionId,
      assessmentId:         submission.assessmentId,
      studentId:            submission.studentId,
      courseId:             submission.courseId,
      textLength:           text.length,
      filteredTextLength:   analysisText.length,
      
      internalScore,
      topMatches,
      aiScore:              aiResult.aiScore,
      isGptGenerated:       aiResult.isGptGenerated,
      aiAdditionalFeedback: aiResult.additionalFeedback,
      aiUnavailable:        aiResult.unavailable || false,
      
      blockDetectionFlag,
      copiedBlocksDetected: blockDetectionFlag?.detected || false,
      
      overallScore,
      riskLevel,
      sources:              aiResult.sources || [],
      provider:             aiResult.provider || 'zerogpt',
      checkedAt:            new Date(),
    },
    { upsert: true, new: true }
  );

  console.log(`[PLAGIARISM] ${submissionId} → overall=${overallScore}% (internal=${internalScore}%, AI=${aiResult.aiScore}%) [${riskLevel}]${blockDetectionFlag?.detected ? ' LARGE BLOCKS DETECTED' : ''}`);
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
