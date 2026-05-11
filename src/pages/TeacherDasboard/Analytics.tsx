import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ArrowLeft, BarChart3, TrendingUp, Users, CheckCircle, AlertCircle,
  Award, Clock, Activity, PieChart as PieChartIcon, RefreshCw, Loader2
} from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { auth } from '../../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import axios from 'axios';

const API = 'http://localhost:5000/api';

const scoreColor = (s: number | null) => {
  if (s === null) return 'text-gray-500';
  if (s >= 90) return 'text-green-600';
  if (s >= 80) return 'text-blue-600';
  if (s >= 70) return 'text-orange-600';
  return 'text-red-600';
};

const fmtDate = (d: string | Date | null) => {
  if (!d) return '';
  try {
    const dt = new Date(d);
    const now = new Date();
    const diff = now.getTime() - dt.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  } catch { return ''; }
};

const assessmentPalette = [
  { row: 'border-purple-200 bg-gradient-to-r from-purple-50/80 to-white hover:border-purple-300', dot: 'bg-purple-400', tag: 'bg-purple-100 text-purple-800' },
  { row: 'border-sky-200 bg-gradient-to-r from-sky-50/80 to-white hover:border-sky-300', dot: 'bg-sky-400', tag: 'bg-sky-100 text-sky-800' },
  { row: 'border-emerald-200 bg-gradient-to-r from-emerald-50/80 to-white hover:border-emerald-300', dot: 'bg-emerald-400', tag: 'bg-emerald-100 text-emerald-800' },
  { row: 'border-amber-200 bg-gradient-to-r from-amber-50/80 to-white hover:border-amber-300', dot: 'bg-amber-400', tag: 'bg-amber-100 text-amber-900' },
  { row: 'border-rose-200 bg-gradient-to-r from-rose-50/80 to-white hover:border-rose-300', dot: 'bg-rose-400', tag: 'bg-rose-100 text-rose-800' },
  { row: 'border-indigo-200 bg-gradient-to-r from-indigo-50/80 to-white hover:border-indigo-300', dot: 'bg-indigo-400', tag: 'bg-indigo-100 text-indigo-800' },
];

