const Submission = require("../models/Submission");
const Assessment = require("../models/Assessment");
const Course = require("../models/Course");
const path = require("path");
const fs = require("fs");
const { notifySubmissionCreated, logSubmissionActivity } = require("../utils/notificationService");
const uploadUtils = require("../utils/uploadUtils");
const { firestore } = require("../config/firebase");
const { ingestSubmission } = require("../utils/ingestionService");
const SubmissionRaw = require("../models/SubmissionRaw");
const ExtractionJob = require("../models/ExtractionJob");
const { automarkOneSubmission, buildPerQuestionScoresFromReport, extractFirstJsonObject } = require("../utils/automarkLlmService");
const { ocrImagesToMergedPdf } = require("../utils/ocrService");
// Recommended notes links (curated matcher) — temporarily disabled.
// const { recommendLearningResource } = require("../utils/resourceRecommendationService");

async function _pushExtractionJobLog(jobId, message, level = "info") {
  await ExtractionJob.updateOne({ _id: jobId }, { $push: { logs: { ts: new Date(), level, message } } }).catch(() => {});
}

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
  } catch {}

  const files = Array.isArray(subDoc?.submissionFiles) ? subDoc.submissionFiles : [];
  const ipynbFiles = files.filter((f) => {
    const name = String(f?.originalName || f?.filename || "").toLowerCase();
    return path.extname(name) === ".ipynb";
  });
  if (!ipynbFiles.length) return { created: 0, skipped: 0 };

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
      $push: {
        submissionFiles: { $each: derivedEntries },
        uploadedFileNames: { $each: derivedEntries.map((x) => x.originalName) },
      },
      $inc: { uploadedFilesCount: derivedEntries.length, uploadedFilesTotalSize: totalSize },
    }).catch(() => {});
  }

  return { created, skipped };
}

function parseAiAnalysisToReport(aiAnalysis) {
  if (!aiAnalysis) return null;
  const s = String(aiAnalysis || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return extractFirstJsonObject(s);
  }
}

async function resolveStudentEmail(studentId) {
  const sid = String(studentId || "").trim();
  if (!sid) return "";
  try {
    const doc = await firestore.collection("users").doc(sid).get();
    if (doc.exists) {
      const data = doc.data() || {};
      return String(data.email || data.mail || "").trim();
    }
  } catch {
    // ignore
  }
  return "";
}

/**
 * GET /api/submissions/:submissionId/performance?teacherId=...
 * Real-time performance stats for AI Grading right panel.
 *
 * - Average: average % among submissions for same assessment+course
 * - Rank: rank of this student's % among same assessment+course submissions
 * - Improvement: delta vs this student's previous submission in same course + same assessmentType
 */
exports.getSubmissionPerformanceStats = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.query.teacherId || "").trim();
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId query parameter are required" });
    }

    const sub = await Submission.findById(submissionId).lean();
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const assessmentId = String(sub.assessmentId?._id || sub.assessmentId || "");
    const courseId = String(sub.courseId?._id || sub.courseId || "");
    const assessmentType = String(sub.assessmentType || "").toLowerCase() === "quiz" ? "quiz" : "assignment";

    const maxGrade = Number(sub.maxGrade ?? 0) || 0;
    const score = Number(sub.grade ?? sub.aiGradingSuggestion ?? 0) || 0;
    const currentPercent = maxGrade > 0 ? (score / maxGrade) * 100 : 0;

    // Cohort: same assessment + same course + same teacher
    const cohort = await Submission.find({
      teacherId,
      assessmentId: sub.assessmentId,
      courseId: sub.courseId,
    })
      .select("studentId grade aiGradingSuggestion maxGrade")
      .lean();

    const cohortPercents = (Array.isArray(cohort) ? cohort : [])
      .map((s) => {
        const mg = Number(s?.maxGrade ?? 0) || 0;
        const sc = Number(s?.grade ?? s?.aiGradingSuggestion ?? 0) || 0;
        const pct = mg > 0 ? (sc / mg) * 100 : null;
        return { studentId: String(s?.studentId || ""), pct };
      })
      .filter((x) => x.studentId && Number.isFinite(x.pct));

    const totalStudents = cohortPercents.length;
    const averagePercent =
      totalStudents > 0
        ? cohortPercents.reduce((acc, x) => acc + Number(x.pct || 0), 0) / totalStudents
        : 0;

    // Rank: dense ranking by percent (higher is better)
    const sorted = [...cohortPercents].sort((a, b) => Number(b.pct) - Number(a.pct));
    let rank = null;
    const myStudentId = String(sub.studentId || "");
    if (myStudentId) {
      const idx = sorted.findIndex((x) => x.studentId === myStudentId);
      if (idx >= 0) rank = idx + 1;
    }

    // Improvement: compare vs previous submission of same student in same course and same assessmentType
    const prev = await Submission.findOne({
      teacherId,
      courseId: sub.courseId,
      studentId: sub.studentId,
      assessmentType: assessmentType,
      _id: { $ne: sub._id },
      status: "graded",
    })
      .sort({ submittedAt: -1 })
      .select("grade aiGradingSuggestion maxGrade submittedAt assessmentTitle assessmentId")
      .lean()
      .catch(() => null);

    const prevMax = Number(prev?.maxGrade ?? 0) || 0;
    const prevScore = Number(prev?.grade ?? prev?.aiGradingSuggestion ?? 0) || 0;
    const prevPercent = prev && prevMax > 0 ? (prevScore / prevMax) * 100 : null;
    const improvementDelta = prevPercent != null ? currentPercent - prevPercent : null;

    return res.status(200).json({
      success: true,
      assessmentId,
      courseId,
      assessmentType,
      averagePercent: Number.isFinite(averagePercent) ? Math.round(averagePercent) : 0,
      currentPercent: Number.isFinite(currentPercent) ? Math.round(currentPercent) : 0,
      rank,
      totalStudents,
      improvementDelta: improvementDelta == null ? null : Math.round(improvementDelta),
      previousPercent: prevPercent == null ? null : Math.round(prevPercent),
      previousAssessmentTitle: prev?.assessmentTitle || "",
    });
  } catch (error) {
    console.error("❌ getSubmissionPerformanceStats:", error);
    return res.status(500).json({ success: false, error: "Failed to compute performance stats" });
  }
};

/**
 * Submit an assessment answer
 * POST /api/submissions/submit
 */
exports.submitAssessment = async (req, res) => {
  try {
    const {
      assessmentId,
      studentId,
      submissionText,
      courseCode
    } = req.body;

    // Validate required fields
    if (!assessmentId || !studentId) {
      return res.status(400).json({ 
        error: "Assessment ID and Student ID are required" 
      });
    }

    // Get assessment details
    const assessment = await Assessment.findById(assessmentId);
    if (!assessment) {
      return res.status(404).json({ error: "Assessment not found" });
    }

    // Get course details
    const course = await Course.findById(assessment.courseId);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    // Check if student already submitted
    const existingSubmission = await Submission.findOne({
      assessmentId,
      studentId
    });

    if (existingSubmission) {
      return res.status(400).json({ 
        error: "You have already submitted this assessment",
        submissionId: existingSubmission._id
      });
    }

    // Determine deadline (prefer submissionDeadline; else combine dueDate+dueTime; else dueDate)
    let deadline = assessment.submissionDeadline || null;
    if (!deadline && assessment.dueDate && assessment.dueTime) {
      deadline = new Date(`${assessment.dueDate}T${assessment.dueTime}`);
    }
    if (!deadline && assessment.dueDate) {
      deadline = new Date(assessment.dueDate);
    }

    const submissionTimestamp = new Date();
    const submissionDate = submissionTimestamp.toISOString().split('T')[0]; // YYYY-MM-DD
    const submissionTime = submissionTimestamp.toTimeString().split(' ')[0]; // HH:MM:SS
    const isLate = deadline ? submissionTimestamp > new Date(deadline) : false;

    const msPerDay = 24 * 60 * 60 * 1000;
    const lateDays = isLate
      ? Math.max(1, Math.ceil((submissionTimestamp.getTime() - new Date(deadline).getTime()) / msPerDay))
      : 0;
    const latePenaltyPerDay = isLate ? (assessment.latePenalty || 0) : 0;
    const latePenaltyPercent = isLate
      ? Math.min(100, lateDays * latePenaltyPerDay)
      : 0;

    // Business rule: submissions are allowed only when due date exists.
    if (!deadline) {
      return res.status(400).json({
        success: false,
        errorCode: "DEADLINE_REQUIRED",
        error: "Submission is not allowed because this assessment has no due date set."
      });
    }

    // Business rule: expired assessments cannot be submitted UNLESS late submissions are allowed
    if (isLate && !assessment.allowLateSubmission) {
      return res.status(403).json({ 
        success: false,
        errorCode: "DEADLINE_EXPIRED",
        error: "Submission deadline has passed for this assessment. Late submissions are not allowed."
      });
    }

    // Log if submission is late
    if (isLate && assessment.allowLateSubmission) {
      console.log(`⚠️ LATE SUBMISSION ALLOWED - Assessment: ${assessment.title}, Student: ${studentId}, Penalty: ${assessment.latePenalty}%`);
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        errorCode: "FILE_REQUIRED",
        error: "Please upload at least one file (PDF, DOC/DOCX, JPG, PNG)."
      });
    }

    // Process uploaded files
    const submissionFiles = [];
    let studentName = "Student";
    let studentEmail = "";

    try {
      const studentDoc = await firestore.collection('users').doc(studentId).get();
      if (studentDoc.exists) {
        const studentData = studentDoc.data();
        studentName = studentData.name || studentData.email || "Student";
        studentEmail = studentData.email || "";
      }
    } catch (error) {
      console.warn(`Could not fetch student data for ${studentId}`);
    }
    
    if (req.files && req.files.length > 0) {
      const dateStr = submissionDate;
      const timeStr = submissionTime;
      
      for (const file of req.files) {
        const fileUrl = `/uploads/student_uploads/${file.filename}`;
        
        submissionFiles.push({
          filename: file.filename,
          originalName: file.originalname,
          fileUrl,
          fileSize: file.size,
          mimeType: file.mimetype,
          uploadedAt: submissionTimestamp,
          uploadedDate: dateStr,
          uploadedTime: timeStr,
          marks: null,
          fileFeedback: ""
        });
      }
    }

    // Create submission record
    const uploadedFileNames = submissionFiles.map((file) => file.originalName || file.filename);
    const uploadedFilesCount = submissionFiles.length;
    const uploadedFilesTotalSize = submissionFiles.reduce((total, file) => total + (file.fileSize || 0), 0);

    const submission = new Submission({
      assessmentId,
      assessmentTitle: assessment.title,
      assessmentType: assessment.type,
      studentId,
      studentName,
      studentEmail,
      courseId: assessment.courseId,
      courseCode: course.courseCode,
      courseName: course.courseTitle,
      teacherId: assessment.teacherId,
      submissionFiles,
      uploadedFileNames,
      uploadedFilesCount,
      uploadedFilesTotalSize,
      submissionText: submissionText || "",
      submittedAt: submissionTimestamp,
      submissionDate,
      submissionTime,
      isLate,
      lateDays,
      latePenaltyPerDay,
      latePenaltyPercent,
      status: isLate ? 'late' : 'submitted',
      maxGrade: assessment.totalMarks,
      attemptNumber: 1
    });

    await submission.save();
    console.log(`✅ Submission created: ${submission._id} for assessment ${assessmentId} with ${submissionFiles.length} file(s)`);

    // Create/Upsert SubmissionRaw record (vector metadata + extraction placeholders)
    try {
      const visualCount = submissionFiles.reduce((acc, f) => {
        const name = String(f?.originalName || f?.filename || "").toLowerCase();
        const ext = path.extname(name);
        return acc + ([".jpg", ".jpeg", ".png"].includes(ext) ? 1 : 0);
      }, 0);

      const initialContentTypesSet = new Set();
      if ((submissionText || "").trim()) initialContentTypesSet.add("text");
      for (const f of submissionFiles) {
        const name = String(f?.originalName || f?.filename || "").toLowerCase();
        const ext = path.extname(name);
        if ([".pdf", ".docx"].includes(ext)) initialContentTypesSet.add("text");
        if ([".py", ".ipynb", ".java", ".js", ".ts", ".tsx", ".c", ".cpp", ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift"].includes(ext)) {
          initialContentTypesSet.add("code");
        }
        if ([".jpg", ".jpeg", ".png"].includes(ext)) initialContentTypesSet.add("graphical");
      }

      const studentEmail = await resolveStudentEmail(studentId);
      await SubmissionRaw.findOneAndUpdate(
        { submissionId: submission._id },
        {
          $setOnInsert: {
            submissionId: submission._id,
          },
          $set: {
            assessmentId: submission.assessmentId,
            courseId: submission.courseId,
            teacherId: submission.teacherId,
            studentId: submission.studentId,
            studentEmail,
            extractionStatus: "pending",
            extractor: "",
            rawText: "",
            charCount: 0,
            pageCount: 0,
            pageMetadata: [],
            contentTypes: Array.from(initialContentTypesSet),
            visualCount,
            equationCount: 0,
            ocrCount: 0,
            ocrCharCount: 0,
            // Default to OCR enabled for student submissions; per-run ingestion can still disable explicitly.
            ocrEnabled: true,
            ocrStatus: "",
            ocrError: "",
            extractionError: "",
            extractedAt: null,
            faissIngestionStatus: "pending",
            faissChunkCount: 0,
            numChunks: 0,
            numEmbeddings: 0,
            faissChunksMetadata: [],
            faissIngestionDurationMs: 0,
            faissIngestionError: "",
            faissIngestedAt: null,
          },
        },
        { upsert: true, new: true }
      );
    } catch (e) {
      console.warn("[SUBMISSION-RAW] ⚠️ Failed to create SubmissionRaw:", e?.message || e);
    }

    // ==================== OCR (OPTIONAL AT SUBMIT) ====================
    // Default behavior should be teacher-triggered digitization.
    // Enable automatic OCR at submit time only if OCR_ON_SUBMIT=true.
    if (String(process.env.OCR_ON_SUBMIT || "").toLowerCase() === "true") {
      try {
      const imageFiles = submissionFiles.filter((f) => {
        const name = String(f?.originalName || f?.filename || "").toLowerCase();
        const ext = path.extname(name);
        return [".jpg", ".jpeg", ".png"].includes(ext) || String(f?.mimeType || "").startsWith("image/");
      });

      if (imageFiles.length > 0) {
        const uploadsRoot = path.join(__dirname, "../uploads/student_uploads");
        const ocrOutDir = path.join(uploadsRoot, "ocr_pdfs");
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ocrPdfFilename = `submission-${uniqueSuffix}-ocr.pdf`;

        // Mark OCR running
        await SubmissionRaw.findOneAndUpdate(
          { submissionId: submission._id },
          { $set: { ocrEnabled: true, ocrStatus: "running", ocrError: "", ocrCount: imageFiles.length } }
        ).catch(() => {});

        const imagePaths = imageFiles
          .map((f) => path.join(uploadsRoot, String(f.filename || "")))
          .filter((p) => p && fs.existsSync(p));

        if (imagePaths.length > 0) {
          const ocrResult = await ocrImagesToMergedPdf({
            imagePaths,
            outputDir: ocrOutDir,
            outputFileName: ocrPdfFilename,
          });

          const ocrPdfUrl = `/uploads/student_uploads/ocr_pdfs/${ocrResult.pdfFilename}`;

          // Attach derived OCR PDF to submissionFiles so teacher UI shows a single PDF in "Text" tab.
          const derivedEntry = {
            filename: path.posix.join("ocr_pdfs", ocrResult.pdfFilename).replace(/\\/g, "/"),
            originalName: `OCR_${ocrResult.pdfFilename}`,
            fileUrl: ocrPdfUrl,
            fileSize: fs.existsSync(ocrResult.pdfPath) ? fs.statSync(ocrResult.pdfPath).size : null,
            mimeType: "application/pdf",
            uploadedAt: new Date(),
            uploadedDate: submissionDate,
            uploadedTime: submissionTime,
            marks: null,
            fileFeedback: "",
            isDerived: true,
            derivedType: "ocr-pdf",
            derivedFrom: imageFiles.map((x) => String(x.filename || "")).filter(Boolean),
          };

          await Submission.findByIdAndUpdate(submission._id, {
            $push: {
              submissionFiles: derivedEntry,
              uploadedFileNames: derivedEntry.originalName,
            },
            $inc: {
              uploadedFilesCount: 1,
              uploadedFilesTotalSize: Number(derivedEntry.fileSize || 0),
            },
          }).catch(() => {});

          await SubmissionRaw.findOneAndUpdate(
            { submissionId: submission._id },
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
        } else {
          await SubmissionRaw.findOneAndUpdate(
            { submissionId: submission._id },
            { $set: { ocrStatus: "failed", ocrError: "OCR skipped: image files not found on disk." } }
          ).catch(() => {});
        }
      }
    } catch (e) {
      await SubmissionRaw.findOneAndUpdate(
        { submissionId: submission._id },
        { $set: { ocrStatus: "failed", ocrError: e?.message || String(e) } }
      ).catch(() => {});
      console.warn("[SUBMISSION-OCR] ⚠️ OCR failed:", e?.message || e);
      }
    }

    // Send notifications and admin activity update (async, non-blocking)
    setImmediate(async () => {
      try {
        await notifySubmissionCreated(submission, assessment, course, studentId);
        await logSubmissionActivity(submission, assessment, course, studentId);
      } catch (error) {
        console.warn('⚠️ Failed to process submission events:', error.message);
      }
    });

    // IMPORTANT: Do NOT auto-extract / ingest student submissions on upload.
    // Extraction/FAISS ingestion should happen only when the teacher clicks the Extract button
    // (see extractionController.startAssessmentExtractBatch).
    //
    // We only mark statuses as pending here so the UI can show "Not extracted yet".
    const subId = String(submission._id);
    await Submission.findByIdAndUpdate(subId, {
      $set: {
        faissIngestionStatus: "pending",
        faissIngestionError: "",
        faissChunkCount: 0,
        faissIngestedAt: null,
      },
    }).catch(() => {});

    await SubmissionRaw.findOneAndUpdate(
      { submissionId: submission._id },
      {
        $setOnInsert: { submissionId: submission._id },
        $set: {
          assessmentId: submission.assessmentId,
          courseId: submission.courseId,
          teacherId: String(submission.teacherId || ""),
          studentId: String(submission.studentId || ""),
          extractionStatus: "pending",
          extractionError: "",
          faissIngestionStatus: "pending",
          faissIngestionError: "",
          faissChunkCount: 0,
          numChunks: 0,
          numEmbeddings: 0,
          faissIngestionDurationMs: 0,
          faissIngestedAt: null,
        },
      },
      { upsert: true }
    ).catch(() => {});

    res.status(201).json({
      success: true,
      errorCode: null,
      message: "Assessment submitted successfully",
      submission: {
        id: submission._id,
        assessmentId: submission.assessmentId,
        submittedAt: submission.submittedAt,
        submittedDate: submissionDate,
        submittedTime: submissionTime,
        uploadedFileNames,
        uploadedFilesCount,
        uploadedFilesTotalSize,
        isLate: submission.isLate,
        status: submission.status,
        filesCount: submissionFiles.length
      }
    });

  } catch (error) {
    console.error("❌ Error submitting assessment:", error);
    res.status(500).json({ 
      error: "Failed to submit assessment",
      details: error.message
    });
  }
};

