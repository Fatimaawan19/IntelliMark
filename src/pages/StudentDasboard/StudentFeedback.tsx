import { useState, useEffect, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip as UITooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ChevronLeft, Brain, Target, TrendingUp, AlertCircle, CheckCircle,
  BookOpen, FileText, Clock, Award, RefreshCw, ChevronRight,
  Star, BarChart3, Zap, ThumbsUp, AlertTriangle, ClipboardList, Filter,
  Sparkles, ShieldAlert, ArrowUpCircle, Lightbulb,
  PlayCircle, PenLine, Dumbbell, ListChecks,
  Youtube, ExternalLink, Search, GraduationCap, MessageCircle
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../../firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, collection, getDocs, query, where, documentId } from "firebase/firestore";
import axios from "axios";
import { buildYouTubeQuery } from "../../utils/learningTopicHandler";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Cell, LabelList,
  AreaChart, Area, ReferenceLine,
  PieChart, Pie, Legend,
} from "recharts";

const API = "http://localhost:5000/api";

const pct = (grade: number, max: number) => max > 0 ? Math.round((grade / max) * 100) : 0;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const getLectureFriendlyName = (fileName: string, courseCode?: string): string => {
  const name = fileName.toLowerCase();
  const code = courseCode?.toUpperCase() || "";

  if (code.includes("CSC410") || code.includes("PP")) {
    if (name.includes("chapter 1")) return "Chapter 1: Introduction to Ethics & Morality";
    if (name.includes("chapter 2")) return "Chapter 2: Ethical Theories (Relativism, Utilitarianism)";
    if (name.includes("chapter 3")) return "Chapter 3: Social Implications of Computing & Net Communications";
    if (name.includes("chapter 4")) return "Chapter 4: Intellectual Property & Open Source Software";
    if (name.includes("chapter 5")) return "Chapter 5: Information Privacy & Disclosures";
    if (name.includes("chapter 6")) return "Chapter 6: Privacy & the Government";
    if (name.includes("chapter 7")) return "Chapter 7: Computer Security & Hacking";
    if (name.includes("chapter 8")) return "Chapter 8: Computer Reliability & Software Failures";
    if (name.includes("chapter 9")) return "Chapter 9: Professional Ethics & Codes";
  }
  
  if (name.includes("lecture 1")) return "Lecture 1: Introduction";
  if (name.includes("lecture 2")) return "Lecture 2";
  if (name.includes("lecture 3")) return "Lecture 3";
  if (name.includes("lecture 4")) return "Lecture 4";
  
  return fileName;
};

const COURSE_COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#ea580c",
  "#16a34a", "#0891b2", "#4f46e5", "#0f766e",
];

// Each chart gets its own distinct palette
const CLO_DONUT_COLORS = ["#22c55e", "#f97316", "#3b82f6", "#7c3aed", "#eab308", "#ef4444", "#06b6d4", "#ec4899"];
const TOPIC_BAR_COLORS  = ["#06b6d4", "#0ea5e9", "#10b981", "#6366f1", "#f43f5e", "#f59e0b", "#8b5cf6", "#14b8a6"];

