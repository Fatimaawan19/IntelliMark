const mongoose = require("mongoose");
const StudentCLOPerformance = require("../models/StudentCLOPerformance");
const Submission = require("../models/Submission");
const Assessment = require("../models/Assessment");
const CLO = require("../models/CLO");
const Question = require("../models/Question");
const SubmissionRaw = require("../models/SubmissionRaw");

/**
 * CLO Performance Calculator Service
 * 
 * Extracts real-time data from Submission and SubmissionRaw collections
 * and maintains StudentCLOPerformance records in sync.
 */

/**
 * Extract numeric CLO number from various formats
 * "CLO-4" → 4, "4" → 4, 4 → 4
 */
function extractCLONumber(cloValue) {
  if (!cloValue) return null;
  
  // If it's already a number
  if (typeof cloValue === 'number') return cloValue;
  
  // If it's a string, extract the numeric part
  if (typeof cloValue === 'string') {
    // Try to extract number from "CLO-4" or "CLO4" format
    const match = cloValue.match(/\d+/);
    if (match) return parseInt(match[0], 10);
  }
  
  return null;
}

/**
 * Sync CLO performance data from a single submission
 * Extracts latest marks and feedback from Submission collection
 * 
 * @param {String} submissionId - MongoDB ObjectId of submission
 * @returns {Promise<Array>} Array of updated CLO performance records
 */