/**
 * Get all submissions for a student
 * GET /api/submissions/student/:studentId
 */
exports.getStudentSubmissions = async (req, res) => {
  try {
    const { studentId } = req.params;

    const submissions = await Submission.find({ studentId })
      .populate('assessmentId', 'title type dueDate totalMarks')
      .populate('courseId', 'courseCode courseTitle')
      .sort({ submittedAt: -1 })
      .lean();

    // IMPORTANT: Student should only see grade/feedback once teacher publishes it.
    const sanitized = (submissions || []).map((s) => {
      const gradePublished = Boolean(s?.gradePublished);
      if (gradePublished) {
        // Strip any persisted recommendedResource so UI won't show stale links while feature is disabled.
        const { recommendedResource: _rr, ...rest } = s || {};
        return rest;
      }
      return {
        ...s,
        status: "submitted",
        grade: null,
        feedback: "",
        gradedBy: null,
        gradedAt: null,
        recommendedResource: null,
      };
    });

    res.json({
      success: true,
      submissions: sanitized,
      count: sanitized.length
    });

  } catch (error) {
    console.error("❌ Error fetching student submissions:", error);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
};

/**
 * Teacher: publish the generated PDF report for student visibility.
 * POST /api/submissions/:submissionId/publish-report
 * Body: { teacherId }
 */
exports.publishStudentReport = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId are required" });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(submission.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    if (String(submission.status || "") !== "graded") {
      return res.status(400).json({ success: false, error: "Report can be sent after grading." });
    }

    // Build and persist a snapshot so student sees EXACT same report teacher sent.
    // (Teacher report is generated client-side; this snapshot freezes the payload.)
    let raw = null;
    try {
      raw = await SubmissionRaw.findOne({ submissionId: submission._id })
        .select("perQuestionScores automarkReport rawText ocrText extractor extractionStatus contentTypes")
        .lean()
        .catch(() => null);
    } catch {
      raw = null;
    }

    const files = Array.isArray(submission.submissionFiles) ? submission.submissionFiles : [];
    const mappedFiles = files.map((f, idx) => ({
      id: String(f?._id || idx),
      filename: String(f?.filename || ""),
      originalName: String(f?.originalName || f?.filename || `file-${idx + 1}`),
      fileUrl: String(f?.fileUrl || ""),
      mimeType: String(f?.mimeType || ""),
      fileSize: typeof f?.fileSize === "number" ? f.fileSize : null,
      isDerived: Boolean(f?.isDerived),
      derivedType: String(f?.derivedType || ""),
      derivedFrom: Array.isArray(f?.derivedFrom) ? f.derivedFrom : [],
    }));

    const extractedRawText =
      String(raw?.rawText || "").trim() ||
      String(raw?.ocrText || "").trim() ||
      String(submission.submissionText || "").trim();

    const snapshot = {
      submission: {
        _id: String(submission._id),
        assessmentTitle: submission.assessmentTitle || "",
        assessmentType: submission.assessmentType === "quiz" ? "quiz" : "assignment",
        courseCode: submission.courseCode || "",
        courseName: submission.courseName || "",
        studentName: submission.studentName || "",
        submittedAt: submission.submittedAt ? new Date(submission.submittedAt).toISOString() : null,
        submittedDisplay: submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : "",
        grade: submission.grade ?? null,
        maxGrade: typeof submission.maxGrade === "number" ? submission.maxGrade : null,
        feedback: submission.feedback || "",
        plagiarismBestMatchPercent:
          typeof submission.plagiarismBestMatchPercent === "number" ? submission.plagiarismBestMatchPercent : null,
        plagiarismCheckedAt: submission.plagiarismCheckedAt ? new Date(submission.plagiarismCheckedAt).toISOString() : null,
        reportPublishedAt: new Date().toISOString(),
      },
      submissionRaw: raw || null,
      content: {
        success: true,
        files: mappedFiles,
        extraction: {
          status: String(raw?.extractionStatus || "completed"),
          extractor: String(raw?.extractor || ""),
          contentTypes: Array.isArray(raw?.contentTypes) ? raw.contentTypes : [],
          rawText: extractedRawText,
        },
        submissionText: String(submission.submissionText || ""),
      },
    };

    await SubmissionRaw.updateOne(
      { submissionId: submission._id },
      { $set: { publishedReportSnapshot: snapshot, publishedReportSnapshotAt: new Date() } },
      { upsert: true }
    ).catch(() => {});

    submission.reportPublished = true;
    submission.reportPublishedAt = new Date();
    await submission.save();

    return res.status(200).json({
      success: true,
      message: "Report sent to student",
      submission: {
        id: submission._id,
        reportPublished: Boolean(submission.reportPublished),
        reportPublishedAt: submission.reportPublishedAt ? new Date(submission.reportPublishedAt).toISOString() : null,
      },
    });
  } catch (error) {
    console.error("❌ publishStudentReport:", error);
    return res.status(500).json({ success: false, error: "Failed to publish report", details: error.message });
  }
};

/**
 * Get submission for a specific assessment by a student
 * GET /api/submissions/assessment/:assessmentId/student/:studentId
 */
exports.getSubmissionByAssessment = async (req, res) => {
  try {
    const { assessmentId, studentId } = req.params;

    const submission = await Submission.findOne({ 
      assessmentId, 
      studentId 
    })
      .populate('assessmentId', 'title type dueDate totalMarks')
      .populate('courseId', 'courseCode courseTitle')
      .lean();

    if (!submission) {
      return res.status(404).json({ 
        success: false,
        error: "Submission not found" 
      });
    }

    res.json({
      success: true,
      submission
    });

  } catch (error) {
    console.error("❌ Error fetching submission:", error);
    res.status(500).json({ error: "Failed to fetch submission" });
  }
};

/**
 * Get all submissions for an assessment (Teacher view)
 * GET /api/submissions/assessment/:assessmentId
 */
exports.getAssessmentSubmissions = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const { firestore } = require("../config/firebase");

    const submissions = await Submission.find({ assessmentId })
      .sort({ submittedAt: -1 })
      .lean();

    // Enrich with student names from Firebase
    const enrichedSubmissions = await Promise.all(submissions.map(async (submission) => {
      let studentName = 'Unknown Student';
      let studentEmail = '';

      try {
        const studentDoc = await firestore.collection('users').doc(submission.studentId).get();
        if (studentDoc.exists) {
          const studentData = studentDoc.data();
          studentName = studentData.name || studentData.email || 'Unknown Student';
          studentEmail = studentData.email || '';
        }
      } catch (error) {
        console.warn(`Could not fetch student data for ${submission.studentId}`);
      }

      return {
        ...submission,
        studentName,
        studentEmail
      };
    }));

    res.json({
      success: true,
      submissions: enrichedSubmissions,
      count: enrichedSubmissions.length,
      stats: {
        total: enrichedSubmissions.length,
        graded: enrichedSubmissions.filter(s => s.status === 'graded').length,
        pending: enrichedSubmissions.filter(s => s.status === 'submitted' || s.status === 'late').length,
        late: enrichedSubmissions.filter(s => s.isLate).length
      }
    });

  } catch (error) {
    console.error("❌ Error fetching assessment submissions:", error);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
};

/**
 * Grade a submission (Teacher)
 * PATCH /api/submissions/:submissionId/grade
 */
exports.gradeSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { grade, feedback, teacherId } = req.body;

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Validate grade
    if (grade < 0 || grade > submission.maxGrade) {
      return res.status(400).json({ 
        error: `Grade must be between 0 and ${submission.maxGrade}` 
      });
    }

    // Update submission
    submission.grade = grade;
    submission.feedback = feedback || "";
    submission.gradedBy = teacherId;
    submission.gradedAt = new Date();
    submission.status = 'graded';
    submission.manualOverride = true;
    submission.needsTeacherReview = false;

    // Keep plagiarism score/report persistent, but update the *grade after plagiarism*
    // whenever teacher manually overrides the base grade.
    try {
      const bestPct =
        Number(submission.plagiarismBestMatchPercent) ||
        Number(submission?.plagiarismReport?.bestMatchPercent) ||
        0;
      const maxGrade = Number(submission.maxGrade ?? 0) || 0;
      const baseGrade = Math.max(0, Math.min(maxGrade || 999999, Number(grade) || 0));

      // Prefer persisted penalty (computed during plagiarism check); fall back to deterministic recompute.
      const lerp = (a, b, t) => a + (b - a) * t;
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      const computePenaltyPercent = (pct) => {
        const p = Number(pct);
        if (!Number.isFinite(p) || p < 30) return 0;
        if (p < 60) return Math.round(lerp(10, 20, clamp01((p - 30) / 30)));
        if (p < 80) return Math.round(lerp(30, 50, clamp01((p - 60) / 20)));
        return 100;
      };

      const penaltyPercent = Number.isFinite(Number(submission.plagiarismPenaltyPercent))
        ? Number(submission.plagiarismPenaltyPercent)
        : computePenaltyPercent(bestPct);

      let adjusted = baseGrade;
      if (bestPct >= 80) adjusted = Math.min(1, maxGrade || 1);
      else if (penaltyPercent > 0) adjusted = Math.max(0, baseGrade - baseGrade * (penaltyPercent / 100));

      submission.plagiarismBestMatchPercent = Number.isFinite(bestPct) ? bestPct : submission.plagiarismBestMatchPercent;
      submission.plagiarismPenaltyPercent = penaltyPercent;
      submission.plagiarismAdjustedGrade = adjusted;
      // Teacher UI uses aiGradingSuggestion as "current score"; keep it aligned after override.
      submission.aiGradingSuggestion = adjusted;

      if (submission.plagiarismReport && typeof submission.plagiarismReport === "object") {
        submission.plagiarismReport = {
          ...(submission.plagiarismReport || {}),
          bestMatchPercent: (submission.plagiarismReport?.bestMatchPercent ?? bestPct),
          gradeAfterPlagiarism: adjusted,
          penalty: submission.plagiarismReport?.penalty
            ? { ...(submission.plagiarismReport.penalty || {}), penaltyPercent }
            : submission.plagiarismReport?.penalty,
          gradeOverrideSyncedAt: new Date().toISOString(),
        };
      }
    } catch {
      // best-effort only; grading should still succeed
    }

    await submission.save();

    console.log(`✅ Submission ${submissionId} graded: ${grade}/${submission.maxGrade}`);

    // Update CLO-wise performance (async, non-blocking)
    setImmediate(async () => {
      try {
        const cloPerformanceService = require("../utils/cloPerformanceService");
        const updatedCLOs = await cloPerformanceService.updateCLOPerformanceForSubmission(submissionId);
        if (updatedCLOs.length > 0) {
          console.log(`✅ Updated CLO performance for ${updatedCLOs.length} CLOs: ${updatedCLOs.map(c => `CLO${c.cloNumber}`).join(', ')}`);
        }
      } catch (error) {
        console.warn('⚠️ Failed to update CLO performance:', error.message);
      }
    });

    // Send notification to student (async)
    setImmediate(async () => {
      try {
        const { notifySubmissionGraded } = require("../utils/notificationService");
        const assessment = await Assessment.findById(submission.assessmentId);
        await notifySubmissionGraded(submission, assessment, submission.studentId);
      } catch (error) {
        console.warn('⚠️ Failed to send grading notification:', error.message);
      }
    });

    res.json({
      success: true,
      message: "Submission graded successfully",
      submission: {
        id: submission._id,
        grade: submission.grade,
        maxGrade: submission.maxGrade,
        gradePercentage: submission.gradePercentage,
        status: submission.status
      }
    });

  } catch (error) {
    console.error("❌ Error grading submission:", error);
    res.status(500).json({ error: "Failed to grade submission" });
  }
};

