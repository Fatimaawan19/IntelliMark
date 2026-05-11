#!/usr/bin/env node
/**
 * Fix Stats course CLO descriptions + Bloom levels.
 *
 * What it does:
 * - Strips trailing "level text" from CLO.description like:
 *   " ... Remember (L1)" or " ... Understand (L2)" etc.
 * - Sets proper bloomLevelId based on CLO number mapping:
 *   CLO-1 -> Remembering, CLO-2 -> Understanding, CLO-3 -> Applying, CLO-4 -> Analyzing
 *
 * Usage:
 *   node scripts/fix_stats_clos.js --courseCode DS-001
 *   node scripts/fix_stats_clos.js --courseId <ObjectId>
 *   node scripts/fix_stats_clos.js --courseCode DS-001 --dryRun
 *
 * Notes:
 * - Requires backend/.env MONGO_URI (or MONGODB_URI)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), override: true });

const mongoose = require("mongoose");
const CLO = require("../models/CLO");
const BloomTaxonomy = require("../models/BloomTaxonomy");

function toObjectId(id) {
  try {
    if (!id) return null;
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { courseCode: null, courseId: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--courseCode") out.courseCode = String(argv[++i] || "").trim();
    else if (a === "--courseId") out.courseId = String(argv[++i] || "").trim();
    else if (a === "--dryRun") out.dryRun = true;
  }
  return out;
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCloNumber(n) {
  const s = String(n || "").trim();
  const m = s.match(/([1-9][0-9]{0,2})\s*$/);
  const num = m ? Number(m[1]) : null;
  return Number.isFinite(num) ? num : null;
}

function normalizeDescription(desc) {
  let s = String(desc || "").replace(/\s+/g, " ").trim();
  if (!s) return s;

  // Remove trailing bloom word + optional (Lx)
  // Examples:
  // "... Remember (L1)" / "... Remembering (L1)" / "... Understand (L2)" / "... Applying (L3)" / "... Analyze (L4)"
  s = s.replace(
    /\s+(remember|remembering|understand|understanding|apply|applying|analyze|analyzing|evaluate|evaluating|create|creating)\s*(\(\s*l\s*\d+\s*\))?\s*$/i,
    ""
  );

  // Remove any leftover trailing "(Lx)" if present
  s = s.replace(/\s*\(\s*l\s*\d+\s*\)\s*$/i, "");

  return s.replace(/\s+/g, " ").trim();
}

async function getBloomIdByName(levelName) {
  const doc = await BloomTaxonomy.getByName(levelName);
  if (!doc?._id) throw new Error(`BloomTaxonomy level not found: "${levelName}"`);
  return doc._id;
}

async function main() {
  const args = parseArgs(process.argv);
  const courseCode = String(args.courseCode || "").trim() || "DS-001";
  const courseId = String(args.courseId || "").trim() || null;
  const dryRun = Boolean(args.dryRun);

  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) throw new Error("Missing MONGO_URI in backend/.env");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
  console.log(`[fix-stats-clos] connected db="${mongoose.connection?.name || ""}" dryRun=${dryRun}`);

  const query = {};
  if (courseId) {
    const oid = toObjectId(courseId);
    if (!oid) throw new Error("Invalid --courseId (not ObjectId)");
    query.courseId = oid;
  }
  if (courseCode) {
    query.courseCode = new RegExp(`^${escapeRegExp(courseCode)}$`, "i");
  }

  // Only touch CLO 1-4 for this course
  const clos = await CLO.find(query).lean();
  console.log(`[fix-stats-clos] matched CLOs=${clos.length} (courseCode=${courseCode || "—"}, courseId=${courseId || "—"})`);
  if (!clos.length) {
    await mongoose.disconnect();
    console.log("[fix-stats-clos] done (no CLOs found)");
    return;
  }

  const bloomByNum = {
    1: await getBloomIdByName("Remembering"),
    2: await getBloomIdByName("Understanding"),
    3: await getBloomIdByName("Applying"),
    4: await getBloomIdByName("Analyzing"),
  };

  let changed = 0;
  let skipped = 0;

  for (const clo of clos) {
    const n = normalizeCloNumber(clo?.cloNumber);
    if (![1, 2, 3, 4].includes(Number(n))) {
      skipped += 1;
      continue;
    }

    const nextDescription = normalizeDescription(clo?.description);
    const nextBloomId = bloomByNum[n];

    const needsDesc = String(nextDescription || "") !== String(clo?.description || "");
    const needsBloom = String(nextBloomId) !== String(clo?.bloomLevelId || "");
    if (!needsDesc && !needsBloom) {
      skipped += 1;
      continue;
    }

    changed += 1;
    console.log(
      `[fix-stats-clos] update cloNumber="${clo.cloNumber}" _id=${clo._id}\n` +
        `  - description: "${String(clo?.description || "")}"\n` +
        `  + description: "${String(nextDescription || "")}"\n` +
        `  - bloomLevelId: ${String(clo?.bloomLevelId || "")}\n` +
        `  + bloomLevelId: ${String(nextBloomId)}`
    );

    if (!dryRun) {
      await CLO.updateOne(
        { _id: clo._id },
        {
          $set: {
            description: nextDescription,
            bloomLevelId: nextBloomId,
            // keep deprecated field in sync (backward compatibility)
            bloomTaxonomyLevel: nextBloomId,
            // optional: store a compact L-level if UI uses it (no bloom words)
            learningLevel: `L${n}`,
          },
        }
      );
    }
  }

  console.log(`[fix-stats-clos] changed=${changed} skipped=${skipped}`);
  await mongoose.disconnect();
  console.log("[fix-stats-clos] done");
}

main().catch(async (e) => {
  console.error("❌ FAILED:", e?.message || String(e));
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