const colorForAssessment = (title: string) => {
  const s = String(title || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return assessmentPalette[h % assessmentPalette.length];
};

// Deduplicate file-level entries to submission-level
type Sub = {
  submissionId: string; studentId: string; studentName: string;
  courseCode: string; courseName: string; assessmentTitle: string;
  assessmentType: string; status: string; isLate: boolean;
  marks: number | null; grade?: number | null; maxGrade?: number | null;
  uploadedAt: string; feedback: string;
};

const dedup = (uploads: any[]): Sub[] => {
  const map = new Map<string, Sub>();
  for (const u of uploads) {
    const sid = u.submissionId || u._id;
    if (map.has(sid)) continue;
    map.set(sid, {
      submissionId: sid,
      studentId: u.studentId || '',
      studentName: u.studentName || 'Unknown',
      courseCode: u.courseCode || '',
      courseName: u.courseName || '',
      assessmentTitle: u.assessmentTitle || '',
      assessmentType: u.assessmentType || 'assignment',
      status: u.status || 'submitted',
      isLate: Boolean(u.isLate),
      marks: u.marks ?? u.grade ?? null,
      grade: u.marks ?? u.grade ?? null,
      maxGrade: u.maxGrade ?? null,
      uploadedAt: u.uploadedAt || '',
      feedback: typeof u.feedback === 'string' ? u.feedback : '',
    });
  }
  return Array.from(map.values());
};

const Analytics = () => {
  const navigate = useNavigate();
  const [selectedCourse, setSelectedCourse] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [allSubs, setAllSubs] = useState<Sub[]>([]);
  const [perfData, setPerfData] = useState<any>(null);

  const fetchData = async (tid: string) => {
    setLoading(true); setError('');
    try {
      const [subsRes, perfRes] = await Promise.all([
        axios.get(`${API}/submissions/teacher/${encodeURIComponent(tid)}`),
        axios.get(`${API}/submissions/teacher/${encodeURIComponent(tid)}/performance`),
      ]);
      const uploads = Array.isArray(subsRes.data?.uploads) ? subsRes.data.uploads : [];
      setAllSubs(dedup(uploads));
      setPerfData(perfRes.data || null);
    } catch (e: any) {
      setError(e?.response?.data?.error || e.message || 'Failed to load analytics');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) return navigate('/');
      setTeacherId(user.uid);
      fetchData(user.uid);
    });
    return () => unsub();
  }, []);

  // Filter by course
  const subs = useMemo(() =>
    selectedCourse === 'all' ? allSubs : allSubs.filter(s => s.courseCode === selectedCourse),
    [allSubs, selectedCourse]
  );

  const graded = useMemo(() => subs.filter(s => s.status === 'graded'), [subs]);
  const courseCodes = useMemo(() => Array.from(new Set(allSubs.map(s => s.courseCode).filter(Boolean))), [allSubs]);
  const uniqueStudentIds = useMemo(() => new Set(subs.map(s => s.studentId).filter(Boolean)), [subs]);

  // Per-student overall percentage: totalMarksEarned / totalMaxMarks * 100
  const studentAvgs = useMemo(() => {
    const map: Record<string, { name: string; sumGrade: number; sumMax: number; subs: number }> = {};
    for (const s of graded) {
      const g = Number(s.grade ?? 0), m = Number(s.maxGrade ?? 0);
      if (m <= 0) continue;
      if (!map[s.studentId]) map[s.studentId] = { name: s.studentName, sumGrade: 0, sumMax: 0, subs: 0 };
      map[s.studentId].sumGrade += g;
      map[s.studentId].sumMax += m;
      map[s.studentId].subs += 1;
    }
    return Object.entries(map)
      .map(([id, v]) => ({ id, name: v.name, avg: v.sumMax > 0 ? Math.round((v.sumGrade / v.sumMax) * 100) : 0, subs: v.subs, totalMarks: Math.round(v.sumGrade * 10) / 10, totalMax: Math.round(v.sumMax * 10) / 10 }))
      .sort((a, b) => b.avg - a.avg);
  }, [graded]);

  // KPIs
  const avgScore = useMemo(() => {
    if (!graded.length) return 0;
    const sum = graded.reduce((a, s) => {
      const m = Number(s.maxGrade ?? 0);
      return a + (m > 0 ? (Number(s.grade ?? 0) / m) * 100 : 0);
    }, 0);
    return Math.round(sum / graded.length * 10) / 10;
  }, [graded]);

  const passRate = useMemo(() => {
    if (!studentAvgs.length) return 0;
    const passing = studentAvgs.filter(s => s.avg >= 60).length;
    return Math.round((passing / studentAvgs.length) * 100);
  }, [studentAvgs]);

  const pendingCount = useMemo(() => subs.filter(s => s.status !== 'graded').length, [subs]);

  // Grade distribution
  const gradeDist = useMemo(() => {
    const buckets = [
      { range: 'A (90-100)', count: 0 },
      { range: 'B (80-89)', count: 0 },
      { range: 'C (70-79)', count: 0 },
      { range: 'D (60-69)', count: 0 },
      { range: 'F (Below 60)', count: 0 },
    ];
    for (const s of studentAvgs) {
      if (s.avg >= 90) buckets[0].count++;
      else if (s.avg >= 80) buckets[1].count++;
      else if (s.avg >= 70) buckets[2].count++;
      else if (s.avg >= 60) buckets[3].count++;
      else buckets[4].count++;
    }
    const total = studentAvgs.length || 1;
    return buckets.map(b => ({ ...b, percentage: Math.round((b.count / total) * 100) }));
  }, [studentAvgs]);

  // Top / Low performers
  const topPerformers = useMemo(() => studentAvgs.slice(0, 5), [studentAvgs]);
  const lowPerformers = useMemo(() =>
    studentAvgs.filter(s => s.avg < 70).sort((a, b) => a.avg - b.avg).slice(0, 5),
    [studentAvgs]
  );

  // Per-assessment analytics
  const assessmentStats = useMemo(() => {
    const map: Record<string, { title: string; type: string; grades: number[]; total: number; graded: number }> = {};
    for (const s of subs) {
      const key = s.assessmentTitle || 'Unknown';
      if (!map[key]) map[key] = { title: key, type: s.assessmentType, grades: [], total: 0, graded: 0 };
      map[key].total++;
      if (s.status === 'graded') {
        map[key].graded++;
        const m = Number(s.maxGrade ?? 0);
        if (m > 0) map[key].grades.push((Number(s.grade ?? 0) / m) * 100);
      }
    }
    return Object.values(map).map(a => ({
      ...a,
      avgScore: a.grades.length ? Math.round(a.grades.reduce((x, y) => x + y, 0) / a.grades.length) : null,
      submissionRate: a.total > 0 ? Math.round((a.graded / a.total) * 100) : 0,
    })).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));
  }, [subs]);

  // Recent submissions (latest 10)
  const recentSubs = useMemo(() =>
    [...subs].sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()).slice(0, 10),
    [subs]
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-gray-50 to-slate-100">
      {/* Header */}
      <div className="px-4 md:px-6 pt-8 pb-6 bg-white/80 backdrop-blur-md shadow-sm border-b border-primary/10">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Button variant="ghost" onClick={() => navigate('/teacher-dashboard')} className="hover:bg-primary/10 p-2 rounded-lg">
                <ArrowLeft className="h-5 w-5 text-gray-700" />
              </Button>
              <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                  Analytics Dashboard
                </h1>
                <p className="text-sm text-muted-foreground mt-1">Real-time student performance and course analytics</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => teacherId && fetchData(teacherId)} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />Refresh
            </Button>
          </div>

          {/* Filters */}
          <div className="flex gap-4 flex-wrap">
            <Select value={selectedCourse} onValueChange={setSelectedCourse}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select Course" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Courses</SelectItem>
                {courseCodes.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <main className="px-4 md:px-6 py-8">
        <div className="max-w-7xl mx-auto space-y-8">

          {error && (
            <Card className="border-red-300 bg-red-50">
              <CardContent className="flex items-center gap-3 py-4">
                <AlertCircle className="h-5 w-5 text-red-500" />
                <p className="text-sm text-red-700">{error}</p>
              </CardContent>
            </Card>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading analytics…</p>
            </div>
          ) : (
            <>
              {/* KPI Cards */}
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <Card className="bg-white border border-primary/15 hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Average Score</p>
                        <h3 className="text-3xl font-bold text-primary">{avgScore}%</h3>
                      </div>
                      <div className="p-3 bg-primary/10 rounded-lg"><Award className="h-6 w-6 text-primary" /></div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-white border border-green-200 hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Pass Rate</p>
                        <h3 className="text-3xl font-bold text-green-600">{passRate}%</h3>
                      </div>
                      <div className="p-3 bg-green-100 rounded-lg"><CheckCircle className="h-6 w-6 text-green-600" /></div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-white border border-blue-200 hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Total Students</p>
                        <h3 className="text-3xl font-bold text-blue-600">{uniqueStudentIds.size}</h3>
                      </div>
                      <div className="p-3 bg-blue-100 rounded-lg"><Users className="h-6 w-6 text-blue-600" /></div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-white border border-purple-200 hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Total Submissions</p>
                        <h3 className="text-3xl font-bold text-purple-600">{subs.length}</h3>
                      </div>
                      <div className="p-3 bg-purple-100 rounded-lg"><Activity className="h-6 w-6 text-purple-600" /></div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-white border border-orange-200 hover:shadow-lg transition-shadow">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground mb-1">Pending Grading</p>
                        <h3 className="text-3xl font-bold text-orange-600">{pendingCount}</h3>
                      </div>
                      <div className="p-3 bg-orange-100 rounded-lg"><Clock className="h-6 w-6 text-orange-600" /></div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Grade Distribution + Needs Attention */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="bg-white border border-primary/15">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><PieChartIcon className="h-5 w-5 text-primary" />Grade Distribution</CardTitle>
                    <CardDescription>Based on {studentAvgs.length} student averages</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {gradeDist.map(g => (
                      <div key={g.range}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">{g.range}</span>
                          <span className="text-sm text-muted-foreground">{g.count} student{g.count !== 1 ? 's' : ''}</span>
                        </div>
                        <Progress value={g.percentage} className="h-2" />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className="bg-white border border-red-200">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-red-600" />Needs Attention</CardTitle>
                    <CardDescription>Students below 70% average</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {lowPerformers.length === 0 ? (
                      <div className="text-center py-4">
                        <CheckCircle className="h-8 w-8 text-green-400 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">All students are performing well!</p>
                      </div>
                    ) : lowPerformers.map((s, i) => (
                      <div key={s.id} className="flex items-center justify-between p-3 bg-red-50 rounded-lg border border-red-200 hover:bg-red-100 transition-colors">
                        <div>
                          <p className="text-sm font-semibold text-black">{s.name}</p>
                          <p className="text-xs text-muted-foreground">{s.subs} submission{s.subs !== 1 ? 's' : ''}</p>
                        </div>
                        <Badge className="bg-red-100 text-red-700">{s.avg}%</Badge>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>

              {/* Top Performers Bar Chart */}
              <Card className="bg-white border border-green-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-green-600" />Top Performers</CardTitle>
                  <CardDescription>Overall grade percentage across all teacher-graded assessments</CardDescription>
                </CardHeader>
                <CardContent>
                  {topPerformers.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No graded data yet</p>
                  ) : (
                    <div className="space-y-3">
                      {topPerformers.map((s, i) => {
                        const barColor = s.avg >= 80 ? 'bg-gradient-to-r from-green-400 to-green-500' : s.avg >= 60 ? 'bg-gradient-to-r from-blue-400 to-blue-500' : s.avg >= 40 ? 'bg-gradient-to-r from-orange-400 to-orange-500' : 'bg-gradient-to-r from-red-400 to-red-500';
                        return (
                          <div key={s.id} className="group">
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-gray-400 w-5">#{i + 1}</span>
                                <span className="text-sm font-semibold text-black">{s.name}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">{s.totalMarks}/{s.totalMax}</span>
                                <span className="text-sm font-bold text-black">{s.avg}%</span>
                              </div>
                            </div>
                            <div className="w-full bg-gray-100 rounded-full h-5 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${barColor} transition-all duration-500 group-hover:opacity-90 group-hover:shadow-md`}
                                style={{ width: `${Math.max(s.avg, 3)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Assessment Analytics */}
              {assessmentStats.length > 0 && (
                <Card className="bg-white border border-primary/15">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-primary" />Assessment Analytics</CardTitle>
                    <CardDescription>Performance metrics for each assessment</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {assessmentStats.map((a, idx) => (
                        <div
                          key={idx}
                          className={[
                            "p-4 rounded-xl border transition-all",
                            "hover:shadow-md hover:-translate-y-0.5",
                            idx % 5 === 0 ? "border-purple-200 bg-gradient-to-br from-purple-50 to-white hover:border-purple-300" :
                            idx % 5 === 1 ? "border-sky-200 bg-gradient-to-br from-sky-50 to-white hover:border-sky-300" :
                            idx % 5 === 2 ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white hover:border-emerald-300" :
                            idx % 5 === 3 ? "border-amber-200 bg-gradient-to-br from-amber-50 to-white hover:border-amber-300" :
                            "border-rose-200 bg-gradient-to-br from-rose-50 to-white hover:border-rose-300",
                          ].join(" ")}
                        >
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-semibold text-black">{a.title}</h4>
                            <Badge
                              variant="outline"
                              className={[
                                "capitalize font-semibold",
                                idx % 5 === 0 ? "bg-purple-100/70 text-purple-800 border-purple-200" :
                                idx % 5 === 1 ? "bg-sky-100/70 text-sky-800 border-sky-200" :
                                idx % 5 === 2 ? "bg-emerald-100/70 text-emerald-800 border-emerald-200" :
                                idx % 5 === 3 ? "bg-amber-100/70 text-amber-900 border-amber-200" :
                                "bg-rose-100/70 text-rose-800 border-rose-200",
                              ].join(" ")}
                            >
                              {a.type}
                            </Badge>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">Average Score</p>
                              <p className={`text-lg font-bold ${a.avgScore !== null ? scoreColor(a.avgScore) : 'text-gray-400'}`}>
                                {a.avgScore !== null ? `${a.avgScore}%` : 'Pending'}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">Graded / Total</p>
                              <div className="flex items-center gap-2">
                                <Progress value={a.total > 0 ? (a.graded / a.total) * 100 : 0} className="flex-1 h-2" />
                                <span className="text-sm font-medium">{a.graded}/{a.total}</span>
                              </div>
                            </div>
                            <div className="hidden md:block">
                              <p className="text-xs text-muted-foreground mb-1">Status</p>
                              <Badge className={a.graded === a.total && a.total > 0 ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}>
                                {a.graded === a.total && a.total > 0 ? 'Completed' : 'In Progress'}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Recent Submissions */}
              {recentSubs.length > 0 && (
                <Card className="bg-white border border-primary/15">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5 text-primary" />Recent Submissions</CardTitle>
                    <CardDescription>Latest student submissions and grades</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {recentSubs.map((s, idx) => {
                        const g = Number(s.grade ?? 0), m = Number(s.maxGrade ?? 0);
                        const pct = m > 0 ? Math.round((g / m) * 100) : null;
                        const theme = colorForAssessment(s.assessmentTitle);
                        return (
                          <div
                            key={idx}
                            className={`flex items-center justify-between p-4 border rounded-xl transition-all hover:shadow-md ${theme.row}`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} />
                                <h4 className="font-semibold text-black">{s.studentName}</h4>
                              </div>
                              <p className="text-sm text-muted-foreground truncate">
                                {s.assessmentTitle}
                                {s.courseCode ? (
                                  <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${theme.tag}`}>
                                    {s.courseCode}
                                  </span>
                                ) : null}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">{fmtDate(s.uploadedAt)}</p>
                            </div>
                            <div className="flex items-center gap-4">
                              {s.status === 'graded' && pct !== null && (
                                <div className="text-right">
                                  <p className="text-xs text-muted-foreground mb-1">Score</p>
                                  <p className={`text-lg font-bold ${scoreColor(pct)}`}>{pct}%</p>
                                </div>
                              )}
                              <Badge className={s.status === 'graded' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}>
                                {s.status === 'graded' ? 'Completed' : 'Pending'}
                              </Badge>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Empty state */}
              {subs.length === 0 && !error && (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                    <BarChart3 className="h-12 w-12 text-muted-foreground mb-4 opacity-40" />
                    <h3 className="font-semibold text-lg mb-2">No Submissions Yet</h3>
                    <p className="text-muted-foreground text-sm max-w-sm">
                      Analytics will appear here once students start submitting assessments.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
};

export default Analytics;