/**
 * Update submission marks/feedback and sync CLO performance
 * PATCH /api/submissions/:submissionId/update-marks
 * 
 * Allows teacher to edit grades/feedback after initial grading
 * Automatically syncs CLO performance data
 */
exports.updateSubmissionMarks = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { grade, feedback, teacherId } = req.body;

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Validate grade
    if (grade !== undefined && (grade < 0 || grade > submission.maxGrade)) {
      return res.status(400).json({ 
        error: `Grade must be between 0 and ${submission.maxGrade}` 
      });
    }

    const updates = {};
    
    // Only update fields that are provided
    if (grade !== undefined && grade !== null) {
      updates.grade = grade;
    }
    if (feedback !== undefined && feedback !== null) {
      updates.feedback = feedback;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ 
        error: "No updates provided (grade or feedback required)" 
      });
    }

    // Update submission
    Object.assign(submission, updates);
    submission.lastUpdated = new Date();
    submission.updatedBy = teacherId;
    
    await submission.save();

    console.log(`✅ Updated submission ${submissionId}: grade=${updates.grade}, feedback=${updates.feedback ? 'provided' : 'unchanged'}`);

    // Sync CLO performance (async)
    setImmediate(async () => {
      try {
        const cloPerformanceService = require("../utils/cloPerformanceService");
        const updatedCLOs = await cloPerformanceService.updateCLOPerformanceForSubmission(submissionId);
        if (updatedCLOs.length > 0) {
          console.log(`✅ Re-synced CLO performance for ${updatedCLOs.length} CLOs after mark update`);
        }
      } catch (error) {
        console.warn('⚠️ Failed to sync CLO performance:', error.message);
      }
    });

    res.json({
      success: true,
      message: "Submission marks updated and CLO performance synced",
      submission: {
        id: submission._id,
        grade: submission.grade,
        maxGrade: submission.maxGrade,
        feedback: submission.feedback,
        status: submission.status
      }
    });

  } catch (error) {
    console.error("❌ Error updating submission marks:", error);
    res.status(500).json({ error: "Failed to update submission marks" });
  }
};

