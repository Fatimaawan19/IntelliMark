const mongoose = require("mongoose");

const plagiarismReportSchema = new mongoose.Schema({
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Submission",
    required: true,
    unique: true,
    index: true,
  },
  assessmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Assessment",
    index: true,
  },
  studentId:  { type: String, required: true, index: true },
  courseId:   { type: mongoose.Schema.Types.ObjectId, ref: "Course", index: true },
  textLength: { type: Number, default: 0 },

  // FAISS internal similarity (student vs other students, same assessment)
  internalScore: { type: Number, default: 0, min: 0, max: 100 },
  topMatches: [{
    submissionId:     { type: mongoose.Schema.Types.ObjectId, ref: "Submission" },
    studentId:        String,
    studentName:      String,
    assessmentTitle:  String,
    similarityPercent:{ type: Number, min: 0, max: 100 },
    matchedText:      String,
  }],

  // ZeroGPT AI-generated content detection
  aiScore:             { type: Number, default: 0, min: 0, max: 100 },
  isGptGenerated:      { type: Boolean, default: false },
  aiAdditionalFeedback:{ type: String, default: "" },

  // Combined
  overallScore: { type: Number, default: 0, min: 0, max: 100 },
  riskLevel:    { type: String, enum: ["low", "medium", "high"], default: "low" },

  checkedAt: { type: Date, default: Date.now },
}, { timestamps: true });

plagiarismReportSchema.index({ assessmentId: 1, overallScore: -1 });
plagiarismReportSchema.index({ courseId: 1, riskLevel: 1 });

module.exports = mongoose.model("PlagiarismReport", plagiarismReportSchema);
