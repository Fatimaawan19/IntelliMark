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
                  <CardTitle className="text-lg">Plagiarism Check</CardTitle>
                  <CardDescription>Similarity against other students for this assessment</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/10 bg-white p-4">
                    <div className="text-sm text-muted-foreground">Best match</div>
                    <Badge variant={Number(plagiarismPercent || 0) >= 70 ? "destructive" : "outline"} className="text-base">
                      {plagiarismPercent == null ? "—" : `${plagiarismPercent}%`}
                    </Badge>
                  </div>
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