function buildFeedbackFromAiReport(report) {
  try {
    const r = report && typeof report === "object" ? report : null;
    if (!r) return "";
    const lines = [];
    const totals = r.totals || {};
    const awarded = totals.awarded ?? null;
    const max = totals.max ?? null;
    if (awarded != null && max != null) {
      lines.push(`AutoMark Report: ${awarded}/${max}`);
    } else {
      lines.push("AutoMark Report");
    }
    lines.push("");

    const qs = Array.isArray(r.questions) ? r.questions : [];
    for (const q of qs) {
      const qk = String(q?.questionKey || "").trim() || "Q";
      const a = q?.awardedMarks;
      const m = q?.maxMarks;
      lines.push(`${qk}: ${a ?? "—"}/${m ?? "—"}`);
      const summary = String(q?.summary || "").trim();
      if (summary) lines.push(`Summary: ${summary}`);

      const feedback = String(q?.feedback || "").trim();
      if (feedback) lines.push(`Feedback: ${feedback}`);

      const mistakes = Array.isArray(q?.mistakes)
        ? q.mistakes
            .map((mm) => String(mm?.feedback || mm?.explanation || mm?.message || "").trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];
      if (mistakes.length) lines.push(`Mistakes: ${mistakes.join("; ")}`);

      const strengths = Array.isArray(q?.strengths) ? q.strengths.filter(Boolean) : [];
      if (strengths.length) lines.push(`Strengths: ${strengths.slice(0, 5).join("; ")}`);
      const improvements = Array.isArray(q?.improvements) ? q.improvements.filter(Boolean) : [];
      if (improvements.length) lines.push(`Improvements: ${improvements.slice(0, 5).join("; ")}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  } catch {
    return "";
  }
}

function buildFeedbackFromSubmissionRaw(raw) {
  try {
    const r = raw && typeof raw === "object" ? raw : null;
    const report = r?.automarkReport && typeof r.automarkReport === "object" ? r.automarkReport : null;
    const perQ = Array.isArray(r?.perQuestionScores) ? r.perQuestionScores : [];
    const reportQs = Array.isArray(report?.questions) ? report.questions : [];

    // Prefer the same source that AI Grading UI uses for per-question feedback:
    // perQuestionScores often has feedback even when automarkReport.questions doesn't (legacy rows).
    const perQHasFeedback = perQ.some((q) => String(q?.feedback || "").trim());
    const reportHasFeedback = reportQs.some((q) => String(q?.feedback || "").trim());
    const qs = perQHasFeedback ? perQ : reportHasFeedback ? reportQs : perQ.length ? perQ : reportQs;
    if (!qs.length) return "";

    const lines = [];
    for (const q of qs) {
      const qk = String(q?.questionKey || "").trim() || "Q";
      const fb = String(q?.feedback || "").trim();
      if (fb) lines.push(`${qk}: ${fb}`);
    }
    const out = lines.join("\n").trim();
    return out;
  } catch {
    return "";
  }
}

/**
 * Publish AI report to student (finalize grade + feedback + notify).
 * POST /api/submissions/:submissionId/publish-ai
 * Body: { teacherId }
 */
exports.publishAiReport = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId are required" });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(submission.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    let reportObj = null;
    try {
      reportObj = submission.aiAnalysis ? JSON.parse(String(submission.aiAnalysis)) : null;
    } catch {
      reportObj = null;
    }

    // If teacher already overrode grade/feedback, never overwrite on publish.
    const isManual = Boolean(submission.manualOverride);
    const gradeToSave = isManual
      ? Number(submission.grade ?? 0) || 0
      : Number(submission.aiGradingSuggestion ?? reportObj?.totals?.awarded ?? submission.grade ?? 0) || 0;

    let raw = null;
    try {
      raw = await SubmissionRaw.findOne({ submissionId: submission._id })
        .select("perQuestionScores automarkReport")
        .lean()
        .catch(() => null);
    } catch {
      raw = null;
    }

    // Prefer the same per-question feedback used on AI Grading page (SubmissionRaw).
    const rawFeedback = buildFeedbackFromSubmissionRaw(raw);
    const aiFeedback = rawFeedback || buildFeedbackFromAiReport(reportObj);
    const feedbackToSave = isManual ? (submission.feedback || "") : (aiFeedback || submission.feedback || "");

    // Apply plagiarism policy if available (computed when teacher runs plagiarism check).
    const bestPct = Number(submission.plagiarismBestMatchPercent);
    const maxGrade = Number(submission.maxGrade ?? 0) || 0;
    const baseGrade = Math.max(0, Math.min(maxGrade || 999999, Number(gradeToSave) || 0));

    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const computePenalty = (pct) => {
      const p = Number(pct);
      if (!Number.isFinite(p)) return { penaltyPercent: 0, severity: "unknown", cappedGrade: null, needsReview: false };
      if (p < 30) return { penaltyPercent: 0, severity: "no_issue", cappedGrade: null, needsReview: false };
      if (p < 60) {
        const t = clamp01((p - 30) / 30);
        return { penaltyPercent: Math.round(lerp(10, 20, t)), severity: "slight", cappedGrade: null, needsReview: false };
      }
      if (p < 80) {
        const t = clamp01((p - 60) / 20);
        return { penaltyPercent: Math.round(lerp(30, 50, t)), severity: "high", cappedGrade: null, needsReview: false };
      }
      // severe: give 0–1 marks OR manual review
      return { penaltyPercent: 100, severity: "severe", cappedGrade: Math.min(1, maxGrade || 1), needsReview: true };
    };

    const pol = computePenalty(bestPct);
    let finalGrade = baseGrade;
    if (pol.severity === "severe" && pol.cappedGrade != null) {
      finalGrade = pol.cappedGrade;
    } else if (pol.penaltyPercent > 0) {
      finalGrade = Math.max(0, baseGrade - baseGrade * (pol.penaltyPercent / 100));
    }

    // Store policy outputs
    submission.plagiarismPenaltyPercent = pol.penaltyPercent;
    submission.plagiarismAdjustedGrade = finalGrade;
    if (pol.needsReview) submission.needsTeacherReview = true;

    submission.grade = finalGrade;
    submission.feedback = feedbackToSave;
    submission.gradedBy = teacherId;
    submission.gradedAt = new Date();
    submission.status = "graded";
    submission.gradePublished = true;
    submission.gradePublishedAt = new Date();
    await submission.save();

    // Notify student (best-effort)
    setImmediate(async () => {
      try {
        const { notifySubmissionGraded } = require("../utils/notificationService");
        const assessment = await Assessment.findById(submission.assessmentId);
        await notifySubmissionGraded(submission, assessment, submission.studentId);
      } catch (error) {
        console.warn("⚠️ Failed to send publish notification:", error.message);
      }
    });

    return res.status(200).json({
      success: true,
      message: "AI report published to student",
      submission: {
        id: submission._id,
        grade: submission.grade,
        maxGrade: submission.maxGrade,
        status: submission.status,
      },
    });
  } catch (error) {
    console.error("❌ publishAiReport:", error);
    return res.status(500).json({ success: false, error: "Failed to publish AI report", details: error.message });
  }
};

/**
 * Delete a submission (Student - before deadline)
 * DELETE /api/submissions/:submissionId
 */
exports.deleteSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { studentId } = req.body;

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Verify student ownership
    if (submission.studentId !== studentId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Don't allow deletion if already graded
    if (submission.status === 'graded') {
      return res.status(400).json({ 
        error: "Cannot delete graded submissions" 
      });
    }

    await Submission.findByIdAndDelete(submissionId);

    console.log(`🗑️ Submission deleted: ${submissionId}`);

    res.json({
      success: true,
      message: "Submission deleted successfully"
    });

  } catch (error) {
    console.error("❌ Error deleting submission:", error);
    res.status(500).json({ error: "Failed to delete submission" });
  }
};

/**
 * Get pending grading count for a teacher (counts published assessments)
 * GET /api/submissions/teacher/:teacherId/pending-count
 */
exports.getTeacherPendingGradingCount = async (req, res) => {
  try {
    const { teacherId } = req.params;

    // Pending grading = submissions not graded yet for this teacher.
    // (We keep the endpoint name stable for the existing dashboard KPI.)
    const pendingCount = await Submission.countDocuments({
      teacherId,
      status: { $ne: "graded" },
    });

    res.json({
      success: true,
      pendingCount
    });

  } catch (error) {
    console.error("❌ Error fetching pending grading count:", error);
    res.status(500).json({ 
      error: "Failed to fetch pending grading count",
      details: error.message
    });
  }
};

/**
 * Live graded submissions count for a teacher.
 * GET /api/submissions/teacher/:teacherId/graded-count
 */
exports.getTeacherGradedCount = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) {
      return res.status(400).json({ success: false, error: "teacherId is required" });
    }

    const gradedCount = await Submission.countDocuments({ teacherId, status: "graded" });

    return res.json({
      success: true,
      gradedCount,
    });
  } catch (error) {
    console.error("❌ Error fetching graded count:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch graded count",
      details: error.message,
    });
  }
};

/**
 * Teacher performance KPI across all assigned courses:
 * Performance% = sum(grade) / sum(maxGrade) * 100 across all graded submissions.
 *
 * GET /api/submissions/teacher/:teacherId/performance
 */
exports.getTeacherPerformance = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) {
      return res.status(400).json({ success: false, error: "teacherId is required" });
    }

    const graded = await Submission.find({ teacherId, status: "graded" })
      .select("grade maxGrade assessmentType")
      .lean();

    let sumGrade = 0;
    let sumMax = 0;
    let gradedCount = 0;
    let quizCount = 0;
    let assignmentCount = 0;

    for (const s of Array.isArray(graded) ? graded : []) {
      const g = Number(s?.grade);
      const m = Number(s?.maxGrade);
      if (!Number.isFinite(g) || !Number.isFinite(m) || m <= 0) continue;
      sumGrade += g;
      sumMax += m;
      gradedCount += 1;
      const t = String(s?.assessmentType || "").toLowerCase();
      if (t === "quiz") quizCount += 1;
      else assignmentCount += 1;
    }

    const performancePercent = sumMax > 0 ? (sumGrade / sumMax) * 100 : 0;

    return res.json({
      success: true,
      performancePercent: Math.round(performancePercent * 10) / 10,
      gradedCount,
      quizCount,
      assignmentCount,
      totals: {
        sumGrade: Math.round(sumGrade * 100) / 100,
        sumMax: Math.round(sumMax * 100) / 100,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching teacher performance:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch performance",
      details: error.message,
    });
  }
};

/**
 * Get all submissions for a teacher (from MongoDB submission collection)
 * GET /api/submissions/teacher/:teacherId
 *
 * Returns flattened "upload-like" entries (one per file) for easy UI rendering.
 */
exports.getTeacherSubmissions = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) {
      return res.status(400).json({ success: false, error: "teacherId is required" });
    }

    const submissions = await Submission.find({ teacherId })
      .populate("assessmentId", "dueDate dueTime submissionDeadline latePenalty allowLateSubmission")
      .sort({ submittedAt: -1 })
      .lean();

    // Fill missing studentName/studentEmail for older submission docs (Firestore is source of truth)
    const missingStudentIds = Array.from(
      new Set(
        submissions
          .filter((s) => !s?.studentName || String(s.studentName).trim().length === 0)
          .map((s) => String(s.studentId || "").trim())
          .filter(Boolean)
      )
    );

    const studentCache = new Map();
    await Promise.all(
      missingStudentIds.map(async (sid) => {
        try {
          const studentDoc = await firestore.collection("users").doc(sid).get();
          if (studentDoc.exists) {
            const data = studentDoc.data() || {};
            studentCache.set(sid, {
              name: data.name || data.displayName || data.email || "",
              email: data.email || "",
            });
          } else {
            studentCache.set(sid, { name: "", email: "" });
          }
        } catch {
          studentCache.set(sid, { name: "", email: "" });
        }
      })
    );

    const msPerDay = 24 * 60 * 60 * 1000;

    const resolveDeadline = (assessment) => {
      if (!assessment) return null;
      if (assessment.submissionDeadline) {
        const d = new Date(assessment.submissionDeadline);
        return Number.isFinite(d.getTime()) ? d : null;
      }
      if (assessment.dueDate && assessment.dueTime) {
        const d = new Date(`${assessment.dueDate}T${assessment.dueTime}`);
        return Number.isFinite(d.getTime()) ? d : null;
      }
      if (assessment.dueDate) {
        const d = new Date(assessment.dueDate);
        return Number.isFinite(d.getTime()) ? d : null;
      }
      return null;
    };

    const computeLate = (sub, fileUploadedAt) => {
      const isLate = Boolean(sub?.isLate);
      if (!isLate) return { lateDays: 0, latePenaltyPerDay: 0, latePenaltyPercent: 0 };

      const assessment = sub.assessmentId;
      const deadline = resolveDeadline(assessment);
      const submittedAt = new Date(fileUploadedAt || sub.submittedAt);
      if (!deadline || !Number.isFinite(submittedAt.getTime())) {
        return { lateDays: 0, latePenaltyPerDay: 0, latePenaltyPercent: 0 };
      }

      // Delay days = ceil((submittedAt - deadline) / 1 day), minimum 1 day when late.
      const diff = submittedAt.getTime() - deadline.getTime();
      const lateDays = diff > 0 ? Math.max(1, Math.ceil(diff / msPerDay)) : 0;
      const latePenaltyPerDay = typeof assessment?.latePenalty === "number" ? assessment.latePenalty : 0;
      const latePenaltyPercent = Math.min(100, latePenaltyPerDay * lateDays);
      return { lateDays, latePenaltyPerDay, latePenaltyPercent };
    };

    const uploads = submissions.flatMap((sub) => {
      const files = Array.isArray(sub.submissionFiles) ? sub.submissionFiles : [];
      const cached = studentCache.get(String(sub.studentId || "").trim());
      const studentName =
        (sub.studentName && String(sub.studentName).trim()) ||
        (cached?.name && String(cached.name).trim()) ||
        "Unknown";
      const studentEmail =
        (sub.studentEmail && String(sub.studentEmail).trim()) ||
        (cached?.email && String(cached.email).trim()) ||
        "";

      return files.map((file, index) => ({
        ...computeLate(sub, file?.uploadedAt),
        _id: `${sub._id}-file-${index}`,
        submissionId: String(sub._id),
        studentId: sub.studentId,
        studentName,
        studentEmail,
        // assessmentId may be populated object; always return the raw Mongo ObjectId string
        assessmentId: String(sub?.assessmentId?._id || sub.assessmentId || ""),
        assessmentTitle: sub.assessmentTitle,
        assessmentType: sub.assessmentType,
        courseId: String(sub.courseId),
        courseCode: sub.courseCode,
        courseName: sub.courseName,
        teacherId: sub.teacherId,
        fileName: file?.filename,
        originalFileName: file?.originalName,
        fileUrl: file?.fileUrl,
        fileSize: file?.fileSize,
        mimeType: file?.mimeType,
        uploadedAt:
          (file?.uploadedAt && new Date(file.uploadedAt).toISOString()) ||
          (sub.submittedAt && new Date(sub.submittedAt).toISOString()),
        uploadedDate: file?.uploadedDate || sub.submissionDate,
        uploadedTime: file?.uploadedTime || sub.submissionTime,
        status: sub.status,
        grade: sub.grade ?? null,
        maxGrade: sub.maxGrade ?? null,
        marks: file?.marks ?? sub.grade ?? null,
        feedback: file?.fileFeedback ?? sub.feedback ?? "",
        isLate: Boolean(sub.isLate),
      }));
    });

    res.json({ success: true, uploads, count: uploads.length });
  } catch (error) {
    console.error("❌ Error fetching teacher submissions:", error);
    res.status(500).json({ success: false, error: "Failed to fetch teacher submissions" });
  }
};

/**
 * Grouped submissions for teacher:
 * GET /api/submissions/teacher/:teacherId/grouped
 *
 * Shape:
 * {
 *   success: true,
 *   courses: [
 *     {
 *       courseCode, courseName, courseId,
 *       types: {
 *         quiz: { assessments: [...], totals: {...} },
 *         assignment: { assessments: [...], totals: {...} }
 *       }
 *     }
 *   ]
 * }
 */
exports.getTeacherSubmissionsGrouped = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId) {
      return res.status(400).json({ success: false, error: "teacherId is required" });
    }

    const submissions = await Submission.find({ teacherId })
      .sort({ submittedAt: -1 })
      .lean();

    // Pull automark status from SubmissionRaw in one query (so UI can show badges).
    const subIds = submissions.map((s) => s?._id).filter(Boolean);
    const rawDocs = await SubmissionRaw.find({ submissionId: { $in: subIds } })
      .select("submissionId automarkStatus automarkError totalAwardedMarks automarkedAt")
      .lean()
      .catch(() => []);
    const rawBySubmissionId = new Map(
      (rawDocs || []).map((r) => [String(r?.submissionId || ""), r])
    );

    // Enrich missing student names from Firestore (bounded + cached).
    const missingStudentIds = Array.from(
      new Set(
        submissions
          .filter((s) => !s?.studentName || String(s.studentName).trim().length === 0)
          .map((s) => String(s.studentId || "").trim())
          .filter(Boolean)
      )
    );

    const studentCache = new Map();
    await Promise.all(
      missingStudentIds.map(async (sid) => {
        try {
          const studentDoc = await firestore.collection("users").doc(sid).get();
          if (studentDoc.exists) {
            const data = studentDoc.data() || {};
            studentCache.set(sid, {
              name: data.name || data.displayName || data.email || "",
              email: data.email || "",
            });
          } else {
            studentCache.set(sid, { name: "", email: "" });
          }
        } catch {
          studentCache.set(sid, { name: "", email: "" });
        }
      })
    );

    // Grouping maps
    const courseMap = new Map();

    const getStudentName = (sub) => {
      const sid = String(sub.studentId || "").trim();
      const cached = studentCache.get(sid);
      return (
        (sub.studentName && String(sub.studentName).trim()) ||
        (cached?.name && String(cached.name).trim()) ||
        "Unknown"
      );
    };

    const normalizeType = (t) => (t === "quiz" ? "quiz" : "assignment");

    for (const sub of submissions) {
      const courseCode = sub.courseCode || "—";
      const courseName = sub.courseName || "";
      const courseId = sub.courseId ? String(sub.courseId) : "";
      const assessmentId = sub.assessmentId ? String(sub.assessmentId?._id || sub.assessmentId) : "";
      const assessmentTitle = sub.assessmentTitle || "";
      const assessmentType = normalizeType(sub.assessmentType);

      const courseKey = `${courseCode}::${courseId || ""}`;
      if (!courseMap.has(courseKey)) {
        courseMap.set(courseKey, {
          courseCode,
          courseName,
          courseId,
          types: {
            quiz: { assessments: [], totals: { assessments: 0, submissions: 0, graded: 0, pending: 0, late: 0 } },
            assignment: { assessments: [], totals: { assessments: 0, submissions: 0, graded: 0, pending: 0, late: 0 } },
          },
          _assessmentIndex: new Map(), // internal: `${type}::${assessmentId}`
        });
      }

      const courseNode = courseMap.get(courseKey);
      const typeNode = courseNode.types[assessmentType];
      const assessKey = `${assessmentType}::${assessmentId}`;

      if (!courseNode._assessmentIndex.has(assessKey)) {
        const newAssessment = {
          assessmentId,
          assessmentTitle,
          assessmentType,
          submissions: [],
          stats: { total: 0, graded: 0, pending: 0, late: 0 },
        };
        typeNode.assessments.push(newAssessment);
        courseNode._assessmentIndex.set(assessKey, newAssessment);
        typeNode.totals.assessments += 1;
      }

      const assessmentNode = courseNode._assessmentIndex.get(assessKey);

      const status = sub.status || "submitted";
      const isGraded = status === "graded";
      const isPending = !isGraded;
      const isLate = Boolean(sub.isLate);

      assessmentNode.submissions.push({
        submissionId: String(sub._id),
        studentId: sub.studentId,
        studentName: getStudentName(sub),
        status,
        isLate,
        submittedAt: sub.submittedAt ? new Date(sub.submittedAt).toISOString() : null,
        uploadedFilesCount: sub.uploadedFilesCount ?? (Array.isArray(sub.submissionFiles) ? sub.submissionFiles.length : 0),
        grade: sub.grade ?? null,
        maxGrade: sub.maxGrade ?? null,
        automarkStatus: rawBySubmissionId.get(String(sub._id))?.automarkStatus || "missing",
        automarkError: rawBySubmissionId.get(String(sub._id))?.automarkError || "",
      });

      assessmentNode.stats.total += 1;
      assessmentNode.stats.graded += isGraded ? 1 : 0;
      assessmentNode.stats.pending += isPending ? 1 : 0;
      assessmentNode.stats.late += isLate ? 1 : 0;

      typeNode.totals.submissions += 1;
      typeNode.totals.graded += isGraded ? 1 : 0;
      typeNode.totals.pending += isPending ? 1 : 0;
      typeNode.totals.late += isLate ? 1 : 0;
    }

    // Sort each assessment submissions by studentId/name (alphabetical).
    const courses = Array.from(courseMap.values()).map((c) => {
      for (const t of ["quiz", "assignment"]) {
        const typeNode = c.types[t];
        for (const a of typeNode.assessments) {
          a.submissions.sort((x, y) => {
            const ax = (String(x.studentId || "") || String(x.studentName || "")).toLowerCase();
            const by = (String(y.studentId || "") || String(y.studentName || "")).toLowerCase();
            return ax.localeCompare(by);
          });
        }
        // Sort assessments by title.
        typeNode.assessments.sort((a, b) => String(a.assessmentTitle || "").localeCompare(String(b.assessmentTitle || "")));
      }
      delete c._assessmentIndex;
      return c;
    });

    // Sort courses by courseCode.
    courses.sort((a, b) => String(a.courseCode || "").localeCompare(String(b.courseCode || "")));

    return res.json({ success: true, teacherId, courses, count: submissions.length });
  } catch (error) {
    console.error("❌ Error fetching grouped teacher submissions:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch grouped teacher submissions" });
  }
};

/**
 * GET /api/submissions/ai-grading/:submissionId?teacherId=...
 * One submission for the AI grading page header (teacher must own it).
 */
exports.getSubmissionForAiGrading = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.query.teacherId || "").trim();
    if (!submissionId || !teacherId) {
      return res.status(400).json({
        success: false,
        error: "submissionId and teacherId query parameter are required",
      });
    }

    const sub = await Submission.findById(submissionId).lean();
    if (!sub) {
      return res.status(404).json({ success: false, error: "Submission not found" });
    }
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    let studentName = String(sub.studentName || "").trim();
    let studentEmail = String(sub.studentEmail || "").trim();
    if (!studentName && sub.studentId) {
      try {
        const studentDoc = await firestore.collection("users").doc(String(sub.studentId)).get();
        if (studentDoc.exists) {
          const data = studentDoc.data() || {};
          studentName = String(data.name || data.displayName || data.email || "").trim();
          if (!studentEmail) studentEmail = String(data.email || "").trim();
        }
      } catch (_) {
        /* ignore */
      }
    }
    if (!studentName) {
      studentName = studentEmail || String(sub.studentId || "");
    }

    const assessmentIdRaw = sub.assessmentId;
    const assessmentId =
      assessmentIdRaw && typeof assessmentIdRaw === "object" && assessmentIdRaw._id
        ? String(assessmentIdRaw._id)
        : String(assessmentIdRaw || "");

    const submittedAtIso = sub.submittedAt ? new Date(sub.submittedAt).toISOString() : null;
    const submittedDisplay =
      sub.submissionDate && sub.submissionTime
        ? `${sub.submissionDate} ${sub.submissionTime}`
        : submittedAtIso
          ? new Date(submittedAtIso).toLocaleString()
          : "";

    let raw = await SubmissionRaw.findOne({ submissionId: sub._id })
      .select("automarkStatus automarkError automarkedAt totalAwardedMarks perQuestionScores automarkReport")
      .lean()
      .catch(() => null);

    // Auto-backfill SubmissionRaw for legacy rows:
    // If Submission is graded and has aiAnalysis, but SubmissionRaw is missing or still "missing",
    // rebuild SubmissionRaw automark fields from aiAnalysis so AI Grading page stays consistent.
    try {
      const status = String(raw?.automarkStatus || "missing");
      const shouldBackfill = (!raw || status === "missing") && Boolean(String(sub.aiAnalysis || "").trim());
      if (shouldBackfill) {
        const report = parseAiAnalysisToReport(sub.aiAnalysis);
        if (report && typeof report === "object") {
          const perQuestionScores = buildPerQuestionScoresFromReport(report);
          await SubmissionRaw.findOneAndUpdate(
            { submissionId: sub._id },
            {
              $setOnInsert: { submissionId: sub._id },
              $set: {
                assessmentId: sub.assessmentId || null,
                courseId: sub.courseId || null,
                teacherId: String(sub.teacherId || ""),
                studentId: String(sub.studentId || ""),
                studentEmail: studentEmail || "",
                automarkStatus: "completed",
                automarkError: "",
                automarkedAt: new Date(),
                automarkReport: report,
                perQuestionScores,
                totalAwardedMarks: Number(report?.totals?.awarded ?? 0) || 0,
              },
            },
            { upsert: true }
          ).catch(() => {});

          raw = await SubmissionRaw.findOne({ submissionId: sub._id })
            .select("automarkStatus automarkError automarkedAt totalAwardedMarks perQuestionScores automarkReport")
            .lean()
            .catch(() => raw);
        }
      }
    } catch {
      // best-effort only
    }

    return res.status(200).json({
      success: true,
      submission: {
        _id: String(sub._id),
        studentId: sub.studentId,
        studentName,
        studentEmail,
        assessmentId,
        assessmentTitle: sub.assessmentTitle || "",
        assessmentType: sub.assessmentType === "quiz" ? "quiz" : "assignment",
        courseCode: sub.courseCode || "",
        courseName: sub.courseName || "",
        submittedAt: submittedAtIso,
        submittedDisplay,
        submissionDate: sub.submissionDate || "",
        submissionTime: sub.submissionTime || "",
        status: sub.status || "submitted",
        isLate: Boolean(sub.isLate),
        grade: sub.grade ?? null,
        maxGrade: typeof sub.maxGrade === "number" ? sub.maxGrade : null,
        feedback: sub.feedback || "",
        needsTeacherReview: Boolean(sub.needsTeacherReview),
        manualOverride: Boolean(sub.manualOverride),
        aiGradingSuggestion: sub.aiGradingSuggestion ?? null,
        plagiarismBestMatchPercent:
          typeof sub.plagiarismBestMatchPercent === "number" ? sub.plagiarismBestMatchPercent : null,
        plagiarismPenaltyPercent:
          typeof sub.plagiarismPenaltyPercent === "number" ? sub.plagiarismPenaltyPercent : null,
        plagiarismAdjustedGrade:
          typeof sub.plagiarismAdjustedGrade === "number" ? sub.plagiarismAdjustedGrade : null,
        plagiarismReport: sub.plagiarismReport && typeof sub.plagiarismReport === "object" ? sub.plagiarismReport : null,
        aiConfidence: sub.aiConfidence ?? null,
        aiAnalysis: sub.aiAnalysis ?? null,
      },
      submissionRaw: raw
        ? {
            automarkStatus: raw.automarkStatus || "missing",
            automarkError: raw.automarkError || "",
            automarkedAt: raw.automarkedAt ? new Date(raw.automarkedAt).toISOString() : null,
            totalAwardedMarks: typeof raw.totalAwardedMarks === "number" ? raw.totalAwardedMarks : null,
            perQuestionScores: Array.isArray(raw.perQuestionScores) ? raw.perQuestionScores : [],
            automarkReport: raw.automarkReport || null,
          }
        : {
            automarkStatus: "missing",
            automarkError: "",
            automarkedAt: null,
            totalAwardedMarks: null,
            perQuestionScores: [],
            automarkReport: null,
          },
    });
  } catch (error) {
    console.error("❌ getSubmissionForAiGrading:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to load submission for AI grading",
      details: error.message,
    });
  }
};

/**
 * GET /api/submissions/:submissionId/content?teacherId=...
 * Returns submission files grouped for the AI grading tabs:
 * - text: submissionText + extracted rawText (best-effort from SubmissionRaw)
 * - code: .py / code-like files
 * - graphical: images (jpg/png)
 *
 * NOTE: This endpoint does not run extraction; it just returns stored metadata + URLs.
 */
exports.getSubmissionContent = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.query.teacherId || "").trim();
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId query parameter are required" });
    }

    const sub = await Submission.findById(submissionId).lean();
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const raw = await SubmissionRaw.findOne({ submissionId: sub._id }).lean().catch(() => null);

    const files = Array.isArray(sub.submissionFiles) ? sub.submissionFiles : [];
    const baseUrl = "http://localhost:5000";

    const normalizeUrl = (u) => {
      if (!u) return null;
      const s = String(u);
      if (s.startsWith("http")) return s;
      return `${baseUrl}${s.startsWith("/") ? "" : "/"}${s}`;
    };

    const mappedFiles = files.map((f, idx) => {
      const originalName = f?.originalName || f?.filename || `file-${idx + 1}`;
      const mimeType = f?.mimeType || "";
      const fileUrl = f?.fileUrl || "";

      const nameLower = String(originalName).toLowerCase();
      const filenameLower = String(f?.filename || "").toLowerCase();
      const extFromOriginal = path.extname(nameLower);
      const extFromStored = path.extname(filenameLower);
      // Some records have originalName without extension; fall back to stored filename.
      const ext = extFromOriginal || extFromStored;
      const isImage = mimeType.startsWith("image/") || [".jpg", ".jpeg", ".png"].includes(ext);
      const isCode =
        [".py", ".ipynb", ".java", ".js", ".ts", ".tsx", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift"].includes(
          ext
        ) ||
        ["text/x-python", "text/x-java-source", "text/x-java", "application/java", "text/x-c", "text/x-c++"].includes(mimeType);

      const category = isCode ? "code" : isImage ? "graphical" : "text";

      return {
        id: `${sub._id}::${idx}`,
        originalName,
        filename: f?.filename || "",
        mimeType,
        fileSize: f?.fileSize ?? null,
        fileUrl: normalizeUrl(fileUrl),
        uploadedAt: f?.uploadedAt ? new Date(f.uploadedAt).toISOString() : null,
        category,
        isDerived: Boolean(f?.isDerived),
        derivedType: String(f?.derivedType || ""),
        derivedFrom: Array.isArray(f?.derivedFrom) ? f.derivedFrom : [],
        questionKey:
          String(f?.questionKey || "").trim() ||
          _extractQKeyFromName(String(originalName || "")) ||
          _extractQKeyFromName(String(f?.filename || "")) ||
          null,
      };
    });

    const grouped = {
      text: mappedFiles.filter((f) => f.category === "text"),
      code: mappedFiles.filter((f) => f.category === "code"),
      graphical: mappedFiles.filter((f) => f.category === "graphical"),
    };

    const contentTypes =
      raw && Array.isArray(raw.contentTypes) && raw.contentTypes.length > 0
        ? raw.contentTypes
        : [
            ...(grouped.text.length > 0 || String(sub.submissionText || "").trim() ? ["text"] : []),
            ...(grouped.code.length > 0 ? ["code"] : []),
            ...(grouped.graphical.length > 0 ? ["graphical"] : []),
          ];

    return res.status(200).json({
      success: true,
      submissionId: String(sub._id),
      submissionText: String(sub.submissionText || ""),
      extraction: raw
        ? {
            status: raw.extractionStatus || "pending",
            rawText:
              String(raw.rawText || "").trim() ||
              String(raw.ocrText || "").trim() ||
              String(sub.submissionText || ""),
            extractor: raw.extractor || "",
            pageCount: raw.pageCount ?? 0,
            visualCount: raw.visualCount ?? 0,
            contentTypes,
            hasVisual: Number(raw.visualCount ?? 0) > 0,
            ocrEnabled: Boolean(raw.ocrEnabled),
            ocrStatus: raw.ocrStatus || "",
            extractionError: raw.extractionError || "",
          }
        : {
            status: "pending",
            rawText: "",
            extractor: "",
            pageCount: 0,
            visualCount: 0,
            contentTypes,
            hasVisual: grouped.graphical.length > 0,
            ocrEnabled: false,
            ocrStatus: "",
            extractionError: "",
          },
      files: mappedFiles,
      grouped,
    });
  } catch (error) {
    console.error("❌ getSubmissionContent:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to load submission content",
      details: error.message,
    });
  }
};

/**
 * Plagiarism check (teacher-owned).
 * POST /api/submissions/:submissionId/plagiarism-check
 * Body: { teacherId }
 *
 * Approach:
 * - Use student's extracted text (SubmissionRaw.ocrText or Submission.submissionText) as the query.
 * - Query submissions FAISS index for top matches within same assessment.
 * - Exclude the same student and same submission.
 * - Return top 5 matches with similarity% and studentId.
 */
exports.checkPlagiarism = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    const force = Boolean(req.body?.force);
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId are required" });
    }

    const sub = await Submission.findById(submissionId).lean();
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    // Check if there are other submissions in this assessment (for intelligent plagiarism detection)
    const otherSubmissionCount = await Submission.countDocuments({
      assessmentId: sub.assessmentId,
      _id: { $ne: submissionId },
      assessmentType: "assignment",
    }).catch(() => 1);

    const isOnlySubmission = otherSubmissionCount === 0;
    const detectionMode = isOnlySubmission ? "external_only" : "both_internal_external";

    console.log(
      `[PLAGIARISM] ${sub.studentName || sub.studentId} (${submissionId}): Mode=${detectionMode}, OtherSubmissions=${otherSubmissionCount}`
    );

    // If we already computed a plagiarism report, return it as-is to keep results stable.
    // Teachers can still "re-run" from UI, but unless force=true, the persisted report is returned.
    if (!force && sub.plagiarismReport && typeof sub.plagiarismReport === "object") {
      const r = sub.plagiarismReport || {};
      // Ensure backward compatibility: compute missing fields from existing data
      // Use || to override 0 values from older stored reports
      const internalScore = (Number(r.internalScore) > 0 ? r.internalScore : null) || Number(r.bestMatchPercent) || 0;
      const aiScore = Number(r.aiScore) || 0;
      const overallScore = (Number(r.overallScore) > 0 ? r.overallScore : null) || Math.round(internalScore * 0.6 + aiScore * 0.4) || 0;
      const riskLevel = r.riskLevel || (overallScore >= 60 ? "high" : overallScore >= 30 ? "medium" : "low");

      return res.status(200).json({
        success: true,
        cached: true,
        detectionMode,
        ...(r || {}),
        // These MUST come after the spread to override any 0 values in stored report
        internalScore,
        aiScore,
        overallScore,
        riskLevel,
        matches: r.matches || [],
        bestMatchPercent: r.bestMatchPercent || internalScore,
      });
    }

    // Back-compat for older rows: if we have a recorded plagiarism score already,
    // do NOT recompute on "re-run". Instead, freeze that score by backfilling a report snapshot.
    const recordedBest =
      typeof sub.plagiarismBestMatchPercent === "number" ? sub.plagiarismBestMatchPercent : null;
    const recordedAt = sub.plagiarismCheckedAt ? new Date(sub.plagiarismCheckedAt) : null;
    if (!force && recordedBest != null && Number.isFinite(Number(recordedBest)) && recordedAt) {
      const best = Math.max(0, Math.min(100, Number(recordedBest)));

      const lerp = (a, b, t) => a + (b - a) * t;
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      const computePenaltyPercent = (pct) => {
        const p = Number(pct);
        if (!Number.isFinite(p) || p < 30) return 0;
        if (p < 60) return Math.round(lerp(10, 20, clamp01((p - 30) / 30)));
        if (p < 80) return Math.round(lerp(30, 50, clamp01((p - 60) / 20)));
        return 100;
      };

      const penaltyPercent =
        typeof sub.plagiarismPenaltyPercent === "number"
          ? Math.max(0, Math.min(100, Number(sub.plagiarismPenaltyPercent)))
          : computePenaltyPercent(best);

      const assessmentId = String(sub.assessmentId?._id || sub.assessmentId || "");
      // For legacy records, reconstruct the scores using the stored best match
      const aiScore = Math.max(0, Number(sub.plagiarismAiScore) || 0);
      const internalScore = Math.max(0, Number(best) || 0);
      const overallScore = Math.round(internalScore * 0.6 + aiScore * 0.4);
      const riskLevel = overallScore >= 60 ? "high" : overallScore >= 30 ? "medium" : "low";

      const legacyReport = {
        submissionId: String(sub._id),
        assessmentId,
        internalScore: best,
        bestMatchPercent: best,
        aiScore,
        overallScore,
        riskLevel,
        penalty: {
          penaltyPercent,
          band:
            best < 30 ? "0-30" :
            best < 60 ? "30-60" :
            best < 80 ? "60-80" : "80-100",
          action:
            best < 30 ? "No issue" :
            best < 60 ? "Deduct 10–20% marks" :
            best < 80 ? "Deduct 30–50% marks OR cap marks" :
            "Give 0–1 marks OR manual review",
        },
        gradeAfterPlagiarism:
          typeof sub.plagiarismAdjustedGrade === "number"
            ? sub.plagiarismAdjustedGrade
            : null,
        matches: [],
        isGptGenerated: Boolean(sub.plagiarismIsGptGenerated),
        meta: { phase: "legacy_cached", normalized: "unknown" },
        computedAt: recordedAt.toISOString(),
      };

      await Submission.updateOne(
        { _id: sub._id },
        {
          $set: {
            plagiarismPenaltyPercent: penaltyPercent,
            plagiarismReport: legacyReport,
          },
        }
      ).catch(() => {});

      return res.status(200).json({
        success: true,
        cached: true,
        ...(legacyReport || {}),
        // These MUST come after the spread to ensure they override
        internalScore: best,
        aiScore,
        overallScore,
        riskLevel,
      });
    }

    const rawDoc = await SubmissionRaw.findOne({ submissionId: sub._id })
      .select("rawText ocrText")
      .lean()
      .catch(() => null);

    const queryText =
      String(rawDoc?.rawText || "").trim() ||
      String(rawDoc?.ocrText || "").trim() ||
      String(sub.submissionText || "").trim();

    // Normalize to "answers only" so plagiarism matches student answers, not the question prompts.
    // Handles common formats like:
    // - "Q1: What is ...? <answer>"
    // - "Q2) What is ...? <answer>"
    // - "Question 1: ...? <answer>"
    const extractAnswersOnly = (text) => {
      const s = String(text || "").replace(/\r\n/g, "\n").trim();
      if (!s) return "";
      const lines = s.split("\n").map((l) => String(l || "").trim()).filter(Boolean);
      const out = [];
      for (const line of lines) {
        const lower = line.toLowerCase();
        const looksLikeQuestionPrefix =
          /^q\s*\d+\s*[:.)-]/i.test(line) ||
          /^question\s*\d+\s*[:.)-]/i.test(line) ||
          /^q\d+\s*[:.)-]/i.test(line);
        if (!looksLikeQuestionPrefix) {
          out.push(line);
          continue;
        }
        // Prefer the part after the first '?' if present; otherwise after ':' / ')' / '.' / '-'
        const qMarkIdx = line.indexOf("?");
        if (qMarkIdx !== -1 && qMarkIdx + 1 < line.length) {
          const after = line.slice(qMarkIdx + 1).trim();
          if (after) out.push(after);
          continue;
        }
        const m = line.match(/^(.+?)([:.)-])\s*(.*)$/);
        const after = String(m?.[3] || "").trim();
        if (after) out.push(after);
      }
      return out.join("\n").trim();
    };

    const queryTextForPlagiarism = extractAnswersOnly(queryText) || String(queryText || "").trim();
    if (!queryText) {
      // Not an error: return 0% match with reason (e.g., first run / extraction not ready).
    const emptyReport = {
        submissionId: String(sub._id),
        assessmentId: String(sub.assessmentId?._id || sub.assessmentId || ""),
        internalScore: 0,
        bestMatchPercent: 0,
        aiScore: 0,
        overallScore: 0,
        riskLevel: "low",
        penalty: { penaltyPercent: 0, band: "0-30", action: "No extracted text" },
        gradeAfterPlagiarism: null,
        matches: [],
        isGptGenerated: false,
        meta: { phase: "no_extracted_text", message: "No extracted text found. Run extraction first." },
        computedAt: new Date().toISOString(),
      };

    await Submission.updateOne(
        { _id: sub._id },
      {
        $set: {
          plagiarismBestMatchPercent: 0,
          plagiarismCheckedAt: new Date(),
          plagiarismPenaltyPercent: 0,
          plagiarismAdjustedGrade: null,
          plagiarismAiScore: 0,
          plagiarismIsGptGenerated: false,
          plagiarismReport: emptyReport,
        },
      }
      ).catch(() => {});
      return res.status(200).json({
        success: true,
        ...(emptyReport || {}),
        // These MUST come after the spread to ensure they are included
        internalScore: 0,
        aiScore: 0,
        overallScore: 0,
        riskLevel: "low",
      });
    }

    const { querySubmissionChunks } = require("../utils/submissionRetrievalService");
    const assessmentId = String(sub.assessmentId?._id || sub.assessmentId || "");
    const currentStudentId = String(sub.studentId || "");
    const currentSubmissionId = String(sub._id || "");

    // If this is the only submission, skip internal plagiarism check (no other students to compare against)
    let candidates = [];
    if (!isOnlySubmission) {
      console.log(`[PLAGIARISM] ${submissionId}: Checking for internal plagiarism (student matches)...`);
      try {
        // Retrieve a larger pool then filter locally to ensure we can pick top 5 after exclusions.
        candidates = await querySubmissionChunks(queryTextForPlagiarism, {
          topK: 50,
          assessmentId,
        });
        console.log(`[PLAGIARISM] ${submissionId}: Found ${(candidates || []).length} candidate chunks`);
      } catch (err) {
        console.error(`[PLAGIARISM] ${submissionId}: Internal plagiarism check error: ${err.message}`);
        candidates = [];
      }
    } else {
      console.log(`[PLAGIARISM] ${submissionId}: Only submission in assessment - skipping internal plagiarism check`);
    }

    const filtered = (Array.isArray(candidates) ? candidates : [])
      .filter((c) => c && c.metadata)
      .filter((c) => String(c.metadata?.student_id || "") !== currentStudentId)
      .filter((c) => String(c.metadata?.submission_id || "") !== currentSubmissionId);

    // Check if we should proceed with empty internal matches
    const hasNoInternalMatches = !filtered.length;
    const shouldContinueWithExternalOnly = isOnlySubmission || hasNoInternalMatches;

    if (shouldContinueWithExternalOnly && !isOnlySubmission) {
      // No other submissions to compare against (first assignment / single student)
      console.log(`[PLAGIARISM] ${submissionId}: No student matches found`);
    } else if (isOnlySubmission) {
      console.log(`[PLAGIARISM] ${submissionId}: Only submission - external plagiarism detection only`);
    }

    // Aggregate by student_id: take best similarity per student.
    const byStudent = new Map();
    for (const c of filtered) {
      const sid = String(c.metadata?.student_id || "").trim();
      if (!sid) continue;
      const sim = Number(c.similarity ?? c.score ?? 0) || 0;
      const prev = byStudent.get(sid);
      if (!prev || sim > prev.similarity) {
        const snippet = extractAnswersOnly(String(c.text || "")) || String(c.text || "");
        byStudent.set(sid, {
          studentId: sid,
          submissionId: String(c.metadata?.submission_id || ""),
          similarity: sim,
          text: snippet.slice(0, 280),
        });
      }
    }

    const toPercent = (sim) => {
      const n = Number(sim) || 0;
      // Normalize:
      // - If score is already 0..1 -> percent
      // - If score is 0..100 -> keep
      if (n <= 1) return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 10; // 0.1% precision
      if (n <= 100) return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
      return 100;
    };

    const matches = Array.from(byStudent.values())
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, 5)
      .map((m) => ({
        studentId: m.studentId,
        submissionId: m.submissionId,
        matchPercent: toPercent(m.similarity),
        snippet: m.text,
      }));

    const best = matches.length ? Math.max(...matches.map((m) => Number(m.matchPercent || 0) || 0)) : 0;

    if (matches.length === 0 && isOnlySubmission) {
      console.log(`[PLAGIARISM] ${submissionId}: External-only mode (no other submissions to compare)`);
    } else if (matches.length > 0) {
      console.log(`[PLAGIARISM] ${submissionId}: Found ${matches.length} student match(es), best=${best.toFixed(1)}%`);
    }

    // Detect AI-generated content (online resources / external plagiarism)
    let aiScore = 0;
    let isGptGenerated = false;
    let aiAdditionalFeedback = "";
    let aiDetectionError = null;

    try {
      console.log(`[PLAGIARISM] ${submissionId}: Checking for AI-generated content...`);
      const { detectAIContent } = require("../utils/zerogpt-fallback");
      const aiResult = await detectAIContent(queryTextForPlagiarism);
      aiScore = aiResult.aiScore || 0;
      isGptGenerated = aiResult.isGptGenerated || false;
      aiAdditionalFeedback = aiResult.feedback || "";

      if (aiResult.unavailable) {
        aiDetectionError = aiResult.error;
        console.warn(`[PLAGIARISM] ${submissionId}: ZeroGPT API unavailable: ${aiDetectionError}`);
        console.warn(`[PLAGIARISM] ${submissionId}: AI detection disabled - returning 0%`);
      } else if (aiScore > 0) {
        const riskLevel = isGptGenerated ? "HIGH" : "MODERATE";
        console.log(`[PLAGIARISM] ${submissionId}: AI Detection: ${aiScore}% (${riskLevel})${isGptGenerated ? " - GPT GENERATED" : ""}`);
      } else {
        console.log(`[PLAGIARISM] ${submissionId}: AI Detection: ${aiScore}% (No AI detected)`);
      }
    } catch (err) {
      // ZeroGPT optional; continue with aiScore = 0
      aiDetectionError = err.message;
      console.error(`[PLAGIARISM] ${submissionId}: AI detection error: ${err.message}`);
      console.error(`[PLAGIARISM] ${submissionId}: Continuing with internal plagiarism only`);
    }

    // Add student names (best-effort) for UI clarity.
    let matchesWithNames = matches;
    try {
      const nameById = new Map();
      for (const m of matches) {
        const sid = String(m?.studentId || "").trim();
        if (!sid || nameById.has(sid)) continue;
        try {
          const doc = await firestore.collection("users").doc(sid).get();
          const data = doc.exists ? (doc.data() || {}) : {};
          const nm = String(data.name || data.displayName || data.fullName || data.email || "").trim();
          nameById.set(sid, nm || sid);
        } catch {
          nameById.set(sid, sid);
        }
      }
      matchesWithNames = matches.map((m) => ({ ...m, studentName: nameById.get(String(m.studentId)) || String(m.studentId) }));
    } catch {
      matchesWithNames = matches;
    }

    // Compute penalty band now and persist (used on publish).
    // Only penalize if there are actual matching student chunks (not just AI detection).
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const computePenaltyPercent = (pct) => {
      const p = Number(pct);
      if (!Number.isFinite(p) || p < 30) return 0;
      if (p < 60) return Math.round(lerp(10, 20, clamp01((p - 30) / 30)));
      if (p < 80) return Math.round(lerp(30, 50, clamp01((p - 60) / 20)));
      return 100;
    };
    // Only apply student-match penalty if matches exist; AI detection is separate.
    const penaltyPercent = matches.length > 0 ? computePenaltyPercent(best) : 0;
    // Compute adjusted grade immediately (teacher-only; NOT published to student until publish-ai).
    const maxGrade = Number(sub.maxGrade ?? 0) || 0;
    const baseGrade = Math.max(0, Math.min(maxGrade || 999999, Number(sub.aiGradingSuggestion ?? sub.grade ?? 0) || 0));
    let adjusted = baseGrade;
    if (matches.length > 0) {
      if (best >= 80) adjusted = Math.min(1, maxGrade || 1);
      else if (penaltyPercent > 0) adjusted = Math.max(0, baseGrade - baseGrade * (penaltyPercent / 100));
    }

    // Band based on student match; separate AI detection result.
    const band = matches.length === 0
      ? "0-30"
      : best < 30 ? "0-30"
      : best < 60 ? "30-60"
      : best < 80 ? "60-80" : "80-100";

    // Log final results
    // Calculate overall plagiarism score: (internal × 0.6) + (external × 0.4)
    const INTERNAL_WEIGHT = 0.6;
    const EXTERNAL_WEIGHT = 0.4;
    const overallScore = Math.round(best * INTERNAL_WEIGHT + aiScore * EXTERNAL_WEIGHT);
    const riskLevel = overallScore >= 60 ? "high" : overallScore >= 30 ? "medium" : "low";

    console.log(
      `[PLAGIARISM] ${submissionId}: COMPLETE - Internal=${best.toFixed(1)}%, External=${aiScore}%, Overall=${overallScore}%, Risk=${riskLevel}, Penalty=${penaltyPercent}%${aiDetectionError ? ` (AI Error: ${aiDetectionError})` : ""}`
    );

    await Submission.updateOne(
      { _id: sub._id },
      {
        $set: {
          plagiarismBestMatchPercent: best,
          plagiarismCheckedAt: new Date(),
          plagiarismPenaltyPercent: penaltyPercent,
          plagiarismAdjustedGrade: adjusted,
          plagiarismAiScore: aiScore,
          plagiarismIsGptGenerated: isGptGenerated,
          // Update teacher-visible overall score instantly
          aiGradingSuggestion: adjusted,
          plagiarismReport: {
            submissionId: String(sub._id),
            assessmentId,
            internalScore: best,
            bestMatchPercent: best,
            aiScore,
            overallScore,
            riskLevel,
            penalty: {
              penaltyPercent,
              band,
              action:
                penaltyPercent === 0 ? "No issue" :
                penaltyPercent <= 20 ? "Deduct 10–20% marks" :
                penaltyPercent <= 50 ? "Deduct 30–50% marks OR cap marks" :
                "Give 0–1 marks OR manual review",
            },
            gradeAfterPlagiarism: adjusted,
            matches: matchesWithNames,
            isGptGenerated,
            aiAdditionalFeedback,
            detectionMode,
            aiDetectionError: aiDetectionError || null,
            meta: { phase: "computed", topK: 50, normalized: "answers_only", hasAiDetection: true, mode: detectionMode },
            computedAt: new Date().toISOString(),
            queryHash: require("crypto").createHash("sha256").update(String(queryTextForPlagiarism || ""), "utf8").digest("hex"),
          },
        },
      }
    ).catch(() => {});
    return res.status(200).json({
      success: true,
      submissionId: String(sub._id),
      assessmentId,
      internalScore: best,
      bestMatchPercent: best,
      aiScore,
      overallScore,
      riskLevel,
      penalty: {
        penaltyPercent,
        band,
        action:
          penaltyPercent === 0 ? "No issue" :
          penaltyPercent <= 20 ? "Deduct 10–20% marks" :
          penaltyPercent <= 50 ? "Deduct 30–50% marks OR cap marks" :
          "Give 0–1 marks OR manual review",
      },
      gradeAfterPlagiarism: adjusted,
      matches: matchesWithNames,
      isGptGenerated,
      aiAdditionalFeedback,
      detectionMode,
      aiDetectionError: aiDetectionError || null,
    });
  } catch (error) {
    const errorMsg = error?.message || String(error);
    console.error(`[PLAGIARISM] ${submissionId || "unknown"}: FATAL ERROR - ${errorMsg}`);
    console.error(`[PLAGIARISM] Stack trace:`, error?.stack);
    return res.status(500).json({
      success: false,
      error: "Failed plagiarism check",
      details: errorMsg,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Student report payload (student-owned, graded only).
 * GET /api/submissions/:submissionId/student-report?studentId=...
 *
 * Returns:
 * - submission header (title, studentName, course, grade/max, feedback)
 * - submissionRaw (perQuestionScores/automarkReport for mistakes + per-question feedback)
 * - content extraction rawText + files list (same shape as teacher content, but authorized for student)
 */
exports.getStudentSubmissionReport = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const studentId = String(req.query.studentId || "").trim();
    if (!submissionId || !studentId) {
      return res.status(400).json({ success: false, error: "submissionId and studentId query parameter are required" });
    }

    const sub = await Submission.findById(submissionId).lean();
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.studentId || "") !== studentId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    if (String(sub.status || "") !== "graded") {
      return res.status(400).json({ success: false, error: "Report is available after grading." });
    }
    if (!Boolean(sub.reportPublished)) {
      return res.status(403).json({ success: false, error: "Report not sent by teacher yet." });
    }

    const raw = await SubmissionRaw.findOne({ submissionId: sub._id })
      .select("perQuestionScores automarkReport publishedReportSnapshot publishedReportSnapshotAt rawText ocrText extractor extractionStatus contentTypes")
      .lean()
      .catch(() => null);

    // If teacher sent a snapshot, return it — but if extracted text is empty,
    // auto-heal by pulling the latest extraction from SubmissionRaw.
    if (raw?.publishedReportSnapshot && typeof raw.publishedReportSnapshot === "object") {
      try {
        const snap = raw.publishedReportSnapshot || {};
        const snapText = String(snap?.content?.extraction?.rawText || "").trim();
        if (snapText) {
          return res.status(200).json({ success: true, ...(snap || {}) });
        }

        const latestRaw = await SubmissionRaw.findOne({ submissionId: sub._id })
          .select("rawText ocrText extractor extractionStatus contentTypes")
          .lean()
          .catch(() => null);
        const healedText =
          String(latestRaw?.rawText || "").trim() ||
          String(latestRaw?.ocrText || "").trim() ||
          String(sub.submissionText || "").trim();

        if (healedText) {
          const healedSnapshot = {
            ...(snap || {}),
            content: {
              ...(snap?.content || {}),
              extraction: {
                ...(snap?.content?.extraction || {}),
                status: String(latestRaw?.extractionStatus || snap?.content?.extraction?.status || "completed"),
                extractor: String(latestRaw?.extractor || snap?.content?.extraction?.extractor || ""),
                contentTypes: Array.isArray(latestRaw?.contentTypes) ? latestRaw.contentTypes : (snap?.content?.extraction?.contentTypes || []),
                rawText: healedText,
              },
            },
          };

          await SubmissionRaw.updateOne(
            { submissionId: sub._id },
            { $set: { publishedReportSnapshot: healedSnapshot, publishedReportSnapshotAt: new Date() } }
          ).catch(() => {});

          return res.status(200).json({ success: true, ...(healedSnapshot || {}) });
        }
      } catch {
        // fall through to dynamic payload
      }
      return res.status(200).json({ success: true, ...(raw.publishedReportSnapshot || {}) });
    }

    // Reuse the same mapping as getSubmissionContent (but student-authorized).
    const files = Array.isArray(sub.submissionFiles) ? sub.submissionFiles : [];
    const baseUrl = "http://localhost:5000";
    const normalizeUrl = (u) => {
      if (!u) return null;
      const s = String(u);
      if (s.startsWith("http")) return s;
      return `${baseUrl}${s.startsWith("/") ? "" : "/"}${s}`;
    };

    const mappedFiles = files.map((f, idx) => {
      const originalName = f?.originalName || f?.filename || `file-${idx + 1}`;
      return {
        id: String(f?._id || idx),
        filename: String(f?.filename || ""),
        originalName: String(originalName || ""),
        fileUrl: normalizeUrl(f?.fileUrl || ""),
        mimeType: String(f?.mimeType || ""),
        fileSize: typeof f?.fileSize === "number" ? f.fileSize : null,
        isDerived: Boolean(f?.isDerived),
        derivedType: String(f?.derivedType || ""),
        derivedFrom: Array.isArray(f?.derivedFrom) ? f.derivedFrom : [],
      };
    });

    // Prefer the same extracted text used by teacher report/content:
    // rawText (ingestion output) first, then ocrText, then submissionText fallback.
    const rawDoc = await SubmissionRaw.findOne({ submissionId: sub._id })
      .select("rawText ocrText")
      .lean()
      .catch(() => null);
    const rawText =
      String(rawDoc?.rawText || "").trim() ||
      String(rawDoc?.ocrText || "").trim() ||
      String(sub.submissionText || "").trim();

    return res.status(200).json({
      success: true,
      submission: {
        _id: String(sub._id),
        assessmentTitle: sub.assessmentTitle || "",
        assessmentType: sub.assessmentType === "quiz" ? "quiz" : "assignment",
        courseCode: sub.courseCode || "",
        courseName: sub.courseName || "",
        studentName: sub.studentName || "",
        submittedAt: sub.submittedAt ? new Date(sub.submittedAt).toISOString() : null,
        grade: sub.grade ?? null,
        maxGrade: typeof sub.maxGrade === "number" ? sub.maxGrade : null,
        feedback: sub.feedback || "",
        plagiarismBestMatchPercent:
          typeof sub.plagiarismBestMatchPercent === "number" ? sub.plagiarismBestMatchPercent : null,
        plagiarismCheckedAt: sub.plagiarismCheckedAt ? new Date(sub.plagiarismCheckedAt).toISOString() : null,
      },
      submissionRaw: raw || null,
      content: {
        success: true,
        files: mappedFiles,
        extraction: {
          status: "completed",
          rawText,
        },
        submissionText: String(sub.submissionText || ""),
      },
    });
  } catch (error) {
    console.error("❌ getStudentSubmissionReport:", error);
    return res.status(500).json({ success: false, error: "Failed to build student report", details: error.message });
  }
};

/**
 * POST /api/submissions/:submissionId/digitize-images
 * Teacher-triggered OCR: convert image uploads (jpg/png) into ONE merged OCR-PDF and attach to submissionFiles.
 * Body: { teacherId }
 */
exports.digitizeSubmissionImages = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId are required" });
    }

    const sub = await Submission.findById(submissionId);
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    // IMPORTANT: always allow re-digitization. If an OCR PDF already exists, we replace it with a new one.
    const raw = await SubmissionRaw.findOne({ submissionId: sub._id }).lean().catch(() => null);

    const files = Array.isArray(sub.submissionFiles) ? sub.submissionFiles : [];
    const imageFiles = files.filter((f) => {
      const name = String(f?.originalName || f?.filename || "").toLowerCase();
      const ext = path.extname(name);
      return [".jpg", ".jpeg", ".png"].includes(ext) || String(f?.mimeType || "").startsWith("image/");
    });

    if (imageFiles.length === 0) {
      return res.status(400).json({ success: false, error: "No image files found on this submission" });
    }

    await SubmissionRaw.findOneAndUpdate(
      { submissionId: sub._id },
      { $set: { ocrEnabled: true, ocrStatus: "running", ocrError: "", ocrCount: imageFiles.length } },
      { upsert: true }
    ).catch(() => {});

    // Run OCR in background and expose real-time logs via ExtractionJob (same polling UI as other jobs).
    const job = await ExtractionJob.create({
      teacherId,
      assessmentId: sub.assessmentId,
      assessmentTitle: sub.assessmentTitle || "",
      courseCode: sub.courseCode || "",
      status: "queued",
      total: imageFiles.length,
      processed: 0,
      currentSubmissionId: String(sub._id),
      currentStudentName: String(sub.studentName || "").trim(),
      logs: [
        {
          ts: new Date(),
          level: "info",
          message: `Queued OCR digitization for ${imageFiles.length} image(s).`,
        },
      ],
    });

    res.status(202).json({ success: true, jobId: String(job._id) });

    setImmediate(async () => {
      await ExtractionJob.updateOne({ _id: job._id }, { $set: { status: "running" } }).catch(() => {});
      await _pushExtractionJobLog(job._id, `Digitization started for submission ${String(sub._id)}.`, "info");

      const uploadsRoot = path.join(__dirname, "../uploads/student_uploads");
      const ocrOutDir = path.join(uploadsRoot, "ocr_pdfs");
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ocrPdfFilename = `submission-${uniqueSuffix}-ocr.pdf`;

      // Best-effort: remove existing OCR-PDF derived entries and old OCR PDF file so the new run "replaces" it.
      try {
        const existingRaw = raw || (await SubmissionRaw.findOne({ submissionId: sub._id }).lean().catch(() => null));
        const oldUrl = String(existingRaw?.ocrPdfFileUrl || "").trim();
        if (oldUrl) {
          const rel = oldUrl.replace("\\", "/").split("/uploads/student_uploads/")[1] || "";
          if (rel) {
            const oldDiskPath = path.join(uploadsRoot, rel);
            if (fs.existsSync(oldDiskPath)) {
              fs.unlinkSync(oldDiskPath);
              await _pushExtractionJobLog(job._id, `Removed previous OCR PDF: ${path.basename(oldDiskPath)}`, "info");
            }
          }
        }

        const currentSub = await Submission.findById(sub._id).lean().catch(() => null);
        const prevFiles = Array.isArray(currentSub?.submissionFiles) ? currentSub.submissionFiles : [];
        const currentImageFilenames = imageFiles.map((x) => String(x?.filename || "")).filter(Boolean);
        const prevOcr = prevFiles.filter((f) => {
          if (!Boolean(f?.isDerived) || String(f?.derivedType || "") !== "ocr-pdf") return false;
          const fn = String(f?.filename || "").trim();
          if (fn && fn === String(existingRaw?.ocrPdfFilename || "").trim()) return true;
          const derivedFrom = Array.isArray(f?.derivedFrom) ? f.derivedFrom.map((x) => String(x || "")).filter(Boolean) : [];
          return derivedFrom.some((x) => currentImageFilenames.includes(x));
        });
        if (prevOcr.length) {
          const prevOcrNames = prevOcr.map((x) => String(x?.originalName || "")).filter(Boolean);
          const prevOcrFilename = String(existingRaw?.ocrPdfFilename || "").trim();
          await Submission.updateOne(
            { _id: sub._id },
            {
              $pull: {
                submissionFiles: {
                  isDerived: true,
                  derivedType: "ocr-pdf",
                  $or: [
                    ...(prevOcrFilename ? [{ filename: prevOcrFilename }] : []),
                    ...(currentImageFilenames.length ? [{ derivedFrom: { $in: currentImageFilenames } }] : []),
                  ],
                },
                ...(prevOcrNames.length ? { uploadedFileNames: { $in: prevOcrNames } } : {}),
              },
            }
          ).catch(() => {});
          await _pushExtractionJobLog(job._id, `Removed ${prevOcr.length} previous OCR-PDF entry(ies).`, "info");
        }
      } catch {}

      const imagePaths = imageFiles
        .map((f) => path.join(uploadsRoot, String(f.filename || "")))
        .filter((p) => p && fs.existsSync(p));

      if (imagePaths.length === 0) {
        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
          { $set: { ocrStatus: "failed", ocrError: "Image files not found on disk." } }
        ).catch(() => {});
        await _pushExtractionJobLog(job._id, "Digitization failed: image files not found on disk.", "error");
        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "failed", error: "Image files not found on disk.", finishedAt: new Date() } }
        ).catch(() => {});
        return;
      }

      try {
        const ocrResult = await ocrImagesToMergedPdf({
          imagePaths,
          outputDir: ocrOutDir,
          outputFileName: ocrPdfFilename,
          onProgress: ({ index, total, imagePath }) => {
            const name = path.basename(String(imagePath || ""));
            _pushExtractionJobLog(job._id, `Converting (${index + 1}/${total}): ${name}`, "info");
            ExtractionJob.updateOne({ _id: job._id }, { $set: { processed: Math.min(total, index) } }).catch(() => {});
          },
        });

        const ocrPdfUrl = `/uploads/student_uploads/ocr_pdfs/${ocrResult.pdfFilename}`;

        const derivedEntry = {
          filename: path.posix.join("ocr_pdfs", ocrResult.pdfFilename).replace(/\\/g, "/"),
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

        await Submission.findByIdAndUpdate(sub._id, {
          $push: { submissionFiles: derivedEntry, uploadedFileNames: derivedEntry.originalName },
          $inc: { uploadedFilesCount: 1, uploadedFilesTotalSize: Number(derivedEntry.fileSize || 0) },
        }).catch(() => {});

        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
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

        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "completed", processed: imagePaths.length, finishedAt: new Date() } }
        ).catch(() => {});
        await _pushExtractionJobLog(job._id, "Digitization completed. OCR PDF attached to submission.", "info");
      } catch (e) {
        const msg = e?.message || String(e);
        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
          { $set: { ocrStatus: "failed", ocrError: msg } }
        ).catch(() => {});
        await ExtractionJob.updateOne(
          { _id: job._id },
          { $set: { status: "failed", error: msg, finishedAt: new Date() } }
        ).catch(() => {});
        await _pushExtractionJobLog(job._id, `Digitization failed: ${msg}`, "error");
      }
    });

    return;
  } catch (e) {
    console.warn("[DIGITIZE] ⚠️ digitizeSubmissionImages failed:", e?.message || e);
    return res.status(500).json({ success: false, error: "Failed to digitize images", details: e?.message || String(e) });
  }
};

/**
 * POST /api/submissions/:submissionId/prepare-review
 * Teacher-owned helper: kicks off extraction/FAISS ingestion if needed.
 *
 * Body: { teacherId: string, force?: boolean }
 */
exports.prepareSubmissionForReview = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    const force = Boolean(req.body?.force);
    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId are required" });
    }

    const sub = await Submission.findById(submissionId);
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const raw = await SubmissionRaw.findOne({ submissionId: sub._id }).lean().catch(() => null);
    const extractionStatus = raw?.extractionStatus || "pending";
    const faissStatus = raw?.faissIngestionStatus || sub.faissIngestionStatus || "pending";

    const shouldRun =
      force ||
      extractionStatus === "pending" ||
      faissStatus === "pending" ||
      faissStatus === "failed" ||
      extractionStatus === "failed";

    if (!shouldRun) {
      return res.status(200).json({
        success: true,
        queued: false,
        message: "Submission already prepared",
        status: { extractionStatus, faissStatus },
      });
    }

    // Fast-fail readiness checks so UI sees errors immediately (instead of only via polling).
    try {
      const { isIngestionReady } = require("../utils/ingestionService");
      if (typeof isIngestionReady === "function" && !isIngestionReady()) {
        return res.status(500).json({
          success: false,
          error: "Extractor/ingestion environment not ready (Python/FAISS).",
        });
      }
    } catch {
      // If check helper missing, proceed (legacy).
    }

    // Mark as pending_review so teacher list updates.
    if (sub.status !== "graded") {
      sub.status = "pending_review";
      await sub.save().catch(() => {});
    }

    // Kick ingestion in background (do not block request).
    setImmediate(async () => {
      const subId = String(sub._id);
      try {
        // If student submitted a Jupyter notebook, extract embedded output images (plots)
        // so the UI "Graphical" tab can show them as normal image files.
        await extractIpynbOutputImagesToUploads(sub).catch(() => ({ created: 0, skipped: 0 }));

        // #region agent log
        fetch('http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'afcd7a'},body:JSON.stringify({sessionId:'afcd7a',runId:'pre-fix',hypothesisId:'H1',location:'submissionController.js:prepareSubmissionForReview:setImmediate',message:'prepare_review_background_start',data:{submissionId:subId,force:Boolean(force),extractionStatus:String(extractionStatus||''),faissStatus:String(faissStatus||'')},timestamp:Date.now()})}).catch(()=>{});
        // #endregion

        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
          {
            $setOnInsert: { submissionId: sub._id },
            $set: {
              assessmentId: sub.assessmentId,
              courseId: sub.courseId,
              teacherId: sub.teacherId,
              studentId: sub.studentId,
              extractionStatus: "pending",
              extractionError: "",
              faissIngestionStatus: "pending",
              faissIngestionError: "",
            },
          },
          { upsert: true, new: true }
        );

        await Submission.findByIdAndUpdate(subId, { $set: { faissIngestionStatus: "pending", faissIngestionError: "" } });

        // Enable OCR only when needed (images/PDFs). This reduces latency for pure code/text submissions.
        // NOTE: we re-fetch Submission to include any newly-derived notebook images.
        const fresh = await Submission.findById(subId).select("submissionFiles").lean().catch(() => null);
        const filesArr = Array.isArray(fresh?.submissionFiles) ? fresh.submissionFiles : Array.isArray(sub.submissionFiles) ? sub.submissionFiles : [];
        const needsOcr = filesArr.some((f) => {
          const n = String(f?.originalName || f?.filename || "").toLowerCase();
          const ext = path.extname(n);
          const mt = String(f?.mimeType || "");
          return [".jpg", ".jpeg", ".png", ".pdf"].includes(ext) || mt.startsWith("image/") || mt === "application/pdf";
        });

        const startedAt = Date.now();
        // #region agent log
        fetch('http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'afcd7a'},body:JSON.stringify({sessionId:'afcd7a',runId:'pre-fix',hypothesisId:'H1',location:'submissionController.js:prepareSubmissionForReview:beforeIngest',message:'ingestSubmission_call_start',data:{submissionId:subId,enableOcr:needsOcr},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const result = await ingestSubmission(subId, { enableOcr: needsOcr });
        const durationMs = Date.now() - startedAt;
        // #region agent log
        fetch('http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'afcd7a'},body:JSON.stringify({sessionId:'afcd7a',runId:'pre-fix',hypothesisId:'H1',location:'submissionController.js:prepareSubmissionForReview:afterIngest',message:'ingestSubmission_call_done',data:{submissionId:subId,durationMs,hasRawText:Boolean(result?.raw_text),chunks:Number(result?.total_chunks_created??result?.chunks??0)||0,ocrEnabled:Boolean(result?.ocr_enabled),ocrStatus:String(result?.ocr_status||'')},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const chunks = Number(result?.total_chunks_created ?? result?.chunks ?? 0) || 0;
        const embeddings = Number(result?.total_embeddings_created ?? result?.total_vectors_created ?? chunks) || 0;

        await Submission.findByIdAndUpdate(subId, {
          $set: {
            faissIngestionStatus: "completed",
            faissChunkCount: chunks,
            faissIngestionError: "",
            faissIngestedAt: new Date(),
          },
        });

        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
          {
            $set: {
              faissIngestionStatus: "completed",
              faissChunkCount: chunks,
              numChunks: chunks,
              numEmbeddings: embeddings,
              faissIngestionDurationMs: durationMs,
              faissIngestionError: "",
              faissIngestedAt: new Date(),
              extractionStatus: result?.raw_text || (Array.isArray(result?.content_types) && result.content_types.length) ? "completed" : "skipped",
              extractor: result?.extractor || "",
              rawText: result?.raw_text || "",
              charCount: typeof result?.raw_text === "string" ? result.raw_text.length : 0,
              pageCount: Number(result?.page_count ?? 0) || 0,
              pageMetadata: Array.isArray(result?.page_metadata) ? result.page_metadata : [],
              visualCount: Number(result?.visual_count ?? 0) || 0,
              equationCount: Number(result?.equation_count ?? 0) || 0,
              ocrEnabled: Boolean(result?.ocr_enabled),
              ocrStatus: result?.ocr_status || "",
              ocrError: result?.ocr_error || "",
              ocrCount: Number(result?.ocr_count ?? 0) || 0,
              ocrCharCount: Number(result?.ocr_char_count ?? 0) || 0,
              extractionError: "",
              extractedAt: new Date(),
            },
          }
        );
      } catch (e) {
        // #region agent log
        fetch('http://127.0.0.1:7581/ingest/941c1564-77f4-42f2-9551-e2a5a14ad240',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'afcd7a'},body:JSON.stringify({sessionId:'afcd7a',runId:'pre-fix',hypothesisId:'H1',location:'submissionController.js:prepareSubmissionForReview:catch',message:'prepare_review_background_error',data:{submissionId:subId,error:String(e?.message||e)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        await Submission.findByIdAndUpdate(subId, {
          $set: { faissIngestionStatus: "failed", faissIngestionError: e?.message || String(e) },
        }).catch(() => {});

        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
          {
            $set: {
              faissIngestionStatus: "failed",
              faissIngestionError: e?.message || String(e),
              extractionStatus: "failed",
              extractionError: e?.message || String(e),
            },
          }
        ).catch(() => {});
      }
    });

    return res.status(202).json({
      success: true,
      queued: true,
      message: "Preparation started (extraction/ingestion queued)",
      status: { extractionStatus, faissStatus },
    });
  } catch (error) {
    console.error("❌ prepareSubmissionForReview:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to prepare submission for review",
      details: error.message,
    });
  }
};

/**
 * POST /api/submissions/:submissionId/automark
 * Teacher-owned; runs an AI grading pass and stores results as suggestion fields.
 *
 * Body: { teacherId: string, forceReingest?: boolean, skipReingest?: boolean, async?: boolean }
 */
exports.automarkSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const teacherId = String(req.body?.teacherId || "").trim();
    const forceReingest = Boolean(req.body?.forceReingest);
    const skipReingest = Boolean(req.body?.skipReingest);
    const runAsync = req.body?.async !== false; // default async=true (better UX for slow CPUs)

    if (!submissionId || !teacherId) {
      return res.status(400).json({ success: false, error: "submissionId and teacherId are required" });
    }

    const sub = await Submission.findById(submissionId);
    if (!sub) return res.status(404).json({ success: false, error: "Submission not found" });
    if (String(sub.teacherId || "") !== teacherId) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const assessmentId = String(sub.assessmentId || "").trim();
    if (!assessmentId) {
      return res.status(400).json({ success: false, error: "Submission is missing assessmentId" });
    }

    const assessment = await Assessment.findById(assessmentId)
      .populate({ path: "questions", populate: { path: "cloId" } })
      .lean();
    if (!assessment) return res.status(404).json({ success: false, error: "Assessment not found" });

    const questions = Array.isArray(assessment.questions) ? assessment.questions : [];
    if (questions.length === 0) {
      return res.status(400).json({ success: false, error: "Assessment has no questions to grade" });
    }

    // Mark as processing immediately (so UI can show "Processing…" and poll).
    await SubmissionRaw.updateOne(
      { submissionId: sub._id },
      {
        $setOnInsert: { submissionId: sub._id },
        $set: {
          assessmentId: sub.assessmentId,
          courseId: sub.courseId || null,
          teacherId,
          studentId: String(sub.studentId || ""),
          automarkStatus: "processing",
          automarkError: "",
          automarkedAt: new Date(),
        },
      },
      { upsert: true }
    ).catch(() => {});

    const run = async () => {
      // Ensure submission chunks exist for retrieval (best-effort).
      // If skipReingest is set, we do NOT run ingestion (re-mark only).
      if (!skipReingest && (forceReingest || (sub.faissIngestionStatus !== "completed" && sub.faissIngestionStatus !== "skipped"))) {
        try {
          // Ensure notebook output images exist before ingestion (so "Graphical" tab populates).
          await extractIpynbOutputImagesToUploads(sub).catch(() => ({ created: 0, skipped: 0 }));
          await ingestSubmission(String(sub._id), { enableOcr: true });
          await Submission.updateOne(
            { _id: sub._id },
            { $set: { faissIngestionStatus: "completed", faissIngestionError: "", faissIngestedAt: new Date() } }
          );
        } catch (e) {
          console.warn("[AUTOMARK] Submission ingestion failed (continuing):", e?.message || String(e));
        }
      }

      // Shared LLM path with batch AutoMark (Ollama prompt, timeouts, course materials, mistakes/spans).
      const report = await automarkOneSubmission(sub, assessment, questions, null);
      if (report?.failed) {
        throw new Error(report?.error || "LLM failed during automark");
      }
      const avgConfidence = report.confidence;

      try {
        const perQuestionScores = buildPerQuestionScoresFromReport(report);
        await SubmissionRaw.findOneAndUpdate(
          { submissionId: sub._id },
          {
            $setOnInsert: { submissionId: sub._id },
            $set: {
              assessmentId: sub.assessmentId,
              courseId: sub.courseId || null,
              teacherId,
              studentId: String(sub.studentId || ""),
              automarkStatus: "completed",
              automarkError: "",
              automarkedAt: new Date(),
              automarkReport: report,
              perQuestionScores,
              totalAwardedMarks: Number(report?.totals?.awarded ?? 0) || 0,
            },
          },
          { upsert: true }
        ).catch(() => {});
      } catch (e) {
        console.warn("[AUTOMARK] Failed to persist SubmissionRaw automark fields:", e?.message || String(e));
      }

      return { report, avgConfidence };
    };

    if (runAsync) {
      setImmediate(async () => {
        try {
          await run();
        } catch (e) {
          const msg = e?.message || String(e);
          await SubmissionRaw.updateOne(
            { submissionId: sub._id },
            { $set: { automarkStatus: "failed", automarkError: msg, automarkedAt: new Date() } }
          ).catch(() => {});
        }
      });

      return res.status(202).json({
        success: true,
        queued: true,
        message: "AutoMark started",
      });
    }

    const { report, avgConfidence } = await run();

    return res.status(200).json({
      success: true,
      message: "AutoMark completed",
      suggestion: {
        grade: report.totals.awarded,
        maxGrade: report.totals.max,
        confidence: avgConfidence,
      },
      report,
    });
  } catch (error) {
    console.error("❌ automarkSubmission:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to automark submission",
      details: error.message,
    });
  }
};

/**
 * Get recent student submissions from student_uploads folder
 * GET /api/submissions/recent
 * Query params: limit (default: 10), teacherId (optional - filter by teacher)
 */
exports.getRecentSubmissions = async (req, res) => {
  try {
    const studentUploadsDir = path.join(__dirname, "../uploads/student_uploads");
    const limit = parseInt(req.query.limit) || 10;
    const teacherId = req.query.teacherId;

    console.log(`📂 Fetching recent submissions from: ${studentUploadsDir}`);

    // Check if directory exists
    if (!fs.existsSync(studentUploadsDir)) {
      console.warn(`⚠️ Student uploads directory not found: ${studentUploadsDir}`);
      return res.json({
        success: true,
        submissions: [],
        count: 0
      });
    }

    // Read all files from student_uploads directory
    const files = fs.readdirSync(studentUploadsDir);
    console.log(`   📁 Found ${files.length} files in student_uploads`);

    // Get file stats and create submissions list
    const submissions = files
      .map((filename) => {
        try {
          const filePath = path.join(studentUploadsDir, filename);
          const stats = fs.statSync(filePath);
          
          // Parse filename: submission-timestamp-randomstring-originalname
          // Example: submission-1776616330632-101833650-Hamza_Awan_ML_Quiz1.docx
          const filenameParts = filename.split('-');
          
          let studentName = "Unknown";
          let courseName = "Unknown";
          let assessmentName = "Unknown";
          
          // Try to extract info from filename
          if (filenameParts.length >= 3) {
            // Skip 'submission' prefix, timestamp, and randomstring
            const originalNamePart = filenameParts.slice(3).join('-');
            
            // Try to parse: StudentName_StudentName_CourseCode_Assessment.ext or similar patterns
            const nameWithoutExt = originalNamePart.replace(/\.[^/.]+$/, '');
            const parts = nameWithoutExt.split('_');
            
            if (parts.length >= 2) {
              // Assume first parts are student name
              studentName = parts.slice(0, -1).join(' ') || "Unknown";
              assessmentName = parts[parts.length - 1] || "Unknown";
            } else {
              assessmentName = nameWithoutExt;
            }
          }
          
          return {
            filename,
            originalName: filename,
            studentName,
            assessmentName,
            fileSize: stats.size,
            uploadedAt: stats.mtime,
            uploadedAtFormatted: stats.mtime.toISOString(),
            type: path.extname(filename).toLowerCase(),
            status: 'submitted'
          };
        } catch (error) {
          console.warn(`⚠️ Error processing file ${filename}:`, error.message);
          return null;
        }
      })
      .filter(sub => sub !== null)
      // Sort by upload time (newest first)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      // Limit to requested count
      .slice(0, limit)
      // Map to cleaner format
      .map((sub, index) => ({
        id: index,
        filename: sub.filename,
        studentName: sub.studentName,
        assessmentName: sub.assessmentName,
        fileSize: sub.fileSize,
        fileSizeFormatted: formatFileSize(sub.fileSize),
        uploadedAt: sub.uploadedAtFormatted,
        type: sub.type,
        status: sub.status,
        downloadUrl: `/api/submissions/file/${sub.filename}`
      }));

    console.log(`   ✅ Returned ${submissions.length} recent submissions`);

    res.json({
      success: true,
      submissions,
      count: submissions.length
    });

  } catch (error) {
    console.error("❌ Error fetching recent submissions:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch recent submissions",
      details: error.message
    });
  }
};

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Get student's submissions from student_uploads folder (for student dashboard)
 * GET /api/submissions/student/:studentId/my-uploads
 */
exports.getStudentMyUploads = async (req, res) => {
  try {
    const { studentId } = req.params;
    const studentUploadsDir = path.join(__dirname, "../uploads/student_uploads");
    
    console.log(`📄 Fetching uploads for student: ${studentId}`);

    // First try to get from database (Upload collection via uploadUtils)
    try {
      const uploadUtils = require("../utils/uploadUtils");
      const dbUploads = await uploadUtils.getStudentUploads(studentId);
      
      if (dbUploads && dbUploads.length > 0) {
        console.log(`   ✅ Found ${dbUploads.length} submissions in database`);
        return res.json({
          success: true,
          submissions: dbUploads.map(upload => ({
            _id: upload._id,
            filename: upload.fileName,
            originalName: upload.originalFileName,
            assessmentTitle: upload.assessmentTitle,
            assessmentName: upload.assessmentTitle,
            courseCode: upload.courseCode,
            courseName: upload.courseName,
            fileSize: upload.fileSize,
            fileSizeFormatted: formatFileSize(upload.fileSize),
            mimeType: upload.mimeType,
            uploadedAt: upload.uploadedAt?.toISOString?.() || upload.uploadedAt,
            uploadedDate: upload.uploadedDate,
            uploadedTime: upload.uploadedTime,
            status: upload.status,
            isLate: upload.isLate,
            downloadUrl: upload.fileUrl || `/api/submissions/file/${upload.fileName}`,
            type: path.extname(upload.fileName).toLowerCase()
          })),
          count: dbUploads.length,
          source: 'database'
        });
      }
    } catch (error) {
      console.warn(`⚠️ Error fetching from database:`, error.message);
    }

    // Fallback: Search file system for student's files
    console.log(`   📂 Checking file system for student uploads in: ${studentUploadsDir}`);
    
    if (!fs.existsSync(studentUploadsDir)) {
      return res.json({
        success: true,
        submissions: [],
        count: 0,
        source: 'filesystem'
      });
    }

    const files = fs.readdirSync(studentUploadsDir);
    
    // Filter files that might belong to this student
    // Since filenames don't include student ID, we'll return all recent files for now
    // In production, you might want to query the database for the student's uploaded files
    const submissions = files
      .map((filename) => {
        try {
          const filePath = path.join(studentUploadsDir, filename);
          const stats = fs.statSync(filePath);
          
          // Try to parse filename to extract info
          const filenameParts = filename.split('-');
          let assessmentName = "Unknown";
          
          if (filenameParts.length >= 3) {
            const originalNamePart = filenameParts.slice(3).join('-');
            assessmentName = originalNamePart.replace(/\.[^/.]+$/, '');
          }
          
          return {
            _id: filename,
            filename: filename,
            originalName: filename,
            assessmentTitle: assessmentName,
            assessmentName: assessmentName,
            fileSize: stats.size,
            fileSizeFormatted: formatFileSize(stats.size),
            mimeType: 'application/octet-stream',
            uploadedAt: stats.mtime.toISOString(),
            uploadedDate: stats.mtime.toLocaleDateString(),
            uploadedTime: stats.mtime.toLocaleTimeString(),
            status: 'submitted',
            isLate: false,
            downloadUrl: `/api/submissions/file/${filename}`,
            type: path.extname(filename).toLowerCase()
          };
        } catch (error) {
          console.warn(`⚠️ Error processing file ${filename}:`, error.message);
          return null;
        }
      })
      .filter(sub => sub !== null)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    console.log(`   ✅ Found ${submissions.length} submissions from file system`);

    res.json({
      success: true,
      submissions,
      count: submissions.length,
      source: 'filesystem',
      note: 'Consider implementing proper student-file association in database'
    });

  } catch (error) {
    console.error("❌ Error fetching student uploads:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch student uploads",
      details: error.message
    });
  }
};

/**
 * Get all submissions (Admin database view)
 * GET /api/submissions/all
 */
exports.getAllSubmissions = async (req, res) => {
  try {
    console.log(`📊 Fetching all submissions for admin database`);
    
    const submissions = await Submission.find({})
      .populate('assessmentId', 'title type totalMarks')
      .populate('courseId', 'courseCode courseTitle')
      .sort({ submittedAt: -1 })
      .lean();

    console.log(`   ✅ Found ${submissions.length} total submissions`);

    res.json({
      success: true,
      submissions,
      count: submissions.length,
      stats: {
        total: submissions.length,
        graded: submissions.filter(s => s.status === 'graded').length,
        pending: submissions.filter(s => s.status === 'submitted' || s.status === 'late').length,
        late: submissions.filter(s => s.isLate).length
      }
    });

  } catch (error) {
    console.error("❌ Error fetching all submissions:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch submissions" 
    });
  }
};