async function updateCLOPerformanceForSubmission(submissionId) {
  try {
    // Fetch submission with all related data
    const submission = await Submission.findById(submissionId)
      .populate({
        path: "assessmentId",
        populate: {
          path: "cloIds",
          model: "CLO"
        }
      })
      .populate("courseId");

    if (!submission) {
      console.warn(`Submission ${submissionId} not found`);
      return [];
    }

    // Only process graded submissions
    if (submission.status !== "graded") {
      console.log(`Submission ${submissionId} not graded yet, skipping CLO performance update`);
      return [];
    }

    const assessment = submission.assessmentId;
    const cloIds = assessment.cloIds || [];

    if (cloIds.length === 0) {
      console.log(`Assessment ${assessment._id} has no CLOs, skipping`);
      return [];
    }

    // Fetch all questions for this assessment to map CLOs
    const questions = await Question.find({ _id: { $in: assessment.questions || [] } });

    // Group questions by CLO
    const cloToQuestions = {};
    questions.forEach(q => {
      const cloId = q.cloId?.toString();
      if (cloId) {
        if (!cloToQuestions[cloId]) cloToQuestions[cloId] = [];
        cloToQuestions[cloId].push(q);
      }
    });

    // Also include CLOs that don't have explicit questions (in case all questions under CLO)
    cloIds.forEach(clo => {
      const cloId = clo._id.toString();
      if (!cloToQuestions[cloId]) {
        cloToQuestions[cloId] = [];
      }
    });

    // Fetch SubmissionRaw for detailed feedback
    const submissionRaw = await SubmissionRaw.findOne({ submissionId }).lean();

    // Calculate performance for each CLO
    const updatedRecords = [];

    for (const clo of cloIds) {
      const cloId = clo._id.toString();
      
      // Get marks for this CLO from submission
      let cloMarksObtained = 0;
      let cloMarksAvailable = 0;

      const cloQuestions = cloToQuestions[cloId] || [];

      // If we have question-level data
      if (submissionRaw?.perQuestionScores && Array.isArray(submissionRaw.perQuestionScores)) {
        for (const questionScore of submissionRaw.perQuestionScores) {
          // Check if this question belongs to this CLO
          const questionId = questionScore.questionId?.toString();
          if (cloQuestions.some(q => q._id.toString() === questionId)) {
            cloMarksObtained += questionScore.awardedMarks || 0;
            cloMarksAvailable += questionScore.maxMarks || 0;
          }
        }
      }

      // Fallback: distribute total grade equally among CLOs if no per-question data
      if (cloMarksAvailable === 0 && cloIds.length > 0) {
        const marksPerCLO = (submission.maxGrade || 0) / cloIds.length;
        const obtainedPerCLO = (submission.grade || submission.aiGradingSuggestion || 0) / cloIds.length;
        cloMarksAvailable = marksPerCLO;
        cloMarksObtained = obtainedPerCLO;
      }

      // Calculate percentage
      const percentage = cloMarksAvailable > 0 
        ? Math.round((cloMarksObtained / cloMarksAvailable) * 100) 
        : 0;

      // Find or create CLO performance record
      const query = {
        studentId: submission.studentId,
        courseId: submission.courseId,
        cloId: clo._id,
        assessmentType: assessment.type
      };

      // Build submission detail object with latest data from Submission collection
      const submissionDetail = {
        submissionId: submission._id,
        assessmentId: assessment._id,
        assessmentTitle: assessment.title,
        submissionRawId: submissionRaw?._id,
        marksObtained: cloMarksObtained,
        marksAvailable: cloMarksAvailable,
        feedback: submission.feedback || "",
        submittedAt: submission.submittedAt,
        gradedAt: submission.gradedAt,
        status: submission.status,
        lastSyncedAt: new Date()
      };

      const update = {
        $set: {
          courseCode: submission.courseCode,
          courseName: submission.courseName,
          cloNumber: extractCLONumber(clo.cloNumber),
          cloDescription: clo.description,
          teacherId: submission.teacherId,
          lastUpdated: new Date(),
          isSynced: true,
          lastSyncedAt: new Date()
        }
      };

      // Check if submission already exists in the array
      const existingIndex = await StudentCLOPerformance.findOne(query).lean();
      
      if (existingIndex && existingIndex.submissions) {
        // Check if this submission is already in the array
        const subIndex = existingIndex.submissions.findIndex(
          s => s.submissionId?.toString() === submission._id.toString()
        );
        
        if (subIndex >= 0) {
          // Update existing submission in array
          update.$set[`submissions.${subIndex}`] = submissionDetail;
        } else {
          // Add new submission to array
          update.$push = update.$push || {};
          update.$push.submissions = submissionDetail;
        }
      } else {
        // Create new record with submission
        update.$set.submissions = [submissionDetail];
      }

      const record = await StudentCLOPerformance.findOneAndUpdate(
        query,
        update,
        { upsert: true, new: true }
      );

      // Recalculate overall metrics based on all submissions in the record
      if (record.submissions && record.submissions.length > 0) {
        let totalObtained = 0;
        let totalAvailable = 0;
        const allFeedback = [];

        record.submissions.forEach(sub => {
          totalObtained += sub.marksObtained || 0;
          totalAvailable += sub.marksAvailable || 0;
          if (sub.feedback) {
            allFeedback.push(sub.feedback);
          }
        });

        const overallPercentage = totalAvailable > 0 
          ? Math.round((totalObtained / totalAvailable) * 100) 
          : 0;

        await StudentCLOPerformance.updateOne(
          { _id: record._id },
          { 
            $set: { 
              percentage: overallPercentage,
              totalMarksObtained: totalObtained,
              totalMarksAvailable: totalAvailable,
              submissionCount: record.submissions.length,
              allFeedback: allFeedback
            } 
          }
        );
      }

      updatedRecords.push({
        studentId: submission.studentId,
        cloNumber: clo.cloNumber,
        assessmentType: assessment.type,
        percentage: percentage,
        recordId: record._id
      });
    }

    console.log(`Updated CLO performance for submission ${submissionId}: ${updatedRecords.length} CLOs`);
    return updatedRecords;

  } catch (error) {
    console.error(`Error updating CLO performance for submission ${submissionId}:`, error);
    throw error;
  }
}

/**
 * Bulk recalculate CLO performance for a student in a course
 * 
 * This is useful for correcting data or generating initial performance records
 * Fetches all graded submissions and rebuilds CLO performance from scratch
 * 
 * @param {String} studentId - Student Firebase UID
 * @param {String} courseId - Course MongoDB ObjectId
 * @returns {Promise<Object>} Summary of updated records
 */
async function recalculateCLOPerformanceForStudentCourse(studentId, courseId) {
  try {
    // Get all graded submissions for this student-course
    const submissions = await Submission.find({
      studentId,
      courseId,
      status: "graded"
    });

    console.log(`Recalculating CLO performance for student ${studentId} in course ${courseId}: ${submissions.length} submissions`);

    const results = [];
    for (const submission of submissions) {
      const updated = await updateCLOPerformanceForSubmission(submission._id.toString());
      results.push(...updated);
    }

    return {
      success: true,
      submissionsProcessed: submissions.length,
      recordsUpdated: results.length,
      details: results
    };

  } catch (error) {
    console.error(`Error recalculating CLO performance:`, error);
    throw error;
  }
}