const colorForCourse = (code: string) => {
  const s = String(code || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COURSE_COLORS[h % COURSE_COLORS.length];
};

const gradeColor = (p: number) => {
  if (p >= 80) return "text-emerald-400";
  if (p >= 60) return "text-yellow-400";
  return "text-red-400";
};

const gradeBg = (p: number) => {
  if (p >= 80) return "bg-emerald-500/20 border-emerald-500/40 text-emerald-300";
  if (p >= 60) return "bg-yellow-500/20 border-yellow-500/40 text-yellow-300";
  return "bg-red-500/20 border-red-500/40 text-red-300";
};

const fmtDate = (d: string | Date) => {
  try { return new Date(d).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return ""; }
};

const Sparkline = ({ values }: { values: number[] }) => {
  const w = 140, h = 34, pad = 3;
  const pts = (values || []).slice(-8).map(v => clamp(Number(v) || 0, 0, 100));
  if (!pts.length) return <div className="h-[34px]" />;
  const min = Math.min(...pts), max = Math.max(...pts);
  const xStep = pts.length > 1 ? (w - pad * 2) / (pts.length - 1) : 0;
  const y = (v: number) => max === min ? h / 2 : pad + ((100 - ((v - min) / (max - min)) * 100) / 100) * (h - pad * 2);
  const d = pts.length === 1
    ? `M ${pad} ${y(pts[0])} L ${w - pad} ${y(pts[0])}`
    : pts.map((v, i) => `${i === 0 ? "M" : "L"} ${pad + i * xStep} ${y(v)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-sky-500">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx={pts.length === 1 ? (w - pad) : (pad + (pts.length - 1) * xStep)} cy={y(pts[pts.length - 1])} r="2.6" fill="currentColor" />
    </svg>
  );
};

const sanitizeToSecondPerson = (text: string): string => {
  if (!text) return "";
  let clean = text;
  
  // Handlers for verb transitions:
  clean = clean.replace(/\b[Tt]he student struggled\b/g, "You struggled");
  clean = clean.replace(/\b[Ss]tudent struggled\b/g, "You struggled");

  // Verb agreement mappings:
  const mappings = [
    { from: /\b[Tt]he student struggles\b/g, to: "you struggle" },
    { from: /\b[Ss]tudent struggles\b/g, to: "you struggle" },
    { from: /\b[Tt]he student has\b/g, to: "you have" },
    { from: /\b[Ss]tudent has\b/g, to: "you have" },
    { from: /\b[Tt]he student is\b/g, to: "you are" },
    { from: /\b[Ss]tudent is\b/g, to: "you are" },
    { from: /\b[Tt]he student needs\b/g, to: "you need" },
    { from: /\b[Ss]tudent needs\b/g, to: "you need" },
    { from: /\b[Tt]he student wants\b/g, to: "you want" },
    { from: /\b[Ss]tudent wants\b/g, to: "you want" },
    { from: /\b[Tt]he student fails\b/g, to: "you fail" },
    { from: /\b[Ss]tudent fails\b/g, to: "you fail" },
    { from: /\b[Tt]he student performs\b/g, to: "you perform" },
    { from: /\b[Ss]tudent performs\b/g, to: "you perform" },
    { from: /\b[Tt]he student provides\b/g, to: "you provide" },
    { from: /\b[Ss]tudent provides\b/g, to: "you provide" },
    { from: /\b[Tt]he student shows\b/g, to: "you show" },
    { from: /\b[Ss]tudent shows\b/g, to: "you show" },
    { from: /\b[Tt]he student's\b/g, to: "your" },
    { from: /\b[Ss]tudent's\b/g, to: "your" },
    { from: /\b[Tt]he student\b/g, to: "you" },
    { from: /\b[Ss]tudent\b/g, to: "you" }
  ];

  for (const m of mappings) {
    clean = clean.replace(m.from, m.to);
  }
  
  return clean;
};

// ── component ──────────────────────────────────────────────────────────────────
const StudentFeedback = () => {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [courses, setCourses] = useState<any[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>("all");
  const [currentUser, setCurrentUser] = useState<any>(null);

  // Analytics chart state
  const [trendType, setTrendType] = useState<"all" | "quiz" | "assignment">("all");
  const [cloType, setCloType] = useState<"all" | "quiz" | "assignment">("all");
  const [cloPerf, setCloPerf] = useState<any[]>([]);
  const [cloLoading, setCloLoading] = useState(false);

  // AI Learning Insights state
  const [aiInsights, setAiInsights] = useState<any>(null);
  const [aiInsightsLoading, setAiInsightsLoading] = useState(false);
  const insightsFetchedRef = useRef<string | null>(null);

  // Step 2 — Smart Risk Detection state
  const [riskData, setRiskData] = useState<any>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const riskFetchedRef = useRef<string | null>(null);
  const [activeRiskMetric, setActiveRiskMetric] = useState<string>("nextScore");

  // Step 3 — Personalized Study Recommendations (data-driven from real weak CLOs)
  const [weakCLOsResources, setWeakCLOsResources] = useState<any[]>([]);
  const [weakCLOsLoading, setWeakCLOsLoading] = useState(false);
  const weakCLOsFetchedRef = useRef<string | null>(null);
  const [activeWeakTab, setActiveWeakTab] = useState(0);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [allCloPerf, setAllCloPerf] = useState<Record<string, any[]>>({});
  const [feedbackTooltipId, setFeedbackTooltipId] = useState<string | null>(null);
  const [plagiarismReports, setPlagiarismReports] = useState<Record<string, any>>({});

  const fetchAll = async (uid: string, regCourseIds: string[]) => {
    setLoading(true); setError("");
    try {
      const { data } = await axios.get(`${API}/submissions/student/${encodeURIComponent(uid)}`);
      setSubmissions(Array.isArray(data?.submissions) ? data.submissions : []);
      if (regCourseIds.length > 0) {
        const snap = await getDocs(query(collection(db, "courses"), where(documentId(), "in", regCourseIds.slice(0, 30))));
        setCourses(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || "Failed to load feedback");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return navigate("/");
      setCurrentUser(user);
      const snap = await getDoc(doc(db, "users", user.uid));
      const d = snap.exists() ? snap.data() : {};
      await fetchAll(user.uid, d.registeredCourses || []);
    });
    return () => unsub();
  }, []);

  // Map courseCode → MongoDB courseId (needed for CLO API)
  const courseMap = useMemo(() => {
    const map: Record<string, { courseId: string; courseName: string }> = {};
    submissions.forEach(s => {
      if (s.courseCode) {
        const cid = typeof s.courseId === "string" ? s.courseId
          : s.courseId?._id?.toString?.() ?? String(s.courseId ?? "");
        if (cid) map[s.courseCode] = { courseId: cid, courseName: s.courseName || s.courseCode };
      }
    });
    courses.forEach(c => {
      const code = c.code || c.courseCode || "";
      const cid = typeof c.id === "string" ? c.id : String(c.id ?? "");
      if (code && cid && !map[code]) {
        map[code] = { courseId: cid, courseName: c.courseName || c.label || code };
      }
    });
    return map;
  }, [submissions, courses]);

  const graded  = useMemo(() => submissions.filter(s => s.status === "graded"), [submissions]);
  const pending = useMemo(() => submissions.filter(s => s.status !== "graded"), [submissions]);

  const avgGrade = useMemo(() => {
    if (!graded.length) return 0;
    return Math.round(graded.reduce((a, s) => {
      const m = Number(s.maxGrade ?? 0);
      return a + (m > 0 ? (Number(s.grade ?? 0) / m) * 100 : 0);
    }, 0) / graded.length);
  }, [graded]);

  const improvementDelta = useMemo(() => {
    const sorted = [...graded].filter(s => Number(s.maxGrade) > 0)
      .map(s => ({ p: (Number(s.grade) / Number(s.maxGrade)) * 100, t: new Date(s.submittedAt).getTime() }))
      .sort((a, b) => b.t - a.t);
    if (sorted.length < 2) return null;
    return Math.round(sorted[0].p - sorted[1].p);
  }, [graded]);

  const topMistakes = useMemo(() => {
    const freq: Record<string, number> = {};
    graded.forEach(s => {
      const raw: any[] = Array.isArray(s.mistakes) ? s.mistakes : [];
      raw.map(m => typeof m === "string" ? m : m?.topic || m?.description || "")
        .filter(Boolean)
        .forEach(m => { freq[m] = (freq[m] || 0) + 1; });
    });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [graded]);

  const courseAvgs = useMemo(() => {
    const map: Record<string, { sum: number; count: number; name: string; points: { p: number; t: number }[] }> = {};
    graded.forEach((s: any) => {
      const code = s.courseCode || "Unknown";
      if (!map[code]) map[code] = { sum: 0, count: 0, name: s.courseName || code, points: [] };
      if (Number(s.maxGrade) > 0) {
        const p = (Number(s.grade) / Number(s.maxGrade)) * 100;
        const t = new Date(s.submittedAt || s.createdAt || Date.now()).getTime();
        map[code].sum += p;
        map[code].count += 1;
        map[code].points.push({ p, t });
      }
    });
    return Object.entries(map).map(([code, v]) => {
      const sorted = [...v.points].sort((a, b) => a.t - b.t);
      const series = sorted.map(x => Math.round(x.p));
      const avg = v.count > 0 ? Math.round(v.sum / v.count) : 0;
      const last = series.length ? series[series.length - 1] : null;
      const prev = series.length > 1 ? series[series.length - 2] : null;
      const delta = last != null && prev != null ? last - prev : null;
      return { code, name: v.name, avg, count: v.count, last, delta, series };
    }).sort((a, b) => b.avg - a.avg);
  }, [graded]);

  const bestCourse = courseAvgs[0] ?? null;

  const filteredGraded  = useMemo(() => selectedCourse === "all" ? graded  : graded.filter(s => s.courseCode === selectedCourse), [graded, selectedCourse]);
  const filteredPending = useMemo(() => selectedCourse === "all" ? pending : pending.filter(s => s.courseCode === selectedCourse), [pending, selectedCourse]);
  const subCourseCodes  = useMemo(() => Array.from(new Set(submissions.map(s => s.courseCode).filter(Boolean))), [submissions]);

  // When header is "all", default CLO charts to the first enrolled course
  // Must be declared AFTER subCourseCodes (uses it in deps + body)
  const activeCloCode = useMemo(
    () => selectedCourse !== "all" ? selectedCourse : (subCourseCodes.length ? "all" : null),
    [selectedCourse, subCourseCodes]
  );

  const activeCloCourseId = useMemo(() => {
    if (!activeCloCode || activeCloCode === "all") return null;
    return courseMap[activeCloCode]?.courseId
      || courses.find(c => c.code === activeCloCode || c.courseCode === activeCloCode)?.id
      || (() => {
        // Fallback: find a submission that references this courseCode and use its courseId
        const sub = submissions.find(s => s.courseCode === activeCloCode && s.courseId);
        if (!sub) return null;
        const cid = typeof sub.courseId === 'string' ? sub.courseId : sub.courseId?._id?.toString?.() ?? String(sub.courseId ?? '');
        return cid || null;
      })();
  }, [activeCloCode, courseMap, courses]);

  // Fetch CLO performance when active CLO course or type filter changes.
  // Auto-recalculates from submissions if no records exist yet with exponential backoff.
  useEffect(() => {
    if (!currentUser) { setCloPerf([]); return; }
    if (selectedCourse === "all") {
      setCloLoading(false);
      const allPerf = Object.values(allCloPerf).flat();
      const filtered = cloType === "all" ? allPerf : allPerf.filter((r: any) => r.assessmentType === cloType);
      setCloPerf(filtered);
      return;
    }

    if (!activeCloCourseId) { setCloPerf([]); return; }
    setCloLoading(true);
    (async () => {
      try {
        let url = `${API}/clo-performance/student/${encodeURIComponent(currentUser.uid)}/course/${activeCloCourseId}`;
        if (cloType !== "all") url += `/type/${cloType}`;
        
        const { data } = await axios.get(url);
        let perf = Array.isArray(data?.performance) ? data.performance : [];
        
        // If no data, trigger recalculation with retry logic
        if (perf.length === 0) {
          try {
            console.log("📊 Triggering CLO performance recalculation...");
            await axios.post(`${API}/clo-performance/recalculate/${encodeURIComponent(currentUser.uid)}/course/${activeCloCourseId}`);
            
            // Wait a moment for async processing, then refetch with retry
            let retries = 3;
            let refetched = [];
            while (retries > 0 && refetched.length === 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
              const { data: retryData } = await axios.get(url);
              refetched = Array.isArray(retryData?.performance) ? retryData.performance : [];
              if (refetched.length > 0) break;
              retries--;
            }
            perf = refetched;
          } catch (err) {
            console.warn("⚠️ Auto-recalculation failed:", err);
          }
        }
        
        // Final fallback: compute from CLOs if still empty
        if (perf.length === 0) {
          try {
            const { data: courseData } = await axios.get(`${API}/courses/${activeCloCourseId}/clos`);
            const courseCLOs: any[] = courseData?.clos ?? [];
            if (courseCLOs.length > 0) {
              const courseSubms = submissions.filter((s: any) => {
                const sid = typeof s.courseId === "string" ? s.courseId
                  : s.courseId?._id?.toString?.() ?? String(s.courseId ?? "");
                return sid === activeCloCourseId && s.status === "graded" && Number(s.maxGrade) > 0
                  && (cloType === "all" || s.assessmentType === cloType);
              });
              if (courseSubms.length > 0) {
                const overallAvg = Math.round(
                  courseSubms.reduce((a: number, s: any) =>
                    a + pct(Number(s.grade ?? 0), Number(s.maxGrade ?? 1)), 0)
                  / courseSubms.length
                );
                perf = courseCLOs.map((clo: any) => ({
                  cloId:               clo._id,
                  cloNumber:           clo.cloNumber,
                  cloDescription:      clo.description,
                  percentage:          overallAvg,
                  totalMarksObtained:  overallAvg,
                  totalMarksAvailable: 100,
                  assessmentType:      cloType === "all" ? "quiz" : cloType,
                  submissionCount:     courseSubms.length,
                  courseCode:          activeCloCode,
                }));
              }
            }
          } catch { /* leave empty */ }
        }
        setCloPerf(perf);
      } catch { setCloPerf([]); }
      finally { setCloLoading(false); }
    })();
  }, [activeCloCourseId, cloType, currentUser, submissions, allCloPerf, selectedCourse]);

  const effectiveCloPerf = useMemo(() => {
    if (cloPerf.length) return cloPerf;
    if (selectedCourse === "all") {
      const allPerf = Object.values(allCloPerf).flat();
      return cloType === "all" ? allPerf : allPerf.filter((r: any) => r.assessmentType === cloType);
    }
    if (!activeCloCourseId) return [];
    const fallback = allCloPerf[activeCloCourseId] ?? [];
    return cloType === "all" ? fallback : fallback.filter((r: any) => r.assessmentType === cloType);
  }, [cloPerf, allCloPerf, activeCloCourseId, cloType, selectedCourse]);

  // ── analytics chart data ──────────────────────────────────────────────────────

  // Trend area chart — submissions sorted by date, filtered by course + type
  const trendData = useMemo(() => {
    let filtered = graded.filter(s => Number(s.maxGrade) > 0);
    if (selectedCourse !== "all") filtered = filtered.filter(s => s.courseCode === selectedCourse);
    if (trendType !== "all") filtered = filtered.filter(s => s.assessmentType === trendType);
    const prefix = trendType === "quiz" ? "Quiz" : trendType === "assignment" ? "Assign." : "Item";
    return [...filtered]
      .sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
      .map((s, i) => ({
        name: `${prefix} ${i + 1}`,
        fullTitle: s.assessmentTitle || `${prefix} ${i + 1}`,
        score: pct(Number(s.grade), Number(s.maxGrade)),
      }));
  }, [graded, selectedCourse, trendType]);

  const trendAvg = useMemo(() =>
    trendData.length ? Math.round(trendData.reduce((a, d) => a + d.score, 0) / trendData.length) : 0,
    [trendData]);

  // CLO donut — aggregate by CLO number; carry description for tooltip
  const cloDonutData = useMemo(() => {
    if (!effectiveCloPerf.length) return [];
    const map: Record<string, { total: number; count: number; description: string }> = {};
    effectiveCloPerf.forEach(r => {
      const key = `CLO-${r.cloNumber ?? "?"}`;
      if (!map[key]) map[key] = { total: 0, count: 0, description: r.cloDescription || "" };
      map[key].total += r.percentage ?? 0;
      map[key].count += 1;
      if (r.cloDescription && !map[key].description) map[key].description = r.cloDescription;
    });
    return Object.entries(map).map(([name, v]) => ({
      name,
      value: Math.round(v.total / v.count),
      description: v.description,
    }));
  }, [effectiveCloPerf]);

  // Topic horizontal bar — use CLO descriptions; keep fullName for tooltip
  const topicData = useMemo(() => {
    if (!effectiveCloPerf.length) return [];
    const map: Record<string, { total: number; count: number }> = {};
    effectiveCloPerf.forEach(r => {
      const topic = r.cloDescription || `CLO-${r.cloNumber ?? "?"}`;
      if (!map[topic]) map[topic] = { total: 0, count: 0 };
      map[topic].total += r.percentage ?? 0;
      map[topic].count += 1;
    });
    return Object.entries(map)
      .map(([fullName, v]) => ({
        fullName,
        name: fullName.length > 18 ? fullName.slice(0, 18) + "…" : fullName,
        value: Math.round(v.total / v.count),
      }))
      .sort((a, b) => b.value - a.value);
  }, [effectiveCloPerf]);

  // ── Rule-Based Fallbacks for offline/missing LLM keys ───────────────────
  const generateRuleBasedInsightsFallback = () => {
    const trendLabel = improvementDelta == null ? "stable"
      : improvementDelta > 0 ? "improving" : improvementDelta < 0 ? "declining" : "stable";

    const strongTopics = [...topicData].filter(t => t.value >= 75).slice(0, 3).map(t => t.fullName || t.name);
    const weakTopics = [...topicData].filter(t => t.value < 60).slice(0, 3).map(t => t.fullName || t.name);

    let summary = `Your current overall grade average is ${avgGrade}%. `;
    if (avgGrade >= 80) {
      summary += "You are performing excellently across your assessments. Keep up the great work!";
    } else if (avgGrade >= 60) {
      summary += "You are showing steady progress, but there is room for improvement in some areas. Reviewing your common mistakes will help boost your grades.";
    } else {
      summary += "Your grades are currently low. We recommend focusing on your weak topics and seeking additional guidance from your instructors.";
    }

    return {
      summary,
      positiveKeywords: avgGrade >= 75 ? ["performing excellently", "great work", "steady progress"] : ["steady progress"],
      negativeKeywords: avgGrade < 60 ? ["low", "room for improvement"] : ["room for improvement"],
      strongTopics: strongTopics.length ? strongTopics : ["General Concepts"],
      weakTopics: weakTopics.length ? weakTopics : ["No critical weak areas"],
      trend: trendLabel,
      riskLevel: avgGrade < 50 ? "high" : avgGrade < 70 ? "medium" : "low",
      riskReasons: avgGrade < 50 ? ["Average grade is below 50%"] : ["Performance needs monitoring"],
      nextAction: avgGrade < 50 ? "Schedule a tutoring session and review lectures." : "Review mistake logs and practice weak areas.",
      improvementVelocity: improvementDelta ?? 0
    };
  };

  const generateRuleBasedRiskFallback = () => {
    const overallRisk = avgGrade < 50 ? "high" : avgGrade < 70 ? "medium" : "low";
    const riskReasons = avgGrade < 50
      ? ["Overall average is below 50%.", "Significant weak areas detected in course outcomes."]
      : avgGrade < 70
      ? ["Performance is in the average range, requiring moderate study adjustments.", "Some weaknesses in CLOs observed."]
      : ["Good overall score average.", "Performing well across most assessed learning outcomes."];

    const prediction = {
      nextEstimate: avgGrade,
      improvementProb: avgGrade >= 70 ? 80 : avgGrade >= 50 ? 60 : 40,
      confidence: "medium",
      failRisk: avgGrade < 50
    };

    const urgentAction = avgGrade < 50
      ? "Seek instructor guidance, review weak CLOs, and complete all practice quizzes."
      : avgGrade < 70
      ? "Review mistakes from recent graded submissions and focus on weak topic resources."
      : "Continue regular revision and maintain your current high-performing study routine.";

    const riskTopics = [...topicData].sort((a, b) => a.value - b.value).slice(0, 3).map(topic => {
      const riskScore = Math.max(0, 100 - topic.value);
      return {
        topic: topic.name,
        riskScore,
        riskLevel: riskScore >= 60 ? "high" : riskScore >= 35 ? "medium" : "low",
        reason: `Student scored ${topic.value}% in assessments mapping to this outcome.`
      };
    });

    const frequentMistakes = topMistakes.slice(0, 3).map(([m]) => m);

    return {
      riskTopics,
      frequentMistakes,
      overallRisk,
      riskReasons,
      prediction,
      urgentAction
    };
  };

  const generateRuleBasedWeakAreas = () => {
    const allClosList = Object.values(allCloPerf).flat();
    const weakClos = allClosList
      .filter((c: any) => typeof c.percentage === "number" && c.percentage < 70)
      .sort((a: any, b: any) => a.percentage - b.percentage);

    if (weakClos.length === 0) {
      const sorted = allClosList
        .filter((c: any) => typeof c.percentage === "number")
        .sort((a: any, b: any) => a.percentage - b.percentage);
      if (sorted.length > 0) {
        weakClos.push(sorted[0]);
      }
    }

    return weakClos.slice(0, 3).map((clo: any) => ({
      topic: clo.cloDescription || `CLO-${clo.cloNumber} Topics`,
      courses: [clo.courseCode],
      assessments: (clo.submissions ?? []).slice(0, 2).map((s: any) => s.assessmentTitle || "Assessment"),
      frequency: (clo.submissions ?? []).length || 1,
      severity: clo.percentage < 50 ? "high" : "medium",
      reason: `Underperforming in CLO-${clo.cloNumber} (${clo.percentage}% average).`,
      mappedCLO: `CLO-${clo.cloNumber}`
    }));
  };

  // ── Step 1: AI Learning Insights ─────────────────────────────────────────────
  // Builds a structured prompt from real student data, calls Groq (free tier),
  // and parses the JSON response into highlight-ready insight fields.

  const fetchAIInsights = async () => {
    if (graded.length === 0) return;
    const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY;
    if (!GROQ_KEY) {
      setAiInsights(generateRuleBasedInsightsFallback());
      return;
    }

    setAiInsightsLoading(true);
    try {
      const trendLabel = improvementDelta == null ? "unknown"
        : improvementDelta > 0 ? "improving" : improvementDelta < 0 ? "declining" : "stable";

      const last5 = [...graded]
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
        .slice(0, 5)
        .map(s => `${pct(Number(s.grade), Number(s.maxGrade))}%`)
        .join(", ");

      const coursesSummary = courseAvgs.slice(0, 4)
        .map(c => `${c.code}: ${c.avg}%`).join(", ");

      const mistakesSummary = topMistakes.slice(0, 4)
        .map(([m]) => m).join("; ") || "none identified";

      const cloSummary = cloDonutData.slice(0, 6)
        .map(c => `${c.name} ${c.value}%`).join(", ") || "no CLO data yet";

      const prompt = `You are a concise academic performance analyst for a university platform. Analyze the student data below and return ONLY a valid JSON object. No markdown, no code fences, no extra text whatsoever.

IMPORTANT: Write all outputs, especially the "summary", "riskReasons", and "nextAction" fields, in the second person directly addressing the student (e.g., use 'you' / 'your' / 'yours' instead of 'the student' or 'student').

STUDENT DATA:
- Graded submissions: ${graded.length}
- Overall average: ${avgGrade}%
- Trend: ${trendLabel} (${improvementDelta != null ? improvementDelta + "% vs previous" : "N/A"})
- Course averages: ${coursesSummary || "N/A"}
- Recurring mistakes: ${mistakesSummary}
- CLO scores: ${cloSummary}
- Last 5 scores (newest first): ${last5}

If there is only 1 graded submission, evaluate performance based on this single data point. Set trend to stable, riskLevel based on that single grade (e.g. high if < 50, medium if < 70, low if >= 70), and explain key observations/strengths or focus areas.

Return exactly this JSON structure (all fields required):
{
  "summary": "2-3 sentences of honest, student-friendly performance insight written in the second person",
  "positiveKeywords": ["exact phrases from summary that describe strengths"],
  "negativeKeywords": ["exact phrases from summary that describe weaknesses"],
  "strongTopics": ["up to 3 strong topic names"],
  "weakTopics": ["up to 3 weak topic names"],
  "trend": "improving or stable or declining",
  "riskLevel": "low or medium or high",
  "riskReasons": ["up to 2 short reasons, written in the second person"],
  "nextAction": "single most important action to take now, written in the second person",
  "improvementVelocity": 0
}`;

      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 600,
        },
        { headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" } }
      );

      const raw = res.data?.choices?.[0]?.message?.content ?? "";
      // Strip any accidental markdown fences before parsing
      const jsonStr = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      setAiInsights(parsed);
    } catch (e) {
      console.warn("AI Insights fetch failed, using fallback:", e);
      setAiInsights(generateRuleBasedInsightsFallback());
    } finally {
      setAiInsightsLoading(false);
    }
  };

  // Trigger once after the graded list stabilises for the current user session
  useEffect(() => {
    if (!currentUser || graded.length === 0 || loading) return;
    const sessionKey = `${currentUser.uid}__${graded.length}`;
    if (insightsFetchedRef.current === sessionKey) return;
    insightsFetchedRef.current = sessionKey;
    fetchAIInsights();
  }, [currentUser?.uid, graded.length, loading]);

  // ── Step 2: Smart Risk Detection ─────────────────────────────────────────────
  // buildCleanStudentData() serialises everything we know about the student into
  // a compact, deterministic JSON that the LLM can reason over.
  // Keys are shortened (pct, n, desc …) to stay inside the token budget.
  const buildCleanStudentData = () => {
    const sorted = [...graded].sort(
      (a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime()
    );

    const history = sorted.slice(-12).map((s, i) => ({
      n:       i + 1,
      title:   s.assessmentTitle || `Assessment ${i + 1}`,
      type:    s.assessmentType  || "unknown",
      course:  s.courseCode      || "?",
      pct:     pct(Number(s.grade ?? 0), Number(s.maxGrade ?? 1)),
      date:    new Date(s.submittedAt).toISOString().slice(0, 10),
      mistakes: getMistakes(s).slice(0, 3),
      late:    Boolean(s.isLate),
    }));

    const scores = history.map(h => h.pct);
    // 3-point moving average to smooth noise before handing to LLM
    const smoothed = scores.map((_, i, arr) => {
      const win = arr.slice(Math.max(0, i - 2), i + 1);
      return Math.round(win.reduce((a, b) => a + b, 0) / win.length);
    });

    return {
      meta: {
        graded:   graded.length,
        avg:      avgGrade,
        lateSubs: graded.filter(s => s.isLate).length,
        pending:  pending.length,
      },
      scores: smoothed,          // cleaned trajectory for trend reasoning
      history,                   // last 12 submissions
      topics: cloDonutData.map(c => ({
        clo:  c.name,
        desc: c.description || "",
        pct:  c.value,
      })),
      mistakes: topMistakes.map(([m, n]) => ({ mistake: m, times: n })),
      courses: courseAvgs.slice(0, 5).map(c => ({
        code:  c.code,
        avg:   c.avg,
        n:     c.count,
        delta: c.delta ?? 0,
      })),
    };
  };

  // Calls llama-3.3-70b-versatile (Groq free) — a 70B model with stronger
  // pattern-recognition than the 8B used for Insights, better suited to
  // reading trajectories and classifying multi-factor risk.
  const fetchRiskAnalysis = async () => {
    if (graded.length < 1) return;
    const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY;
    if (!GROQ_KEY) {
      setRiskData(generateRuleBasedRiskFallback());
      return;
    }

    setRiskLoading(true);
    try {
      const cleanData = buildCleanStudentData();

      const prompt = `You are a university academic risk analyst. Given a student's complete, cleaned assessment history below, identify risk patterns and predict future performance.

IMPORTANT: Write all explanations, reasons, and actions (especially the "reason" field under "riskTopics", "riskReasons", and "urgentAction") in the second person directly addressing the student (use 'you' / 'your' / 'yours' instead of 'the student' or 'student').

CLEANED STUDENT DATA (JSON):
${JSON.stringify(cleanData)}

RISK SCORING RULES:
- riskScore 70-100 → HIGH risk  (topic is a serious weak point)
- riskScore 40-69  → MEDIUM risk (needs monitoring)
- riskScore 0-39   → LOW risk   (performing adequately)

If there is only 1 graded submission in the history, evaluate the risk based on that single grade, the mistakes, and any associated CLOs, and set the prediction confidence to "low" or "medium". Do not fail or refuse to predict; you must generate the prediction based on the single assessment.

Consider these signals when classifying risk:
1. Declining score trajectory (smoothed scores going down)
2. Topics/CLOs with consistently low percentage
3. Mistakes that repeat across multiple submissions
4. Late submission pattern (indicates engagement issues)
5. Recent performance vs earlier performance (last 3 vs first 3 scores)

Return ONLY this JSON — no markdown, no code fences, no extra text:
{
  "riskTopics": [
    { "topic": "string", "riskScore": 0, "riskLevel": "high|medium|low", "reason": "brief explanation written in the second person" }
  ],
  "frequentMistakes": ["mistake phrase 1", "mistake phrase 2", "mistake phrase 3"],
  "overallRisk": "low|medium|high",
  "riskReasons": ["reason 1 written in the second person", "reason 2 written in the second person"],
  "prediction": {
    "nextEstimate": 0,
    "improvementProb": 0,
    "confidence": "low|medium|high",
    "failRisk": false
  },
  "urgentAction": "single most critical intervention right now written in the second person"
}`;

      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model:       "llama-3.3-70b-versatile",
          messages:    [{ role: "user", content: prompt }],
          temperature: 0.2,   
          max_tokens:  700,
        },
        { headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" } }
      );

      const raw     = res.data?.choices?.[0]?.message?.content ?? "";
      const jsonStr = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
      setRiskData(JSON.parse(jsonStr));
    } catch (e) {
      console.warn("Risk analysis fetch failed, using fallback:", e);
      setRiskData(generateRuleBasedRiskFallback());
    } finally {
      setRiskLoading(false);
    }
  };

  // Trigger once per session after graded data is ready 
  useEffect(() => {
    if (!currentUser || graded.length < 1 || loading) return;
    const key = `risk__${currentUser.uid}__${graded.length}`;
    if (riskFetchedRef.current === key) return;
    riskFetchedRef.current = key;
    fetchRiskAnalysis();
  }, [currentUser?.uid, graded.length, loading]);

  // ── Step 3: Personalized Study Recommendations (AI-FEEDBACK DRIVEN) ─────────
  // Reads the AI-generated feedback + mistakes from EVERY graded submission
  // across all courses, sends them to Groq's llama-3.3-70b to extract
  // structured weak topic areas, then fetches real YouTube + Google resources
  // for each AI-identified topic.
  const fetchWeakCLOsWithResources = async () => {
    if (!currentUser || graded.length === 0) return;

    const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY;
    const YT_KEY   = import.meta.env.VITE_YOUTUBE_API_KEY;
    const CSE_KEY  = import.meta.env.VITE_GOOGLE_CSE_KEY;
    const CSE_ID   = import.meta.env.VITE_GOOGLE_CSE_ID;

    setWeakCLOsLoading(true);
    try {
      let weakAreas: any[] = [];

      if (GROQ_KEY) {
        try {
          // 1. Collect AI feedback + mistakes from every graded submission (last 15)
          const feedbackBundle = [...graded]
            .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
            .slice(0, 15)
            .map((s: any) => {
              const fb = getFeedbackText(s);
              const mistakes = getMistakes(s);
              if (!fb && mistakes.length === 0) return null;
              return {
                course:     s.courseCode || "?",
                courseName: s.courseName || s.courseCode || "?",
                assessment: s.assessmentTitle || "Untitled",
                type:       s.assessmentType || "assessment",
                scorePct:   pct(Number(s.grade ?? 0), Number(s.maxGrade ?? 1)),
                feedback:   fb.slice(0, 400),
                mistakes:   mistakes.slice(0, 5),
              };
            })
            .filter(Boolean);

          if (feedbackBundle.length > 0) {
            // 2. Ask LLM to extract structured weak topic areas from the feedback corpus
            // Map courses to their CLOs from allCloPerf to pass into the prompt
            const courseClosInfo: Record<string, string[]> = {};
            Object.entries(courseMap).forEach(([code, info]) => {
              const perf = allCloPerf[info.courseId];
              if (Array.isArray(perf)) {
                const clos = perf.map((p: any) => `${p.cloNumber || `CLO-${p.cloNumber ?? "?"}`}: ${p.cloDescription || ""}`);
                courseClosInfo[code] = Array.from(new Set(clos));
              }
            });

            const prompt = `You are an academic study advisor. Below are AI-generated grading feedback entries from a student's graded assessments across multiple courses. Identify the TOP 4–5 weak topic areas this student must focus on, drawing patterns from the feedback texts AND the mistakes lists.

IMPORTANT: Write all explanation fields, especially the "reason" field, in the second person (e.g., use 'you' / 'your' / 'yours' to refer to the student, e.g. "You struggled to provide clear and precise definitions of probability distributions across multiple assessments in the DS-001 course." instead of "The student struggled to...").

ASSESSMENT FEEDBACK DATA (JSON):
${JSON.stringify(feedbackBundle)}

COURSE CLO DEFINITIONS (JSON):
${JSON.stringify(courseClosInfo)}

For each weak area extract:
- topic            : a SPECIFIC, searchable subject name (e.g. "Recursion Base Cases", "SQL Inner Joins", "Stack vs Heap Memory") — NOT a generic phrase
- courses          : array of course codes where this weakness appears
- assessments      : array of 1–3 assessment titles where this weakness was flagged
- frequency        : how many distinct assessments mentioned this weakness
- severity         : "high" (frequent + low scores) | "medium" | "low"
- reason           : ONE sentence explaining the pattern of mistakes/feedback that proves this is a weakness, written in the second person directly addressing the student (use 'you' / 'your' / 'yours')
- mappedCLO        : the CLO identifier (e.g., "CLO-2") from the COURSE CLO DEFINITIONS that is most relevant to this weak topic area (or null if none match)

Return ONLY valid JSON — no markdown, no code fences, no preamble:
{
  "weakAreas": [
    { "topic": "string", "courses": ["CSC354"], "assessments": ["Quiz 1"], "frequency": 2, "severity": "high|medium|low", "reason": "string", "mappedCLO": "CLO-2" }
  ]
}`;

            const res = await axios.post(
              "https://api.groq.com/openai/v1/chat/completions",
              {
                model:       "llama-3.3-70b-versatile",
                messages:    [{ role: "user", content: prompt }],
                temperature: 0.3,
                max_tokens:  900,
              },
              { headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" } }
            );

            const raw     = res.data?.choices?.[0]?.message?.content ?? "";
            const jsonStr = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
            const parsed  = JSON.parse(jsonStr);
            weakAreas = (parsed.weakAreas ?? []).slice(0, 5);
          }
        } catch (err) {
          console.warn("Groq weak areas extraction failed, using fallback:", err);
        }
      }

      if (weakAreas.length === 0) {
        // Fallback: Check if there's a low-performing CLO in the student's records to use as a focus area
        const allClosList = Object.values(allCloPerf).flat();
        const filteredClos = selectedCourse === "all" 
          ? allClosList 
          : allClosList.filter((c: any) => c.courseCode === selectedCourse || c.courseId === courseMap[selectedCourse]?.courseId);
        
        const lowPerfClo = [...filteredClos]
          .filter((c: any) => typeof c.percentage === "number")
          .sort((a: any, b: any) => a.percentage - b.percentage)[0];

        if (lowPerfClo) {
          // Ask LLM to extract a specific searchable topic using feedback from assessments under this CLO
          const cloAssessments = Array.isArray(lowPerfClo.submissions) 
            ? lowPerfClo.submissions.map((sub: any) => ({
                title: sub.assessmentTitle || "Assessment",
                grade: sub.marksObtained,
                maxGrade: sub.marksAvailable,
                feedback: sub.feedback || ""
              }))
            : [];

          if (GROQ_KEY) {
            const fallbackPrompt = `You are an academic study advisor. A student is underperforming in a specific Course Learning Outcome (CLO). Identify ONE specific searchable weak topic area that the student should focus on to improve. Use the assessment titles and student grading feedback below to isolate the specific weakness.

IMPORTANT: Write all explanation fields, especially the "reason" field, in the second person (e.g., use 'you' / 'your' / 'yours' to refer to the student).

CLO INFORMATION:
- Course: ${lowPerfClo.courseName || lowPerfClo.courseCode} (${lowPerfClo.courseCode})
- CLO Number: CLO-${lowPerfClo.cloNumber}
- CLO Description: ${lowPerfClo.cloDescription}
- CLO Score: ${lowPerfClo.percentage}%

ASSESSMENTS & FEEDBACK under this CLO (JSON):
${JSON.stringify(cloAssessments)}

For this weak area extract:
- topic            : a SPECIFIC, searchable subject name (e.g. "Recursion Base Cases", "SQL Inner Joins", "Stack vs Heap Memory") — NOT a generic phrase
- courses          : [ "${lowPerfClo.courseCode}" ]
- assessments      : array of 1–3 assessment titles under this CLO where the student struggled
- frequency        : number of assessments analyzed
- severity         : "high"
- reason           : ONE sentence explaining why the student is struggling on this specific topic based on their feedback, written in the second person directly addressing the student (use 'you' / 'your' / 'yours')
- mappedCLO        : "CLO-${lowPerfClo.cloNumber}"

Return ONLY valid JSON — no markdown, no code fences, no preamble:
{
  "weakAreas": [
    { "topic": "string", "courses": ["${lowPerfClo.courseCode}"], "assessments": ["Quiz 1"], "frequency": 1, "severity": "high", "reason": "string", "mappedCLO": "CLO-${lowPerfClo.cloNumber}" }
  ]
}`;

            try {
              const fallbackRes = await axios.post(
                "https://api.groq.com/openai/v1/chat/completions",
                {
                  model:       "llama-3.3-70b-versatile",
                  messages:    [{ role: "user", content: fallbackPrompt }],
                  temperature: 0.3,
                  max_tokens:  400,
                },
                { headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" } }
              );

              const fallbackRaw = fallbackRes.data?.choices?.[0]?.message?.content ?? "";
              const fallbackJsonStr = fallbackRaw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
              const fallbackParsed = JSON.parse(fallbackJsonStr);
              weakAreas = (fallbackParsed.weakAreas ?? []).slice(0, 1);
            } catch (err) {
              console.warn("Groq fallback CLO weakness extraction failed:", err);
            }
          }
        }
      }

      if (weakAreas.length === 0) {
        weakAreas = generateRuleBasedWeakAreas();
      }

      if (weakAreas.length === 0) {
        setWeakCLOsResources([]);
        return;
      }

      // 3. For each AI-extracted topic, fetch real YouTube + Google resources + local materials
      const results = await Promise.all(weakAreas.map(async (area: any) => {
        const query  = area.topic;
        const videos: any[] = [];
        const notes:  any[] = [];
        const localMaterials: any[] = [];

        const courseCode = area.courses?.[0];
        const courseInfo = courseMap[courseCode];
        const courseId   = courseInfo?.courseId;
        const courseName = courseInfo?.courseName || courseCode || "";
        
        // Clean the course name (e.g. "Professional Practices" instead of "CSC410")
        // as university codes like "CSC410" cause search engines to return 0 hits.
        const cleanCourseName = courseName.replace(/csc\d+/gi, "").trim();
        const refinedSearchQuery = `${cleanCourseName} ${query}`.trim();

        // 3a. Query YouTube API dynamically
        if (YT_KEY) {
          try {
            const { data } = await axios.get(
              "https://www.googleapis.com/youtube/v3/search",
              {
                params: {
                  part:              "snippet",
                  q:                 `${refinedSearchQuery} computer science explained`,
                  type:              "video",
                  maxResults:        4,
                  videoDuration:     "medium",
                  relevanceLanguage: "en",
                  key:               YT_KEY,
                },
              }
            );
            (data.items ?? []).forEach((v: any) => {
              if (v.id.videoId) {
                videos.push({
                  id:        v.id.videoId,
                  title:     v.snippet.title,
                  thumbnail: v.snippet.thumbnails?.medium?.url ?? `https://img.youtube.com/vi/${v.id.videoId}/mqdefault.jpg`,
                  channel:   v.snippet.channelTitle,
                });
              }
            });
          } catch (e) {
            console.warn(`YouTube fetch failed for "${query}":`, e);
          }
        }

        // 3b. Query Google Custom Search Engine dynamically
        if (CSE_KEY && CSE_ID) {
          try {
            const { data } = await axios.get(
              "https://www.googleapis.com/customsearch/v1",
              {
                params: {
                  q:   `${refinedSearchQuery} study notes lecture tutorial`,
                  key: CSE_KEY,
                  cx:  CSE_ID,
                  num: 4,
                },
              }
            );
            (data.items ?? []).forEach((n: any) => {
              try {
                notes.push({
                  title:   n.title,
                  snippet: n.snippet?.replace(/\n/g, " ") ?? "",
                  link:    n.link,
                  domain:  new URL(n.link).hostname.replace("www.", ""),
                });
              } catch {}
            });
          } catch (e) {
            console.warn(`Google CSE fetch failed for "${query}":`, e);
          }
        }

        // 3c. Fetch and Match Local Course Materials (Slides/PDFs)
        if (courseId) {
          try {
            // Fetch the list of uploaded course materials
            const materialsRes = await axios.get(`${API}/courses/materials-list/${courseId}`);
            const courseMaterials = materialsRes.data?.materials || [];

            // A. Query RAG vector database (FAISS) for matching chunks
            let ragChunks: any[] = [];
            try {
              const contextRes = await axios.post(`${API}/courses/${courseId}/material-context`, {
                query: `${area.topic} ${area.mappedCLO || ""}`,
                topK: 4
              });
              if (contextRes.data?.success && Array.isArray(contextRes.data.results)) {
                ragChunks = contextRes.data.results;
              }
            } catch (err) {
              console.warn(`RAG query failed for topic "${query}":`, err);
            }

            // B. Map RAG matches to files and construct slide resources
            if (ragChunks.length > 0) {
              ragChunks.forEach((chunk: any) => {
                const matId = chunk.metadata?.material_id || chunk.metadata?.materialId;
                const fileName = chunk.metadata?.filename || chunk.metadata?.fileName;
                const matchedMat = courseMaterials.find((m: any) => 
                  (matId && String(m._id) === String(matId)) ||
                  (fileName && m.originalFileName === fileName)
                );

                if (matchedMat) {
                  if (!localMaterials.some(m => m.link === matchedMat.fileUrl)) {
                    localMaterials.push({
                      title: matchedMat.originalFileName,
                      snippet: chunk.text || "Relevant slide chunk.",
                      page: chunk.metadata?.page || chunk.metadata?.pageNumber || null,
                      link: matchedMat.fileUrl,
                      similarity: chunk.similarity
                    });
                  }
                }
              });
            }

            // C. Fallback: client-side keyword matching
            if (localMaterials.length === 0 && courseMaterials.length > 0) {
              const topicWords = `${area.topic} ${area.mappedCLO || ""}`.toLowerCase().split(/\s+/).filter(w => w.length > 3);
              courseMaterials.forEach((m: any) => {
                const fileNameLower = m.originalFileName.toLowerCase();
                const matchedWords = topicWords.filter(w => fileNameLower.includes(w));
                if (matchedWords.length > 0) {
                  localMaterials.push({
                    title: m.originalFileName,
                    snippet: `Relevant course slide matching: "${matchedWords.join(", ")}"`,
                    link: m.fileUrl,
                    score: matchedWords.length
                  });
                }
              });
              localMaterials.sort((a, b) => (b.score || 0) - (a.score || 0));
            }
          } catch (e) {
            console.warn(`Failed to fetch local materials for "${courseCode}":`, e);
          }
        }

        return { ...area, videos, notes, materials: localMaterials };
      }));

      setWeakCLOsResources(results);
      setActiveWeakTab(0);
    } catch (e) {
      console.warn("AI-feedback weak areas fetch failed:", e);
    } finally {
      setWeakCLOsLoading(false);
    }
  };

  // Trigger once graded submissions are loaded
  useEffect(() => {
    if (!currentUser || graded.length === 0 || loading) return;
    const key = `weakareas__${currentUser.uid}__${graded.length}`;
    if (weakCLOsFetchedRef.current === key) return;
    weakCLOsFetchedRef.current = key;
    fetchWeakCLOsWithResources();
  }, [currentUser?.uid, graded.length, loading]);

  // Fetch CLO performance for every enrolled course so we can map CLOs to submissions
  useEffect(() => {
    if (!currentUser || !submissions.length) return;
    const uniqueCourseIds = Array.from(new Set(
      submissions
        .map(s => typeof s.courseId === "string" ? s.courseId : s.courseId?._id?.toString?.() ?? "")
        .filter(Boolean)
    ));
    if (!uniqueCourseIds.length) return;
    Promise.all(
      uniqueCourseIds.map(courseId =>
        axios.get(`${API}/clo-performance/student/${encodeURIComponent(currentUser.uid)}/course/${courseId}`)
          .then(({ data }) => ({ courseId, perf: Array.isArray(data?.performance) ? data.performance : [] }))
          .catch(() => ({ courseId, perf: [] }))
      )
    ).then(results => {
      const map: Record<string, any[]> = {};
      results.forEach(({ courseId, perf }) => { map[courseId] = perf; });
      setAllCloPerf(map);
    });
  }, [currentUser?.uid, submissions.length]);

  // Fetch plagiarism reports for student's assignment submissions
  useEffect(() => {
    if (!currentUser || submissions.length === 0) return;
    axios.get(`${API}/plagiarism/student/${encodeURIComponent(currentUser.uid)}`)
      .then(({ data }) => {
        const map: Record<string, any> = {};
        (data?.reports ?? []).forEach((r: any) => {
          if (r.submissionId) map[r.submissionId.toString()] = r;
        });
        setPlagiarismReports(map);
      })
      .catch(() => {});
  }, [currentUser?.uid, submissions.length]);

  // Highlights positive/negative keywords in the AI summary text
  const highlightText = (text: string, positives: string[], negatives: string[]) => {
    if (!text) return <></>;
    type Seg = { text: string; type: "normal" | "pos" | "neg" };
    let parts: Seg[] = [{ text, type: "normal" }];
    const kws = [
      ...positives.map(k => ({ k, type: "pos" as const })),
      ...negatives.map(k => ({ k, type: "neg" as const })),
    ].filter(x => x.k.trim()).sort((a, b) => b.k.length - a.k.length);

    for (const { k, type } of kws) {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(${esc})`, "gi");
      parts = parts.flatMap(part => {
        if (part.type !== "normal") return [part];
        return part.text.split(re).map(chunk => ({
          text: chunk,
          type: chunk.toLowerCase() === k.toLowerCase() ? type : "normal",
        }));
      });
    }
    return (
      <>
        {parts.filter(p => p.text).map((p, i) =>
          p.type === "pos"
            ? <span key={i} className="font-semibold text-emerald-400">{p.text}</span>
            : p.type === "neg"
            ? <span key={i} className="font-semibold text-orange-400">{p.text}</span>
            : <span key={i}>{p.text}</span>
        )}
      </>
    );
  };

  const getFeedbackText = (s: any): string =>
    typeof s.feedback === "string" ? s.feedback
    : typeof s.feedback?.feedback === "string" ? s.feedback.feedback : "";

  const getMistakes = (s: any): string[] =>
    (Array.isArray(s.mistakes) ? s.mistakes : [])
      .map((m: any) => typeof m === "string" ? m : m?.topic || m?.description || "")
      .filter(Boolean);

  // Enrolled course options for the header filter
  const courseOptions = useMemo(() => {
    return subCourseCodes.map(code => ({
      code,
      label: `${code}${courseMap[code]?.courseName && courseMap[code].courseName !== code ? ` — ${courseMap[code].courseName}` : ""}`,
    }));
  }, [subCourseCodes, courseMap]);

  // CLO label list keyed by courseCode (e.g. "CS101" → ["CLO-1","CLO-2"])
  const closByCourseCode = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    Object.values(allCloPerf).flat().forEach(r => {
      const code = r.courseCode || "";
      if (!code) return;
      if (!map[code]) map[code] = new Set();
      map[code].add(`CLO-${r.cloNumber ?? "?"}`);
    });
    return Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, Array.from(v).sort()])
    );
  }, [allCloPerf]);

  // Data for the Recent Assessments table (newest first, all submissions)
  const recentAssessmentsData = useMemo(() => {
    const filteredAll = selectedCourse === "all" ? submissions : submissions.filter(s => s.courseCode === selectedCourse);

    // Build per-course ascending history for trend computation (graded only)
    const courseChron: Record<string, { _id: string; p: number }[]> = {};
    [...filteredAll]
      .filter(s => s.status === "graded" && Number(s.maxGrade) > 0)
      .sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
      .forEach(s => {
        const code = s.courseCode || "__";
        if (!courseChron[code]) courseChron[code] = [];
        courseChron[code].push({ _id: s._id, p: pct(Number(s.grade ?? 0), Number(s.maxGrade ?? 1)) });
      });

    const trendMap: Record<string, "improving" | "needs_work" | "stable"> = {};
    Object.values(courseChron).forEach(hist => {
      hist.forEach((entry, i) => {
        const prev = i > 0 ? hist[i - 1].p : null;
        trendMap[entry._id] =
          prev === null ? "stable"
          : entry.p > prev ? "improving"
          : entry.p < prev ? "needs_work"
          : "stable";
      });
    });

    return [...filteredAll]
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
      .map(s => {
        const isGraded = s.status === "graded";
        const grade = Number(s.grade ?? 0);
        const maxGrade = Number(s.maxGrade ?? 0);
        const p = isGraded && maxGrade > 0 ? pct(grade, maxGrade) : null;
        const clos = closByCourseCode[s.courseCode] ?? [];
        const feedbackText = getFeedbackText(s);
        return {
          _id: s._id,
          title: s.assessmentTitle || "Assessment",
          type: s.assessmentType || "assignment",
          grade, maxGrade, p,
          clos,
          isGraded,
          hasFeedback: Boolean(feedbackText.trim()),
          feedbackText,
          markingStatus: isGraded ? "marked" : "pending",
          date: fmtDate(s.submittedAt || s.createdAt),
          trend: isGraded ? (trendMap[s._id] ?? "stable") : null,
          reportPublished: Boolean(s.reportPublished),
        };
      });
  }, [submissions, selectedCourse, closByCourseCode]);

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-md border-b border-border">
        <div className="container mx-auto px-6 py-3 flex items-center gap-4 max-w-7xl">
          <Button
            variant="ghost" size="sm"
            onClick={() => navigate("/student-dashboard")}
            className="hover:bg-primary/10 hover:text-primary transition-colors shrink-0"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              Feedback &amp; Focus Areas
            </h1>
            <p className="text-sm text-muted-foreground">Real-time results from your submissions</p>
          </div>

          {/* Course filter — only shown when student has courses */}
          {courseOptions.length > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                <SelectTrigger className="w-52 h-8 text-sm">
                  <SelectValue placeholder="All Courses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Courses</SelectItem>
                  {courseOptions.map(c => (
                    <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Button
            variant="outline" size="sm"
            onClick={() => currentUser && fetchAll(currentUser.uid, courses.map((c: any) => c.id))}
            disabled={loading}
            aria-label="Refresh"
            className="group hover:bg-transparent hover:border-primary/50 transition-colors shrink-0"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""} text-muted-foreground group-hover:text-purple-500`} />
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-6 py-6 max-w-7xl space-y-6">

        {error && (
          <Card className="border-red-500/30 bg-red-500/10">
            <CardContent className="flex items-center gap-3 py-3">
              <AlertCircle className="h-5 w-5 text-red-400 shrink-0" />
              <p className="text-sm text-red-300">{error}</p>
            </CardContent>
          </Card>
        )}

        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-pulse">
            {[1,2,3,4].map(i => <div key={i} className="h-24 rounded-xl bg-muted/40" />)}
          </div>
        )}

        {!loading && (
          <>
            {/* ── KPI Row ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { icon: ClipboardList, label: "Total",      value: submissions.length,                           color: "text-primary",          bg: "bg-primary/10",      border: "hover:border-primary/50" },
                { icon: CheckCircle,   label: "Graded",     value: graded.length,                                color: "text-sky-500",          bg: "bg-sky-500/10",      border: "hover:border-sky-500/50" },
                { icon: Award,         label: "Avg Grade",  value: graded.length ? `${avgGrade}%` : "—",         color: gradeColor(avgGrade),     bg: "bg-yellow-500/10",   border: "hover:border-yellow-500/50" },
                { icon: TrendingUp,    label: "Trend",      value: improvementDelta == null ? "—" : `${improvementDelta > 0 ? "+" : ""}${improvementDelta}%`, color: improvementDelta == null ? "text-muted-foreground" : improvementDelta >= 0 ? "text-emerald-400" : "text-red-400", bg: "bg-muted/20", border: "hover:border-border" },
              ].map(({ icon: Icon, label, value, color, bg, border }) => (
                <Card key={label} className={`border-border bg-card transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 hover:scale-105 cursor-default ${border}`}>
                  <CardContent className="pt-4 pb-3">
                    <div className={`inline-flex p-2 rounded-lg ${bg} mb-2`}>
                      <Icon className={`h-5 w-5 ${color}`} />
                    </div>
                    <p className={`text-3xl font-bold ${color}`}>{value}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* ── Focus Areas ── */}
            {topMistakes.length > 0 && (
              <Card className="border-border hover:shadow-lg hover:border-orange-500/30 transition-all duration-200">
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Target className="h-5 w-5 text-orange-400" />Your Focus Areas
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pb-4">
                  {topMistakes.map(([mistake, count], i) => (
                    <div key={i} className="flex items-center gap-3 p-2.5 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/15 hover:border-orange-500/40 transition-all duration-150">
                      <AlertTriangle className="h-4 w-4 text-orange-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-base font-medium truncate">{mistake}</p>
                        <p className="text-xs text-muted-foreground">{count} submission{count > 1 ? "s" : ""}</p>
                      </div>
                      <Badge variant="outline" className="text-xs text-orange-300 border-orange-500/30 shrink-0">{count}x</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {graded.length > 0 && (
              <div className="grid gap-5 md:grid-cols-3">
                {/* ── 1. Course Performance ── */}
                {courseAvgs.length > 0 ? (
                  <Card className="border-border hover:shadow-lg hover:border-primary/30 hover:scale-105 transition-all duration-200">
                    <CardHeader className="pb-2 pt-5 px-5">
                      <div className="flex items-center gap-2 mb-1">
                        <BarChart3 className="h-4 w-4 text-primary" />
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Overview</p>
                      </div>
                      <CardTitle className="text-2xl font-extrabold tracking-tight">Performance by Course</CardTitle>
                    </CardHeader>
                    <CardContent className="pb-5 px-4">
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart data={courseAvgs} margin={{ top: 14, right: 24, left: 18, bottom: 36 }} barCategoryGap="20%" maxBarSize={80}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" vertical={false} />
                          <XAxis dataKey="code" height={46} interval={0}
                            tick={{ fontSize: 12, fontWeight: 600, fill: "hsl(var(--muted-foreground))" }}
                            axisLine={{ stroke: "rgba(148,163,184,0.25)" }}
                            tickLine={false}
                            label={{ value: "Courses", position: "insideBottom", offset: -8, fill: "hsl(var(--muted-foreground))", fontSize: 11, fontWeight: 600 }}
                            tickFormatter={(code: any) => String(code ?? "")}
                          />
                          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
                            tick={{ fontSize: 12, fontWeight: 500, fill: "hsl(var(--muted-foreground))" }}
                            axisLine={{ stroke: "rgba(148,163,184,0.25)" }}
                            tickLine={false}
                            tickFormatter={v => `${v}%`}
                            width={42}
                          />
                          <RechartsTooltip cursor={{ fill: "rgba(255,255,255,0.05)" }}
                            content={({ active, payload, label }: any) => {
                              if (!active || !payload?.length) return null;
                              const row = courseAvgs.find((c: any) => c.code === label);
                              const val = payload?.[0]?.value ?? row?.avg ?? 0;
                              return (
                                <div className="rounded-xl border border-border bg-popover/95 backdrop-blur-sm px-3.5 py-2.5 shadow-xl">
                                  <p className="text-[13px] font-semibold text-foreground">{row?.name || String(label || "")}</p>
                                  <div className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
                                    <div>Avg: <span className="font-bold text-foreground">{val}%</span></div>
                                    <div>Submissions: <span className="font-semibold text-foreground">{row?.count}</span>
                                      {row?.last != null && <span> · last: <span className="font-semibold text-foreground">{row.last}%</span></span>}
                                    </div>
                                    {row?.delta != null && (
                                      <div className={row.delta >= 0 ? "text-emerald-400" : "text-red-400"}>
                                        {row.delta >= 0 ? "↑" : "↓"} {Math.abs(row.delta)}% vs previous
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Bar dataKey="avg" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                            {courseAvgs.map((entry: any, index: number) => (
                              <Cell key={`cell-${index}`} fill={colorForCourse(entry?.code)} fillOpacity={1} />
                            ))}
                            <LabelList dataKey="avg" position="top" formatter={(v: any) => `${v}%`}
                              style={{ fontSize: 12, fontWeight: 700, fill: "hsl(var(--foreground))" }} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border-border flex items-center justify-center min-h-[300px]">
                    <CardContent className="text-center py-8">
                      <BarChart3 className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                      <p className="text-sm text-muted-foreground">No course data yet</p>
                    </CardContent>
                  </Card>
                )}

                {/* ── 2. CLO-wise Performance (pie chart) ── */}
                <Card className="border border-emerald-500/20 bg-card shadow-sm hover:shadow-lg hover:border-emerald-500/40 hover:scale-105 transition-all duration-200">
                  <CardHeader className="pb-2 pt-5 px-5">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Learning Outcomes</p>
                        <CardTitle className="text-2xl font-extrabold tracking-tight">CLO-wise Performance</CardTitle>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {activeCloCode && selectedCourse === "all" && (
                          <Badge variant="outline" className="text-[11px] border-emerald-500/30 text-emerald-400">
                            All Courses
                          </Badge>
                        )}
                        <Select value={cloType} onValueChange={(v: any) => setCloType(v)}>
                          <SelectTrigger className="h-8 text-xs w-40 bg-muted/40 border-border/60"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Types</SelectItem>
                            <SelectItem value="quiz">Quiz Only</SelectItem>
                            <SelectItem value="assignment">Assignment Only</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pb-5 px-4">
                    {!activeCloCode ? (
                      <div className="flex flex-col items-center justify-center h-[280px] text-center">
                        <Target className="h-10 w-10 text-muted-foreground opacity-15 mb-3" />
                        <p className="text-sm font-medium text-muted-foreground">No enrolled courses found</p>
                      </div>
                    ) : cloLoading ? (
                      <div className="flex flex-col items-center justify-center h-[280px] gap-3">
                        <RefreshCw className="h-6 w-6 text-emerald-400 animate-spin" />
                        <p className="text-xs text-muted-foreground">Computing CLO performance…</p>
                      </div>
                    ) : cloDonutData.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-[280px] text-center">
                        <Target className="h-10 w-10 text-muted-foreground opacity-15 mb-3" />
                        <p className="text-sm font-medium text-foreground/90 mb-1">
                          {filteredGraded.length === 0 ? "No marked assessments found for this selection." : "No CLO data available yet."}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                          {filteredGraded.length === 0 ? "Grade an assessment to unlock your course CLO breakdown." : "Submit graded assessments to see your CLO breakdown here."}
                        </p>
                      </div>
                    ) : (
                      <div className="relative">
                        <ResponsiveContainer width="100%" height={320}>
                          <PieChart>
                            <Pie data={cloDonutData} cx="45%" cy="50%" innerRadius={60} outerRadius={88}
                              paddingAngle={3} dataKey="value" isAnimationActive={false} strokeWidth={0}
                              label={({ cx, cy, midAngle, outerRadius, value }: any) => {
                                const RADIAN = Math.PI / 180;
                                const radius = outerRadius + 18;
                                const x = cx + radius * Math.cos(-midAngle * RADIAN);
                                const y = cy + radius * Math.sin(-midAngle * RADIAN);
                                const anchor = x > cx ? "start" : "end";
                                return (
                                  <text x={x} y={y} fill="#000000" textAnchor={anchor} dominantBaseline="central" style={{ fontSize: 12, fontWeight: 700, stroke: "#ffffff", strokeWidth: 0.8, paintOrder: "stroke" }}>
                                    {value}%
                                  </text>
                                );
                              }} labelLine={true}
                            >
                              {cloDonutData.map((_, i) => <Cell key={i} fill={CLO_DONUT_COLORS[i % CLO_DONUT_COLORS.length]} />)}
                            </Pie>
                            <RechartsTooltip content={({ active, payload }: any) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0]?.payload;
                              const color = CLO_DONUT_COLORS[cloDonutData.indexOf(d) % CLO_DONUT_COLORS.length];
                              return (
                                <div className="rounded-xl border border-border bg-popover/95 backdrop-blur-sm px-3.5 py-2.5 shadow-xl max-w-[240px]">
                                  <div className="flex items-center gap-2 mb-1.5">
                                    <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                                    <p className="text-sm font-bold text-foreground">{d?.name}</p>
                                  </div>
                                  {d?.description && <p className="text-xs text-muted-foreground leading-relaxed mb-2">{d.description}</p>}
                                  <p className="text-sm font-extrabold" style={{ color }}>{d?.value}%</p>
                                </div>
                              );
                            }} />
                            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={11}
                              formatter={(value: string, entry: any) => (
                                <span style={{ fontSize: 13, fontWeight: 500, lineHeight: "2.2" }}>
                                  {value}&nbsp;<span style={{ fontWeight: 700 }}>{entry?.payload?.value}%</span>
                                </span>
                              )} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* ── 3. Assessment Performance Trend (renamed) ── */}
                <Card className="border border-violet-500/20 bg-card shadow-sm hover:shadow-lg hover:border-violet-500/40 hover:scale-105 transition-all duration-200">
                  <CardHeader className="pb-2 pt-5 px-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Performance Over Time</p>
                        <CardTitle className="text-2xl font-extrabold tracking-tight">
                          Assessment Performance Trend
                        </CardTitle>
                      </div>
                      {trendData.length > 0 && (
                        <div className="shrink-0 text-right bg-violet-500/10 border border-violet-500/25 rounded-lg px-3 py-1.5">
                          <div className="text-xl font-extrabold text-violet-400 leading-tight">{trendAvg}%</div>
                          <div className="text-[10px] font-medium text-muted-foreground leading-tight mt-0.5">Avg. Score</div>
                        </div>
                      )}
                    </div>
                    <div className="mt-3">
                      <Select value={trendType} onValueChange={(v: any) => setTrendType(v)}>
                        <SelectTrigger className="h-8 text-xs w-40 bg-muted/40 border-border/60">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Types</SelectItem>
                          <SelectItem value="quiz">Quiz Only</SelectItem>
                          <SelectItem value="assignment">Assignment Only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </CardHeader>
                  <CardContent className="pb-5 px-2">
                    {trendData.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-[210px] text-center">
                        <TrendingUp className="h-10 w-10 text-muted-foreground opacity-15 mb-3" />
                        <p className="text-sm font-medium text-muted-foreground">No submissions match this filter</p>
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={230}>
                        <AreaChart data={trendData} margin={{ top: 14, right: 16, left: 2, bottom: 20 }}>
                          <defs>
                            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.4} />
                              <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" vertical={false} />
                          <XAxis
                            dataKey="name"
                            tick={{ fontSize: 13, fill: "hsl(var(--muted-foreground))", fontWeight: 600 }}
                            axisLine={{ stroke: "rgba(148,163,184,0.25)" }}
                            tickLine={false}
                            dy={8}
                          />
                          <YAxis
                            domain={[0, 100]}
                            ticks={[0, 25, 50, 75, 100]}
                            tick={{ fontSize: 13, fill: "hsl(var(--muted-foreground))", fontWeight: 600 }}
                            axisLine={{ stroke: "rgba(148,163,184,0.25)" }}
                            tickLine={false}
                            tickFormatter={v => `${v}%`}
                            width={42}
                          />
                          <RechartsTooltip
                            cursor={{ stroke: "#8b5cf6", strokeWidth: 1.5, strokeDasharray: "4 3" }}
                            content={({ active, payload }: any) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0]?.payload;
                              return (
                                <div className="rounded-xl border border-violet-500/30 bg-popover/95 backdrop-blur-sm px-3.5 py-2.5 shadow-xl">
                                  <p className="text-[13px] font-semibold text-foreground leading-snug">{d?.fullTitle}</p>
                                  <p className="text-[11px] text-muted-foreground mt-0.5">{d?.name}</p>
                                  <div className="flex items-center gap-1.5 mt-2">
                                    <span className="inline-block w-2 h-2 rounded-full bg-violet-400" />
                                    <span className="text-[13px] font-bold text-violet-400">{payload[0]?.value}%</span>
                                  </div>
                                </div>
                              );
                            }}
                          />
                          {trendData.length > 1 && (
                            <ReferenceLine y={trendAvg} stroke="#8b5cf6" strokeDasharray="5 3" strokeOpacity={0.5} strokeWidth={1.5} />
                          )}
                          <Area
                            type="monotone"
                            dataKey="score"
                            stroke="#8b5cf6"
                            strokeWidth={2.5}
                            fill="url(#trendGrad)"
                            dot={{ fill: "#8b5cf6", r: 4, strokeWidth: 2, stroke: "hsl(var(--background))" }}
                            activeDot={{ r: 6, fill: "#8b5cf6", stroke: "#fff", strokeWidth: 2 }}
                            isAnimationActive={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ── AI Insights + Smart Risk Detection ── */}
            {graded.length > 0 && (
              <div className="grid md:grid-cols-2 gap-5">

                {/* ── AI Learning Insights ── */}
                <Card className="border border-purple-500/25 bg-gradient-to-br from-purple-950/40 via-card to-card shadow-sm hover:shadow-lg hover:border-purple-500/50 transition-all duration-200 relative overflow-hidden">
                  <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-purple-600/10 blur-2xl pointer-events-none" />
                  <CardHeader className="pb-2 pt-5 px-5 relative">
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles className="h-5 w-5 text-purple-400" />
                      <p className="text-sm font-semibold uppercase tracking-widest text-purple-400">AI Powered</p>
                    </div>
                    <CardTitle className="text-2xl font-extrabold leading-tight">AI Learning Insights</CardTitle>
                  </CardHeader>
                  <CardContent className="pb-5 px-5 relative space-y-4">
                    <div className="grid grid-cols-3 gap-px rounded-xl overflow-hidden border border-border">
                      <div className="flex flex-col items-center justify-center gap-0.5 px-3 py-3 bg-background/50">
                        <Star className="h-4 w-4 text-yellow-400 mb-0.5" />
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Best Course</p>
                        <p className="text-sm font-bold text-foreground truncate max-w-full">
                          {bestCourse ? bestCourse.code : "—"}
                        </p>
                        {bestCourse && <p className="text-xs font-semibold text-emerald-400">{bestCourse.avg}%</p>}
                      </div>
                      <div className="flex flex-col items-center justify-center gap-0.5 px-3 py-3 bg-background/50 border-x border-border">
                        <TrendingUp className="h-4 w-4 text-primary mb-0.5" />
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Trend</p>
                        <p className={`text-sm font-bold ${improvementDelta == null ? "text-muted-foreground" : improvementDelta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {improvementDelta == null ? "—" : `${improvementDelta >= 0 ? "↑" : "↓"} ${Math.abs(improvementDelta)}%`}
                        </p>
                        <p className="text-[11px] text-muted-foreground">vs previous</p>
                      </div>
                      <div className="flex flex-col items-center justify-center gap-0.5 px-3 py-3 bg-background/50">
                        <Clock className="h-4 w-4 text-orange-400 mb-0.5" />
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pending</p>
                        <p className="text-sm font-bold text-orange-400">{pending.length}</p>
                        <p className="text-[11px] text-muted-foreground">submission{pending.length !== 1 ? "s" : ""}</p>
                      </div>
                    </div>

                    {/* Loading skeleton */}
                    {aiInsightsLoading && (
                      <div className="space-y-3 animate-pulse">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-purple-500/20 shrink-0" />
                          <div className="flex-1 space-y-2">
                            <div className="h-3.5 bg-muted/50 rounded w-3/4" />
                            <div className="h-3.5 bg-muted/50 rounded w-full" />
                            <div className="h-3.5 bg-muted/50 rounded w-2/3" />
                          </div>
                        </div>
                        <div className="h-3 bg-muted/30 rounded w-full" />
                        <div className="h-3 bg-muted/30 rounded w-4/5" />
                        <div className="flex gap-2 mt-2">
                          <div className="h-5 w-16 bg-muted/30 rounded-full" />
                          <div className="h-5 w-20 bg-muted/30 rounded-full" />
                        </div>
                      </div>
                    )}

                    {/* No data yet */}
                    {!aiInsightsLoading && !aiInsights && graded.length > 0 && (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <Brain className="h-10 w-10 text-purple-400/30 mb-3" />
                        <p className="text-sm text-muted-foreground">Generating insights…</p>
                      </div>
                    )}

                    {/* ── AI Powered Analysis content ── */}
                    {!aiInsightsLoading && aiInsights && (
                      <>
                        {/* Summary with keyword highlights */}
                        <div className="flex gap-3">
                          <div className="shrink-0 w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/25 flex items-center justify-center">
                            <Brain className="h-5 w-5 text-purple-400" />
                          </div>
                          <p className="text-lg leading-relaxed text-foreground/90">
                            {highlightText(
                              sanitizeToSecondPerson(aiInsights.summary ?? ""),
                              aiInsights.positiveKeywords ?? [],
                              aiInsights.negativeKeywords ?? []
                            )}
                          </p>
                        </div>

                        {/* Risk + velocity row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <ShieldAlert className="h-5 w-5 shrink-0 text-red-400" />
                          <span className="text-lg font-semibold text-muted-foreground">Risk:</span>
                          <Badge className={`text-lg capitalize px-4 py-1 ${
                            aiInsights.riskLevel === "high"
                              ? "text-red-300 border-red-500/30"
                              : aiInsights.riskLevel === "medium"
                              ? "text-yellow-300 border-yellow-500/30"
                              : "text-emerald-300 border-emerald-500/30"
                          }`} variant="outline">
                            {aiInsights.riskLevel ?? "—"} Risk
                          </Badge>
                          {typeof aiInsights.improvementVelocity === "number" && (
                            <span className={`text-lg font-semibold ml-auto ${aiInsights.improvementVelocity >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {aiInsights.improvementVelocity >= 0 ? "↑" : "↓"} {Math.abs(aiInsights.improvementVelocity)}
                            </span>
                          )}
                        </div>

                        {/* Topics row: Focus Areas + Strengths side by side */}
                        {(aiInsights.weakTopics?.length > 0 || aiInsights.strongTopics?.length > 0) && (
                          <div className="grid grid-cols-2 gap-3">
                            {aiInsights.weakTopics?.length > 0 && (
                              <div>
                                <p className="text-sm font-bold uppercase tracking-wide text-orange-400 mb-1.5">Focus Areas</p>
                                <div className="flex flex-wrap gap-2">
                                  {aiInsights.weakTopics.map((t: string, i: number) => (
                                    <Badge key={i} variant="outline" className="text-base text-orange-300 border-orange-500/30 px-3 py-1">
                                      {t}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                            {aiInsights.strongTopics?.length > 0 && (
                              <div>
                                <p className="text-sm font-bold uppercase tracking-wide text-emerald-400 mb-1.5">Strengths</p>
                                <div className="flex flex-wrap gap-2">
                                  {aiInsights.strongTopics.map((t: string, i: number) => (
                                    <Badge key={i} variant="outline" className="text-base text-emerald-300 border-emerald-500/30 px-3 py-1">
                                      {t}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Next action */}
                        {aiInsights.nextAction && (
                          <div className="flex items-start gap-2 p-4 rounded-lg border border-purple-500/20">
                            <Lightbulb className="h-5 w-5 text-purple-400 shrink-0 mt-0.5" />
                            <p className="text-base text-muted-foreground leading-relaxed">{sanitizeToSecondPerson(aiInsights.nextAction)}</p>
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* ── Smart Risk Detection (real-time) ── */}
                <Card className="border border-red-500/20 bg-gradient-to-br from-red-950/20 via-card to-card shadow-sm hover:shadow-lg hover:border-red-500/35 transition-all duration-200">
                  <CardHeader className="pb-2 pt-5 px-5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-5 w-5 text-red-400" />
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-red-400/80">Real-time Analysis</p>
                          <CardTitle className="text-2xl font-extrabold leading-tight mt-0.5">Smart Risk Detection</CardTitle>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedCourse === "all" && (
                          <Badge variant="outline" className="text-[10px] font-semibold capitalize px-2.5 py-0.5 text-slate-700 border-slate-200">
                            All Courses
                          </Badge>
                        )}
                        {(riskData?.overallRisk || topicData.length > 0) && (() => {
                          const level: string = riskData?.overallRisk ?? (() => {
                            if (!topicData.length) return "low";
                            const worst = [...topicData].sort((a: any, b: any) => a.value - b.value)[0];
                            const rs = 100 - worst.value;
                            return rs >= 60 ? "high" : rs >= 35 ? "medium" : "low";
                          })();
                          return (
                            <Badge variant="outline" className={`text-sm font-semibold capitalize px-3 py-1 ${
                              level === "high"   ? "text-red-300 border-red-500/30"
                              : level === "medium" ? "text-yellow-300 border-yellow-500/30"
                              : "text-emerald-300 border-emerald-500/30"
                            }`}>
                              {level} Risk
                            </Badge>
                          );
                        })()}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="pb-6 px-5 space-y-6">

                    {/* High Risk Topics — bars show risk score (100 - performance) */}
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-4">High Risk Topics</p>
                      {cloLoading ? (
                        <div className="space-y-4 animate-pulse">
                          {[1,2,3].map(i => (
                            <div key={i} className="space-y-2">
                              <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                  <div className="w-3.5 h-3.5 rounded-full bg-muted/50 shrink-0" />
                                  <div className="h-3 bg-muted/40 rounded w-32" />
                                </div>
                                <div className="h-3 bg-muted/40 rounded w-10" />
                              </div>
                              <div className="h-2.5 bg-muted/30 rounded-full" />
                            </div>
                          ))}
                        </div>
                      ) : topicData.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-6 text-center">
                          <ShieldAlert className="h-8 w-8 text-muted-foreground/20 mb-2" />
                          <p className="text-sm text-muted-foreground italic">No CLO data available yet.</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {[...topicData].sort((a, b) => a.value - b.value).slice(0, 5).map((topic, i) => {
                            // risk score is inverse of performance
                            const riskScore = Math.max(0, 100 - topic.value);
                            // color thresholds based on risk level
                            const c = riskScore >= 60
                              ? { bar: "bg-red-500",      barGlow: "shadow-red-500/40",    text: "text-red-400",    dot: "bg-red-500",    ring: "ring-red-500/30",    label: "High" }
                              : riskScore >= 35
                              ? { bar: "bg-orange-500",   barGlow: "shadow-orange-500/40", text: "text-orange-400", dot: "bg-orange-500", ring: "ring-orange-500/30", label: "Med"  }
                              : { bar: "bg-teal-500",     barGlow: "shadow-teal-500/40",   text: "text-teal-400",   dot: "bg-teal-500",   ring: "ring-teal-500/30",   label: "Low"  };
                            return (
                              <div key={i} className="space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <span className={`inline-flex w-3.5 h-3.5 rounded-full shrink-0 ring-2 ${c.dot} ${c.ring}`} />
                                    <UITooltip>
                                      <TooltipTrigger asChild>
                                        <span className="text-[13px] font-semibold text-foreground truncate hover:text-primary/80 transition-colors">
                                          {topic.name}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="right" className="max-w-xs break-words text-sm">
                                        {topic.fullName}
                                      </TooltipContent>
                                    </UITooltip>
                                  </div>
                                  <span className={`text-[13px] font-extrabold shrink-0 ${c.text}`}>{riskScore}%</span>
                                </div>
                                <div className="w-full h-2.5 rounded-full bg-muted/30 overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all duration-700 ${c.bar}`}
                                    style={{ width: `${riskScore}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Divider */}
                    <div className="border-t border-border/50" />

                    {/* AI Future Risk Prediction */}
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <Brain className="h-3.5 w-3.5 text-purple-400" />
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">AI Risk Prediction</p>
                        {riskData?.prediction?.confidence && (
                          <Badge variant="outline" className="text-xs ml-auto text-purple-300 border-purple-500/30 px-2.5 py-1">
                            {riskData.prediction.confidence} conf.
                          </Badge>
                        )}
                      </div>

                      {riskLoading ? (
                        <div className="space-y-2.5 animate-pulse">
                          <div className="grid grid-cols-3 gap-2">
                            {[1,2,3].map(i => <div key={i} className="h-14 rounded-lg bg-muted/30" />)}
                          </div>
                          <div className="h-3 bg-muted/20 rounded w-full" />
                          <div className="h-3 bg-muted/20 rounded w-4/5" />
                          <div className="h-3 bg-muted/20 rounded w-3/5" />
                        </div>
                      ) : !riskData ? (
                        graded.length < 1 ? (
                          <p className="text-xs text-muted-foreground italic">No graded submissions yet. Grade an assessment to generate a prediction.</p>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">Generating AI risk prediction…</p>
                        )
                      ) : (
                        <div className="space-y-3">
                          {/* Prediction stats strip */}
                          <div className="grid grid-cols-3 gap-2">
                            <div 
                              onClick={() => setActiveRiskMetric("nextScore")}
                              className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-center cursor-pointer transition-all duration-250 hover:shadow-sm select-none ${
                                activeRiskMetric === "nextScore"
                                  ? "border-red-500/60 bg-red-500/10 shadow-sm ring-1 ring-red-500/30 scale-[1.02]"
                                  : "border-border/60 bg-muted/20 hover:border-red-500/40 hover:bg-red-500/5"
                              }`}
                            >
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Next Score</span>
                              <span className={`text-lg font-extrabold leading-tight ${gradeColor(riskData.prediction?.nextEstimate ?? 0)}`}>
                                {riskData.prediction?.nextEstimate ?? "—"}%
                              </span>
                            </div>
                            <div 
                              onClick={() => setActiveRiskMetric("improveProb")}
                              className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-center cursor-pointer transition-all duration-250 hover:shadow-sm select-none ${
                                activeRiskMetric === "improveProb"
                                  ? "border-red-500/60 bg-red-500/10 shadow-sm ring-1 ring-red-500/30 scale-[1.02]"
                                  : "border-border/60 bg-muted/20 hover:border-red-500/40 hover:bg-red-500/5"
                              }`}
                            >
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Improve Prob.</span>
                              <span className={`text-lg font-extrabold leading-tight ${(riskData.prediction?.improvementProb ?? 0) >= 50 ? "text-emerald-400" : "text-red-400"}`}>
                                {riskData.prediction?.improvementProb ?? "—"}%
                              </span>
                            </div>
                            <div 
                              onClick={() => setActiveRiskMetric("failRisk")}
                              className={`flex flex-col items-center justify-center p-2.5 rounded-lg border text-center cursor-pointer transition-all duration-250 hover:shadow-sm select-none ${
                                activeRiskMetric === "failRisk"
                                  ? "border-red-500/60 bg-red-500/10 shadow-sm ring-1 ring-red-500/30 scale-[1.02]"
                                  : "border-border/60 bg-muted/20 hover:border-red-500/40 hover:bg-red-500/5"
                              }`}
                            >
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Fail Risk</span>
                              <span className={`text-lg font-extrabold leading-tight ${riskData.prediction?.failRisk ? "text-red-400" : "text-emerald-400"}`}>
                                {riskData.prediction?.failRisk ? "Yes" : "No"}
                              </span>
                            </div>
                          </div>

                          {/* AI-predicted risk topics */}
                          {riskData.riskTopics?.length > 0 && (
                            <div className="space-y-2">
                              {riskData.riskTopics.slice(0, 3).map((rt: any, i: number) => {
                                const rc = rt.riskLevel === "high"
                                  ? { text: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/25"    }
                                  : rt.riskLevel === "medium"
                                  ? { text: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/25" }
                                  : { text: "text-teal-400",   bg: "bg-teal-500/10",   border: "border-teal-500/25"   };
                                return (
                                  <div key={i} className={`flex items-start gap-2 p-2.5 rounded-lg ${rc.bg} border ${rc.border}`}>
                                    <AlertTriangle className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${rc.text}`} />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between gap-1 flex-wrap">
                                        <span className="text-[12px] font-semibold text-foreground truncate">{rt.topic}</span>
                                        <Badge variant="outline" className={`text-xs capitalize px-2 py-1 shrink-0 ${
                                          rt.riskLevel === "high" ? "text-red-300 border-red-500/30"
                                          : rt.riskLevel === "medium" ? "text-orange-300 border-orange-500/30"
                                          : "text-teal-300 border-teal-500/30"
                                        }`}>{rt.riskLevel}</Badge>
                                      </div>
                                      {rt.reason && <p className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">{sanitizeToSecondPerson(rt.reason)}</p>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Urgent action */}
                          {riskData.urgentAction && (
                            <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10">
                              <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                              <p className="text-[12px] text-foreground/85 leading-relaxed">{sanitizeToSecondPerson(riskData.urgentAction)}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Divider */}
                    <div className="border-t border-border/50" />

                    {/* Frequently Repeated Mistakes — from actual graded submissions */}
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Frequently Repeated Mistakes</p>
                      {topMistakes.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic">No repeated mistakes identified yet.</p>
                      ) : (
                        <ul className="space-y-2.5">
                          {topMistakes.map(([m, count], i) => (
                            <li key={i} className="flex items-center gap-2.5 text-[13px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0 mt-0.5" />
                              <span className="flex-1 text-foreground/85 leading-snug">{m}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </CardContent>
                </Card>

              </div>
            )}

            {/* ── Step 3: Personalized Study Recommendations (AI-feedback-driven) ── */}
            {(weakCLOsLoading || weakCLOsResources.length > 0 || graded.length > 0) && (() => {
              // Filter by header course dropdown — when a specific course is selected,
              // only show weak areas where that course appears in `area.courses`.
              const filteredAreas = selectedCourse === "all"
                ? weakCLOsResources
                : weakCLOsResources.filter((a: any) =>
                    Array.isArray(a.courses) && a.courses.includes(selectedCourse)
                  );
              const safeTab = Math.min(activeWeakTab, Math.max(0, filteredAreas.length - 1));
              const active = filteredAreas[safeTab];

              const sevColor = (s: string) =>
                s === "high"   ? { text: "text-rose-400",     bg: "bg-rose-500/10",     border: "border-rose-500/40",     dot: "bg-rose-500",     ring: "ring-rose-500/30",     icon: "text-rose-400" }
                : s === "medium" ? { text: "text-amber-400",   bg: "bg-amber-500/10",   border: "border-amber-500/40",   dot: "bg-amber-500",   ring: "ring-amber-500/30",   icon: "text-amber-400" }
                :                  { text: "text-sky-400",     bg: "bg-sky-500/10",     border: "border-sky-500/40",     dot: "bg-sky-500",     ring: "ring-sky-500/30",     icon: "text-sky-400" };

              return (
                <Card className="border border-teal-500/30 bg-gradient-to-br from-teal-950/20 via-card to-card shadow-md hover:shadow-xl hover:border-teal-500/50 transition-all duration-200">
                  <CardHeader className="pb-3 pt-6 px-7">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-teal-500/15 border border-teal-500/30 flex items-center justify-center shrink-0">
                          <Lightbulb className="h-5 w-5 text-teal-400" />
                        </div>
                        <div>
                          <CardTitle className="text-xl font-bold leading-tight">Personalized Study Recommendations</CardTitle>
                          <p className="text-sm text-muted-foreground mt-1">Extracted from your AI grading feedback</p>
                        </div>
                      </div>
                      {selectedCourse !== "all" && (
                        <Badge variant="outline" className="text-xs font-bold border-teal-500/40 text-teal-300 px-2.5 py-1 shrink-0">
                          <Filter className="h-3 w-3 mr-1" /> {selectedCourse}
                        </Badge>
                      )}
                    </div>

                    {/* Topic tab strip — each tab is an AI-extracted weak topic */}
                    {!weakCLOsLoading && filteredAreas.length > 0 && (
                      <div className="flex gap-2 mt-5 flex-wrap">
                        {filteredAreas.map((area: any, i: number) => {
                          const c = sevColor(area.severity);
                          const isActive = safeTab === i;
                          return (
                            <button
                              key={i}
                              onClick={() => setActiveWeakTab(i)}
                              className={`px-4 py-2 rounded-full text-sm font-semibold border transition-all duration-150 flex items-center gap-2 ${
                                isActive
                                  ? `${c.bg} ${c.border} ${c.text} ring-2 ${c.ring}`
                                  : "border-border text-muted-foreground hover:border-teal-500/40 hover:text-foreground bg-card/40"
                              }`}
                            >
                              <span className={`inline-block w-2 h-2 rounded-full ${c.dot}`} />
                              <span className="truncate max-w-[220px]">{area.topic || "Weak area"}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </CardHeader>

                  <CardContent className="pb-7 px-7">
                    {/* Loading skeleton */}
                    {weakCLOsLoading && (
                      <div className="space-y-5 animate-pulse">
                        <div className="flex gap-2">
                          {[1,2,3].map(i => <div key={i} className="h-9 w-40 rounded-full bg-muted/30" />)}
                        </div>
                        <div className="h-24 bg-muted/20 rounded-xl" />
                        <div>
                          <div className="h-4 bg-muted/30 rounded w-40 mb-3" />
                          <div className="grid grid-cols-3 gap-3">
                            {[1,2,3].map(i => (
                              <div key={i} className="rounded-xl overflow-hidden border border-border">
                                <div className="h-32 bg-muted/30" />
                                <div className="p-3 space-y-2">
                                  <div className="h-3.5 bg-muted/30 rounded w-full" />
                                  <div className="h-2.5 bg-muted/20 rounded w-2/3" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* No weak areas (or filter yielded zero) */}
                    {!weakCLOsLoading && filteredAreas.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mb-4">
                          <CheckCircle className="h-8 w-8 text-emerald-400" />
                        </div>
                        <p className="text-lg font-bold text-foreground">
                          {selectedCourse === "all" ? "No weak areas detected" : `No weak areas in ${selectedCourse}`}
                        </p>
                        <p className="text-sm text-muted-foreground mt-1.5 max-w-md">
                          {selectedCourse === "all"
                            ? "Your AI feedback doesn't surface any recurring weaknesses. Keep it up!"
                            : "Switch to \"All Courses\" in the header filter to see weak areas from other courses."}
                        </p>
                      </div>
                    )}

                    {/* Active weak area content */}
                    {!weakCLOsLoading && active && (() => {
                      const c = sevColor(active.severity);
                      const hasVideos = active.videos?.length > 0;
                      const hasNotes  = active.notes?.length > 0;
                      const hasMaterials = active.materials?.length > 0;

                      return (
                        <div className="space-y-6">
                          {/* Topic context header (no colored tint background) */}
                          <div className="rounded-2xl p-5 border border-border bg-card/40">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-3 flex-wrap">
                                  <Badge variant="outline" className={`text-xs font-bold capitalize ${c.border} ${c.text} px-2.5 py-0.5`}>
                                    {active.severity || "medium"} severity
                                  </Badge>
                                  {(active.courses ?? []).map((cc: string, idx: number) => (
                                    <Badge key={idx} variant="outline" className="text-xs font-bold border-teal-500/40 text-teal-300 px-2.5 py-0.5">
                                      {cc}
                                    </Badge>
                                  ))}
                                  {active.mappedCLO && (
                                    <Badge variant="outline" className="text-xs font-bold border-purple-500/40 text-purple-300 px-2.5 py-0.5 flex items-center gap-1">
                                      <Sparkles className="h-3 w-3 animate-pulse" /> {active.mappedCLO}
                                    </Badge>
                                  )}
                                  <span className="text-sm text-muted-foreground font-medium">
                                    · flagged in {active.frequency ?? 1} assessment{(active.frequency ?? 1) > 1 ? "s" : ""}
                                  </span>
                                </div>
                                <p className="text-2xl font-extrabold text-foreground leading-tight mb-2">{active.topic || "—"}</p>
                                
                                {/* Mapped CLO Description */}
                                {(() => {
                                  const courseCode = active.courses?.[0];
                                  const courseId = courseMap[courseCode]?.courseId;
                                  const perf = allCloPerf[courseId];
                                  const clo = perf?.find((p: any) => p.cloNumber === active.mappedCLO);
                                  if (clo?.cloDescription) {
                                    return (
                                      <div className="text-sm text-muted-foreground mt-1 mb-2.5 flex items-center gap-1.5 bg-teal-500/5 border border-teal-500/10 rounded-lg px-3 py-1.5 w-fit">
                                        <Target className="h-4 w-4 text-teal-400 shrink-0" />
                                        <span className="font-bold text-teal-400">{active.mappedCLO}:</span>
                                        <span className="text-foreground/90">{clo.cloDescription}</span>
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}

                                {active.reason && (
                                  <p className="text-base text-muted-foreground leading-relaxed">{sanitizeToSecondPerson(active.reason)}</p>
                                )}
                                {(active.assessments ?? []).length > 0 && (
                                  <div className="flex flex-wrap gap-1.5 mt-3">
                                    {active.assessments.map((a: string, idx: number) => (
                                      <span key={idx} className="text-xs px-2.5 py-1 rounded-md border border-border bg-background/40 text-muted-foreground">
                                        {a}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="shrink-0 flex flex-col items-center justify-center">
                                <AlertTriangle className={`h-9 w-9 ${c.icon}`} />
                                <div className={`text-xs uppercase tracking-wider font-bold mt-1.5 ${c.text}`}>{active.severity || "—"}</div>
                              </div>
                            </div>
                          </div>

                          {/* No resources */}
                          {!hasVideos && !hasNotes && !hasMaterials && (
                            <div className="flex flex-col items-center justify-center py-10 text-center">
                              <Search className="h-10 w-10 text-muted-foreground opacity-20 mb-3" />
                              <p className="text-base font-semibold text-muted-foreground">No resources found for this topic.</p>
                              <p className="text-sm text-muted-foreground mt-1">Check that your API keys are configured.</p>
                            </div>
                          )}

                          {/* Course Slides & Materials */}
                          {hasMaterials && (
                            <div>
                              <div className="flex items-center gap-2 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-teal-500/15 border border-teal-500/30 flex items-center justify-center">
                                  <BookOpen className="h-4 w-4 text-teal-400" />
                                </div>
                                <p className="text-sm font-bold uppercase tracking-wider text-foreground">Course Slides &amp; Materials</p>
                                <span className="text-xs font-semibold text-muted-foreground px-2 py-0.5 rounded-full bg-muted/40">{active.materials.length}</span>
                              </div>
                              <div className="space-y-2.5">
                                {active.materials.map((m: any, i: number) => (
                                  <a
                                    key={i}
                                    href={m.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group flex items-start gap-3 p-3.5 rounded-xl border border-border hover:border-teal-500/40 hover:bg-teal-500/5 hover:shadow-md transition-all duration-150"
                                  >
                                    <div className="shrink-0 w-9 h-9 rounded-lg bg-teal-500/10 border border-teal-500/25 flex items-center justify-center">
                                      <FileText className="h-4 w-4 text-teal-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <div className="flex flex-col gap-0.5 min-w-0">
                                          <p className="text-base font-semibold text-foreground leading-snug truncate group-hover:text-teal-400 transition-colors">
                                            {getLectureFriendlyName(m.title, active.courses?.[0])}
                                          </p>
                                          {getLectureFriendlyName(m.title, active.courses?.[0]) !== m.title && (
                                            <span className="text-[11px] text-muted-foreground truncate font-mono">File: {m.title}</span>
                                          )}
                                        </div>
                                        {m.page && (
                                          <Badge variant="outline" className="text-[10px] font-bold border-teal-500/30 text-teal-300 px-1.5 py-0 shrink-0">
                                            Slide Page {m.page}
                                          </Badge>
                                        )}
                                        {m.similarity && (
                                          <Badge variant="outline" className="text-[10px] font-bold border-emerald-500/30 text-emerald-300 px-1.5 py-0 ml-auto">
                                            {Math.round(m.similarity * 100)}% match
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed italic">
                                        "{m.snippet}"
                                      </p>
                                    </div>
                                    <ExternalLink className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1 group-hover:text-teal-400 transition-colors" />
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* YouTube Videos */}
                          {hasVideos && (
                            <div>
                              <div className="flex items-center gap-2 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                                  <Youtube className="h-4 w-4 text-red-400" />
                                </div>
                                <p className="text-sm font-bold uppercase tracking-wider text-foreground">YouTube Videos</p>
                                <span className="text-xs font-semibold text-muted-foreground px-2 py-0.5 rounded-full bg-muted/40">{active.videos.length}</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-5">
                                {active.videos.map((v: any) => (
                                  <a
                                    key={v.id}
                                    href={`https://www.youtube.com/watch?v=${v.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group rounded-xl overflow-hidden border border-border hover:border-red-500/40 hover:shadow-xl hover:-translate-y-1 transition-all duration-200 flex flex-col bg-card"
                                  >
                                    {/* 16:9 thumbnail */}
                                    <div className="relative overflow-hidden aspect-video bg-muted/20">
                                      <img
                                        src={v.thumbnail}
                                        alt={v.title}
                                        className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                      />
                                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/40">
                                        <PlayCircle className="h-14 w-14 text-white drop-shadow-xl" />
                                      </div>
                                      <div className="absolute top-2.5 right-2.5 bg-red-600 rounded-md px-2 py-1 shadow-md flex items-center gap-1">
                                        <Youtube className="h-4 w-4 text-white" />
                                      </div>
                                    </div>
                                    <div className="p-4 flex-1 flex flex-col gap-2">
                                      <p className="text-base font-semibold text-foreground leading-snug line-clamp-2 group-hover:text-red-400 transition-colors">{v.title}</p>
                                      <p className="text-sm text-muted-foreground truncate mt-auto font-medium">{v.channel}</p>
                                    </div>
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Notes & Articles */}
                          {hasNotes && (
                            <div>
                              <div className="flex items-center gap-2 mb-4">
                                <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
                                  <FileText className="h-4 w-4 text-blue-400" />
                                </div>
                                <p className="text-sm font-bold uppercase tracking-wider text-foreground">Notes &amp; Articles</p>
                                <span className="text-xs font-semibold text-muted-foreground px-2 py-0.5 rounded-full bg-muted/40">{active.notes.length}</span>
                              </div>
                              <div className="space-y-2.5">
                                {active.notes.map((n: any, i: number) => (
                                  <a
                                    key={i}
                                    href={n.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group flex items-start gap-3 p-3.5 rounded-xl border border-border hover:border-blue-500/40 hover:bg-blue-500/5 hover:shadow-md transition-all duration-150"
                                  >
                                    <div className="shrink-0 w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/25 flex items-center justify-center">
                                      <FileText className="h-4 w-4 text-blue-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-base font-semibold text-foreground leading-snug line-clamp-1 group-hover:text-blue-400 transition-colors">{n.title}</p>
                                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{n.snippet}</p>
                                      <p className="text-xs text-blue-400/70 mt-1.5 font-medium">{n.domain}</p>
                                    </div>
                                    <ExternalLink className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1 group-hover:text-blue-400 transition-colors" />
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
              );
            })()}

            {/* ── Recent Assessments ── */}
            {recentAssessmentsData.length > 0 ? (
              <Card className="border-border">
                <CardHeader className="pb-3 pt-5 px-6">
                  <CardTitle className="text-2xl font-extrabold tracking-tight flex items-center gap-2">
                    <ClipboardList className="h-5 w-5 text-primary" />
                    Recent Assessments
                    <Badge variant="outline" className="text-sm ml-1">{recentAssessmentsData.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-4">
                  <div className="overflow-x-auto" onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (!target.closest("[data-feedback-btn]")) setFeedbackTooltipId(null);
                  }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="px-6 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Assessment</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Type</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Score</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">CLOs</th>
                          <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">Feedback</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Marking Status</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plagiarism</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Trend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(recentExpanded ? recentAssessmentsData : recentAssessmentsData.slice(0, 5)).map((row, i) => (
                          <tr key={row._id || i} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                            {/* Assessment name */}
                            <td className="px-6 py-3">
                              <div className="flex items-center gap-2 min-w-0">
                                {row.type === "quiz"
                                  ? <FileText className="h-4 w-4 text-primary shrink-0" />
                                  : <PenLine className="h-4 w-4 text-violet-400 shrink-0" />}
                                <span className="font-medium truncate max-w-[200px]">{row.title}</span>
                              </div>
                            </td>
                            {/* Type */}
                            <td className="px-4 py-3">
                              <Badge variant="outline" className="text-xs capitalize">{row.type}</Badge>
                            </td>
                            {/* Score + % */}
                            <td className="px-4 py-3 whitespace-nowrap">
                              {row.isGraded && row.p !== null ? (
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-foreground">{Math.round(row.grade)}/{Math.round(row.maxGrade)}</span>
                                  <span className={`flex items-center gap-0.5 text-xs font-bold ${gradeColor(row.p)}`}>
                                    {row.trend === "improving" ? "▲" : row.trend === "needs_work" ? "▼" : ""}
                                    {row.p}%
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </td>
                            {/* CLOs */}
                            <td className="px-4 py-3">
                              <span className="text-xs text-muted-foreground">
                                {row.clos.length > 0 ? row.clos.join(", ") : "—"}
                              </span>
                            </td>
                            {/* Feedback icon — click to toggle tooltip */}
                            <td className="px-4 py-3 text-center">
                              <div className="relative inline-block">
                                <button
                                  data-feedback-btn
                                  onClick={(e) => { e.stopPropagation(); setFeedbackTooltipId(prev => prev === row._id ? null : row._id); }}
                                  className={`p-1 rounded-full transition-colors ${row.hasFeedback ? "hover:bg-sky-500/10 cursor-pointer" : "cursor-default opacity-30"}`}
                                  disabled={!row.hasFeedback}
                                  title={row.hasFeedback ? "Click to view feedback" : "No feedback yet"}
                                >
                                  <MessageCircle className={`h-4 w-4 ${row.hasFeedback ? "text-sky-400" : "text-muted-foreground"}`} />
                                </button>
                                {feedbackTooltipId === row._id && row.hasFeedback && (
                                  <div className="absolute z-50 top-full left-1/2 -translate-x-1/2 mt-2 w-72 rounded-xl border border-sky-500/30 bg-popover/98 backdrop-blur-sm shadow-2xl p-3">
                                    <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 border-l border-t border-sky-500/30 bg-popover" />
                                    <div className="flex items-center gap-1.5 mb-2">
                                      <MessageCircle className="h-3.5 w-3.5 text-sky-400" />
                                      <p className="text-[11px] font-bold uppercase tracking-wider text-sky-400">Teacher Feedback</p>
                                    </div>
                                    <p className="text-[13px] text-foreground/90 leading-relaxed whitespace-pre-wrap">{row.feedbackText}</p>
                                  </div>
                                )}
                              </div>
                            </td>
                            {/* Marking Status */}
                            <td className="px-4 py-3">
                              {row.isGraded ? (
                                <Badge variant="outline" className="text-xs font-semibold border-emerald-500/40 text-emerald-400">
                                  <CheckCircle className="h-3 w-3 mr-1" /> Marked
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs font-semibold border-orange-500/40 text-orange-400">
                                  <Clock className="h-3 w-3 mr-1" /> Pending
                                </Badge>
                              )}
                            </td>
                            {/* Plagiarism badge — assignment only, shows if report exists */}
                            <td className="px-4 py-3">
                              {row.type === "assignment" ? (() => {
                                const pr = plagiarismReports[row._id?.toString()];
                                if (!pr) return <span className="text-xs text-muted-foreground/50">—</span>;
                                const c = pr.riskLevel === "high"
                                  ? "bg-red-500/15 border-red-500/40 text-red-400"
                                  : pr.riskLevel === "medium"
                                  ? "bg-orange-500/15 border-orange-500/40 text-orange-400"
                                  : "bg-emerald-500/15 border-emerald-500/40 text-emerald-400";
                                return (
                                  <div title={`Internal: ${pr.internalScore}% · AI: ${pr.aiScore}%`}>
                                    <Badge variant="outline" className={`text-xs font-bold ${c}`}>
                                      {pr.overallScore}%
                                    </Badge>
                                  </div>
                                );
                              })() : <span className="text-xs text-muted-foreground/40">N/A</span>}
                            </td>
                            {/* Date */}
                            <td className="px-4 py-3 whitespace-nowrap">
                              <span className="text-xs text-muted-foreground">{row.date}</span>
                            </td>
                            {/* Trend */}
                            <td className="px-4 py-3 whitespace-nowrap">
                              {row.trend === "improving" ? (
                                <span className="flex items-center gap-1 text-xs font-semibold text-emerald-400">
                                  <TrendingUp className="h-3.5 w-3.5" /> Improving
                                </span>
                              ) : row.trend === "needs_work" ? (
                                <span className="flex items-center gap-1 text-xs font-semibold text-red-400">
                                  <TrendingUp className="h-3.5 w-3.5 rotate-180" /> Needs Work
                                </span>
                              ) : row.trend === "stable" ? (
                                <span className="text-xs text-muted-foreground">Stable</span>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {recentAssessmentsData.length > 5 && (
                    <div className="flex justify-center pt-4">
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setRecentExpanded(v => !v)}
                        className="text-sm font-semibold"
                      >
                        {recentExpanded
                          ? "Show Less"
                          : `View Full History (${recentAssessmentsData.length})`}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              !loading && submissions.length === 0 && (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                    <FileText className="h-8 w-8 text-muted-foreground mb-2 opacity-40" />
                    <p className="text-sm text-muted-foreground">No submissions yet{selectedCourse !== "all" ? ` for ${selectedCourse}` : ""}.</p>
                  </CardContent>
                </Card>
              )
            )}


            {/* ── Empty state ── */}
            {submissions.length === 0 && !error && (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <BookOpen className="h-12 w-12 text-muted-foreground mb-4 opacity-40" />
                  <h3 className="font-semibold text-lg mb-2">No Submissions Yet</h3>
                  <p className="text-muted-foreground text-sm mb-6 max-w-sm">
                    You haven't submitted any assessments yet. Once you do, your feedback and grades will appear here.
                  </p>
                  <Button onClick={() => navigate("/student/assessments")}>
                    View Assessments <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default StudentFeedback;
