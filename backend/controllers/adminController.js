const Submission = require("../models/Submission");

function toInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function dayKeyLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dayLabelLocal(d) {
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

exports.getAcademicPerformance = async (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, toInt(req.query.days, 7)));
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);

    const pendingStatuses = ["submitted", "pending_review", "late"];

    // Summary counts
    const [gradedCount, pendingSubmissionsCount, pendingAssessmentIds] = await Promise.all([
      Submission.countDocuments({ status: "graded", grade: { $ne: null }, maxGrade: { $gt: 0 } }),
      Submission.countDocuments({ status: { $in: pendingStatuses } }),
      Submission.distinct("assessmentId", { status: { $in: pendingStatuses } }),
    ]);

    // Overall avg percent across ALL graded submissions (not limited to N days)
    const overallAvgAgg = await Submission.aggregate([
      { $match: { status: "graded", grade: { $ne: null }, maxGrade: { $gt: 0 } } },
      {
        $project: {
          percent: {
            $multiply: [{ $divide: ["$grade", "$maxGrade"] }, 100],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgPercent: { $avg: "$percent" },
        },
      },
    ]);
    const overallAvgPercent = Math.round(Number(overallAvgAgg?.[0]?.avgPercent || 0));

    // Time series (last N days) using gradedAt (fallback to submittedAt)
    const seriesAgg = await Submission.aggregate([
      {
        $match: {
          status: "graded",
          grade: { $ne: null },
          maxGrade: { $gt: 0 },
          $expr: {
            $gte: [{ $ifNull: ["$gradedAt", "$submittedAt"] }, start],
          },
        },
      },
      {
        $project: {
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $ifNull: ["$gradedAt", "$submittedAt"] },
            },
          },
          percent: { $multiply: [{ $divide: ["$grade", "$maxGrade"] }, 100] },
        },
      },
      {
        $group: {
          _id: "$day",
          avgPercent: { $avg: "$percent" },
          gradedCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const byDay = new Map();
    for (const row of seriesAgg) {
      byDay.set(String(row._id), {
        avgPercent: Math.round(Number(row.avgPercent || 0)),
        gradedCount: Number(row.gradedCount || 0),
      });
    }

    const series = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = dayKeyLocal(d);
      const row = byDay.get(key) || { avgPercent: 0, gradedCount: 0 };
      series.push({
        day: dayLabelLocal(d),
        avgPercent: row.avgPercent,
        gradedCount: row.gradedCount,
      });
    }

    const gradedCountNd = series.reduce((acc, p) => acc + (p.gradedCount || 0), 0);
    const avgPercentNd = gradedCountNd
      ? Math.round(series.reduce((acc, p) => acc + p.avgPercent * p.gradedCount, 0) / gradedCountNd)
      : 0;

    res.json({
      success: true,
      days,
      series,
      summary: {
        overallAvgPercent,
        gradedCount,
        gradedCountNd,
        avgPercentNd,
        pendingSubmissionsCount,
        pendingAssessmentsCount: Array.isArray(pendingAssessmentIds) ? pendingAssessmentIds.length : 0,
      },
    });
  } catch (error) {
    console.error("❌ getAcademicPerformance error:", error);
    res.status(500).json({ success: false, error: "Failed to compute academic performance" });
  }
};

