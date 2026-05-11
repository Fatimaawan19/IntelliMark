import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ChevronLeft, Brain, Target, TrendingUp, AlertCircle, CheckCircle,
  BookOpen, FileText, Clock, Award, RefreshCw, ChevronRight,
  Star, BarChart3, Zap, ThumbsUp, AlertTriangle, ClipboardList
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../../firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, collection, getDocs, query, where, documentId } from "firebase/firestore";
import axios from "axios";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell, LabelList } from "recharts";

const API = "http://localhost:5000/api";

const pct = (grade: number, max: number) => max > 0 ? Math.round((grade / max) * 100) : 0;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const COURSE_COLORS = [
  "#2563eb", // blue-600
  "#7c3aed", // violet-600
  "#db2777", // pink-600
  "#ea580c", // orange-600
  "#16a34a", // green-600
  "#0891b2", // cyan-600
  "#4f46e5", // indigo-600
  "#0f766e", // teal-700
];

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
  const w = 140;
  const h = 34;
  const pad = 3;
  const pts = (values || []).slice(-8).map(v => clamp(Number(v) || 0, 0, 100));
  if (pts.length === 0) return <div className="h-[34px]" />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const xStep = pts.length > 1 ? (w - pad * 2) / (pts.length - 1) : 0;
  const y = (v: number) => {
    if (max === min) return h / 2;
    return pad + ((100 - ((v - min) / (max - min)) * 100) / 100) * (h - pad * 2);
  };
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

