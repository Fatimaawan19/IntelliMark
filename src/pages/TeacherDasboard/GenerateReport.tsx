import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/firebase";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Download,
  FileText,
  Sparkles,
  User,
  Calendar,
  Send,
  BookOpen,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type LocationState = {
  submissionId?: string;
  assessmentId?: string;
};

function safeFilename(name: string) {
  return String(name || "AI-Grading-Report")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const GenerateReport = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const state = (location.state || {}) as LocationState;
  const submissionId = state.submissionId || searchParams.get("submissionId") || "";
  const assessmentIdFromQuery = state.assessmentId || searchParams.get("assessmentId") || "";

  const [teacherId, setTeacherId] = useState("");
  const [loading, setLoading] = useState(true);
  const [header, setHeader] = useState<any>(null);
  const [submissionRaw, setSubmissionRaw] = useState<any>(null);
  const [content, setContent] = useState<any>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setTeacherId(u?.uid || ""));
    return () => unsub();
  }, []);

  useEffect(() => {
    const run = async () => {
      if (!submissionId) {
        setLoading(false);
        toast({
          title: "Missing submission",
          description: "Open this page from AI Grading → Generate Report.",
        });
        return;
      }
      if (!teacherId) return;
      setLoading(true);
      try {
        const [hRes, cRes] = await Promise.all([
          fetch(
            `http://localhost:5000/api/submissions/ai-grading/${encodeURIComponent(
              submissionId
            )}?teacherId=${encodeURIComponent(teacherId)}`
          ),
          fetch(
            `http://localhost:5000/api/submissions/${encodeURIComponent(
              submissionId
            )}/content?teacherId=${encodeURIComponent(teacherId)}`
          ),
        ]);
        const hData = await hRes.json().catch(() => ({}));
        const cData = await cRes.json().catch(() => ({}));
        if (!hRes.ok || !hData?.success)
          throw new Error(hData?.error || `Failed (${hRes.status})`);
        setHeader(hData?.submission || null);
        setSubmissionRaw(hData?.submissionRaw || null);
        setContent(cData?.success ? cData : null);
      } catch (e: any) {
        toast({
          title: "Failed to build report",
          description: e?.message || String(e),
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [submissionId, teacherId]);

  const extractedAnswer = useMemo(() => {
    const raw = String(content?.extraction?.rawText || "").trim();
    const fallback = String(content?.submissionText || "").trim();
    return raw || fallback;
  }, [content]);

  const submittedImages = useMemo(() => {
    const files = Array.isArray(content?.files) ? content.files : [];
    // Prefer original (non-derived) images; fall back to any image.
    const isImage = (f: any) => String(f?.mimeType || "").toLowerCase().startsWith("image/");
    const originals = files.filter((f: any) => isImage(f) && !f?.isDerived);
    const anyImgs = files.filter((f: any) => isImage(f));
    return (originals.length ? originals : anyImgs)
      .map((f: any) => ({
        originalName: String(f?.originalName || f?.filename || "image").trim(),
        fileUrl: String(f?.fileUrl || "").trim(),
      }))
      .filter((x: any) => x.fileUrl);
  }, [content]);

  const submittedFiles = useMemo(() => {
    const files = Array.isArray(content?.files) ? content.files : [];
    const originals = files.filter((f: any) => !f?.isDerived);
    const names = originals
      .map((f: any) => String(f?.originalName || f?.filename || "").trim())
      .filter(Boolean);
    return names.length
      ? names
      : files
          .map((f: any) => String(f?.originalName || f?.filename || "").trim())
          .filter(Boolean);
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
          correct: String(
            m?.suggestion || m?.correct_answer || m?.correctAnswer || ""
          ).trim(),
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

      // Generous inner margins on every PDF page (top + bottom + sides)
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
      toast({
        title: "PDF export failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  };

  const sendToStudent = async () => {
    if (!submissionId || !teacherId) return;
    setSending(true);
    try {
      const res = await fetch(
        `http://localhost:5000/api/submissions/${encodeURIComponent(
          submissionId
        )}/publish-report`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teacherId }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success)
        throw new Error(data?.error || `Failed (${res.status})`);
      toast({ title: "Sent", description: "Report is now available to the student." });
    } catch (e: any) {
      toast({
        title: "Send failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const score = Number(header?.grade ?? header?.aiGradingSuggestion ?? 0);
  const maxScore = Number(header?.maxGrade ?? 0);
  const fmt1 = (n: any) => {
    const v = Number(n);
    return Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : "—";
  };

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Top action bar (NOT included in PDF) */}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <div className="leading-tight">
                <h1 className="text-base font-semibold">AI Grading Report</h1>
                <p className="text-xs text-muted-foreground">Structured PDF export</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={sendToStudent} disabled={sending}>
              <Send className="mr-2 h-4 w-4" />
              {sending ? "Sending…" : "Send to Student"}
            </Button>
            <Button size="sm" onClick={downloadPdf} disabled={downloading}>
              <Download className="mr-2 h-4 w-4" />
              {downloading ? "Preparing PDF…" : "Download PDF"}
            </Button>
          </div>
        </div>
      </header>

      {/* Main report area */}
      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* This is the node we rasterize for the PDF */}
        <div
          ref={reportRef}
          className="report-root rounded-xl bg-white px-12 py-12 shadow-sm ring-1 ring-border"
        >
          {/* === Report Header === */}
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
                  <span>{header?.submittedDisplay || "—"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="rounded-full px-4 py-1.5 text-sm font-medium"
                  >
                    {header?.assessmentType || "assessment"}
                  </Badge>
                  {header?.courseCode ? (
                    <Badge
                      variant="secondary"
                      className="rounded-full px-4 py-1.5 text-sm font-medium"
                    >
                      <BookOpen className="mr-1.5 h-4 w-4" />
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
                {fmt1(score)}
                <span className="text-2xl text-muted-foreground">/{fmt1(maxScore)}</span>
              </p>
            </div>
          </section>

          <Separator className="my-8" />

          {/* === Report Sections === */}
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
                      <li
                        key={idx}
                        className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm"
                      >
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
                <CardTitle className="text-lg">
                  {submittedImages.length ? "Submitted Images" : "Full Extracted Answer"}
                </CardTitle>
                <CardDescription>
                  {submittedImages.length
                    ? "Original image submission included directly in the report"
                    : "Text extracted by the AI grading system"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {submittedImages.length ? (
                  <div className="space-y-4">
                    {submittedImages.slice(0, 10).map((img: any, idx: number) => (
                      <div key={`rep-img-${idx}`} className="rounded-md border border-primary/10 bg-muted/20 p-3">
                        <div className="text-xs font-medium text-muted-foreground break-all">
                          {img.originalName || `Image ${idx + 1}`}
                        </div>
                        <div className="mt-2 overflow-hidden rounded-md bg-white">
                          <img
                            src={img.fileUrl}
                            alt={img.originalName || `submitted-image-${idx + 1}`}
                            crossOrigin="anonymous"
                            className="w-full h-auto object-contain"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="extracted-answer whitespace-pre-wrap break-words rounded-md bg-muted/40 p-5 font-sans text-base leading-7 text-foreground">
                    {extractedAnswer || "Extraction not available yet."}
                  </pre>
                )}
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
                      <li
                        key={idx}
                        className="rounded-lg border border-destructive/20 bg-destructive/5 p-4"
                      >
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

          {/* === Footer === */}
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

      <style>{`
        /* Keep short blocks together; allow long blocks to break safely */
        .report-card,
        .report-section {
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .extracted-answer {
          page-break-inside: auto;
          break-inside: auto;
          orphans: 3;
          widows: 3;
        }

        @media print {
          .report-root {
            box-shadow: none !important;
            padding: 32px !important;
          }
          .report-card {
            margin-top: 16px;
          }
          .grid > .report-card:first-child {
            margin-top: 0;
          }
        }
      `}</style>
    </div>
  );
};

export default GenerateReport;
