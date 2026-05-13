import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/firebase";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Download, FileText, Sparkles, User, Calendar } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type LocationState = {
  submissionId?: string;
};

function safeFilename(name: string) {
  return String(name || "AI-Grading-Report")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const ViewReport = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const state = (location.state || {}) as LocationState;
  const submissionId = state.submissionId || searchParams.get("submissionId") || "";

  const [studentId, setStudentId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<any>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [scoreBreakdown, setScoreBreakdown] = useState<any>(null);
  const [scoreLoading, setScoreLoading] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setStudentId(u?.uid || ""));
    return () => unsub();
  }, []);

  useEffect(() => {
    const run = async () => {
      if (!submissionId) {
        setLoading(false);
        toast({ title: "Missing submission", description: "Open this page from Student → View Details → Download." });
        return;
      }
      if (!studentId) return;
      setLoading(true);
      try {
        const res = await fetch(
          `http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/student-report?studentId=${encodeURIComponent(studentId)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success) throw new Error(data?.error || `Failed (${res.status})`);
        setPayload(data);
      } catch (e: any) {
        toast({ title: "Failed to load report", description: e?.message || String(e), variant: "destructive" });
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [submissionId, studentId]);

  // Fetch score breakdown (consistent scoring with plagiarism penalty)
  useEffect(() => {
    const fetchScoreBreakdown = async () => {
      if (!submissionId) return;
      setScoreLoading(true);
      try {
        const res = await fetch(
          `http://localhost:5000/api/plagiarism/score-breakdown/${encodeURIComponent(submissionId)}`
        );
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.scoreBreakdown) {
          setScoreBreakdown(data.scoreBreakdown);
        }
      } catch (e: any) {
        console.warn("Failed to load score breakdown:", e?.message);
      } finally {
        setScoreLoading(false);
      }
    };
    fetchScoreBreakdown();
  }, [submissionId]);

  const header = payload?.submission || null;
  const submissionRaw = payload?.submissionRaw || null;
  const content = payload?.content || null;

  const extractedAnswer = useMemo(() => {
    const raw = String(content?.extraction?.rawText || "").trim();
    const fallback = String(content?.submissionText || "").trim();
    return raw || fallback;
  }, [content]);

  const perQuestion = useMemo(() => {
    const qs = Array.isArray(submissionRaw?.automarkReport?.questions)
      ? submissionRaw.automarkReport.questions
      : Array.isArray(submissionRaw?.perQuestionScores)
        ? submissionRaw.perQuestionScores
        : [];
    return qs;
  }, [submissionRaw]);

  const flatMistakes = useMemo(() => {
    const out: Array<{ qKey: string; text: string; why: string; correct: string }> = [];
    for (const q of perQuestion) {
      const qKey = String(q?.questionKey || "Q").trim();
      const ms = Array.isArray(q?.mistakes) ? q.mistakes : [];
      for (const m of ms) {
        const text = String(m?.feedback || m?.explanation || m?.message || "").trim();
        if (!text) continue;
        out.push({
          qKey,
          text,
          why: String(m?.why_wrong || m?.whyWrong || "").trim(),
          correct: String(m?.suggestion || m?.correct_answer || m?.correctAnswer || "").trim(),
        });
      }
    }
    // De-dupe exact repeats (LLM can repeat same mistake multiple times)
    const seen = new Set<string>();
    const deduped: typeof out = [];
    for (const m of out) {
      const key = `${m.qKey}::${m.text}::${m.why}::${m.correct}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    return deduped;
  }, [perQuestion]);

  const submittedFiles = useMemo(() => {
    const files = Array.isArray(content?.files) ? content.files : [];
    const originals = files.filter((f: any) => !f?.isDerived);
    const names = originals.map((f: any) => String(f?.originalName || f?.filename || "").trim()).filter(Boolean);
    return names.length ? names : files.map((f: any) => String(f?.originalName || f?.filename || "").trim()).filter(Boolean);
  }, [content]);

  const fmt1 = (n: any) => {
    const v = Number(n);
    return Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : "—";
  };

  const finalFeedback = useMemo(() => {
    const lines = perQuestion
      .map((q: any) => {
        const qk = String(q?.questionKey || "Q").trim();
        const fb = String(q?.feedback || "").trim();
        return fb ? `${qk}: ${fb}` : "";
      })
      .filter(Boolean);
    if (lines.length) return lines.join("\n");
    return String(header?.feedback || "").trim();
  }, [header, perQuestion]);

  const plagiarismPercent = useMemo(() => {
    const n = Number((header as any)?.plagiarismBestMatchPercent);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }, [header]);

  const downloadPdf = async () => {
    if (!reportRef.current) return;
    setDownloading(true);
    try {
      const node = reportRef.current;
      const canvas = await html2canvas(node, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        windowWidth: node.scrollWidth,
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF("p", "mm", "a4");
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();

      // Match teacher-side PDF margins for identical output
      const marginX = 12; // mm
      const marginY = 16; // mm
      const usableWidth = pageWidth - marginX * 2;
      const usableHeight = pageHeight - marginY * 2;

      const imgWidth = usableWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;
      let position = marginY;

      pdf.addImage(imgData, "PNG", marginX, position, imgWidth, imgHeight, undefined, "FAST");
      heightLeft -= usableHeight;

      while (heightLeft > 2) {
        pdf.addPage();
        position = marginY - (imgHeight - heightLeft);
        pdf.addImage(imgData, "PNG", marginX, position, imgWidth, imgHeight, undefined, "FAST");
        heightLeft -= usableHeight;
      }

      const student = String(header?.studentName || "Student").trim();
      const title = String(header?.assessmentTitle || "Assessment").trim();
      const fname = safeFilename(`${student} - ${title} - AI Report`);
      pdf.save(`${fname}.pdf`);
    } catch (e: any) {
      toast({ title: "PDF export failed", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-gray-50 to-slate-100">
      <header className="sticky top-0 z-50 bg-white border-b border-primary/10 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-semibold text-gray-900">Report</div>
                <div className="text-xs text-muted-foreground">Download PDF</div>
              </div>
            </div>
            <Button onClick={downloadPdf} disabled={loading || downloading}>
              <Download className="h-4 w-4 mr-2" />
              {downloading ? "Preparing PDF…" : "Download PDF"}
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <div ref={reportRef} className="report-root rounded-xl bg-white px-12 py-12 shadow-sm ring-1 ring-border max-w-[920px] mx-auto">
          <section className="report-section flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                AI Grading Report
              </p>
              <h2 className="mt-2 text-3xl font-bold leading-tight text-foreground">
                {header?.assessmentTitle || "Grading Report"}
              </h2>

              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-primary" />
                  <span className="font-medium text-foreground">
                    {header?.studentName || "—"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-primary" />
                  <span>{header?.submittedAt ? new Date(header.submittedAt).toLocaleString() : "—"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="rounded-full px-4 py-1.5 text-sm font-medium">
                    {header?.assessmentType || "assessment"}
                  </Badge>
                  {header?.courseCode ? (
                    <Badge variant="secondary" className="rounded-full px-4 py-1.5 text-sm font-medium">
                      {header.courseCode}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="shrink-0 text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Total obtained
              </p>
              <p className="mt-1 text-4xl font-bold text-primary">
                {fmt1(header?.grade ?? 0)}
                <span className="text-2xl text-muted-foreground">/{fmt1(header?.maxGrade ?? 0)}</span>
              </p>
            </div>
          </section>

          <Separator className="my-8" />

          <div className="grid gap-6">
            {scoreBreakdown && (
              <Card className="report-card border-primary/10 shadow-none">
                <CardHeader>
                  <CardTitle className="text-lg">Score Breakdown</CardTitle>
                  <CardDescription>Detailed explanation of your grade with plagiarism penalty</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* FINAL SCORE - Prominent display */}
                  <div className="rounded-lg bg-gradient-to-r from-blue-50 to-indigo-50 p-6 border border-blue-200">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-lg font-bold text-foreground">Final Score</span>
                      <span className="text-4xl font-bold text-blue-600">
                        {scoreBreakdown.finalScore?.afterPenalty || 0} / {scoreBreakdown.finalScore?.maxScore || 10}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {scoreBreakdown.finalScore?.percentage?.toFixed(1) || 0}% ({scoreBreakdown.finalScore?.letterGrade || "—"})
                    </div>
                  </div>

                  {/* AI GRADING SCORE */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-semibold text-foreground">AI Grading Score</h4>
                        <p className="text-sm text-muted-foreground">
                          {scoreBreakdown.transparency?.scoreBreakdown?.aiGrade?.explanation}
                        </p>
                      </div>
                      <Badge className="text-lg px-3 py-1 bg-green-100 text-green-900">
                        {scoreBreakdown.grading?.aiScore}/10
                      </Badge>
                    </div>
                  </div>

                  {/* PLAGIARISM DETECTION */}
                  <div className="space-y-3 pt-4 border-t">
                    <h4 className="font-semibold text-foreground">Plagiarism Detection</h4>

                    {/* Internal Plagiarism */}
                    <div className="ml-4 space-y-2">
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="text-sm font-medium text-foreground">Student-to-Student Matching (FAISS)</p>
                          <p className="text-xs text-muted-foreground">
                            {scoreBreakdown.transparency?.scoreBreakdown?.plagiarismDetection?.internal?.explanation}
                          </p>
                        </div>
                        <Badge variant="outline">{scoreBreakdown.plagiarism?.internal?.score || 0}%</Badge>
                      </div>

                      {/* Show matching students if any */}
                      {scoreBreakdown.plagiarism?.internal?.topMatches && scoreBreakdown.plagiarism?.internal?.topMatches.length > 0 && (
                        <div className="ml-2 space-y-1 text-xs bg-orange-50 p-3 rounded border border-orange-100">
                          <p className="font-medium text-orange-900">Top Matching Students:</p>
                          {scoreBreakdown.plagiarism?.internal?.topMatches.map((match: any, idx: number) => (
                            <div key={idx} className="text-orange-800">
                              {idx + 1}. {match.studentName} ({match.similarity}% similar)
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* External Plagiarism (Online Sources / AI Detection) */}
                    <div className="ml-4 space-y-2">
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="text-sm font-medium text-foreground">
                            {scoreBreakdown.plagiarism?.external?.provider === 'zerogpt' ? 'AI-Generated Content Detection' : 'Online Source Detection (via RapidAPI)'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {scoreBreakdown.transparency?.scoreBreakdown?.plagiarismDetection?.external?.explanation}
                          </p>
                        </div>
                        <Badge variant="outline">{scoreBreakdown.plagiarism?.external?.score || 0}%</Badge>
                      </div>

                      {/* Show external sources if any */}
                      {scoreBreakdown.plagiarism?.external?.sources && scoreBreakdown.plagiarism?.external?.sources.length > 0 && (
                        <div className="ml-2 space-y-2 text-xs bg-red-50 p-3 rounded border border-red-100">
                          <p className="font-medium text-red-900">🔗 Detected Online Sources:</p>
                          {scoreBreakdown.plagiarism?.external?.sources.map((source: any, idx: number) => (
                            <div key={idx} className="text-red-800 space-y-1">
                              <div className="font-medium">
                                {idx + 1}. {source.title || 'Unknown Source'}
                              </div>
                              {source.matchPercentage && (
                                <div className="text-red-700">
                                  Match: {source.matchPercentage}%
                                </div>
                              )}
                              {source.url && (
                                <div className="text-red-600 break-all hover:text-red-700 cursor-pointer">
                                  📍 {source.url}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Combined Score */}
                    <div className="ml-4 p-3 bg-gray-50 rounded space-y-1 border border-gray-200">
                      <p className="text-sm font-medium text-foreground">Overall Plagiarism Score</p>
                      <p className="text-xs text-muted-foreground">
                        {scoreBreakdown.transparency?.scoreBreakdown?.plagiarismDetection?.combined?.explanation}
                      </p>
                      <code className="text-xs bg-gray-200 px-2 py-1 rounded block mt-1 text-gray-800">
                        {scoreBreakdown.transparency?.scoreBreakdown?.plagiarismDetection?.combined?.formula}
                      </code>
                      <div className="text-lg font-bold text-gray-700 mt-2">
                        = {scoreBreakdown.plagiarism?.overallScore || 0}%
                      </div>
                    </div>
                  </div>

                  {/* PENALTY APPLICATION */}
                  <div className="space-y-3 pt-4 border-t">
                    <h4 className="font-semibold text-foreground">Penalty Application</h4>

                    <div className="p-3 rounded bg-amber-50 border border-amber-200 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-amber-900">Plagiarism Band:</span>
                        <Badge className="bg-amber-200 text-amber-900">
                          {scoreBreakdown.penalty?.band}
                        </Badge>
                      </div>
                      <p className="text-sm text-amber-900">
                        {scoreBreakdown.transparency?.scoreBreakdown?.penaltyApplication?.reason}
                      </p>
                      <p className="text-sm font-medium text-amber-900">
                        Penalty: {scoreBreakdown.penalty?.penaltyPercent}%
                      </p>
                      <code className="text-xs bg-amber-100 px-2 py-1 rounded block text-amber-900">
                        {scoreBreakdown.transparency?.scoreBreakdown?.penaltyApplication?.calculation}
                      </code>
                    </div>
                  </div>

                  {/* SCORE CALCULATION SUMMARY */}
                  <div className="space-y-3 pt-4 border-t bg-slate-50 p-4 rounded border border-slate-200">
                    <h4 className="font-semibold text-foreground">Score Calculation Summary</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span>AI Grade:</span>
                        <span className="font-medium">{scoreBreakdown.finalScore?.beforePenalty}/10</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Plagiarism Penalty ({scoreBreakdown.penalty?.penaltyPercent}%):</span>
                        <span className="font-medium text-red-600">
                          {scoreBreakdown.finalScore?.penalty?.toFixed(1)}
                        </span>
                      </div>
                      <div className="border-t pt-2 flex justify-between font-bold text-base">
                        <span>Final Score:</span>
                        <span className="text-blue-600">
                          {scoreBreakdown.finalScore?.afterPenalty}/{scoreBreakdown.finalScore?.maxScore}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* STUDENT FEEDBACK */}
                  <div className="p-4 rounded bg-blue-50 border border-blue-200">
                    <h4 className="font-semibold text-foreground mb-2">Feedback</h4>
                    <p className="text-sm text-blue-900">
                      {scoreBreakdown.transparency?.studentFeedback}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="report-card border-primary/10 shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">Submission File</CardTitle>
                <CardDescription>Filename recorded for this submission</CardDescription>
              </CardHeader>
              <CardContent>
                {submittedFiles.length ? (
                  <ul className="space-y-2">
                    {submittedFiles.slice(0, 10).map((n: string, idx: number) => (
                      <li key={idx} className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
                        <FileText className="h-4 w-4 text-primary" />
                        <span className="break-all">{n}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">—</p>
                )}
              </CardContent>
            </Card>

            <Card className="report-card border-primary/10 shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">Full Extracted Answer</CardTitle>
                <CardDescription>Text extracted by the AI grading system</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="extracted-answer whitespace-pre-wrap break-words rounded-md bg-muted/40 p-5 font-sans text-base leading-7 text-foreground">
                  {extractedAnswer || "Extraction not available yet."}
                </pre>
              </CardContent>
            </Card>

            {String(header?.assessmentType || "").toLowerCase() === "assignment" ? (
              <Card className="report-card border-primary/10 shadow-none">
                <CardHeader>
                  <CardTitle className="text-lg">Plagiarism & AI Detection</CardTitle>
                  <CardDescription>Similarity check, AI-generated content analysis, and external sources</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/10 bg-white p-4">
                    <div className="text-sm text-muted-foreground">Student submission match (Internal)</div>
                    <Badge variant={Number(plagiarismPercent || 0) >= 70 ? "destructive" : "outline"} className="text-base">
                      {plagiarismPercent == null ? "—" : `${plagiarismPercent}%`}
                    </Badge>
                  </div>
                  {Number(header?.plagiarismAiScore || 0) > 0 ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                      <div className="text-sm text-amber-900">AI-generated content detected</div>
                      <Badge variant="outline" className="text-base bg-amber-100 text-amber-900 border-amber-200">
                        {Number(header?.plagiarismAiScore || 0)}%
                      </Badge>
                    </div>
                  ) : null}

                  {/* External Plagiarised Sources */}
                  {payload?.plagiarismReport?.sources && payload?.plagiarismReport?.sources.length > 0 ? (
                    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-4">
                      <div className="text-sm font-semibold text-red-900">🔗 Detected Online Sources</div>
                      <ul className="space-y-2">
                        {payload.plagiarismReport.sources.slice(0, 5).map((source: any, idx: number) => (
                          <li key={idx} className="text-xs text-red-800">
                            <div className="font-medium">
                              {idx + 1}. {source.title || 'Unknown Source'}
                            </div>
                            {source.url && (
                              <div className="text-red-600 break-all hover:text-red-700 cursor-pointer mt-1">
                                📍 {source.url}
                              </div>
                            )}
                            {source.matchPercentage && (
                              <div className="text-red-700 mt-1">
                                Match: {source.matchPercentage}%
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                      {payload.plagiarismReport.sources.length > 5 && (
                        <p className="text-xs text-red-700 mt-2">
                          ... and {payload.plagiarismReport.sources.length - 5} more sources
                        </p>
                      )}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Card className="report-card border-primary/10 shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">Mistakes (with explanations)</CardTitle>
                <CardDescription>Detected errors and why they are wrong</CardDescription>
              </CardHeader>
              <CardContent>
                {flatMistakes.length ? (
                  <ul className="space-y-4">
                    {flatMistakes.slice(0, 50).map((m, idx) => (
                      <li key={idx} className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-foreground">{m.qKey}</p>
                          <Badge variant="destructive" className="rounded-full">
                            mistake
                          </Badge>
                        </div>
                        <p className="text-sm leading-relaxed text-foreground">{m.text}</p>
                        {m.why ? (
                          <p className="mt-2 text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">Why wrong: </span>
                            {m.why}
                          </p>
                        ) : null}
                        {m.correct ? (
                          <p className="mt-1 text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">Correct answer: </span>
                            {m.correct}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No mistakes recorded.</p>
                )}
              </CardContent>
            </Card>

            <Card className="report-card border-primary/10 shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">Final Feedback</CardTitle>
                <CardDescription>Improvement suggestions for the student</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap break-words rounded-md bg-primary/5 p-5 font-sans text-base leading-7 text-foreground">
                  {finalFeedback || "No feedback available."}
                </pre>
              </CardContent>
            </Card>
          </div>

          <Separator className="my-8" />

          <footer className="flex flex-col items-center gap-1 text-center">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Sparkles className="h-4 w-4 text-primary" />
              Generated by InteliMark
            </div>
            <p className="text-xs text-muted-foreground">
              Generated at: {new Date().toLocaleString()}
            </p>
          </footer>
        </div>
      </main>
    </div>
  );
};

export default ViewReport;
