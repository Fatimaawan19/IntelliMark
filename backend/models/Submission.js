const mongoose = require("mongoose");

const submissionSchema = new mongoose.Schema({
  // Assessment Reference
  assessmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Assessment",
    required: true,
    index: true
  },
  
  // Student Reference
  studentId: {
    type: String,
    required: true,
    index: true
  },

  studentName: {
    type: String,
    default: ""
  },

  studentEmail: {
    type: String,
    default: ""
  },
  
  // Course Reference
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course",
    required: true
  },
  
  courseCode: {
    type: String,
    required: true
  },

  courseName: {
    type: String,
    default: ""
  },

  teacherId: {
    type: String,
    required: true,
    index: true
  },

  assessmentTitle: {
    type: String,
    default: ""
  },

  assessmentType: {
    type: String,
    enum: ["quiz", "assignment"],
    default: "assignment"
  },
  
  // Submission Content - Enhanced file tracking
  submissionFiles: [{
    filename: String,
    originalName: String,
    fileUrl: String,
    fileSize: Number,
    mimeType: String,
    // Derived files (e.g., OCR-PDF generated from images)
    isDerived: { type: Boolean, default: false },
    derivedFrom: { type: [String], default: [] }, // source filenames
    derivedType: { type: String, default: "" }, // e.g. "ocr-pdf"
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    uploadedDate: String, // YYYY-MM-DD format
    uploadedTime: String, // HH:MM:SS format
    // File-level feedback (for multi-file submissions)
    marks: {
      type: Number,
      default: null
    },
    fileFeedback: {
      type: String,
      default: ""
    }
  }],

  uploadedFileNames: {
    type: [String],
    default: []
  },

  uploadedFilesCount: {
    type: Number,
    default: 0
  },

  uploadedFilesTotalSize: {
    type: Number,
    default: 0
  },
  
  submissionText: {
    type: String,
    default: ""
  },
  
  // Submission Timing
  submittedAt: {
    type: Date,
    default: Date.now,
    required: true
  },

  submissionDate: {
    type: String,
    default: ""
  },

  submissionTime: {
    type: String,
    default: ""
  },
  
  isLate: {
    type: Boolean,
    default: false
  },

  lateDays: {
    type: Number,
    default: 0,
    min: 0
  },

  latePenaltyPerDay: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  latePenaltyPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  // FAISS ingestion for submission content (code/text)
  faissIngestionStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'skipped'],
    default: 'pending'
  },
  faissChunkCount: {
    type: Number,
    default: 0,
    min: 0
  },
  faissIngestionError: {
    type: String,
    default: ""
  },
  faissIngestedAt: {
    type: Date,
    default: null
  },
  
  // Status Tracking
  status: {
    type: String,
    enum: ['submitted', 'graded', 'late', 'pending_review', 'returned'],
    default: 'submitted'
  },
  
  // Grading Information
  grade: {
    type: Number,
    min: 0,
    default: null
  },
  
  maxGrade: {
    type: Number,
    required: true
  },
  
  feedback: {
    type: String,
    default: ""
  },

  // Recommended learning resource link (derived from published teacher feedback/mistakes)
  recommendedResource: {
    type: Object,
    default: null
  },

  // Teacher-controlled report visibility for students (PDF report page)
  reportPublished: {
    type: Boolean,
    default: false
  },
  reportPublishedAt: {
    type: Date,
    default: null
  },

  // Teacher-controlled grade/feedback visibility for students (assessment cards)
  gradePublished: {
    type: Boolean,
    default: false,
    index: true
  },
  gradePublishedAt: {
    type: Date,
    default: null
  },
  
  gradedBy: {
    type: String, // teacherId (Firebase UID)
    default: null
  },
  
  gradedAt: {
    type: Date,
    default: null
  },
  
  // AI Grading Support
  aiGradingSuggestion: {
    type: Number,
    default: null
  },
  
  aiConfidence: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  
  aiAnalysis: {
    type: String,
    default: null
  },

  // Plagiarism check (assignments only)
  plagiarismBestMatchPercent: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  plagiarismCheckedAt: {
    type: Date,
    default: null
  },

  // Full plagiarism report snapshot (persisted to keep results stable across re-runs)
  plagiarismReport: {
    type: Object,
    default: null
  },

  // Plagiarism policy outputs (computed when teacher runs plagiarism check)
  plagiarismPenaltyPercent: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  plagiarismAdjustedGrade: {
    type: Number,
    min: 0,
    default: null
  },

  // Tier-2 mistakes summary (for listing/analytics without SubmissionRaw)
  mistakes: {
    type: Array,
    default: []
  },

  // Tier-3 aggregated flag: at least one question needs teacher review
  needsTeacherReview: {
    type: Boolean,
    default: false,
    index: true
  },
  
  manualOverride: {
    type: Boolean,
    default: false
  },
  
  // Metadata
  attemptNumber: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
submissionSchema.index({ studentId: 1, assessmentId: 1 });
submissionSchema.index({ assessmentId: 1, status: 1 });
submissionSchema.index({ courseId: 1, studentId: 1 });

// Virtual for grade percentage
submissionSchema.virtual('gradePercentage').get(function() {
  if (this.grade === null || this.maxGrade === 0) return null;
  return ((this.grade / this.maxGrade) * 100).toFixed(2);
});

// Method to check if submission was late
submissionSchema.methods.checkIfLate = function(assessmentDeadline) {
  if (!assessmentDeadline) return false;
  return new Date(this.submittedAt) > new Date(assessmentDeadline);
};

module.exports = mongoose.model("Submission", submissionSchema, "submission");
