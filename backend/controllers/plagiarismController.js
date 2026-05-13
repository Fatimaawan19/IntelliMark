const plagiarismService = require("../utils/plagiarismService");
const { calculateConsistentScore } = require("../utils/consistentScoringService");
const PlagiarismReport = require("../models/PlagiarismReport");
const Submission = require("../models/Submission");

/**
 * POST /api/plagiarism/check/:submissionId
 * Run plagiarism check (or return cached). Query ?refresh=true to force rerun.
 */
exports.checkSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const forceRefresh = req.query.refresh === "true";

    const report = await plagiarismService.checkPlagiarism(submissionId, { forceRefresh });

    if (report === null) {
      return res.json({ success: true, applicable: false, message: "Plagiarism check only applies to assignments" });
    }

    res.json({ success: true, report, isCached: Boolean(report.isCached) });
  } catch (err) {
    console.error("[PLAGIARISM] check error:", err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/plagiarism/report/:submissionId
 * Fetch existing report without triggering a new check.
 */
exports.getReport = async (req, res) => {
  try {
    const report = await PlagiarismReport.findOne({ submissionId: req.params.submissionId }).lean();
    if (!report) return res.status(404).json({ error: "No plagiarism report found for this submission" });
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/plagiarism/assessment/:assessmentId
 * All reports for an assessment (teacher view — sorted by risk).
 */
exports.getAssessmentReports = async (req, res) => {
  try {
    const reports = await plagiarismService.getAssessmentPlagiarismReports(req.params.assessmentId);
    res.json({ success: true, count: reports.length, reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/plagiarism/student/:studentId
 * All reports for a student (student-facing, their own submissions).
 */
exports.getStudentReports = async (req, res) => {
  try {
    const reports = await plagiarismService.getStudentPlagiarismReports(req.params.studentId);
    res.json({ success: true, count: reports.length, reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/plagiarism/score-breakdown/:submissionId
 * Get consistent score breakdown with transparent penalty application.
 * Requires plagiarism report to exist.
 */
exports.getScoreBreakdown = async (req, res) => {
  try {
    const { submissionId } = req.params;

    const submission = await Submission.findById(submissionId).lean();
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    const plagiarismReport = await PlagiarismReport.findOne({ submissionId }).lean();
    if (!plagiarismReport) {
      return res.status(404).json({ error: "Plagiarism report not found. Run plagiarism check first." });
    }

    if (!submission.grade) {
      return res.status(400).json({ error: "Submission has not been graded yet" });
    }

    const scoreBreakdown = await calculateConsistentScore(submission);
    res.json({ success: true, scoreBreakdown });
  } catch (err) {
    console.error("[PLAGIARISM] score-breakdown error:", err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/plagiarism/check-assessment/:assessmentId
 * Batch-check all submissions for an assessment (background, non-blocking).
 */
exports.checkAssessmentBatch = async (req, res) => {
  try {
    const { assessmentId } = req.params;

    const submissions = await Submission.find({
      assessmentId,
      assessmentType: "assignment",
      status: "graded",
    }).select("_id").lean();

    if (submissions.length === 0) {
      return res.json({ success: true, message: "No graded assignment submissions found", queued: 0 });
    }

    res.json({ success: true, message: "Batch plagiarism check started", queued: submissions.length });

    // Run checks asynchronously after responding
    (async () => {
      for (const s of submissions) {
        try {
          await plagiarismService.checkPlagiarism(s._id.toString(), { forceRefresh: false });
        } catch (e) {
          console.warn(`[PLAGIARISM] Batch check failed for ${s._id}:`, e.message);
        }
      }
      console.log(`[PLAGIARISM] Batch check complete for assessment ${assessmentId}: ${submissions.length} submissions`);
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