// ── component ──────────────────────────────────────────────────────────────────
const StudentFeedback = () => {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [courses, setCourses] = useState<any[]>([]);
  const [activeCourse, setActiveCourse] = useState<string>("all");
  const [currentUser, setCurrentUser] = useState<any>(null);

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

  // ── derived ───────────────────────────────────────────────────────────────────
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
    const map: Record<
      string,
      { sum: number; count: number; name: string; points: { p: number; t: number }[] }
    > = {};
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
    return Object.entries(map)
      .map(([code, v]) => {
        const sorted = [...v.points].sort((a, b) => a.t - b.t);
        const series = sorted.map(x => Math.round(x.p));
        const avg = v.count > 0 ? Math.round(v.sum / v.count) : 0;
        const last = series.length ? series[series.length - 1] : null;
        const prev = series.length > 1 ? series[series.length - 2] : null;
        const delta = last != null && prev != null ? last - prev : null;
        return { code, name: v.name, avg, count: v.count, last, delta, series };
      })
      .sort((a, b) => b.avg - a.avg);
  }, [graded]);

  const bestCourse = courseAvgs[0] ?? null;

  const filteredGraded  = useMemo(() => activeCourse === "all" ? graded  : graded.filter(s => s.courseCode === activeCourse),  [graded, activeCourse]);
  const filteredPending = useMemo(() => activeCourse === "all" ? pending : pending.filter(s => s.courseCode === activeCourse), [pending, activeCourse]);
  const subCourseCodes  = useMemo(() => Array.from(new Set(submissions.map(s => s.courseCode).filter(Boolean))), [submissions]);

  // ── helpers for safe extraction ───────────────────────────────────────────────
  const getFeedbackText = (s: any): string =>
    typeof s.feedback === "string" ? s.feedback
    : typeof s.feedback?.feedback === "string" ? s.feedback.feedback : "";

  const getMistakes = (s: any): string[] =>
    (Array.isArray(s.mistakes) ? s.mistakes : [])
      .map((m: any) => typeof m === "string" ? m : m?.topic || m?.description || "")
      .filter(Boolean);

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-md border-b border-border">
        <div className="container mx-auto px-6 py-3 flex items-center justify-between max-w-7xl">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/student-dashboard")}
              className="hover:bg-primary/10 hover:text-primary transition-colors"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                Feedback &amp; Focus Areas
              </h1>
              <p className="text-sm text-muted-foreground">Real-time results from your submissions</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => currentUser && fetchAll(currentUser.uid, courses.map((c: any) => c.id))} disabled={loading} className="hover:bg-primary/10 hover:border-primary/50 transition-all">
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-6 py-6 max-w-7xl space-y-6">

        {/* Error */}
        {error && (
          <Card className="border-red-500/30 bg-red-500/10">
            <CardContent className="flex items-center gap-3 py-3">
              <AlertCircle className="h-5 w-5 text-red-400 shrink-0" />
              <p className="text-sm text-red-300">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Loading */}
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
                { icon: ClipboardList, label: "Total", value: submissions.length, color: "text-primary", bg: "bg-primary/10", border: "hover:border-primary/50" },
                { icon: CheckCircle,   label: "Graded", value: graded.length,     color: "text-sky-500", bg: "bg-sky-500/10", border: "hover:border-sky-500/50" },
                { icon: Award,         label: "Avg Grade", value: graded.length ? `${avgGrade}%` : "—", color: gradeColor(avgGrade), bg: "bg-yellow-500/10", border: "hover:border-yellow-500/50" },
                { icon: TrendingUp,    label: "Trend", value: improvementDelta == null ? "—" : `${improvementDelta > 0 ? "+" : ""}${improvementDelta}%`, color: improvementDelta == null ? "text-muted-foreground" : improvementDelta >= 0 ? "text-emerald-400" : "text-red-400", bg: "bg-muted/20", border: "hover:border-border" },
              ].map(({ icon: Icon, label, value, color, bg, border }) => (
                <Card key={label} className={`border-border bg-card transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 cursor-default ${border}`}>
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

            {/* ── AI Insights + Course Performance (side by side) ── */}
            {graded.length > 0 && (
              <div className="grid md:grid-cols-2 gap-4">
                {/* AI Insights */}
                <Card className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent border-primary/30 hover:shadow-lg hover:border-primary/50 transition-all duration-200">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="flex items-center gap-2 text-base font-semibold">
                      <Brain className="h-5 w-5 text-primary" />AI Performance Insights
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pb-4">
                    <div className="flex items-center gap-3 p-2.5 bg-background/40 rounded-lg hover:bg-background/60 transition-colors">
                      <Star className="h-4 w-4 text-yellow-400 shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Best Course</p>
                        <p className="text-base font-medium">{bestCourse ? `${bestCourse.code} — ${bestCourse.avg}%` : "Not enough data"}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 bg-background/40 rounded-lg hover:bg-background/60 transition-colors">
                      <Zap className="h-4 w-4 text-primary shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Trend</p>
                        <p className="text-base font-medium">
                          {improvementDelta == null ? "Submit more to track" : improvementDelta > 0 ? `Improving ↑ ${improvementDelta}% vs last` : improvementDelta < 0 ? `Declining ↓ ${Math.abs(improvementDelta)}% vs last` : "Steady performance"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 bg-background/40 rounded-lg hover:bg-background/60 transition-colors">
                      <Clock className="h-4 w-4 text-orange-400 shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Awaiting Feedback</p>
                        <p className="text-base font-medium">{pending.length} submission{pending.length !== 1 ? "s" : ""}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Course Performance */}
                {courseAvgs.length > 0 ? (
                  <Card className="border-border hover:shadow-lg hover:border-primary/30 transition-all duration-200">
                    <CardHeader className="pb-2 pt-4">
                      <CardTitle className="flex items-center gap-2 text-base font-semibold">
                        <BarChart3 className="h-5 w-5 text-primary" />Performance by Course
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-3 pt-2">
                      <div className="w-full mt-5">
                        <ResponsiveContainer width="100%" height={245}>
                          <BarChart
                            data={courseAvgs}
                            margin={{ top: 10, right: 0, left: 22, bottom: 36 }}
                            barCategoryGap="8%"
                            barGap={4}
                            maxBarSize={52}
                          >
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.10)" vertical={false} />
                          <XAxis 
                            dataKey="code" 
                            height={46}
                            interval={0}
                            tick={{ fontSize: 10, fontWeight: 600, fill: "rgba(0,0,0,0.88)" }}
                            axisLine={{ stroke: "rgba(0,0,0,0.75)", strokeWidth: 1.5 }}
                            tickLine={{ stroke: "rgba(0,0,0,0.65)" }}
                            label={{ value: "Courses", position: "insideBottom", offset: -8, fill: "rgba(0,0,0,0.85)", fontSize: 12, fontWeight: 700 }}
                            tickFormatter={(code: any) => {
                              return String(code ?? "");
                            }}
                          />
                          <YAxis 
                            domain={[0, 100]}
                            ticks={[0, 20, 40, 60, 80, 100]}
                            tick={{ fontSize: 12, fontWeight: 600, fill: "rgba(0,0,0,0.88)" }}
                            axisLine={{ stroke: "rgba(0,0,0,0.75)", strokeWidth: 1.5 }}
                            tickLine={{ stroke: "rgba(0,0,0,0.65)" }}
                            label={{ value: "Marks %", angle: -90, position: "insideLeft", offset: -10, fill: "rgba(0,0,0,0.85)", fontSize: 13, fontWeight: 700 }}
                          />
                          <Tooltip 
                            cursor={{ fill: "rgba(255,255,255,0.08)" }}
                            content={({ active, payload, label }: any) => {
                              if (!active || !payload?.length) return null;
                              const row = courseAvgs.find((c: any) => c.code === label);
                              const name = row?.name || String(label || "");
                              const val = payload?.[0]?.value ?? row?.avg ?? 0;
                              const count = row?.count ?? 0;
                              const last = row?.last;
                              const delta = row?.delta;
                              return (
                                <div className="rounded-lg border border-black/10 bg-white px-3 py-2 shadow-lg">
                                  <div className="text-sm font-semibold text-black">{name}</div>
                                  <div className="mt-1 space-y-0.5 text-xs text-black/80">
                                    <div>
                                      Average Grade: <span className="font-semibold text-black">{val}%</span>
                                    </div>
                                    <div>
                                      Submissions: <span className="font-semibold text-black">{count}</span>
                                      {last != null ? (
                                        <span className="text-black/70"> • last: <span className="font-semibold text-black">{last}%</span></span>
                                      ) : null}
                                    </div>
                                    {delta != null ? (
                                      <div className={delta >= 0 ? "text-emerald-700" : "text-red-700"}>
                                        Trend: <span className="font-semibold">{delta >= 0 ? "+" : ""}{delta}%</span> vs previous
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Bar 
                            dataKey="avg" 
                            radius={[6, 6, 0, 0]}
                            barSize={42}
                            background={{ fill: "rgba(255,255,255,0.07)" }}
                          >
                            {courseAvgs.map((entry: any, index: number) => {
                              return <Cell key={`cell-${index}`} fill={colorForCourse(entry?.code)} fillOpacity={1} />;
                            })}
                            <LabelList
                              dataKey="avg"
                              position="top"
                              formatter={(v: any) => `${v}%`}
                              fill="rgba(0,0,0,0.9)"
                              fontSize={12}
                            />
                          </Bar>
                        </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border-border flex items-center justify-center">
                    <CardContent className="text-center py-8">
                      <BarChart3 className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                      <p className="text-sm text-muted-foreground">No course data yet</p>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

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
                      <Badge variant="outline" className="text-xs border-orange-500/30 text-orange-400 shrink-0">{count}x</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* ── Filter + Graded (single container) ── */}
            <div className="space-y-4">
              {subCourseCodes.length > 1 && (
                <Card className="border-border hover:shadow-lg transition-all duration-200">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="flex items-center gap-2 text-base font-semibold">
                      <BookOpen className="h-5 w-5 text-primary" />Filter by Course
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-4">
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant={activeCourse === "all" ? "default" : "outline"} onClick={() => setActiveCourse("all")} className="text-sm h-8">All</Button>
                      {subCourseCodes.map(code => (
                        <Button key={code} size="sm" variant={activeCourse === code ? "default" : "outline"} onClick={() => setActiveCourse(code)} className="text-sm h-8">{code}</Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

            {/* ── Graded Submissions (2-col grid) ── */}
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
                <CheckCircle className="h-5 w-5 text-emerald-400" />
                Graded Submissions
                <Badge variant="outline" className="text-sm">{filteredGraded.length}</Badge>
              </h2>

              {filteredGraded.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                    <FileText className="h-8 w-8 text-muted-foreground mb-2 opacity-40" />
                    <p className="text-sm text-muted-foreground">No graded submissions yet{activeCourse !== "all" ? ` for ${activeCourse}` : ""}.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid md:grid-cols-2 gap-4">
                  {filteredGraded.map((s, i) => {
                    const grade = Number(s.grade ?? 0);
                    const maxGrade = Number(s.maxGrade ?? 0);
                    const gradePercent = pct(grade, maxGrade);
                    const feedbackText = getFeedbackText(s);
                    const mistakes = getMistakes(s);
                    const hasAI = Boolean(s.aiAnalysis || s.aiGradingSuggestion != null);
                    const isActiveCourseCard = activeCourse !== "all" && s.courseCode === activeCourse;
                    // Recommended notes (external links) — temporarily disabled.
                    // const rec = (s as any)?.recommendedResource;

                    return (
                      <Card
                        key={s._id || i}
                        className={[
                          "border-border bg-card transition-all duration-200 group",
                          "hover:shadow-xl hover:-translate-y-0.5 hover:border-primary/30",
                          isActiveCourseCard
                            ? "ring-2 ring-purple-500/70 border-purple-500/50 shadow-lg shadow-purple-500/15 scale-[1.01]"
                            : "",
                        ].join(" ")}
                      >
                        <CardContent className="pt-4 pb-4 space-y-3">
                          {/* Top row */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                <Badge variant="outline" className="text-xs capitalize">{s.assessmentType || "assignment"}</Badge>
                                <Badge variant="outline" className="text-xs text-primary border-primary/30">{s.courseCode}</Badge>
                                {s.isLate && <Badge variant="outline" className="text-xs text-orange-400 border-orange-400/30">Late</Badge>}
                                {s.reportPublished && <Badge variant="outline" className="text-xs text-sky-400 border-sky-400/30">📋 Report</Badge>}
                              </div>
                              <h3 className="font-semibold text-base leading-tight truncate group-hover:text-primary transition-colors">{s.assessmentTitle || "Assessment"}</h3>
                              <p className="text-xs text-muted-foreground mt-0.5">{s.courseName || s.courseCode} · {fmtDate(s.submittedAt)}</p>
                            </div>
                            {/* Grade pill */}
                            <div className={`flex flex-col items-center justify-center w-20 h-16 rounded-xl border font-bold shrink-0 ${gradeBg(gradePercent)}`}>
                              <span className="text-2xl leading-none">{gradePercent}%</span>
                              <span className="text-xs opacity-70 mt-0.5">{grade}/{maxGrade}</span>
                            </div>
                          </div>

                          {/* Teacher feedback */}
                          {feedbackText.trim() && (
                            <div className="p-2.5 rounded-lg bg-muted/30 border border-border hover:bg-muted/50 transition-colors">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                                <ThumbsUp className="h-4 w-4" />Teacher Feedback
                              </p>
                              <p className="text-sm leading-relaxed line-clamp-3">{feedbackText}</p>
                            </div>
                          )}

                          {/*
                          Recommended notes link — disabled.
                          {feedbackText.trim() && rec?.url && (
                            <a href={rec.url} target="_blank" rel="noreferrer" className="...">...</a>
                          )}
                          */}

                          {/* AI grading */}
                          {hasAI && s.aiConfidence != null && (
                            <div className="p-2.5 rounded-lg bg-primary/5 border border-primary/20 hover:bg-primary/10 transition-colors">
                              <p className="text-xs font-semibold text-primary uppercase tracking-wide flex items-center gap-1">
                                <Brain className="h-4 w-4" />AI Grading · {s.aiConfidence}% confidence
                              </p>
                              {s.aiGradingSuggestion != null && (
                                <p className="text-xs text-muted-foreground mt-0.5">Suggested: {s.aiGradingSuggestion}/{maxGrade}</p>
                              )}
                            </div>
                          )}

                          {/* Mistakes */}
                          {mistakes.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {mistakes.slice(0, 3).map((m, idx) => (
                                <span key={idx} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-300">
                                  <AlertCircle className="h-3 w-3" />{m}
                                </span>
                              ))}
                              {mistakes.length > 3 && (
                                <span className="text-xs px-2.5 py-1 rounded-full bg-muted/40 text-muted-foreground">+{mistakes.length - 3} more</span>
                              )}
                            </div>
                          )}

                          {/* No feedback */}
                          {!feedbackText.trim() && mistakes.length === 0 && (
                            <p className="text-sm text-muted-foreground italic">No written feedback provided yet.</p>
                          )}

                          {/* Report button */}
                          {s.reportPublished && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full text-sm h-8 font-semibold text-sky-500 border-sky-500/35 hover:bg-sky-500/10 hover:border-sky-500/70 focus:text-sky-500 focus-visible:text-sky-500 active:text-sky-500 transition-all"
                              onClick={() => navigate(`/view-report?submissionId=${s._id}`)}>
                              View Full Report <ChevronRight className="h-4 w-4 ml-1" />
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
            </div>

            {/* ── Awaiting Feedback (2-col grid) ── */}
            {filteredPending.length > 0 && (
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
                  <Clock className="h-5 w-5 text-orange-400" />
                  Awaiting Feedback
                  <Badge variant="outline" className="text-sm border-orange-400/40 text-orange-400">{filteredPending.length}</Badge>
                </h2>
                <div className="grid md:grid-cols-2 gap-3">
                  {filteredPending.map((s, i) => (
                    <Card key={s._id || i} className="border-border opacity-80 hover:opacity-100 hover:shadow-md hover:border-orange-400/30 transition-all duration-200">
                      <CardContent className="pt-3 pb-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex gap-1.5 mb-1 flex-wrap">
                              <Badge variant="outline" className="text-xs capitalize">{s.assessmentType || "assignment"}</Badge>
                              <Badge variant="outline" className="text-xs text-primary border-primary/30">{s.courseCode}</Badge>
                              {s.isLate && <Badge variant="outline" className="text-xs text-orange-400 border-orange-400/30">Late</Badge>}
                            </div>
                            <p className="font-medium text-base truncate">{s.assessmentTitle || "Assessment"}</p>
                            <p className="text-xs text-muted-foreground">{fmtDate(s.submittedAt)}</p>
                          </div>
                          <Badge className="bg-orange-500/20 text-orange-300 border-orange-500/30 capitalize shrink-0 text-xs">
                            {s.status?.replace("_", " ") || "Pending"}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
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
