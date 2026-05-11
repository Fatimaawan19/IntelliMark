const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const sharp = require("sharp");

/**
 * OCR image files using local Tesseract and produce:
 * - merged PDF (OCR'd per-page PDFs merged)
 * - concatenated extracted text
 *
 * Requires: Tesseract installed locally.
 * Optional env:
 * - TESSERACT_PATH: full path to tesseract.exe
 * - TESSERACT_LANG: e.g. "eng"
 */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function runTesseractToPdfAndText({ imagePath, outBasePath, lang, psm = "6" }) {
  const tesseractBin = String(process.env.TESSERACT_PATH || "tesseract");
  // Improve OCR quality on scanned/handwritten-ish pages:
  // - OEM 1: LSTM engine
  // - PSM 6: assume a uniform block of text
  // - preserve_interword_spaces: reduce word-joining artifacts
  const args = [
    imagePath,
    outBasePath,
    "-l",
    lang,
    "--oem",
    "1",
    "--psm",
    String(psm),
    "-c",
    "preserve_interword_spaces=1",
    "pdf",
    "txt",
  ];

  return new Promise((resolve, reject) => {
    const p = spawn(tesseractBin, args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d || "")));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`tesseract exited ${code}: ${stderr.trim() || "unknown error"}`));
      }
      resolve(true);
    });
  });
}

function runTesseractToTextAndTsv({ imagePath, outBasePath, lang, psm = "6" }) {
  const tesseractBin = String(process.env.TESSERACT_PATH || "tesseract");
  const args = [
    imagePath,
    outBasePath,
    "-l",
    lang,
    "--oem",
    "1",
    "--psm",
    String(psm),
    "-c",
    "preserve_interword_spaces=1",
    // Produce both text and TSV (for confidence scoring)
    "txt",
    "tsv",
  ];

  return new Promise((resolve, reject) => {
    const p = spawn(tesseractBin, args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d || "")));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`tesseract exited ${code}: ${stderr.trim() || "unknown error"}`));
      }
      resolve(true);
    });
  });
}

function scoreTsvConfidence(tsvText) {
  try {
    const s = String(tsvText || "").trim();
    if (!s) return -1;
    const lines = s.split(/\r?\n/);
    if (lines.length < 2) return -1;
    const header = lines[0].split("\t");
    const confIdx = header.findIndex((h) => String(h || "").trim().toLowerCase() === "conf");
    if (confIdx === -1) return -1;

    let sum = 0;
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      const v = Number(cols[confIdx]);
      // Tesseract uses -1 for non-word rows; ignore those.
      if (!Number.isFinite(v) || v < 0) continue;
      sum += v;
      count += 1;
    }
    if (!count) return -1;
    return sum / count;
  } catch {
    return -1;
  }
}

async function preprocessForOcr(imagePath, outPath) {
  // Handwritten scans benefit from: deskew-ish rotate + denoise + normalize + sharpen + threshold.
  // This is best-effort; if preprocessing fails we still fall back to the original image.
  await sharp(imagePath)
    .rotate() // auto-orient via EXIF if present
    .resize({ width: 2200, withoutEnlargement: true }) // keep readable scale
    .grayscale()
    .median(1) // denoise small speckles
    .normalise()
    .gamma(1.1) // slightly boost mid-tones
    .sharpen({ sigma: 1, m1: 1.2, m2: 0.2 }) // strengthen strokes
    .threshold(165)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return outPath;
}

