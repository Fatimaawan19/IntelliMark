const mongoose = require("mongoose");

/**
 * StudentCLOPerformance Schema
 * 
 * Stores aggregated performance metrics for each student per CLO per assessment type per course.
 * This enables tracking of learning outcomes achievement at granular level.
 * 
 * Example:
 * - Student: S123
 * - Course: ML 101
 * - CLO: CLO 1 (Understand ML algorithms)
 * - Assessment Type: quiz
 * - Total Marks in CLO 1 quizzes: 85/100 = 85%
 */
const studentCLOPerformanceSchema = new mongoose.Schema({
  // References
  studentId: {
    type: String,
    required: true,
    index: true
  },

  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course",
    required: true,
    index: true
  },

  courseCode: {
    type: String,
    required: true,
    index: true
  },

  courseName: {
    type: String,
    default: ""
  },

  cloId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "CLO",
    required: true,
    index: true
  },

  cloNumber: {
    type: Number,
    required: true
  },

  cloDescription: {
    type: String,
    default: ""
  },

  // Assessment Type
  assessmentType: {
    type: String,
    enum: ['quiz', 'assignment'],
    required: true,
    index: true
  },

  // Performance Metrics
  totalMarksObtained: {
    type: Number,
    default: 0,
    min: 0
  },

  totalMarksAvailable: {
    type: Number,
    default: 0,
    min: 0
  },

  percentage: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  submissionCount: {
    type: Number,
    default: 0,
    min: 0
  },

  // Detail breakdown - stores references to source submissions for real-time data extraction
  submissions: [{
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Submission",
      index: true
    },
    assessmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assessment"
    },
    assessmentTitle: String,
    submissionRawId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubmissionRaw"
    },
    submittedAt: Date,
    gradedAt: Date,
    status: {
      type: String,
      enum: ['graded', 'pending', 'submitted']
    },
    // Cached data (pulled from Submission collection)
    marksObtained: Number,
    marksAvailable: Number,
    feedback: String,
    lastSyncedAt: Date
  }],

  // Tracking
  teacherId: {
    type: String,
    required: true,
    index: true
  },

  // Summary feedback from all graded submissions
  allFeedback: {
    type: [String],
    default: []
  },

  // Flag to track if CLO performance is synced with actual submission data
  isSynced: {
    type: Boolean,
    default: false
  },

  lastSyncedAt: {
    type: Date,
    default: null
  },

  lastUpdated: {
    type: Date,
    default: Date.now
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Compound unique index - one record per student-course-clo-assessmentType combo
studentCLOPerformanceSchema.index(
  { studentId: 1, courseId: 1, cloId: 1, assessmentType: 1 },
  { unique: true }
);

// Additional indexes for querying
studentCLOPerformanceSchema.index({ studentId: 1, assessmentType: 1 });
studentCLOPerformanceSchema.index({ courseId: 1, cloId: 1 });
studentCLOPerformanceSchema.index({ teacherId: 1, courseId: 1 });
studentCLOPerformanceSchema.index({ isSynced: 1 });
studentCLOPerformanceSchema.index({ lastSyncedAt: 1 });

module.exports = mongoose.model("StudentCLOPerformance", studentCLOPerformanceSchema);
