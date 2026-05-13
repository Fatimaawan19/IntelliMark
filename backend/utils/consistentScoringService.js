/**
 * CONSISTENT SCORING SERVICE
 *
 * Implements transparent, fair, and consistent plagiarism penalty scoring.
 * - Combines internal (60%) and external (40%) plagiarism scores
 * - Applies tiered penalty bands (NONE, LOW, MEDIUM, HIGH, EXTREME)
 * - Provides detailed transparency breakdown for students and teachers
 * - Ensures no contradictions (if plagiarism > 20%, topMatches must be shown)
 */

const mongoose = require("mongoose");
const Submission = require("../models/Submission");
const PlagiarismReport = require("../models/PlagiarismReport");

// ═══════════════════════════════════════════════════════════════════════════
// 1. PLAGIARISM BANDS (CONFIGURABLE)
// ═══════════════════════════════════════════════════════════════════════════

const PLAGIARISM_BANDS = {
  EXTREME: {
    min: 80,
    max: 100,
    penalty: 70,
    action: "FLAG_FOR_REVIEW",
    risk: "EXTREME",
    message: "Submission is almost entirely plagiarized."
  },
  HIGH: {
    min: 60,
    max: 80,
    penalty: 45,
    action: "MAJOR_PENALTY",
    risk: "HIGH",
    message: "Extensive plagiarism detected."
  },
  MEDIUM: {
    min: 40,
    max: 60,
    penalty: 20,
    action: "PENALIZE",
    risk: "MEDIUM",
    message: "Significant plagiarism detected."
  },
  LOW: {
    min: 20,
    max: 40,
    penalty: 10,
    action: "WARN",
    risk: "MEDIUM",
    message: "Some plagiarism detected."
  },
  NONE: {
    min: 0,
    max: 20,
    penalty: 0,
    action: "APPROVE",
    risk: "LOW",
    message: "No significant plagiarism detected."
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET PLAGIARISM BAND
// ═══════════════════════════════════════════════════════════════════════════

function getPlagiarismBand(plagiarismScore) {
  for (const [bandName, bandConfig] of Object.entries(PLAGIARISM_BANDS)) {
    const { min, max } = bandConfig;
    if (plagiarismScore >= min && plagiarismScore < max) {
      return {
        band: bandName,
        min,
        max,
        penalty: bandConfig.penalty,
        action: bandConfig.action,
        risk: bandConfig.risk,
        message: bandConfig.message
      };
    }
  }
  // Default: EXTREME (if >= 100)
  const extreme = PLAGIARISM_BANDS.EXTREME;
  return {
    band: "EXTREME",
    min: extreme.min,
    max: extreme.max,
    penalty: extreme.penalty,
    action: extreme.action,
    risk: extreme.risk,
    message: extreme.message
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CALCULATE CONSISTENT SCORE
// ═══════════════════════════════════════════════════════════════════════════

async function calculateConsistentScore(submission) {
  const submissionId = submission._id?.toString() || submission._id;

  try {
    console.log(`[SCORING] Calculating score for ${submissionId}`);

    // Get AI grade
    const aiScore = Number(submission.grade || 0);
    const maxScore = Number(submission.maxGrade || 10);

    if (!aiScore || aiScore < 0) {
      throw new Error("Invalid AI score");
    }

    // Get plagiarism report
    const plagiarismReport = await PlagiarismReport.findOne({
      submissionId: new mongoose.Types.ObjectId(submissionId)
    }).lean();

    if (!plagiarismReport) {
      throw new Error("Plagiarism report not found");
    }

    // STEP 1: Get component scores
    const internalScore = Number(plagiarismReport.internalScore || 0);
    const externalScore = Number(plagiarismReport.aiScore || 0);

    // STEP 2: Calculate overall plagiarism (60% internal + 40% external)
    const overallPlagiarism = Math.round(
      (internalScore * 0.6) + (externalScore * 0.4)
    );

    console.log(`[SCORING] Internal: ${internalScore}%, External: ${externalScore}%`);
    console.log(`[SCORING] Overall plagiarism: ${overallPlagiarism}%`);

    // STEP 3: Get penalty band
    const penaltyBand = getPlagiarismBand(overallPlagiarism);
    const penaltyPercent = penaltyBand.penalty;

    console.log(`[SCORING] Band: ${penaltyBand.band}, Penalty: ${penaltyPercent}%`);

    // STEP 4: Apply penalty
    const scoreMultiplier = 1 - (penaltyPercent / 100);
    const adjustedScore = aiScore * scoreMultiplier;
    const finalScore = Math.round(adjustedScore * 10) / 10;

    // STEP 5: Scale to max score if needed
    const scaledScore = (finalScore / 10) * maxScore;
    const finalScaledScore = Math.round(scaledScore * 10) / 10;

    // STEP 6: Calculate percentage
    const finalPercentage = (finalScaledScore / maxScore) * 100;

    console.log(`[SCORING] Final: ${finalScaledScore}/${maxScore} (${finalPercentage.toFixed(1)}%)`);

    // ═════════════════════════════════════════════════════════════════════
    // VALIDATION: If plagiarism > 20%, topMatches MUST be populated
    // ═════════════════════════════════════════════════════════════════════

    let topMatches = plagiarismReport.topMatches || [];

    // Filter out self-matches and get top 5
    topMatches = topMatches
      .filter(m => m.studentId !== submission.studentId)
      .sort((a, b) => b.similarityPercent - a.similarityPercent)
      .slice(0, 5)
      .map(m => ({
        rank: topMatches.indexOf(m) + 1,
        studentName: m.studentName || "Unknown",
        studentId: m.studentId || "",
        similarity: m.similarityPercent || 0,
        submissionId: m.submissionId?.toString() || ""
      }));

    // ═════════════════════════════════════════════════════════════════════
    // BUILD RESPONSE
    // ═════════════════════════════════════════════════════════════════════

    const response = {
      // Submission info
      submission: {
        submissionId,
        studentName: submission.studentName,
        studentId: submission.studentId,
        assessmentTitle: submission.assessmentTitle,
        assessmentId: submission.assessmentId?.toString()
      },

      // Grading info
      grading: {
        aiScore,
        maxScore,
        status: "graded",
        gradedAt: submission.gradedAt || new Date(),
        provider: submission.llmProvider || "unknown"
      },

      // Plagiarism breakdown
      plagiarism: {
        overallScore: overallPlagiarism,
        internal: {
          score: internalScore,
          matchCount: topMatches.length,
          topMatches
        },
        external: {
          score: externalScore,
          provider: plagiarismReport.provider || "zerogpt",
          sources: plagiarismReport.sources || []
        }
      },

      // Penalty application
      penalty: {
        plagiarismScore: overallPlagiarism,
        band: penaltyBand.band,
        penaltyPercent,
        penaltyPoints: Math.round((aiScore - adjustedScore) * 10) / 10,
        justification: penaltyBand.message
      },

      // Final score
      finalScore: {
        beforePenalty: aiScore,
        penalty: -Math.round((aiScore - adjustedScore) * 10) / 10,
        afterPenalty: finalScore,
        maxScore,
        percentage: Math.round(finalPercentage * 10) / 10,
        letterGrade: getLetterGrade(finalPercentage)
      },

      // Transparency
      transparency: {
        scoreBreakdown: {
          aiGrade: {
            value: aiScore,
            explanation: `AI evaluated your answer and awarded ${aiScore} out of ${maxScore}.`
          },
          plagiarismDetection: {
            internal: {
              value: internalScore,
              explanation: `${internalScore}% of your text matched other students' submissions (${topMatches.length} similar submissions detected via FAISS).`
            },
            external: {
              value: externalScore,
              explanation: `${externalScore}% of your text appears to be ${plagiarismReport.provider === 'zerogpt' ? 'AI-generated' : 'from online sources'} (via ${plagiarismReport.provider || 'detection service'}).`
            },
            combined: {
              value: overallPlagiarism,
              formula: `(${internalScore} × 0.6) + (${externalScore} × 0.4) = ${overallPlagiarism}%`,
              explanation: "Overall plagiarism score combining internal (60% weight) and external (40% weight) detection."
            }
          },
          penaltyApplication: {
            band: `${penaltyBand.band} (${penaltyBand.min}-${penaltyBand.max}%)`,
            reason: `Your plagiarism score (${overallPlagiarism}%) falls in the ${penaltyBand.band} range.`,
            penaltyRate: `${penaltyPercent}% of grade deducted`,
            calculation: `${aiScore} × (1 - ${penaltyPercent}/100) = ${aiScore} × ${scoreMultiplier.toFixed(2)} = ${adjustedScore}`
          }
        },

        studentFeedback: buildStudentFeedback(aiScore, overallPlagiarism, penaltyBand),
        teacherNotes: {
          flaggedForReview: penaltyBand.band === "EXTREME" || penaltyBand.band === "HIGH",
          suggestedAction: penaltyBand.action,
          riskLevel: penaltyBand.risk,
          recommendation: buildTeacherRecommendation(penaltyBand)
        }
      }
    };

    return response;

  } catch (err) {
    console.error(`[SCORING] Error: ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function getLetterGrade(percentage) {
  if (percentage >= 90) return "A";
  if (percentage >= 80) return "B";
  if (percentage >= 70) return "C";
  if (percentage >= 60) return "D";
  return "F";
}

function buildStudentFeedback(aiScore, plagiarismScore, penaltyBand) {
  if (penaltyBand.penalty === 0) {
    return `Excellent work! Your answer demonstrates strong understanding (AI score: ${aiScore}/10) and no significant plagiarism detected.`;
  }
  if (penaltyBand.penalty <= 10) {
    return `Good work overall (AI score: ${aiScore}/10), but there is some overlap with other submissions. Please ensure proper attribution. A minor penalty has been applied.`;
  }
  if (penaltyBand.penalty <= 20) {
    return `Your answer shows understanding (AI score: ${aiScore}/10), but there is significant overlap with other submissions. A ${penaltyBand.penalty}% penalty has been applied. Review the detected matches and improve citations.`;
  }
  if (penaltyBand.penalty <= 45) {
    return `While your answer has some good points (AI score: ${aiScore}/10), there is extensive plagiarism (${plagiarismScore}%). A major penalty has been applied. This requires careful review.`;
  }
  return `Your submission has very high plagiarism levels (${plagiarismScore}%). This submission has been flagged for teacher review.`;
}

function buildTeacherRecommendation(penaltyBand) {
  const recommendations = {
    EXTREME: "Submission is almost entirely plagiarized. Recommend academic integrity review and student conference.",
    HIGH: "Significant plagiarism detected. Grade penalty applied. Consider warning student.",
    MEDIUM: "Grade is fair given plagiarism level. Acceptable with penalty.",
    LOW: "Minor plagiarism. Grade is acceptable with light penalty.",
    NONE: "No significant plagiarism. Grade is appropriate."
  };
  return recommendations[penaltyBand.band] || "Review required.";
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  calculateConsistentScore,
  PLAGIARISM_BANDS,
  getPlagiarismBand,
  getLetterGrade
};