function normalizeOcrText(raw) {
  const s = String(raw || "").replace(/\r\n/g, "\n");
  const lines = s.split("\n");
  const out = [];
  const endsSentence = (t) => /[.!?;:]"?$/.test(String(t || "").trim());
  const isShort = (t) => String(t || "").trim().length > 0 && String(t || "").trim().length <= 18;
  const startsLower = (t) => /^[a-z(]/.test(String(t || "").trim());
  const isBullet = (t) => /^(\-|\*|\u2022|\d+\.)\s+/.test(String(t || "").trim());

  for (let i = 0; i < lines.length; i++) {
    const cur = String(lines[i] || "").trimEnd();
    if (!cur.trim()) {
      out.push("");
      continue;
    }

    // De-hyphenate common OCR line breaks: "vari-\nable" -> "variable"
    if (cur.trim().endsWith("-") && i + 1 < lines.length) {
      const nxt = String(lines[i + 1] || "").trim();
      if (nxt && /^[a-z]/i.test(nxt)) {
        out.push(cur.trim().slice(0, -1) + nxt);
        i += 1;
        continue;
      }
    }

    // If OCR produced one-word-per-line, reflow into a sentence-ish paragraph.
    const prev = out.length ? String(out[out.length - 1] || "") : "";
    if (
      prev &&
      prev.trim() &&
      !endsSentence(prev) &&
      !isBullet(prev) &&
      isShort(prev) &&
      isShort(cur) &&
      (startsLower(cur) || /^[A-Z]/.test(cur.trim()))
    ) {
      out[out.length - 1] = `${prev.trimEnd()} ${cur.trimStart()}`;
      continue;
    }

    out.push(cur);
  }

  // Clean excessive blank lines
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function mergePdfs(pdfPaths, mergedPdfPath) {
  const { PDFDocument } = require("pdf-lib");
  const out = await PDFDocument.create();

  for (const p of pdfPaths) {
    const bytes = fs.readFileSync(p);
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((pg) => out.addPage(pg));
  }

  const merged = await out.save();
  fs.writeFileSync(mergedPdfPath, merged);
}

/**
 * @param {object} args
 * @param {string[]} args.imagePaths - absolute paths to JPG/PNG files
 * @param {string} args.outputDir - absolute dir where merged PDF should be written
 * @param {string} args.outputFileName - merged PDF filename (e.g. "submission-...-ocr.pdf")
 * @param {(info: { index: number, total: number, imagePath: string }) => void} [args.onProgress] - progress callback per image
 * @returns {Promise<{ pdfPath: string, pdfFilename: string, text: string, pageCount: number }>}
 */
async function ocrImagesToMergedPdf({ imagePaths, outputDir, outputFileName, onProgress }) {
  const imgs = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  if (imgs.length === 0) throw new Error("No imagePaths provided");

  ensureDir(outputDir);

  const lang = String(process.env.TESSERACT_LANG || "eng").trim() || "eng";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "intelimark-ocr-"));

  const pdfs = [];
  const texts = [];

  try {
    for (let i = 0; i < imgs.length; i++) {
      const imgPath = imgs[i];
      try {
        if (typeof onProgress === "function") onProgress({ index: i, total: imgs.length, imagePath: imgPath });
      } catch {
        // ignore callback errors (OCR should still proceed)
      }
      const outBase = path.join(tmpDir, `page-${i + 1}`);
      const prePath = path.join(tmpDir, `pre-${i + 1}.png`);
      let ocrInputPath = imgPath;
      try {
        ocrInputPath = await preprocessForOcr(imgPath, prePath);
      } catch {
        ocrInputPath = imgPath;
      }

      // Try a couple of PSM modes and pick the best based on TSV confidence.
      // PSM 6: uniform block of text, PSM 4: single column of text, variable sizes.
      const candidates = ["6", "4"];
      let bestPsm = "6";
      let bestScore = -1;
      for (const psm of candidates) {
        const probeBase = path.join(tmpDir, `probe-${i + 1}-psm${psm}`);
        try {
          await runTesseractToTextAndTsv({ imagePath: ocrInputPath, outBasePath: probeBase, lang, psm });
          const tsvPath = `${probeBase}.tsv`;
          const score = fs.existsSync(tsvPath) ? scoreTsvConfidence(fs.readFileSync(tsvPath, "utf8")) : -1;
          if (score > bestScore) {
            bestScore = score;
            bestPsm = psm;
          }
        } catch {
          // ignore probe failures; fall back to defaults
        }
      }

      await runTesseractToPdfAndText({ imagePath: ocrInputPath, outBasePath: outBase, lang, psm: bestPsm });

      const pdfPath = `${outBase}.pdf`;
      const txtPath = `${outBase}.txt`;

      if (fs.existsSync(pdfPath)) pdfs.push(pdfPath);
      if (fs.existsSync(txtPath)) texts.push(normalizeOcrText(fs.readFileSync(txtPath, "utf8")));
    }

    if (pdfs.length === 0) throw new Error("Tesseract did not produce any PDF output");

    const mergedPdfPath = path.join(outputDir, outputFileName);
    await mergePdfs(pdfs, mergedPdfPath);

    return {
      pdfPath: mergedPdfPath,
      pdfFilename: outputFileName,
      text: normalizeOcrText(texts.join("\n\n")),
      pageCount: pdfs.length,
    };
  } finally {
    // Best-effort cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  ocrImagesToMergedPdf,
};