/**
 * Bulk fetch and populate CLO performance for entire course
 * Extracts data from all submitted assessments across all students
 * 
 * @param {String} courseId - Course MongoDB ObjectId
 * @returns {Promise<Object>} Summary of populated records
 */
async function populateCLOPerformanceForCourse(courseId) {
  try {
    console.log(`Populating CLO performance for entire course ${courseId}`);

    // Get all graded submissions in this course
    const allSubmissions = await Submission.find({
      courseId,
      status: "graded"
    }).lean();

    console.log(`Found ${allSubmissions.length} graded submissions for course ${courseId}`);

    let populatedCount = 0;
    const errors = [];
    const results = [];

    for (const submission of allSubmissions) {
      try {
        const updated = await updateCLOPerformanceForSubmission(submission._id.toString());
        results.push(...updated);
        populatedCount++;
      } catch (error) {
        errors.push({
          submissionId: submission._id,
          error: error.message
        });
        console.error(`Error processing submission ${submission._id}:`, error.message);
      }
    }

    return {
      success: true,
      message: `Populated CLO performance for course ${courseId}`,
      totalSubmissionsProcessed: allSubmissions.length,
      successfullyPopulated: populatedCount,
      errors: errors,
      totalCLORecordsUpdated: results.length
    };

  } catch (error) {
    console.error(`Error populating CLO performance for course:`, error);
    throw error;
  }
}

/**
 * Get CLO performance summary for a student in a course
 * 
 * @param {String} studentId - Student Firebase UID
 * @param {String} courseId - Course MongoDB ObjectId
 * @returns {Promise<Array>} CLO performance records
 */
async function getStudentCLOPerformance(studentId, courseId) {
  try {
    const performance = await StudentCLOPerformance.find({
      studentId,
      courseId
    })
      .populate("cloId")
      .sort({ cloNumber: 1, assessmentType: 1 })
      .lean();

    return performance;

  } catch (error) {
    console.error(`Error fetching CLO performance:`, error);
    throw error;
  }
}

/**
 * Get CLO performance for a specific assessment type
 * 
 * @param {String} studentId - Student Firebase UID
 * @param {String} courseId - Course MongoDB ObjectId
 * @param {String} assessmentType - 'quiz' or 'assignment'
 * @returns {Promise<Array>} CLO performance records for assessment type
 */
async function getStudentCLOPerformanceByType(studentId, courseId, assessmentType) {
  try {
    const performance = await StudentCLOPerformance.find({
      studentId,
      courseId,
      assessmentType
    })
      .populate("cloId")
      .sort({ cloNumber: 1 })
      .lean();

    return performance;

  } catch (error) {
    console.error(`Error fetching CLO performance by type:`, error);
    throw error;
  }
}

/**
 * Get CLO performance analytics for a course (all students)
 * 
 * @param {String} courseId - Course MongoDB ObjectId
 * @param {String} assessmentType - Optional: filter by 'quiz' or 'assignment'
 * @returns {Promise<Array>} Aggregated performance data
 */
async function getCourseClOPerformanceAnalytics(courseId, assessmentType = null) {
  try {
    const courseObjectId = mongoose.Types.ObjectId.isValid(courseId) 
      ? new mongoose.Types.ObjectId(courseId) 
      : courseId;

    const pipeline = [
      {
        $match: {
          courseId: courseObjectId,
          ...(assessmentType && { assessmentType })
        }
      },
      {
        $group: {
          _id: {
            cloId: "$cloId",
            cloNumber: "$cloNumber",
            assessmentType: "$assessmentType"
          },
          avgPercentage: { $avg: "$percentage" },
          studentCount: { $sum: 1 },
          totalMarksObtained: { $sum: "$totalMarksObtained" },
          totalMarksAvailable: { $sum: "$totalMarksAvailable" }
        }
      },
      { $sort: { "_id.cloNumber": 1, "_id.assessmentType": 1 } }
    ];

    const analytics = await StudentCLOPerformance.aggregate(pipeline);
    return analytics;

  } catch (error) {
    console.error(`Error fetching course CLO performance analytics:`, error);
    throw error;
  }
}

module.exports = {
  updateCLOPerformanceForSubmission,
  recalculateCLOPerformanceForStudentCourse,
  populateCLOPerformanceForCourse,
  getStudentCLOPerformance,
  getStudentCLOPerformanceByType,
  getCourseClOPerformanceAnalytics
};
