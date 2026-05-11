const Assessment = require("../models/Assessment");
const Submission = require("../models/Submission");
const SubmissionRaw = require("../models/SubmissionRaw");
const ExtractionJob = require("../models/ExtractionJob");

const { ingestSubmission } = require("../utils/ingestionService");
const { ocrImagesToMergedPdf } = require("../utils/ocrService");
const path = require("path");
const fs = require("fs");

function _safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function _asBase64String(v) {
  if (!v) return "";
  if (Array.isArray(v)) return v.map((x) => String(x || "")).join("");
  return String(v || "");
}

function _extractQKeyFromName(name) {
  const s = String(name || "");
  const m = s.match(/(?:^|[^a-z0-9])q\s*([0-9]{1,3})(?:[^a-z0-9]|$)/i);
  if (!m) return null;
  const n = Number(m[1] || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `Q${n}`;
}

async function extractIpynbOutputImagesToUploads(subDoc) {
  const submissionId = String(subDoc?._id || "");
  if (!submissionId) return { created: 0, skipped: 0 };

  const uploadsRoot = path.join(__dirname, "../uploads/student_uploads");
  const outDir = path.join(uploadsRoot, "ipynb_outputs");
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }

  const files = Array.isArray(subDoc?.submissionFiles) ? subDoc.submissionFiles : [];
  const ipynbFiles = files.filter((f) => {
    const name = String(f?.originalName || f?.filename || "").toLowerCase();
    return path.extname(name) === ".ipynb";
  });
  if (!ipynbFiles.length) return { created: 0, skipped: 0 };

  // Avoid duplicates: if we already created derived images from a notebook, skip that notebook
  const alreadyDerivedFrom = new Set(
    files
      .filter((f) => Boolean(f?.isDerived) && String(f?.derivedType || "") === "ipynb-output-image")
      .flatMap((f) => (Array.isArray(f?.derivedFrom) ? f.derivedFrom : []))
      .map((x) => String(x || ""))
      .filter(Boolean)
  );

  const derivedEntries = [];
  let created = 0;
  let skipped = 0;

  for (const f of ipynbFiles) {
    const sourceFilename = String(f?.filename || "").trim();
    if (!sourceFilename) continue;
    if (alreadyDerivedFrom.has(sourceFilename)) {
      skipped += 1;
      continue;
    }

    const fullPath = path.join(uploadsRoot, sourceFilename);
    if (!fs.existsSync(fullPath)) continue;

    const raw = fs.readFileSync(fullPath, "utf8");
    const nb = _safeJsonParse(raw);
    if (!nb || !Array.isArray(nb?.cells)) continue;

    const qKeyForNotebook =
      _extractQKeyFromName(String(f?.originalName || "")) ||
      _extractQKeyFromName(String(sourceFilename || "")) ||
      null;

    for (let ci = 0; ci < nb.cells.length; ci++) {
      const cell = nb.cells[ci] || {};
      const outs = Array.isArray(cell?.outputs) ? cell.outputs : [];
      for (let oi = 0; oi < outs.length; oi++) {
        const out = outs[oi] || {};
        const data = out?.data || {};
        const pngB64 = _asBase64String(data?.["image/png"]);
        const jpgB64 = _asBase64String(data?.["image/jpeg"]);
        const chosen = pngB64 || jpgB64;
        if (!chosen) continue;

        const mimeType = pngB64 ? "image/png" : "image/jpeg";
        const ext = pngB64 ? ".png" : ".jpg";
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const outFilename = `ipynb-${submissionId}-${uniqueSuffix}-c${ci + 1}-o${oi + 1}${ext}`;
        const outPath = path.join(outDir, outFilename);
        try {
          fs.writeFileSync(outPath, Buffer.from(chosen, "base64"));
        } catch {
          continue;
        }

        const fileUrl = `/uploads/student_uploads/ipynb_outputs/${outFilename}`;
        const fileSize = fs.existsSync(outPath) ? fs.statSync(outPath).size : null;
        const now = new Date();

        derivedEntries.push({
          filename: path.posix.join("ipynb_outputs", outFilename).replace(/\\/g, "/"),
          originalName: `NOTEBOOK_IMAGE_${String(f?.originalName || sourceFilename)}${qKeyForNotebook ? `_${qKeyForNotebook}` : ""}_cell${ci + 1}${ext}`,
          fileUrl,
          fileSize,
          mimeType,
          uploadedAt: now,
          uploadedDate: now.toISOString().split("T")[0],
          uploadedTime: now.toTimeString().split(" ")[0],
          marks: null,
          fileFeedback: "",
          isDerived: true,
          derivedType: "ipynb-output-image",
          derivedFrom: [sourceFilename],
          questionKey: qKeyForNotebook,
        });
        created += 1;
      }
    }
  }

  if (derivedEntries.length) {
    const totalSize = derivedEntries.reduce((acc, x) => acc + Number(x?.fileSize || 0), 0);
    await Submission.findByIdAndUpdate(submissionId, {
      $push: { submissionFiles: { $each: derivedEntries }, uploadedFileNames: { $each: derivedEntries.map((x) => x.originalName) } },
      $inc: { uploadedFilesCount: derivedEntries.length, uploadedFilesTotalSize: totalSize },
    }).catch(() => {});
  }

  return { created, skipped };
}

