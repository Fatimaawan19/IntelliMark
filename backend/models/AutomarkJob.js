const mongoose = require("mongoose");

const automarkJobSchema = new mongoose.Schema(
  {
    teacherId: { type: String, required: true, index: true },
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assessment", required: true, index: true },
    assessmentTitle: { type: String, default: "" },
    courseCode: { type: String, default: "" },
    jobType: {
      type: String,
      // Backward compatible: keep "extract" for old records, but use "ExtractStudentChunks" going forward.
      enum: ["automark", "remark", "publish"],
      default: "automark",
      index: true,
    },

    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "cancelled"],
      default: "queued",
      index: true,
    },

    total: { type: Number, default: 0, min: 0 },
    processed: { type: Number, default: 0, min: 0 },
    currentSubmissionId: { type: String, default: "" },
    currentStudentName: { type: String, default: "" },

    // Debug tracking flags (high-level readiness for marking)
    studentEvidenceExtracted: { type: Boolean, default: false },
    sampleAnswerExtracted: { type: Boolean, default: false },
    relevantCourseMaterialChunksExtracted: { type: Boolean, default: false },

    logs: [
      {
        ts: { type: Date, default: Date.now },
        level: { type: String, default: "info" },
        message: { type: String, default: "" },
      },
    ],

    // Which marker was used (cloud/local) and summary results
    marker: { type: String, default: "ollama", index: true }, // e.g., "groq" | "ollama"
    markerCounts: {
      groq: { type: Number, default: 0, min: 0 },
      ollama: { type: Number, default: 0, min: 0 },
    },
    results: [
      {
        submissionId: { type: String, default: "" },
        studentName: { type: String, default: "" },
        status: { type: String, default: "" }, // "graded" | "pending_review" | "failed"
        awarded: { type: Number, default: 0 },
        max: { type: Number, default: 0 },
        confidence: { type: Number, default: 0 },
        provider: { type: String, default: "" }, // "groq" | "ollama"
        needsTeacherReview: { type: Boolean, default: false },
        error: { type: String, default: "" },
        ts: { type: Date, default: Date.now },
      },
    ],

    error: { type: String, default: "" },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "automarkJobs" }
);

automarkJobSchema.index({ teacherId: 1, assessmentId: 1, createdAt: -1 });

module.exports = mongoose.model("AutomarkJob", automarkJobSchema);

