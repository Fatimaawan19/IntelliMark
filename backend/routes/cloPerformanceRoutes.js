const express = require("express");
const router = express.Router();
const cloPerformanceController = require("../controllers/cloPerformanceController");

/**
 * CLO Performance Routes
 * 
 * Endpoints for retrieving and managing student CLO-wise performance metrics
 */

// Get CLO performance for a student in a course
router.get("/student/:studentId/course/:courseId", cloPerformanceController.getStudentCLOPerformance);

// Get CLO performance filtered by assessment type
router.get("/student/:studentId/course/:courseId/type/:assessmentType", cloPerformanceController.getStudentCLOPerformanceByType);

// Get CLO performance analytics for entire course
router.get("/course/:courseId/analytics", cloPerformanceController.getCourseClOAnalytics);

// Get performance summary for a specific CLO
router.get("/course/:courseId/clo/:cloId", cloPerformanceController.getCLOPerformanceSummary);

// Manually recalculate CLO performance for a student-course
router.post("/recalculate/:studentId/course/:courseId", cloPerformanceController.recalculateStudentCLOPerformance);

// Get all CLO performance records (with filtering and pagination)
router.get("/", cloPerformanceController.getAllCLOPerformance);

module.exports = router;
