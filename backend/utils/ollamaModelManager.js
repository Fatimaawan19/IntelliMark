const dotenv = require("dotenv");
dotenv.config();

const OLLAMA_API_URL = (process.env.OLLAMA_API_URL || "http://localhost:11434").replace(/\/+$/, "");
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "5m";

// One-at-a-time gate: prevents concurrent model use and avoids Ollama contention.
let _lock = Promise.resolve();
let _activePurpose = null;
let _activeModel = null;

// #region agent log
function __ollamaMgrDbg(location, message, data, hypothesisId, runId = "pre-fix") {
  const payload = {
    sessionId: "afcd7a",
    runId,
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
// #endregion

async function _withLock(fn) {
  const prev = _lock;
  let release;
  _lock = new Promise((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function _pokeKeepAlive(model, keepAlive) {
  // A "no-op" generate call that just sets keep_alive / unload behavior.
  // Ollama accepts keep_alive: 0 to unload a model from memory.
  const body = {
    model,
    // Some Ollama builds reject empty prompt; keep this minimal but non-empty.
    prompt: " ",
    stream: false,
    keep_alive: keepAlive,
  };

  // #region agent log
  __ollamaMgrDbg(
    "ollamaModelManager.js:_pokeKeepAlive",
    "keepalive_request",
    { apiUrl: OLLAMA_API_URL, model, keepAlive, promptLen: body.prompt.length },
    "H1"
  );
  // #endregion

  const res = await fetch(`${OLLAMA_API_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => ({ ok: false, status: 0, _err: e }));

  if (!res?.ok) {
    let detail = "";
    try {
      detail = res?.json ? JSON.stringify(await res.json().catch(() => ({}))) : "";
    } catch {}
    const msg = res?._err?.message || `HTTP ${res?.status || "?"}${detail ? ` ${detail}` : ""}`;
    throw new Error(`Ollama keep_alive update failed for ${model}: ${msg}`);
  }
}

/**
 * Ensure only one "purpose" uses Ollama at a time, and unload the other model.
 *
 * @param {object} args
 * @param {"generation"|"automark"} args.purpose
 * @param {string} args.targetModel
 * @param {string[]} args.unloadModels
 */
async function withExclusiveOllamaModel({ purpose, targetModel, unloadModels = [] }, fn) {
  return _withLock(async () => {
    // #region agent log
    __ollamaMgrDbg(
      "ollamaModelManager.js:withExclusiveOllamaModel",
      "lock_enter",
      { purpose, targetModel, unloadModels, apiUrl: OLLAMA_API_URL, keepAlive: KEEP_ALIVE },
      "H2"
    );
    // #endregion

    // If switching purposes/models, unload others first to free RAM/CPU and avoid cross-model contention.
    const toUnload = (Array.isArray(unloadModels) ? unloadModels : [])
      .map((m) => String(m || "").trim())
      .filter(Boolean)
      .filter((m) => m !== targetModel);

    for (const m of toUnload) {
      try {
        await _pokeKeepAlive(m, 0);
      } catch (_) {
        // Non-fatal: unloading may fail if model not loaded; continue.
      }
    }

    // Keep the target model warm for this run.
    try {
      await _pokeKeepAlive(targetModel, KEEP_ALIVE);
    } catch (e) {
      // #region agent log
      __ollamaMgrDbg(
        "ollamaModelManager.js:withExclusiveOllamaModel",
        "keepalive_failed_nonfatal",
        { purpose, targetModel, error: String(e?.message || e) },
        "H3"
      );
      // #endregion
      // Non-fatal: if keep_alive poking fails, the real request may still succeed.
    }
    _activePurpose = purpose;
    _activeModel = targetModel;

    return await fn();
  });
}

function getOllamaModelManagerState() {
  return { activePurpose: _activePurpose, activeModel: _activeModel, keepAlive: KEEP_ALIVE, apiUrl: OLLAMA_API_URL };
}

module.exports = {
  withExclusiveOllamaModel,
  getOllamaModelManagerState,
};