async function pushLog(jobId, message, level = "info") {
  await ExtractionJob.updateOne({ _id: jobId }, { $push: { logs: { ts: new Date(), level, message } } }).catch(() => {});
}

async function resolveStudentName(subDoc, firestore) {
  const fromDoc = String(subDoc.studentName || "").trim();
  if (fromDoc) return fromDoc;
  const sid = String(subDoc.studentId || "").trim();
  if (!sid) return "Unknown";
  if (!firestore) return sid;
  try {
    const doc = await firestore.collection("users").doc(sid).get();
    if (doc.exists) {
      const data = doc.data() || {};
      return String(data.name || data.displayName || data.email || "").trim() || sid;
    }
  } catch {}
  return sid;
}

// Reuse the same prepare logic as automarkController's prepareOneSubmission, but without touching AutomarkJob.
async function prepareOneSubmission(subDoc, firestore) {
  const subId = String(subDoc._id);

  await SubmissionRaw.findOneAndUpdate(
    { submissionId: subDoc._id },
    {
      $setOnInsert: { submissionId: subDoc._id },
      $set: {
        assessmentId: subDoc.assessmentId,
        courseId: subDoc.courseId,
        teacherId: subDoc.teacherId,
        studentId: subDoc.studentId,
        extractionStatus: "pending",
        extractionError: "",
        faissIngestionStatus: "pending",
        faissIngestionError: "",
      },
    },
    { upsert: true, new: true }
  ).catch(() => {});

  await Submission.findByIdAndUpdate(subId, { $set: { faissIngestionStatus: "pending", faissIngestionError: "" } }).catch(() => {});

  // If student submitted a Jupyter notebook, extract embedded output images (plots)
  // so the UI "Graphical" tab can show them as normal image files.
  const ipynbImgs = await extractIpynbOutputImagesToUploads(subDoc).catch(() => ({ created: 0, skipped: 0 }));

  const startedAt = Date.now();
  const result = await ingestSubmission(subId, { enableOcr: true });
  const durationMs = Date.now() - startedAt;
  const chunks = Number(result?.total_chunks_created ?? result?.chunks ?? 0) || 0;
  const embeddings = Number(result?.total_embeddings_created ?? result?.total_vectors_created ?? chunks) || 0;
  const rawText = typeof result?.raw_text === "string" ? result.raw_text : "";
  const contentTypes = Array.isArray(result?.content_types) ? result.content_types : [];

  if (chunks <= 0) {
    const msg = String(result?.error || "Ingestion produced 0 chunks for submission");
    await Submission.findByIdAndUpdate(subId, { $set: { faissIngestionStatus: "failed", faissIngestionError: msg } }).catch(() => {});
    await SubmissionRaw.findOneAndUpdate(
      { submissionId: subDoc._id },
      { $set: { extractionStatus: "failed", extractionError: msg, faissIngestionStatus: "failed", faissIngestionError: msg } }
    ).catch(() => {});
    throw new Error(msg);
  }

  await Submission.findByIdAndUpdate(subId, {
    $set: {
      faissIngestionStatus: "completed",
      faissChunkCount: chunks,
      faissIngestionError: "",
      faissIngestedAt: new Date(),
    },
  }).catch(() => {});

  await SubmissionRaw.findOneAndUpdate(
    { submissionId: subDoc._id },
    {
      $set: {
        faissIngestionStatus: "completed",
        faissChunkCount: chunks,
        numChunks: chunks,
        numEmbeddings: embeddings,
        faissIngestionDurationMs: durationMs,
        faissIngestionError: "",
        faissIngestedAt: new Date(),
        extractionStatus: rawText || contentTypes.length ? "completed" : "skipped",
        extractor: result?.extractor || "",
        rawText,
        charCount: rawText.length,
        pageCount: Number(result?.page_count ?? 0) || 0,
        pageMetadata: Array.isArray(result?.page_metadata) ? result.page_metadata : [],
        visualCount: Number(result?.visual_count ?? 0) || 0,
        equationCount: Number(result?.equation_count ?? 0) || 0,
        contentTypes,
        ocrEnabled: Boolean(result?.ocr_enabled),
        ocrStatus: result?.ocr_status || "",
        ocrError: result?.ocr_error || "",
        ocrCount: Number(result?.ocr_count ?? 0) || 0,
        ocrCharCount: Number(result?.ocr_char_count ?? 0) || 0,
        extractionError: "",
        extractedAt: new Date(),
      },
    }
  ).catch(() => {});

  return {
    durationMs,
    chunks,
    embeddings,
    contentTypes,
    ocrEnabled: Boolean(result?.ocr_enabled),
    ocrStatus: String(result?.ocr_status || ""),
    ocrError: String(result?.ocr_error || ""),
    ipynbImagesCreated: Number(ipynbImgs?.created ?? 0) || 0,
  };
}

