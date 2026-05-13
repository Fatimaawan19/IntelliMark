const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/plagiarismController");

// Run check (returns cached unless ?refresh=true)
router.post("/check/:submissionId", ctrl.checkSubmission);

// Fetch existing report only
router.get("/report/:submissionId", ctrl.getReport);

// All reports for an assessment (teacher)
router.get("/assessment/:assessmentId", ctrl.getAssessmentReports);

// All reports for a student (student-facing)
router.get("/student/:studentId", ctrl.getStudentReports);

// Batch check all submissions for an assessment
router.post("/check-assessment/:assessmentId", ctrl.checkAssessmentBatch);

// Get consistent score breakdown with transparent penalty
router.get("/score-breakdown/:submissionId", ctrl.getScoreBreakdown);

module.exports = router;
