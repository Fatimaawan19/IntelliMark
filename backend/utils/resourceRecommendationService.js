function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s+.#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function __agentDebugLog(payload) {
  // #region agent log
  try {
    const fs = require("fs");
    const path = require("path");
    const line = `${JSON.stringify({ sessionId: "afcd7a", timestamp: Date.now(), ...payload })}\n`;
    fs.appendFileSync(path.join(__dirname, "..", "..", "debug-afcd7a.log"), line, { encoding: "utf8" });
  } catch {
    // ignore
  }
  // #endregion
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "to", "of", "in", "on", "for", "with", "as", "at", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "this", "that", "these", "those", "you", "your", "we", "our",
  "can", "could", "should", "would", "may", "might", "not", "no", "yes", "more", "less", "very", "also", "just", "from",
  "into", "about", "than", "then", "there", "here", "when", "while", "because", "so", "such", "some", "any", "all",
  "each", "both", "either", "neither", "per", "via", "etc",
]);

function tokenize(text) {
  const t = normalize(text);
  if (!t) return new Set();
  const words = t.split(" ").filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (w.length < 2) continue;
    if (STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

function phraseHit(fullText, phrase) {
  const p = normalize(phrase);
  if (!p) return false;
  if (fullText.includes(p)) return true;
  const parts = p.split(" ").filter(Boolean).filter(w => !STOP.has(w));
  if (parts.length <= 1) return false;
  // require all non-stop words from a multi-word phrase to appear in the text
  return parts.every((w) => fullText.includes(w));
}

function wordHit(fullText, word) {
  const w = normalize(word);
  if (!w) return false;
  if (fullText.includes(w)) return true;
  // avoid substring traps for short tokens (e.g. "ai" inside "said")
  if (w.length <= 3) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(fullText);
  }
  return fullText.includes(w);
}


const CATALOG = [
  {
    id: "ml_reinforcement_learning",
    courseTags: ["ml", "csc354", "machine learning"],
    title: "Reinforcement learning (notes)",
    url: "https://www.geeksforgeeks.org/what-is-reinforcement-learning/",
    keywords: [
      "reinforcement learning",
      "q learning",
      "q-learning",
      "policy gradient",
      "markov decision",
      "mdp",
      "reward",
      "agent",
      "environment",
      "exploration",
      "exploitation",
    ],
  },
  {
    id: "ml_supervised_unsupervised",
    courseTags: ["ml", "csc354", "machine learning"],
    title: "Supervised vs unsupervised learning (notes)",
    url: "https://www.khanacademy.org/computing/computer-science/informationtheory/moderninfotheory/v/supervised-learning",
    keywords: ["supervised learning", "unsupervised learning", "semi supervised", "feature engineering", "overfitting", "underfitting"],
  },
  {
    id: "ml_linear_regression",
    courseTags: ["ml", "csc354", "machine learning", "stats", "ds"],
    title: "Linear Regression (notes)",
    url: "https://www.khanacademy.org/math/statistics-probability/describing-relationships-quantitative-data/regression-library/a/introduction-to-linear-regression",
    keywords: ["linear regression", "least squares", "r squared", "residual", "regression line"],
  },
  {
    id: "ml_classification",
    courseTags: ["ml", "csc354", "machine learning", "stats", "ds"],
    title: "Classification basics (notes)",
    url: "https://www.khanacademy.org/math/statistics-probability/modeling-distributions-of-data/more-on-conditional-probability/v/classification-and-decision-boundaries",
    keywords: ["classification", "decision boundary", "precision", "recall", "confusion matrix", "f1"],
  },
  {
    id: "ds_data_science_intro",
    courseTags: ["ds", "csc461", "data science", "statistics"],
    title: "What is data science? (notes)",
    url: "https://www.ibm.com/topics/data-science",
    keywords: ["data science", "data scientist", "data pipeline", "etl", "feature", "dataset", "exploratory data analysis", "eda"],
  },
  {
    id: "ds_normalization",
    courseTags: ["ds", "csc461", "database", "dbms"],
    title: "Normalization in DBMS (notes)",
    url: "https://www.geeksforgeeks.org/database-normalization-normal-forms/",
    keywords: ["normalization", "1nf", "2nf", "3nf", "bc nf", "functional dependency", "dbms", "relational schema"],
  },
  {
    id: "ds_probability",
    courseTags: ["ds", "csc461", "data science", "statistics"],
    title: "Probability basics (notes)",
    url: "https://www.khanacademy.org/math/statistics-probability/probability-library",
    keywords: ["probability", "bayes", "conditional probability", "independent", "random variable"],
  },
  {
    id: "prog_big_o",
    courseTags: ["algo", "cs", "programming"],
    title: "Big-O complexity (notes)",
    url: "https://www.geeksforgeeks.org/analysis-of-algorithms-big-o-analysis/",
    keywords: ["time complexity", "space complexity", "big o", "big-o", "asymptotic", "algorithm complexity", "worst case", "average case"],
  },
  {
    id: "prog_ds_arrays",
    courseTags: ["algo", "cs", "programming", "ds"],
    title: "Arrays & Strings (notes)",
    url: "https://www.geeksforgeeks.org/array-data-structure/",
    keywords: ["array", "arrays", "string", "strings", "two pointer", "sliding window", "hash map", "hashmap"],
  },
];

function inferCourseTags(courseCode, courseName) {
  const cc = normalize(courseCode);
  const cn = normalize(courseName);
  const tags = new Set();
  if (cc.includes("354")) tags.add("ml");
  if (cc.includes("461")) tags.add("ds");
  if (cn.includes("machine learning")) tags.add("ml");
  if (cn.includes("data science")) tags.add("ds");
  if (cn.includes("fundamentals")) tags.add("ds");
  return tags;
}

function scoreEntry(fullText, entry, courseTags) {
  const t = normalize(fullText);
  if (!t) return 0;
  const entryTags = Array.isArray(entry?.courseTags) ? entry.courseTags.map((x) => normalize(x)) : [];
  const tagMatch = entryTags.some((tg) => {
    if (!tg) return false;
    if (courseTags.has(tg)) return true;
    // allow code/name substring matches for tags like "machine learning"
    return (tg.length >= 4 && (t.includes(tg) || [...courseTags].some((ct) => tg.includes(ct))));
  });
  const keys = Array.isArray(entry?.keywords) ? entry.keywords : [];
  let score = 0;
  for (const k of keys) {
    const nk = normalize(k);
    if (!nk) continue;
    if (nk.includes(" ")) {
      if (phraseHit(t, nk)) score += 5;
      continue;
    }
    // single-token keywords: must be a real hit, not a substring accident
    if (wordHit(t, nk)) score += 3;
  }
  // small prior: prefer entries aligned with inferred course tags when scores tie
  if (tagMatch) score += 0.25;
  return score;
}

function recommendLearningResource({ courseCode, courseName, feedbackText, mistakes = [] }) {
  // #region agent log
  fetch("http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "afcd7a" },
    body: JSON.stringify({
      sessionId: "afcd7a",
      runId: "pre-fix",
      hypothesisId: "H1",
      location: "resourceRecommendationService.js:recommendLearningResource:entry",
      message: "recommendLearningResource entry",
      data: {
        courseCode: String(courseCode || ""),
        courseName: String(courseName || ""),
        feedbackLen: String(feedbackText || "").length,
        mistakesCount: Array.isArray(mistakes) ? mistakes.length : 0,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  __agentDebugLog({
    runId: "pre-fix",
    hypothesisId: "H1",
    location: "resourceRecommendationService.js:recommendLearningResource:entry:fs",
    message: "recommendLearningResource entry (fs)",
    data: {
      courseCode: String(courseCode || ""),
      courseName: String(courseName || ""),
      feedbackLen: String(feedbackText || "").length,
      mistakesCount: Array.isArray(mistakes) ? mistakes.length : 0,
    },
  });
  // #endregion

  const text = [
    courseCode ? `course: ${courseCode}` : "",
    courseName ? `name: ${courseName}` : "",
    feedbackText || "",
    ...(Array.isArray(mistakes) ? mistakes : []).map(m => typeof m === "string" ? m : (m?.topic || m?.description || "")),
  ]
    .filter(Boolean)
    .join(" | ");

  const courseTags = inferCourseTags(courseCode, courseName);
  const fbTok = tokenize(feedbackText || "");
  const mistakeTok = tokenize(
    (Array.isArray(mistakes) ? mistakes : [])
      .map(m => typeof m === "string" ? m : (m?.topic || m?.description || ""))
      .join(" ")
  );

  let best = null;
  let bestScore = 0;
  for (const entry of CATALOG) {
    const s = scoreEntry(text, entry, courseTags);
    if (s > bestScore) {
      bestScore = s;
      best = entry;
    }
  }
  if (!best || bestScore < 3) {
    // #region agent log
    __agentDebugLog({
      runId: "pre-fix",
      hypothesisId: "H6",
      location: "resourceRecommendationService.js:recommendLearningResource:noMatch",
      message: "no strong catalog match",
      data: {
        bestId: best?.id || null,
        bestScore,
        courseTags: Array.from(courseTags.values()),
      },
    });
    // #endregion
    return null;
  }

  // #region agent log
  fetch("http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "afcd7a" },
    body: JSON.stringify({
      sessionId: "afcd7a",
      runId: "pre-fix",
      hypothesisId: "H2",
      location: "resourceRecommendationService.js:recommendLearningResource:bestBeforeGenericSwap",
      message: "best catalog match before generic swap",
      data: {
        bestId: best?.id,
        bestScore,
        courseTags: Array.from(courseTags.values()),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  __agentDebugLog({
    runId: "pre-fix",
    hypothesisId: "H2",
    location: "resourceRecommendationService.js:recommendLearningResource:bestBeforeGenericSwap:fs",
    message: "best catalog match before generic swap (fs)",
    data: {
      bestId: best?.id,
      bestScore,
      courseTags: Array.from(courseTags.values()),
    },
  });
  // #endregion

  // If catalog match is weak/generic, prefer a course-default when we inferred a domain tag
  const genericIds = new Set(["prog_big_o", "prog_ds_arrays"]);
  if (genericIds.has(best.id) && courseTags.has("ml")) {
    const fb = best;
    best = CATALOG.find((e) => e.id === "ml_reinforcement_learning") || fb;
    bestScore = Math.max(bestScore, 3.1);
  }
  if (genericIds.has(best.id) && courseTags.has("ds") && (fbTok.has("data") || fbTok.has("science") || mistakeTok.has("data"))) {
    const fb = best;
    best = CATALOG.find((e) => e.id === "ds_data_science_intro") || fb;
    bestScore = Math.max(bestScore, 3.1);
  }

  const out = {
    topic: best.title,
    title: best.title,
    url: best.url,
    source: "catalog",
    score: bestScore,
  };

  // #region agent log
  fetch("http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "afcd7a" },
    body: JSON.stringify({
      sessionId: "afcd7a",
      runId: "pre-fix",
      hypothesisId: "H3",
      location: "resourceRecommendationService.js:recommendLearningResource:exit",
      message: "recommendLearningResource exit",
      data: {
        pickedId: best?.id,
        pickedTitle: best?.title,
        score: bestScore,
        courseTags: Array.from(courseTags.values()),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  __agentDebugLog({
    runId: "pre-fix",
    hypothesisId: "H3",
    location: "resourceRecommendationService.js:recommendLearningResource:exit:fs",
    message: "recommendLearningResource exit (fs)",
    data: {
      pickedId: best?.id,
      pickedTitle: best?.title,
      score: bestScore,
      courseTags: Array.from(courseTags.values()),
    },
  });
  // #endregion

  return out;
}

module.exports = { recommendLearningResource };

