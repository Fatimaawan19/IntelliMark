const cloPerformanceService = require("../utils/cloPerformanceService");
const StudentCLOPerformance = require("../models/StudentCLOPerformance");

/**
 * Get CLO performance for current student in a course
 */
exports.getStudentCLOPerformance = async (req, res) => {
  try {
    const { studentId, courseId } = req.params;

    if (!studentId || !courseId) {
      return res.status(400).json({ error: "studentId and courseId required" });
    }

    const performance = await cloPerformanceService.getStudentCLOPerformance(
      studentId,
      courseId
    );

    res.json({
      success: true,
      courseId,
      studentId,
      performance
    });

  } catch (error) {
    console.error("Error fetching student CLO performance:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get CLO performance filtered by assessment type (quiz/assignment)
 */
exports.getStudentCLOPerformanceByType = async (req, res) => {
  try {
    const { studentId, courseId, assessmentType } = req.params;

    if (!studentId || !courseId || !assessmentType) {
      return res.status(400).json({ 
        error: "studentId, courseId, and assessmentType required" 
      });
    }

    if (!['quiz', 'assignment'].includes(assessmentType)) {
      return res.status(400).json({ 
        error: "assessmentType must be 'quiz' or 'assignment'" 
      });
    }

    const performance = await cloPerformanceService.getStudentCLOPerformanceByType(
      studentId,
      courseId,
      assessmentType
    );

    res.json({
      success: true,
      courseId,
      studentId,
      assessmentType,
      performance
    });

  } catch (error) {
    console.error("Error fetching student CLO performance by type:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Manually trigger CLO performance recalculation for a student-course combo
 * (Usually called after bulk grading updates)
 */
exports.recalculateStudentCLOPerformance = async (req, res) => {
  try {
    const { studentId, courseId } = req.params;

    if (!studentId || !courseId) {
      return res.status(400).json({ error: "studentId and courseId required" });
    }

    const result = await cloPerformanceService.recalculateCLOPerformanceForStudentCourse(
      studentId,
      courseId
    );

    res.json({
      success: true,
      message: `Recalculated CLO performance for student ${studentId} in course ${courseId}`,
      ...result
    });

  } catch (error) {
    console.error("Error recalculating CLO performance:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get CLO performance analytics for entire course (all students)
 * Shows average performance per CLO per assessment type
 */
exports.getCourseClOAnalytics = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { assessmentType } = req.query; // Optional filter

    if (!courseId) {
      return res.status(400).json({ error: "courseId required" });
    }

    if (assessmentType && !['quiz', 'assignment'].includes(assessmentType)) {
      return res.status(400).json({ 
        error: "assessmentType must be 'quiz' or 'assignment'" 
      });
    }

    const analytics = await cloPerformanceService.getCourseClOPerformanceAnalytics(
      courseId,
      assessmentType || null
    );

    res.json({
      success: true,
      courseId,
      filter: assessmentType ? { assessmentType } : null,
      analytics
    });

  } catch (error) {
    console.error("Error fetching course CLO analytics:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get all CLO performance records (admin/analytics endpoint)
 */
exports.getAllCLOPerformance = async (req, res) => {
  try {
    const { studentId, courseId, assessmentType } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const query = {};
    if (studentId) query.studentId = studentId;
    if (courseId) query.courseId = courseId;
    if (assessmentType) query.assessmentType = assessmentType;

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      StudentCLOPerformance.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      StudentCLOPerformance.countDocuments(query)
    ]);

    res.json({
      success: true,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      records
    });

  } catch (error) {
    console.error("Error fetching CLO performance records:", error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get performance summary for a single CLO across all students
 */
exports.getCLOPerformanceSummary = async (req, res) => {
  try {
    const { courseId, cloId } = req.params;
    const { assessmentType } = req.query;

    if (!courseId || !cloId) {
      return res.status(400).json({ error: "courseId and cloId required" });
    }

    const query = {
      courseId,
      cloId
    };

    if (assessmentType) {
      if (!['quiz', 'assignment'].includes(assessmentType)) {
        return res.status(400).json({ 
          error: "assessmentType must be 'quiz' or 'assignment'" 
        });
      }
      query.assessmentType = assessmentType;
    }

    const performances = await StudentCLOPerformance.find(query)
      .select("studentId percentage submissionCount assessmentType")
      .lean();

    const avgPercentage = performances.length > 0
      ? Math.round(
          performances.reduce((sum, p) => sum + p.percentage, 0) / performances.length
        )
      : 0;

    res.json({
      success: true,
      courseId,
      cloId,
      assessmentType: assessmentType || "all",
      summary: {
        studentCount: performances.length,
        avgPercentage,
        minPercentage: Math.min(...performances.map(p => p.percentage), 0),
        maxPercentage: Math.max(...performances.map(p => p.percentage), 0),
        totalSubmissions: performances.reduce((sum, p) => sum + p.submissionCount, 0)
      },
      performances
    });

  } catch (error) {
    console.error("Error fetching CLO performance summary:", error);
    res.status(500).json({ error: error.message });
  }
};