exports.startAssessmentExtractBatch = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    const force = Boolean(req.body?.force);
    if (!assessmentId || !teacherId) {
      return res.status(400).json({ success: false, error: "assessmentId and teacherId are required" });
    }

    const assessment = await Assessment.findById(assessmentId).lean();
    if (!assessment) return res.status(404).json({ success: false, error: "Assessment not found" });
    if (String(assessment.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const allSubs = await Submission.find({ assessmentId: assessment._id, teacherId }).sort({ studentId: 1 }).lean();
    const subIds = (allSubs || []).map((s) => s?._id).filter(Boolean);
    const raws = await SubmissionRaw.find({ submissionId: { $in: subIds } })
      .select("submissionId extractionStatus faissIngestionStatus rawText contentTypes")
      .lean()
      .catch(() => []);
    const rawById = new Map((raws || []).map((r) => [String(r?.submissionId || ""), r]));

    const needsPrep = (subDoc) => {
      if (force) return true;
      const r = rawById.get(String(subDoc?._id || ""));
      if (!r) return true;
      const extractionDone = String(r.extractionStatus || "") === "completed" && (String(r.rawText || "").trim() || (Array.isArray(r.contentTypes) && r.contentTypes.length));
      const faissDone = String(r.faissIngestionStatus || "") === "completed";
      return !(extractionDone && faissDone);
    };
    const submissions = (allSubs || []).filter(needsPrep);

    const job = await ExtractionJob.create({
      teacherId,
      assessmentId: assessment._id,
      assessmentTitle: assessment.title || "",
      courseCode: assessment.courseCode || "",
      status: "queued",
      total: submissions.length,
      processed: 0,
      logs: [{ ts: new Date(), level: "info", message: `Queued extraction for ${submissions.length} submission(s).` }],
    });

    res.status(202).json({ success: true, jobId: String(job._id) });

    // Firestore is optional; require lazily to avoid boot issues if admin not configured.
    let firestore = null;
    try {
      firestore = require("../config/firebase-admin").firestore;
    } catch {}

    setImmediate(async () => {
      await ExtractionJob.updateOne({ _id: job._id }, { $set: { status: "running" } }).catch(() => {});
      await pushLog(job._id, `Extraction started for "${assessment.title || assessmentId}".`);

      try {
        for (let i = 0; i < submissions.length; i++) {
          const subDoc = submissions[i];
          const studentName = await resolveStudentName(subDoc, firestore);
          await ExtractionJob.updateOne(
            { _id: job._id },
            { $set: { currentSubmissionId: String(subDoc._id), currentStudentName: studentName } }
          ).catch(() => {});

          await pushLog(job._id, `${studentName}: extracting + embedding submission into FAISS (submission index)…`);
          const info = await prepareOneSubmission(subDoc, firestore);
          await pushLog(
            job._id,
            `${studentName}: completed in ${Number(info?.durationMs ?? 0) || 0}ms (chunks=${Number(info?.chunks ?? 0) || 0}, notebookImages=${Number(info?.ipynbImagesCreated ?? 0) || 0}, ocr=${info?.ocrEnabled ? info?.ocrStatus || "on" : "off"}).`
          );

          await ExtractionJob.updateOne({ _id: job._id }, { $set: { processed: i + 1 } }).catch(() => {});
        }

        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "completed", finishedAt: new Date(), currentSubmissionId: "", currentStudentName: "" } }
        ).catch(() => {});
        await pushLog(job._id, "Extraction completed.", "info");
      } catch (e) {
        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "failed", error: e?.message || String(e), finishedAt: new Date() } }
        ).catch(() => {});
        await pushLog(job._id, `Extraction failed: ${e?.message || String(e)}`, "error");
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to start extraction batch", details: error.message });
  }
};

