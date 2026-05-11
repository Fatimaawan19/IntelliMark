/**
 * Submission Retrieval Service - Query student submission chunks from FAISS.
 *
 * Uses a dedicated FAISS index stored in backend/rag_marking/faiss_submissions_index.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const RAG_DIR = path.join(__dirname, '..', 'rag_marking');
const ROOT_DIR = path.join(__dirname, '..', '..');
const VENV_PYTHON = path.join(ROOT_DIR, '.venv-1', 'Scripts', 'python.exe');
const SUBMISSIONS_INDEX_DIR = path.join(RAG_DIR, 'faiss_submissions_index');

// #region agent log
function __dbg(location, message, data, hypothesisId, runId = "pre-fix") {
  const payload = {
    sessionId: "afcd7a",
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };

  fetch("http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "afcd7a" },
    body: JSON.stringify(payload),
  }).catch(() => {
    try {
      const logPath = path.join(__dirname, "..", "..", "..", ".cursor", "debug-afcd7a.log");
      fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`);
    } catch {}
  });
}
// #endregion

function resolvePythonExecutable() {
  if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
    const envPython = process.env.PYTHON_BIN.trim();
    if (path.isAbsolute(envPython) && fs.existsSync(envPython)) return envPython;
  }
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return 'python';
}

/**
 * Query FAISS for relevant submission chunks.
 *
 * Options:
 * - topK: number
 * - submissionId: string | null (filter results)
 * - assessmentId: string | null
 * - studentId: string | null
 */
function querySubmissionChunks(query, options = {}) {
  return new Promise((resolve, reject) => {
    const { topK = 8, submissionId = null, assessmentId = null, studentId = null } = options;
    const pythonExec = resolvePythonExecutable();
    const t0 = Date.now();

    __dbg(
      "submissionRetrievalService.js:querySubmissionChunks",
      "spawn_start",
      { pythonExec, topK, hasSubmissionId: Boolean(submissionId), hasAssessmentId: Boolean(assessmentId), hasStudentId: Boolean(studentId), queryLen: String(query || "").length },
      "H8"
    );

    const pythonCode = `
import json
import sys
from pathlib import Path
sys.path.insert(0, r'${RAG_DIR}')

query_text = ${JSON.stringify(String(query || ''))}
top_k = ${Number.isFinite(topK) ? Math.max(1, Number(topK)) : 8}
submission_id = ${submissionId ? JSON.stringify(String(submissionId)) : 'None'}
assessment_id = ${assessmentId ? JSON.stringify(String(assessmentId)) : 'None'}
student_id = ${studentId ? JSON.stringify(String(studentId)) : 'None'}
index_dir = Path(r'${SUBMISSIONS_INDEX_DIR}')

try:
    from faiss_vector_store import FAISSVectorStore
    store = FAISSVectorStore(index_dir=index_dir)
    result = store.query(query_text, top_k=top_k)
    matches = result.get('matches', []) or []
    prefilter_count = len(matches)

    out = { 'success': True, 'results': [], 'debug': { 'prefilter_count': prefilter_count, 'postfilter_count': 0, 'filters': { 'submission_id': submission_id, 'assessment_id': assessment_id, 'student_id': student_id, 'top_k': top_k } } }
    for m in matches:
        md = m.get('metadata') or {}
        if submission_id is not None and str(md.get('submission_id')) != str(submission_id):
            continue
        if assessment_id is not None and str(md.get('assessment_id')) != str(assessment_id):
            continue
        if student_id is not None and str(md.get('student_id')) != str(student_id):
            continue

        out['results'].append({
            'id': str(m.get('id')),
            'text': m.get('text') or '',
            'similarity': float(m.get('score') or 0.0),
            'metadata': md,
        })
    out['debug']['postfilter_count'] = len(out['results'])

    print(json.dumps(out))
except Exception as e:
    print(json.dumps({ 'success': False, 'error': str(e), 'type': type(e).__name__ }))
    sys.exit(1)
`;

    const proc = spawn(pythonExec, ['-c', pythonCode], {
      cwd: RAG_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(process.env.SUBMISSION_RETRIEVAL_TIMEOUT_MS || 120000);
    const timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`Submission retrieval timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => (stderr += data.toString()));

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        __dbg(
          "submissionRetrievalService.js:querySubmissionChunks",
          "spawn_exit_error",
          { ms: Date.now() - t0, code, stderrLen: String(stderr || "").length },
          "H8"
        );
        reject(new Error(`Submission retrieval failed (code ${code}): ${stderr || 'No stderr'}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.success) return reject(new Error(parsed.error || 'Unknown retrieval error'));
        __dbg(
          "submissionRetrievalService.js:querySubmissionChunks",
          "spawn_exit_ok",
          {
            ms: Date.now() - t0,
            resultCount: Array.isArray(parsed?.results) ? parsed.results.length : 0,
            prefilter: Number(parsed?.debug?.prefilter_count ?? -1),
            postfilter: Number(parsed?.debug?.postfilter_count ?? -1),
          },
          "H8"
        );
        resolve(parsed.results || []);
      } catch (e) {
        __dbg(
          "submissionRetrievalService.js:querySubmissionChunks",
          "parse_error",
          { ms: Date.now() - t0, error: String(e?.message || e), stdoutHead: String(stdout || "").slice(0, 200) },
          "H8"
        );
        reject(new Error(`Failed to parse submission retrieval output: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      __dbg(
        "submissionRetrievalService.js:querySubmissionChunks",
        "spawn_error",
        { ms: Date.now() - t0, error: String(err?.message || err) },
        "H8"
      );
      reject(new Error(`Failed to spawn submission retrieval: ${err.message}`));
    });
  });
}

module.exports = { querySubmissionChunks };

