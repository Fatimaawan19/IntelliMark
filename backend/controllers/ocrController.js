/** Provides per-submission image-to-text conversion with Tesseract.
 * Creates searchable PDFs and stores extracted text.
 */

const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { ocrImagesToMergedPdf } = require("../utils/ocrService");

const RAG_DIR = path.join(__dirname, "..", "rag_marking");
const VENV_PYTHON = path.join(__dirname, "..", "..", ".venv-1", "Scripts", "python.exe");
const PYTHON_BIN = (process.env.PYTHON_BIN && path.isAbsolute(process.env.PYTHON_BIN))
  ? process.env.PYTHON_BIN
  : (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python");

/**
 * Run Advanced OCR pipeline (OpenCV + PyTesseract) with comprehensive preprocessing.
 * Supports multi-page image submissions with structure preservation.
 *
 * @param {string[]} imagePaths - Array of absolute paths to images
 * @returns {Promise<object>} OCR result with text, confidence, quality
 */
function runAdvancedOcr(imagePaths) {
  return new Promise((resolve) => {
    const script = path.join(RAG_DIR, "ocr_advanced.py");
    const args = [script, "--images", imagePaths.join(","), "--output-json"];

    const proc = spawn(PYTHON_BIN, args, {
      cwd: RAG_DIR,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, text: "", error: "OCR timeout (5 min)" });
    }, 300000); // 5 minutes for multi-page

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[OCR Python] Exit ${code}: ${stderr.slice(0, 200)}`);
        resolve({ success: false, text: "", error: stderr || "OCR process failed" });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        console.warn(`[OCR Python] Parse error: ${e.message}`);
        console.warn(`[OCR Python] stdout head: ${stdout.slice(0, 300)}`);
        resolve({ success: false, text: "", error: "Parse error: " + e.message });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, text: "", error: err.message });
    });
  });
}

/**
 * POST /api/submissions/:submissionId/ocr
 *
 * OCR the image files in a submission and store the extracted text.
 *
 * Response:
 * {
 *   success: true,
 *   submissionId: string,
 *   textExtracted: string (extracted text from images),
 *   pdfCreated: string (path to merged OCR PDF),
 *   confidence: number (average confidence score),
 *   message: string
 * }
 */
exports.ocrSubmissionImages = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();

    if (!submissionId || !teacherId) {
      return res.status(400).json({
        success: false,
        error: "submissionId and teacherId are required",
      });
    }

    // Verify submission ownership
    const submission = await Submission.findById(submissionId).lean();
    if (!submission) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }
    if (String(submission.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    // Get submission files
    const files = Array.isArray(submission.submissionFiles) ? submission.submissionFiles : [];
    const imageFiles = files.filter((f) => {
      const mimeType = String(f?.mimeType || "").toLowerCase();
      return (
        mimeType.startsWith("image/") &&
        (mimeType.includes("jpeg") || mimeType.includes("jpg") || mimeType.includes("png"))
      );
    });

    if (imageFiles.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No image files found in this submission",
      });
    }

    // Get absolute paths to image files
    const uploadsDir = path.join(__dirname, "..", "uploads", "student_uploads");
    const imagePaths = imageFiles
      .map((f) => {
        const fullPath = path.join(uploadsDir, String(f?.filename || ""));
        return fs.existsSync(fullPath) ? fullPath : null;
      })
      .filter(Boolean);

    if (imagePaths.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Image files exist in database but not found on disk",
      });
    }

    // Create output directory for OCR PDF
    const pdfsDir = path.join(__dirname, "..", "pdfs");
    if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });

    const timestamp = Date.now();
    const pdfFilename = `ocr-${submissionId}-${timestamp}.pdf`;
    const pdfPath = path.join(pdfsDir, pdfFilename);

    console.log(`[OCR] Starting advanced OCR for submission ${submissionId}`);
    console.log(`[OCR] Processing ${imagePaths.length} image(s) with structure preservation`);

    // Run Advanced OCR pipeline (multi-pipeline + structure preservation + confidence)
    const advancedResult = await runAdvancedOcr(imagePaths);
    const advancedSuccess = Boolean(advancedResult?.success && advancedResult?.text && advancedResult.text.trim().length > 0);

    if (advancedSuccess) {
      console.log(`[OCR] ✓ Advanced OCR: ${advancedResult.text_length} chars, ${advancedResult.average_confidence}% confidence, quality: ${advancedResult.quality_label}`);
      if (advancedResult.needs_manual_review) {
        console.log(`[OCR] ⚠️  Low quality - flagged for manual review`);
      }
    } else {
      console.log(`[OCR] ⚠️  Advanced OCR failed, falling back to legacy Tesseract`);
    }

    // Run legacy Tesseract for PDF generation (always needed for searchable PDF)
    const ocrResult = await ocrImagesToMergedPdf({
      imagePaths,
      outputDir: pdfsDir,
      outputFileName: pdfFilename,
      onProgress: (info) => {
        console.log(
          `[OCR] PDF generation ${info.index + 1}/${info.total}: ${path.basename(info.imagePath)}`
        );
      },
    });

    // Prefer advanced OCR text; fallback to legacy Tesseract
    const extractedText = advancedSuccess
      ? String(advancedResult.text || "").trim()
      : String(ocrResult.text || "").trim();

    // OCR metadata
    const ocrConfidence = advancedSuccess ? advancedResult.average_confidence : 0;
    const ocrQuality = advancedSuccess ? advancedResult.quality_label : "low";
    const needsManualReview = advancedSuccess ? advancedResult.needs_manual_review : true;
    const ocrEngine = advancedSuccess ? "advanced-opencv-tesseract" : "tesseract-legacy";

    console.log(`[OCR] Final: ${extractedText.length} chars (engine: ${ocrEngine}, confidence: ${ocrConfidence}%)`);

    await SubmissionRaw.findOneAndUpdate(
      { submissionId },
      {
        $set: {
          submissionId,
          rawText: extractedText, // Primary field for extraction content
          ocrText: extractedText, // Also store as ocrText for backwards compatibility
          ocrPdfPath: `/pdfs/${pdfFilename}`,
          ocrPdfFilename: pdfFilename,
          ocrProcessedAt: new Date(),
          ocrConfidence: ocrConfidence, // 0-100 confidence score
          ocrQuality: ocrQuality, // "high" | "medium" | "low"
          ocrNeedsManualReview: needsManualReview,
          extractionStatus: "completed",
          extractor: ocrEngine,
          contentTypes: ["text"], // Converted from images to text
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    // Also update submission to mark OCR as done
    await Submission.updateOne(
      { _id: submissionId },
      {
        $set: {
          ocrProcessedAt: new Date(),
          submissionText: extractedText, // Store in submission for backwards compatibility
        },
      }
    ).catch(() => {}); // Don't fail if submission update fails

    console.log(`[OCR] ✅ Completed for submission ${submissionId}`);

    return res.status(200).json({
      success: true,
      submissionId,
      textExtracted: extractedText.substring(0, 200) + (extractedText.length > 200 ? "..." : ""),
      textLength: extractedText.length,
      pdfCreated: `/pdfs/${pdfFilename}`,
      pageCount: ocrResult.pageCount || imagePaths.length,
      confidence: ocrConfidence,
      quality: ocrQuality,
      needsManualReview: needsManualReview,
      engine: ocrEngine,
      message: needsManualReview
        ? `Extracted ${extractedText.length} chars at ${ocrConfidence}% confidence (low quality - manual review recommended)`
        : `Successfully extracted text from ${imagePaths.length} image(s) at ${ocrConfidence}% confidence`,
    });
  } catch (error) {
    console.error(`[OCR] ❌ Error:`, error?.message || error);
    return res.status(500).json({
      success: false,
      error: "OCR processing failed",
      details: error?.message || String(error),
    });
  }
};

/**
 * GET /api/submissions/:submissionId/ocr-status
 *
 * Check if OCR has been done and get extracted text.
 *
 * Response:
 * {
 *   success: true,
 *   submissionId: string,
 *   hasOcr: boolean,
 *   extractedText: string | null,
 *   ocrPdfUrl: string | null,
 *   processedAt: string | null
 * }
 */
exports.getOcrStatus = async (req, res) => {
  try {
    const { submissionId } = req.params;

    const raw = await SubmissionRaw.findOne({ submissionId }).select("ocrText ocrPdfPath ocrPdfFilename ocrProcessedAt").lean();

    return res.status(200).json({
      success: true,
      submissionId,
      hasOcr: Boolean(raw?.ocrText),
      extractedText: raw?.ocrText || null,
      ocrPdfUrl: raw?.ocrPdfPath || null,
      ocrPdfFilename: raw?.ocrPdfFilename || null,
      processedAt: raw?.ocrProcessedAt || null,
    });
  } catch (error) {
    console.error("[OCR Status] Error:", error?.message || error);
    return res.status(500).json({
      success: false,
      error: "Failed to get OCR status",
    });
  }
};