exports.getExtractionJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await ExtractionJob.findById(jobId).lean();
    if (!job) return res.status(404).json({ success: false, error: "Job not found" });
    return res.json({ success: true, job });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to fetch job", details: error.message });
  }
};

exports.startAssessmentDigitizeBatch = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    if (!assessmentId || !teacherId) {
      return res.status(400).json({ success: false, error: "assessmentId and teacherId are required" });
    }

    const assessment = await Assessment.findById(assessmentId).lean();
    if (!assessment) return res.status(404).json({ success: false, error: "Assessment not found" });
    if (String(assessment.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const allSubs = await Submission.find({ assessmentId: assessment._id, teacherId }).sort({ studentId: 1 }).lean();
    const subIds = (allSubs || []).map((s) => s?._id).filter(Boolean);
    const raws = await SubmissionRaw.find({ submissionId: { $in: subIds } })
      .select("submissionId ocrPdfFileUrl")
      .lean()
      .catch(() => []);
    const rawById = new Map((raws || []).map((r) => [String(r?.submissionId || ""), r]));

    const needsDigitize = (subDoc) => {
      const r = rawById.get(String(subDoc?._id || ""));
      if (r?.ocrPdfFileUrl) return false;
      const files = Array.isArray(subDoc?.submissionFiles) ? subDoc.submissionFiles : [];
      return files.some((f) => {
        const name = String(f?.originalName || f?.filename || "").toLowerCase();
        const ext = path.extname(name);
        return [".jpg", ".jpeg", ".png"].includes(ext) || String(f?.mimeType || "").startsWith("image/");
      });
    };
    const submissions = (allSubs || []).filter(needsDigitize);

    const job = await ExtractionJob.create({
      teacherId,
      assessmentId: assessment._id,
      assessmentTitle: assessment.title || "",
      courseCode: assessment.courseCode || "",
      status: "queued",
      total: submissions.length,
      processed: 0,
      logs: [{ ts: new Date(), level: "info", message: `Queued digitization for ${submissions.length} submission(s).` }],
    });

    res.status(202).json({ success: true, jobId: String(job._id) });

    // Firestore is optional; reuse same helper.
    let firestore = null;
    try {
      firestore = require("../config/firebase-admin").firestore;
    } catch {}

    setImmediate(async () => {
      await ExtractionJob.updateOne({ _id: job._id }, { $set: { status: "running" } }).catch(() => {});
      await pushLog(job._id, `Digitization started for "${assessment.title || assessmentId}".`);

      try {
        for (let i = 0; i < submissions.length; i++) {
          const subDoc = submissions[i];
          const studentName = await resolveStudentName(subDoc, firestore);
          await ExtractionJob.updateOne(
            { _id: job._id },
            { $set: { currentSubmissionId: String(subDoc._id), currentStudentName: studentName } }
          ).catch(() => {});

          const files = Array.isArray(subDoc?.submissionFiles) ? subDoc.submissionFiles : [];
          const imageFiles = files.filter((f) => {
            const name = String(f?.originalName || f?.filename || "").toLowerCase();
            const ext = path.extname(name);
            return [".jpg", ".jpeg", ".png"].includes(ext) || String(f?.mimeType || "").startsWith("image/");
          });

          if (!imageFiles.length) {
            await pushLog(job._id, `${studentName}: no images found (skipped).`, "info");
            await ExtractionJob.updateOne({ _id: job._id }, { $set: { processed: i + 1 } }).catch(() => {});
            continue;
          }

          await pushLog(job._id, `${studentName}: digitizing ${imageFiles.length} image(s) → OCR PDF…`);
          await SubmissionRaw.findOneAndUpdate(
            { submissionId: subDoc._id },
            { $set: { ocrEnabled: true, ocrStatus: "running", ocrError: "", ocrCount: imageFiles.length } },
            { upsert: true }
          ).catch(() => {});

          const uploadsRoot = path.join(__dirname, "../uploads/student_uploads");
          const ocrOutDir = path.join(uploadsRoot, "ocr_pdfs");
          const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
          const ocrPdfFilename = `submission-${uniqueSuffix}-ocr.pdf`;

          const imagePaths = imageFiles
            .map((f) => path.join(uploadsRoot, String(f.filename || "")))
            .filter((p) => p && fs.existsSync(p));

          if (!imagePaths.length) {
            await SubmissionRaw.findOneAndUpdate(
              { submissionId: subDoc._id },
              { $set: { ocrStatus: "failed", ocrError: "Image files not found on disk." } }
            ).catch(() => {});
            await pushLog(job._id, `${studentName}: failed (images missing on disk).`, "error");
            await ExtractionJob.updateOne({ _id: job._id }, { $set: { processed: i + 1 } }).catch(() => {});
            continue;
          }

          const ocrResult = await ocrImagesToMergedPdf({
            imagePaths,
            outputDir: ocrOutDir,
            outputFileName: ocrPdfFilename,
          });
          const ocrPdfUrl = `/uploads/student_uploads/ocr_pdfs/${ocrResult.pdfFilename}`;

          const derivedEntry = {
            filename: ocrResult.pdfFilename,
            originalName: `OCR_${ocrResult.pdfFilename}`,
            fileUrl: ocrPdfUrl,
            fileSize: fs.existsSync(ocrResult.pdfPath) ? fs.statSync(ocrResult.pdfPath).size : null,
            mimeType: "application/pdf",
            uploadedAt: new Date(),
            uploadedDate: new Date().toISOString().split("T")[0],
            uploadedTime: new Date().toTimeString().split(" ")[0],
            marks: null,
            fileFeedback: "",
            isDerived: true,
            derivedType: "ocr-pdf",
            derivedFrom: imageFiles.map((x) => String(x.filename || "")).filter(Boolean),
          };

          await Submission.findByIdAndUpdate(subDoc._id, {
            $push: { submissionFiles: derivedEntry, uploadedFileNames: derivedEntry.originalName },
            $inc: { uploadedFilesCount: 1, uploadedFilesTotalSize: Number(derivedEntry.fileSize || 0) },
          }).catch(() => {});

          await SubmissionRaw.findOneAndUpdate(
            { submissionId: subDoc._id },
            {
              $set: {
                ocrStatus: "completed",
                ocrError: "",
                ocrPdfFileUrl: ocrPdfUrl,
                ocrPdfFilename: ocrResult.pdfFilename,
                ocrText: String(ocrResult.text || ""),
                ocrCharCount: String(ocrResult.text || "").length,
              },
            }
          ).catch(() => {});

          await pushLog(job._id, `${studentName}: OCR PDF ready.`);
          await ExtractionJob.updateOne({ _id: job._id }, { $set: { processed: i + 1 } }).catch(() => {});
        }

        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "completed", finishedAt: new Date(), currentSubmissionId: "", currentStudentName: "" } }
        ).catch(() => {});
        await pushLog(job._id, "Digitization completed.", "info");
      } catch (e) {
        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "failed", error: e?.message || String(e), finishedAt: new Date() } }
        ).catch(() => {});
        await pushLog(job._id, `Digitization failed: ${e?.message || String(e)}`, "error");
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to start digitization batch", details: error.message });
  }
};

