import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { 
  Brain, 
  FileText, 
  Code, 
  Image,
  CheckCircle,
  AlertCircle,
  Clock,
  Sparkles,
  ChevronLeft,
  Download,
  Edit,
  Save,
  RotateCcw,
  Target,
  TrendingUp,
  Zap
} from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { auth } from "../../firebase";
import { useToast } from "@/hooks/use-toast";

type AiGradingHeader = {
  _id: string;
  studentId: string;
  studentName: string;
  studentEmail?: string;
  assessmentId: string;
  assessmentTitle: string;
  assessmentType: "quiz" | "assignment";
  courseCode: string;
  courseName?: string;
  submittedAt?: string | null;
  submittedDisplay?: string;
  status: string;
  isLate: boolean;
  grade: number | null;
  maxGrade: number | null;
  feedback?: string;
  needsTeacherReview?: boolean;
  manualOverride?: boolean;
  aiGradingSuggestion?: number | null;
  aiConfidence?: number | null;
  aiAnalysis?: string | null;
  plagiarismBestMatchPercent?: number | null;
  plagiarismPenaltyPercent?: number | null;
  plagiarismAdjustedGrade?: number | null;
  plagiarismReport?: any | null;
};

type CoursePerformanceStats = {
  averagePercent: number;
  currentPercent: number;
  rank: number | null;
  totalStudents: number;
  improvementDelta: number | null;
  previousPercent: number | null;
};

function extractFirstJsonObject(text: any) {
  if (!text) return null;
  const raw = String(text);
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const AIGrading = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [manualFeedback, setManualFeedback] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [overrideGrade, setOverrideGrade] = useState<number | null>(null);
  const [teacherId, setTeacherId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [header, setHeader] = useState<AiGradingHeader | null>(null);
  const [report, setReport] = useState<any>(null);
  const [submissionRaw, setSubmissionRaw] = useState<any>(null);
  const [activeQuestionKey, setActiveQuestionKey] = useState<string>("Q1");
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const [content, setContent] = useState<any>(null);
  const [activeCodeFileId, setActiveCodeFileId] = useState<string | null>(null);
  const [codeFileText, setCodeFileText] = useState<string>("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<number>(65);
  const [coursePerf, setCoursePerf] = useState<CoursePerformanceStats | null>(null);
  const [coursePerfLoading, setCoursePerfLoading] = useState(false);
  const [plagiarismLoading, setPlagiarismLoading] = useState(false);
  const [plagiarismResult, setPlagiarismResult] = useState<any>(null);
  const [plagiarismPhase, setPlagiarismPhase] = useState<string>("");
  const [plagiarismLogs, setPlagiarismLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [publishingGrade, setPublishingGrade] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [showExtractedText, setShowExtractedText] = useState(false);
  const [showRawExtractedText, setShowRawExtractedText] = useState(false);
  const [showGarbledAnyway, setShowGarbledAnyway] = useState(false);

  const CODE_EXTS = useMemo(
    () =>
      new Set([
        ".py",
        ".ipynb",
        ".java",
        ".js",
        ".ts",
        ".tsx",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".go",
        ".rb",
        ".php",
        ".rs",
        ".kt",
        ".swift",
      ]),
    []
  );

  const extractQKeyFromName = (name: string) => {
    const s = String(name || "");
    const m = s.match(/(?:^|[^a-z0-9])q\s*([0-9]{1,3})(?:[^a-z0-9]|$)/i);
    if (!m) return null;
    const n = Number(m[1] || 0);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `Q${n}`;
  };

  const stripImageTextBlocks = (txt: string) => {
    const lines = String(txt || "").split(/\r?\n/);
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
      const isImageTextHeader = /^\s*\[IMAGE_TEXT:/i.test(line);
      const isFileHeader = /^\s*\[FILE:/i.test(line);
      if (isImageTextHeader) {
        skipping = true;
        continue;
      }
      // Stop skipping once we hit the next file header (next question/file section)
      if (skipping && isFileHeader) {
        skipping = false;
      }
      if (skipping) continue;
      out.push(line);
    }
    return out.join("\n").trim();
  };

  const looksGarbled = (txt: string) => {
    const s = String(txt || "").trim();
    if (!s) return false;
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length < 12) return false;
    const short = tokens.filter((t) => t.length <= 2).length / tokens.length;
    const weird = tokens.filter((t) => /[^a-z0-9.,;:'"()\-]/i.test(t)).length / tokens.length;
    // Heuristic: lots of 1–2 char tokens or many weird symbols tends to indicate bad OCR.
    return short > 0.38 || weird > 0.28;
  };

  const coursePerfInFlightRef = useRef(false);

  const perQuestionScores = useMemo(() => {
    const fromRaw = Array.isArray(submissionRaw?.perQuestionScores) ? submissionRaw.perQuestionScores : [];
    if (fromRaw.length) return fromRaw;
    const qs = Array.isArray(report?.questions) ? report.questions : [];
    return qs.map((q: any) => ({
      questionKey: q?.questionKey || "",
      awardedMarks: Number(q?.awardedMarks ?? 0) || 0,
      maxMarks: Number(q?.maxMarks ?? 0) || 0,
      confidence: Number(q?.confidence ?? 0) || 0,
      summary: String(q?.summary || q?.studentAnswerSummary || "").trim(),
      feedback: String(q?.feedback || "").trim(),
      mistakes: Array.isArray(q?.mistakes) ? q.mistakes : [],
      improvements: Array.isArray(q?.improvements) ? q.improvements : [],
      coverage: Array.isArray(q?.coverage) ? q.coverage : [],
    }));
  }, [submissionRaw, report]);

  const questionTypeByKey = useMemo(() => {
    const qs =
      Array.isArray(submissionRaw?.automarkReport?.questions)
        ? submissionRaw.automarkReport.questions
        : Array.isArray(report?.questions)
          ? report.questions
          : [];
    const m = new Map<string, string>();
    for (const q of qs) {
      const key = String(q?.questionKey || "").trim();
      if (!key) continue;
      const qt = String(q?.questionType || "").trim();
      if (qt) m.set(key, qt);
    }
    return m;
  }, [report, submissionRaw]);

  const questionCategory = (qKey: string) => {
    const t = String(questionTypeByKey.get(String(qKey || "")) || "").toLowerCase();
    // Backend enum: mcq/short-answer/true-false/coding/long-answer/fill-in-the-blank
    if (t === "coding") return "code";
    // Graphical questions are still "text" type in schema; we treat "graphical" as "has images" tab.
    // Keep only coding separated; everything else is text-based marking.
    return "text";
  };

  const questionKeysByCategory = useMemo(() => {
    const out: Record<string, string[]> = { text: [], code: [], graphical: [] };
    for (const q of perQuestionScores || []) {
      const k = String(q?.questionKey || "").trim();
      if (!k) continue;
      const cat = questionCategory(k);
      if (cat === "code") out.code.push(k);
      else out.text.push(k);
    }
    // Graphical tab is driven by images; questions stay text/coding.
    return out;
  }, [perQuestionScores, questionTypeByKey]);

  const contentFlags = useMemo(() => {
    const types: string[] = Array.isArray(content?.extraction?.contentTypes) ? content.extraction.contentTypes : [];
    const hasCode = types.includes("code") || Boolean(content?.grouped?.code?.length) || questionKeysByCategory.code.length > 0;
    const hasGraphical =
      types.includes("graphical") || Boolean(content?.grouped?.graphical?.length) || Boolean(content?.extraction?.hasVisual);

    // Text tab should appear ONLY when there are text-type questions OR real non-code documents.
    // Do NOT show it for coding-only or image-only submissions, even if OCR/rawText exists.
    const textFiles = Array.isArray(content?.grouped?.text)
      ? content.grouped.text.filter((f: any) => {
          const isOcr = Boolean(f?.isDerived) && String(f?.derivedType || "") === "ocr-pdf";
          if (isOcr) return false;
          const name = String(f?.originalName || f?.filename || "").toLowerCase();
          const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
          if (CODE_EXTS.has(ext)) return false;
          return true;
        })
      : [];

    const hasTextQuestions = questionKeysByCategory.text.length > 0;
    const hasTypedText = Boolean(String(content?.submissionText || "").trim());
    const hasExplicitTextType = types.includes("text");

    // If it’s coding or graphical submission and there are no text questions, hide text tab entirely.
    const hasText =
      hasTextQuestions ||
      Boolean(textFiles.length) ||
      (hasTypedText && !hasCode && !hasGraphical) ||
      (hasExplicitTextType && !hasCode && !hasGraphical);

    return { hasText, hasCode, hasGraphical };
  }, [content, questionKeysByCategory, CODE_EXTS]);

  const activeQuestion = useMemo(() => {
    const found = perQuestionScores.find((q: any) => String(q?.questionKey || "") === activeQuestionKey);
    return found || perQuestionScores[0] || null;
  }, [perQuestionScores, activeQuestionKey]);

  useEffect(() => {
    // Ensure active question belongs to the current tab's category (avoid mixing).
    const k = String(activeQuestionKey || "Q1");
    if (activeTab === "code") {
      if (!questionKeysByCategory.code.includes(k) && questionKeysByCategory.code.length) {
        setActiveQuestionKey(questionKeysByCategory.code[0]);
      }
      return;
    }
    if (activeTab === "text") {
      if (!questionKeysByCategory.text.includes(k) && questionKeysByCategory.text.length) {
        setActiveQuestionKey(questionKeysByCategory.text[0]);
      }
      return;
    }
  }, [activeTab, activeQuestionKey, questionKeysByCategory]);

  useEffect(() => {
    // If text isn't applicable, don't allow landing/staying on the Text tab.
    if (activeTab !== "text") return;
    if (contentFlags.hasText) return;
    if (contentFlags.hasCode) {
      setActiveTab("code");
      return;
    }
    if (contentFlags.hasGraphical) {
      setActiveTab("graphical");
      return;
    }
    setActiveTab("overview");
  }, [activeTab, contentFlags]);

  const detectedMistakes = useMemo(() => {
    // IMPORTANT:
    // Use the same canonical per-question source as the rest of the page (`perQuestionScores`).
    // `automarkReport.questions` is often incomplete (legacy rows / OCR flows), which hides mistakes.
    const qs = Array.isArray(perQuestionScores) ? perQuestionScores : [];

    const toText = (m: any) =>
      String(m?.feedback || m?.explanation || m?.message || m?.type || m || "").trim();

    return qs.map((q: any) => {
      const rawMistakes = Array.isArray(q?.mistakes) ? q.mistakes : [];
      // Do not fabricate mistakes; only render what backend provided.
      const seen = new Set<string>();
      const mistakes = rawMistakes
        .map(toText)
        .filter(Boolean)
        .filter((t: string) => {
          const k = t.toLowerCase().replace(/\s+/g, " ").trim();
          if (!k) return false;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 8);
      return { q, mistakes };
    });
  }, [perQuestionScores]);

  function buildHighlightRanges(fullText: string, mistakes: any[]) {
    const text = String(fullText || "");
    const ranges: { start: number; end: number; meta: any }[] = [];
    const safeAdd = (start: number, end: number, meta: any) => {
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const s = Math.max(0, Math.min(text.length, start));
      const e = Math.max(0, Math.min(text.length, end));
      if (e <= s) return;
      if (ranges.some((r) => !(e <= r.start || s >= r.end))) return;
      ranges.push({ start: s, end: e, meta });
    };

    for (const m of Array.isArray(mistakes) ? mistakes : []) {
      const quote = String(m?.text_span || m?.evidenceQuote || "").trim();
      if (Number.isFinite(m?.start_index) && Number.isFinite(m?.end_index)) {
        safeAdd(Number(m.start_index), Number(m.end_index), m);
        continue;
      }
      if (Number.isFinite(m?.spanStart) && Number.isFinite(m?.spanEnd)) {
        safeAdd(Number(m.spanStart), Number(m.spanEnd), m);
        continue;
      }
      if (quote && quote.length >= 6) {
        const idx = text.toLowerCase().indexOf(quote.toLowerCase());
        if (idx !== -1) safeAdd(idx, idx + quote.length, m);
      }
    }
    return ranges.sort((a, b) => a.start - b.start);
  }

  function renderHighlightedText(fullText: string, ranges: { start: number; end: number; meta: any }[]) {
    const text = String(fullText || "");
    if (!ranges.length) return <pre className="text-sm whitespace-pre-wrap">{text || "—"}</pre>;
    const parts: any[] = [];
    let cursor = 0;

    const HighlightSpan = ({ snippet, meta }: { snippet: string; meta: any }) => {
      const [open, setOpen] = useState(false);
      const type = String(meta?.type || "mistake").trim();
      const explanation = String(meta?.feedback || meta?.explanation || meta?.message || "").trim();
      const whyWrong = String(meta?.why_wrong || meta?.whyWrong || "").trim();
      const correct = String(meta?.suggestion || meta?.suggestedCorrection || meta?.correct_answer || meta?.correctAnswer || "").trim();

      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <span
              className="relative inline-block underline decoration-red-500 decoration-2 underline-offset-2 bg-red-50 text-red-900 cursor-help px-0.5 rounded-sm"
              onMouseEnter={() => setOpen(true)}
              onMouseLeave={() => setOpen(false)}
            >
              <span className="absolute -top-1 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-red-600 shadow-sm" />
              {snippet}
            </span>
          </PopoverTrigger>
          <PopoverContent
            className="w-96"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-red-700">{type}</div>
                <Badge variant="destructive" className="text-[10px] px-2 py-0.5">
                  issue
                </Badge>
              </div>
              {explanation ? (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Mistake explanation</div>
                  <div className="text-sm text-gray-900 whitespace-pre-wrap">{explanation}</div>
                </div>
              ) : null}
              {whyWrong ? (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Why it’s wrong</div>
                  <div className="text-sm text-gray-900 whitespace-pre-wrap">{whyWrong}</div>
                </div>
              ) : null}
              {correct ? (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Correct answer (suggestion)</div>
                  <div className="whitespace-pre-wrap bg-muted rounded-md p-2 text-sm">{correct}</div>
                </div>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      );
    };

    ranges.forEach((r, i) => {
      if (cursor < r.start) parts.push(<span key={`t-${i}-p`}>{text.slice(cursor, r.start)}</span>);
      parts.push(<HighlightSpan key={`t-${i}-h`} snippet={text.slice(r.start, r.end)} meta={r.meta} />);
      cursor = r.end;
    });
    if (cursor < text.length) parts.push(<span key="t-end">{text.slice(cursor)}</span>);
    return <pre className="text-sm whitespace-pre-wrap">{parts}</pre>;
  }

  function renderSubmissionTextWithQaLayout(fullText: string, ranges: { start: number; end: number; meta: any }[]) {
    const text = String(fullText || "");
    const lines = text.split(/\r?\n/);
    let offset = 0;

    const isQuestionLine = (line: string) => {
      const t = String(line || "").trim();
      if (!t) return false;
      return /^(?:q|question)\s*\d{1,3}\s*[\).:\-]/i.test(t);
    };

    const shiftRanges = (lineStart: number, lineEnd: number) => {
      const out: { start: number; end: number; meta: any }[] = [];
      for (const r of ranges || []) {
        const s = Math.max(lineStart, r.start);
        const e = Math.min(lineEnd, r.end);
        if (e > s) out.push({ start: s - lineStart, end: e - lineStart, meta: r.meta });
      }
      return out;
    };

    return (
      <div className="space-y-2">
        {lines.map((line, idx) => {
          const lineStart = offset;
          const lineEnd = offset + line.length;
          offset = lineEnd + 1;

          const qLine = isQuestionLine(line);
          return (
            <div key={`qa-line-${idx}`} className={qLine ? "pt-2" : ""}>
              {qLine ? (
                // Do NOT highlight mistakes on question lines; only mark answers.
                <div className="text-sm font-semibold text-gray-900 whitespace-pre-wrap">{line}</div>
              ) : (
                <div className="text-sm text-gray-900 pl-4 border-l-2 border-primary/10">
                  {renderHighlightedText(line, shiftRanges(lineStart, lineEnd))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function normalizeOcrTextForDisplay(raw: string) {
    const s = String(raw || "").replace(/\r\n/g, "\n");
    const lines = s.split("\n");
    const out: string[] = [];
    const endsSentence = (t: string) => /[.!?;:]"?$/.test(String(t || "").trim());
    const isShort = (t: string) => {
      const x = String(t || "").trim();
      return x.length > 0 && x.length <= 18;
    };
    const isBullet = (t: string) => /^(\-|\*|\u2022|\d+\.)\s+/.test(String(t || "").trim());

    for (let i = 0; i < lines.length; i++) {
      const curRaw = String(lines[i] || "");
      const cur = curRaw.trimEnd();
      if (!cur.trim()) {
        out.push("");
        continue;
      }

      // De-hyphenate: "vari-\nable" -> "variable"
      if (cur.trim().endsWith("-") && i + 1 < lines.length) {
        const nxt = String(lines[i + 1] || "").trim();
        if (nxt && /^[a-z]/i.test(nxt)) {
          out.push(cur.trim().slice(0, -1) + nxt);
          i += 1;
          continue;
        }
      }

      const prev = out.length ? String(out[out.length - 1] || "") : "";
      if (
        prev &&
        prev.trim() &&
        !endsSentence(prev) &&
        !isBullet(prev) &&
        isShort(prev) &&
        isShort(cur)
      ) {
        out[out.length - 1] = `${prev.trimEnd()} ${cur.trimStart()}`;
        continue;
      }

      out.push(cur);
    }

    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  
  // Determine if this is being viewed by a student (coming from student dashboard)
  const isStudentView = location.state?.fromStudent || false;
  const submissionId: string | undefined = location.state?.submissionId;
  const assessmentIdFromNav: string | undefined = location.state?.assessmentId;
  const queueSubmissionIds: string[] = Array.isArray(location.state?.queueSubmissionIds) ? location.state.queueSubmissionIds : [];
  const queueIndex: number = Number.isFinite(location.state?.queueIndex) ? Number(location.state.queueIndex) : 0;
  const autoRun: boolean = Boolean(location.state?.autoRun);

  useEffect(() => {
    // Default: keep extracted OCR text collapsed (especially for image/graphical submissions).
    setShowExtractedText(false);
    setShowRawExtractedText(false);
    setShowGarbledAnyway(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setTeacherId(user?.uid || "");
    });
    return () => unsubscribe();
  }, []);

  const lastAutomarkStatusRef = useRef<string>("");
  const didInitActiveQuestionRef = useRef(false);

  const prepareReview = async (tid: string) => {
    if (!submissionId) return;
    if (!tid && !isStudentView) return;
    try {
      await fetch(`http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/prepare-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherId: tid }),
      });
    } catch {
      // best-effort only
    }
  };

  const fetchHeader = async (tid: string, opts?: { silent?: boolean }) => {
    if (!submissionId) {
      setLoading(false);
      setHeader(null);
      return;
    }
    if (!tid && !isStudentView) {
      // teacher view requires teacherId for authorization
      return;
    }

    const silent = Boolean(opts?.silent);
    if (!silent) setLoading(true);
    try {
      const url = `http://localhost:5000/api/submissions/ai-grading/${encodeURIComponent(submissionId)}?teacherId=${encodeURIComponent(tid)}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Failed to load submission (${res.status})`);
      }
      const sub: AiGradingHeader = data.submission;
      setHeader(sub);
      setSubmissionRaw(data?.submissionRaw || null);
      // Don't clobber the teacher's in-progress typing while polling.
      if (!feedbackDirty) setManualFeedback(sub.feedback || "");

      if (sub.aiAnalysis) {
        try {
          // Backward-compatible: old records may store non-JSON or fenced JSON.
          const parsed = (() => {
            try {
              return JSON.parse(String(sub.aiAnalysis));
            } catch {
              return extractFirstJsonObject(sub.aiAnalysis);
            }
          })();
          setReport(parsed || null);
        } catch {
          setReport(null);
        }
      } else {
        setReport(null);
      }

      // If plagiarism was already run earlier, show the saved report immediately.
      // The backend persists `plagiarismReport` to keep the score/report stable across refreshes/re-runs.
      if (sub?.plagiarismReport && typeof sub.plagiarismReport === "object") {
        setPlagiarismResult(sub.plagiarismReport);
      }

      const qs = Array.isArray(data?.submissionRaw?.perQuestionScores) ? data.submissionRaw.perQuestionScores : [];
      const firstKey = String(qs?.[0]?.questionKey || "").trim();
      const currentKey = String(activeQuestionKey || "").trim();
      const keys = new Set((qs || []).map((x: any) => String(x?.questionKey || "").trim()).filter(Boolean));
      // Only initialize the question once per submission (avoid "glitch" where polling resets selection).
      if (!didInitActiveQuestionRef.current) {
        if (currentKey && keys.has(currentKey)) {
          didInitActiveQuestionRef.current = true;
        } else if (firstKey) {
          setActiveQuestionKey(firstKey);
          didInitActiveQuestionRef.current = true;
        }
      }
    } catch (e: any) {
      toast({
        title: "Failed to load AI grading view",
        description: e?.message || String(e),
        variant: "destructive",
      });
      setHeader(null);
      setReport(null);
      setSubmissionRaw(null);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Reset local UI state when changing submissions (Save & Next navigation).
  useEffect(() => {
    setFeedbackDirty(false);
    setOverrideGrade(null);
    setReport(null);
    setContent(null);
    setActiveCodeFileId(null);
    setCodeFileText("");
    didInitActiveQuestionRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  const fetchContent = async (tid: string) => {
    if (!submissionId) return;
    if (!tid && !isStudentView) return;

    try {
      const url = `http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/content?teacherId=${encodeURIComponent(tid)}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Failed to load content (${res.status})`);
      }
      setContent(data);
      // Default-select first code file
      const firstCode = data?.grouped?.code?.[0];
      if (firstCode && !activeCodeFileId) {
        setActiveCodeFileId(firstCode.id);
      }
    } catch (e: any) {
      // keep UI working even if content endpoint fails
      console.warn("[AIGrading] content fetch failed:", e?.message || e);
    }
  };

  // OCR is initiated from the Submissions page (not AI Grading).

  useEffect(() => {
    if (isStudentView) return;
    if (!teacherId) return;
    // When opening Review: ensure extraction/ingestion is queued so tabs populate automatically.
    prepareReview(teacherId);
    fetchHeader(teacherId);
    fetchContent(teacherId);
    fetchCoursePerformance(teacherId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, submissionId, isStudentView]);

  // AutoMark is initiated from the Submissions page.

  // Real-time refresh (polling) to keep the mockup page live.
  useEffect(() => {
    if (isStudentView) return;
    if (!teacherId) return;
    if (!submissionId) return;

    const interval = setInterval(() => {
      // Keep polling even during LLM processing so the UI can flip from
      // processing -> completed and show results without waiting for the request to return.
      fetchHeader(teacherId, { silent: true });
      fetchContent(teacherId);
      // Course performance is heavier and causes UI flicker if polled too often.
    }, 4000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, submissionId, isStudentView, isProcessing]);

  // Refresh course performance less frequently (no flicker)
  useEffect(() => {
    if (isStudentView) return;
    if (!teacherId) return;
    if (!submissionId) return;

    const interval = setInterval(() => {
      fetchCoursePerformance(teacherId, { silent: true });
    }, 15000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, submissionId, isStudentView]);

  // Show a toast once LLM processing flips to completed (not on initial load).
  useEffect(() => {
    const s = String(submissionRaw?.automarkStatus || "");
    if (!s) return;
    const prev = lastAutomarkStatusRef.current;
    lastAutomarkStatusRef.current = s;
    if (!prev) return;
    if (prev !== s && s === "completed") {
      toast({ title: "LLM Marking Successful", description: "AutoMark results are ready for review." });
      setIsProcessing(false);
    }
    if (prev !== s && s === "failed") {
      const msg = String(submissionRaw?.automarkError || "").trim();
      toast({
        title: "LLM Marking Failed",
        description: msg || "AutoMark failed. Check extraction and try again.",
        variant: "destructive",
      });
      setIsProcessing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionRaw?.automarkStatus]);

  // Animate the processing progress bar while LLM runs.
  useEffect(() => {
    if (!isProcessing) return;
    setProcessingProgress(65);
    const id = setInterval(() => {
      setProcessingProgress((p) => {
        // Keep it moving but never "finish" until request completes.
        const next = p + 7;
        return next >= 92 ? 70 : next;
      });
    }, 700);
    return () => clearInterval(id);
  }, [isProcessing]);

  const overall = useMemo(() => {
    const max = header?.maxGrade ?? report?.totals?.max ?? null;
    // Use plagiarism-adjusted grade if available (shows score after plagiarism penalty)
    // Otherwise fall back to AI suggestion or manual grade
    const awarded = overrideGrade ?? header?.plagiarismAdjustedGrade ?? header?.grade ?? header?.aiGradingSuggestion ?? report?.totals?.awarded ?? null;
    const confidence = header?.aiConfidence ?? report?.confidence ?? null;
    const plagiarismAdjusted = header?.plagiarismAdjustedGrade ?? null;
    const fmt = (n: any) => {
      const v = Number(n);
      return Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : "—";
    };
    const fmtInt = (n: any) => {
      const v = Number(n);
      return Number.isFinite(v) ? String(v) : "—";
    };
    return { max, awarded, confidence, plagiarismAdjusted, fmt, fmtInt };
  }, [header, report, overrideGrade]);

  const autoGraded = Boolean(header?.aiGradingSuggestion != null || header?.aiAnalysis);

  // AutoMark is initiated from the Submissions page (not AI Grading).

  const loadCodeFile = async (fileId: string) => {
    const file = content?.files?.find((f: any) => f?.id === fileId);
    if (!file?.fileUrl) return;
    setActiveCodeFileId(fileId);
    setCodeLoading(true);
    try {
      const res = await fetch(file.fileUrl);
      const text = await res.text();
      setCodeFileText(text);
    } catch (e: any) {
      setCodeFileText(`Failed to load code file.\n${e?.message || String(e)}`);
    } finally {
      setCodeLoading(false);
    }
  };

  const saveGrade = async () => {
    if (!submissionId || !teacherId) return;
    const gradeToSave =
      overrideGrade ?? header?.aiGradingSuggestion ?? header?.grade ?? report?.totals?.awarded ?? null;

    if (gradeToSave == null) {
      toast({
        title: "No grade to save",
        description: "Run AutoMark or set an override grade first.",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);
    try {
      const res = await fetch(`http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/grade`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grade: gradeToSave,
          feedback: manualFeedback,
          teacherId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Save failed (${res.status})`);
      }
      toast({ title: "Saved", description: "Marks and feedback saved to submissions." });
      await fetchHeader(teacherId);
    } catch (e: any) {
      toast({
        title: "Save failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const fetchCoursePerformance = async (tid: string, opts?: { silent?: boolean }) => {
    if (!submissionId || !tid) return;
    const silent = Boolean(opts?.silent);
    // Avoid UI flicker: only show spinner on first load.
    if (!silent && !coursePerf) setCoursePerfLoading(true);
    if (coursePerfInFlightRef.current) return;
    coursePerfInFlightRef.current = true;
    try {
      const url = `http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/performance?teacherId=${encodeURIComponent(tid)}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) throw new Error(data?.error || `Failed (${res.status})`);
      setCoursePerf({
        averagePercent: Number(data?.averagePercent ?? 0) || 0,
        currentPercent: Number(data?.currentPercent ?? 0) || 0,
        rank: data?.rank != null ? Number(data.rank) : null,
        totalStudents: Number(data?.totalStudents ?? 0) || 0,
        improvementDelta: data?.improvementDelta != null ? Number(data.improvementDelta) : null,
        previousPercent: data?.previousPercent != null ? Number(data.previousPercent) : null,
      });
    } catch {
      // Keep last known values on transient errors (prevents panel jumping/glitching).
      if (!coursePerf) setCoursePerf(null);
    } finally {
      coursePerfInFlightRef.current = false;
      if (!silent && !coursePerf) setCoursePerfLoading(false);
    }
  };

  const goNextInQueue = () => {
    if (!queueSubmissionIds.length) return;
    const nextIndex = queueIndex + 1;
    const nextSubmissionId = queueSubmissionIds[nextIndex];
    if (!nextSubmissionId) return;
    navigate("/ai-grading", {
      state: {
        submissionId: nextSubmissionId,
        assessmentId: assessmentIdFromNav,
        queueSubmissionIds,
        queueIndex: nextIndex,
        teacherView: true,
        // IMPORTANT: do not auto-run LLM on navigation
        autoRun: false,
      },
    });
  };

  const hasNextInQueue = Boolean(queueSubmissionIds.length && queueIndex + 1 < queueSubmissionIds.length);

  const publishToStudent = async () => {
    if (!submissionId || !teacherId) return;
    const ok = window.confirm("This will publish the AI report/grade to the student (final). Continue?");
    if (!ok) return;
    setPublishingGrade(true);
    try {
      // If teacher changed feedback or set an override grade, persist it first so publish uses teacher-approved values.
      const hasTeacherEdits = feedbackDirty || overrideGrade != null;
      if (hasTeacherEdits) {
        const gradeToSave =
          overrideGrade ?? header?.aiGradingSuggestion ?? header?.grade ?? report?.totals?.awarded ?? null;
        if (gradeToSave != null) {
          const sr = await fetch(`http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/grade`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grade: gradeToSave,
              feedback: manualFeedback,
              teacherId,
            }),
          });
          const sd = await sr.json().catch(() => ({}));
          if (!sr.ok) {
            throw new Error(sd?.error || `Save failed (${sr.status})`);
          }
          setFeedbackDirty(false);
        }
      }

      const res = await fetch(
        `http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/publish-ai`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teacherId }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Publish failed (${res.status})`);
      }
      toast({ title: "Published", description: "AI report/grade published to student." });
      await fetchHeader(teacherId);
    } catch (e: any) {
      toast({
        title: "Publish failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    } finally {
      setPublishingGrade(false);
    }
  };

  const runPlagiarismCheck = async (forceRefresh = false) => {
    if (!submissionId || !teacherId) return;
    setPlagiarismLoading(true);
    setPlagiarismLogs([]);
    setPlagiarismPhase("phase1");

    const addLog = (message: string) => {
      setPlagiarismLogs(prev => [...prev, `${new Date().toLocaleTimeString()} - ${message}`]);
    };

    try {
      addLog("Starting plagiarism check...");

      // Phase 1: ensure we have extracted text loaded in UI
      const extracted = String(content?.extraction?.rawText || "").trim() || String(content?.submissionText || "").trim();
      addLog(`Text extracted: ${extracted ? `✓ Found (${extracted.length} chars)` : "✗ Not found"}`);
      setPlagiarismPhase(extracted ? "phase2" : "phase1");

      addLog("Calculating internal plagiarism (student-to-student matching)...");
      setPlagiarismPhase("phase2");

      addLog("Calculating external plagiarism (online sources & AI detection)...");
      const res = await fetch(
        `http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/plagiarism-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Force refresh to recalculate internal + external plagiarism
          body: JSON.stringify({ teacherId, force: forceRefresh || plagiarismResult ? true : false }),
        }
      );
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.error('Failed to parse JSON response:', e);
        data = {};
      }
      if (!res.ok || !data?.success) throw new Error(data?.error || `Failed (${res.status})`);

      setPlagiarismPhase("phase3");
      addLog("Combining plagiarism scores (60% internal + 40% external)...");
      addLog(`✓ Plagiarism check ${data.cached ? "(CACHED - SAME SCORE)" : "complete"}!`);
      addLog(`  Internal: ${data.internalScore || 0}%`);
      addLog(`  External: ${data.aiScore || 0}%`);
      addLog(`  Overall: ${data.overallScore || 0}%`);
      if (data.riskLevel) addLog(`  Risk Level: ${data.riskLevel}`);
      if (data.cached && data.cachedAt) addLog(`  Last Checked: ${new Date(data.cachedAt).toLocaleString()}`);

      setPlagiarismResult(data);

      // Scroll logs to bottom
      setTimeout(() => {
        logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);

      // Plagiarism check updates grade suggestion server-side; refresh header to reflect new overall score.
      addLog("Updating overall score...");
      await fetchHeader(teacherId, { silent: true });
      addLog("✓ Score updated successfully");
    } catch (e: any) {
      addLog(`✗ Error: ${e?.message || String(e)}`);
      toast({ title: "Plagiarism check failed", description: e?.message || String(e), variant: "destructive" });
      setPlagiarismResult(null);
    } finally {
      setPlagiarismLoading(false);
      setPlagiarismPhase("");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-gray-50 to-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-primary/10 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button 
                variant="ghost" 
                onClick={() => navigate(-1)}
                className="hover:bg-primary/10 transition-all p-2 rounded-lg"
              >
                <ChevronLeft className="h-5 w-5 text-gray-700" />
              </Button>
              <div className="flex items-center gap-2">
                <Brain className="h-6 sm:h-8 w-6 sm:w-8 text-primary" />
                <div>
                  <h1 className="text-lg sm:text-2xl font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                    View Detailed Analysis of Assessments
                  </h1>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isStudentView ? (
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-2" />
                  Download Report
                </Button>
              ) : (
                <>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() =>
                      navigate(
                        `/teacher/generate-report?submissionId=${encodeURIComponent(String(submissionId || ""))}&assessmentId=${encodeURIComponent(String(assessmentIdFromNav || ""))}`,
                        {
                          state: {
                            submissionId,
                            assessmentId: assessmentIdFromNav,
                          },
                        }
                      )
                    }
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Generate Report
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={publishToStudent}
                    disabled={publishingGrade || isProcessing || loading}
                  >
                    Publish Grade to Student
                  </Button>
                  <Button
                    className="bg-gradient-primary text-primary-foreground hover:shadow-glow"
                    onClick={goNextInQueue}
                    disabled={loading || !hasNextInQueue}
                  >
                    <Save className="h-4 w-4 mr-2" />
                    Next
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Submission Info */}
        <Card className="mb-6 border-2 border-primary/15 shadow-sm bg-white rounded-xl">
          <CardHeader className="pb-3 bg-gradient-to-r from-primary/5 to-primary/10 rounded-t-xl border-b border-primary/10">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg sm:text-xl text-gray-900">
                  {header?.assessmentTitle || "AI Grading"}
                </CardTitle>
                <CardDescription>
                  <span className="block text-sm text-gray-800 font-medium">
                    {header?.studentName || "—"}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {header?.courseCode || "—"}
                  </span>
                </CardDescription>
              </div>
              <div className="flex items-center gap-4">
                <Badge variant="info">
                  <Clock className="h-3 w-3 mr-1" />
                  {header?.submittedDisplay || "—"}
                </Badge>
                {autoGraded ? (
                <Badge variant="success">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Auto-Graded
                </Badge>
                ) : (
                  <Badge variant="warning">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Pending AI
                  </Badge>
                )}
                {header?.needsTeacherReview ? (
                  <Badge variant="destructive">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Review Needed
                  </Badge>
                ) : null}
              </div>
            </div>
          </CardHeader>
        </Card>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Column - Submission Content */}
          <div className="lg:col-span-2 space-y-6">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {contentFlags.hasText ? <TabsTrigger value="text">Text Answers</TabsTrigger> : null}
                {contentFlags.hasCode ? <TabsTrigger value="code">Code</TabsTrigger> : null}
                {contentFlags.hasGraphical ? <TabsTrigger value="graphical">Graphical</TabsTrigger> : null}
                {header?.assessmentType === "assignment" ? (
                  <TabsTrigger value="plagiarism">Plagiarism Check</TabsTrigger>
                ) : null}
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                {/* AI Grading Summary */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-primary" />
                      AI Grading Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-gradient-card rounded-lg">
                      <div>
                        <p className="text-sm text-muted-foreground">
                          Overall Score{header?.assessmentType === "assignment" && overall.plagiarismAdjusted != null ? " (After Plagiarism)" : ""}
                        </p>
                        <p className="text-3xl font-bold text-primary">
                          {overall.awarded != null && overall.max != null ? `${overall.fmt(overall.awarded)}/${overall.fmt(overall.max)}` : "—"}
                        </p>
                        {header?.assessmentType === "assignment" && header?.aiGradingSuggestion != null && overall.plagiarismAdjusted != null ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Original AI score:{" "}
                            <span className="font-semibold text-gray-900">
                              {overall.fmt(header.aiGradingSuggestion)}/{overall.fmt(overall.max)}
                            </span>
                          </p>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">AI Confidence</p>
                        <div className="flex items-center gap-2">
                          <Progress value={overall.confidence ?? 0} className="w-20" />
                          <span className="text-sm font-medium">{overall.confidence ?? "—"}%</span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center">
                        <p className="text-sm text-muted-foreground">Total Marks</p>
                        <p className="text-xl font-bold">{overall.max ?? "—"}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-muted-foreground">Late</p>
                        <p className="text-xl font-bold">{header?.isLate ? "Yes" : "No"}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Processing Animation */}
                {isProcessing && (
                  <Card className="bg-gradient-primary text-primary-foreground">
                    <CardContent className="py-8">
                      <div className="text-center space-y-4">
                        <div className="flex justify-center">
                          <Brain className="h-12 w-12 animate-pulse" />
                        </div>
                        <h3 className="text-xl font-semibold">AI Processing Submission</h3>
                        <p className="text-sm opacity-90">
                          Running AutoMark and generating a detailed grading report…
                        </p>
                        <Progress value={processingProgress} className="w-full max-w-xs mx-auto" />
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Detected Mistakes and Manual Feedback - Side by Side */}
                <div className="grid lg:grid-cols-2 gap-4">
                  {/* Detected Mistakes */}
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle>Detected Mistakes</CardTitle>
                      <CardDescription>AI-identified areas for improvement</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {!detectedMistakes.length ? (
                        <div className="text-sm text-muted-foreground">
                          Run AutoMark to generate per-question feedback and detected issues.
                        </div>
                      ) : (
                      <div className="space-y-3">
                          {detectedMistakes.map(({ q, mistakes }: any) => (
                            <div key={q.questionKey} className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                            <div className="mt-1">
                                {(q.confidence ?? 0) >= 70 ? (
                                  <CheckCircle className="h-4 w-4 text-success" />
                                ) : (
                                  <AlertCircle className="h-4 w-4 text-warning" />
                                )}
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <Badge variant="outline" className="text-xs">
                                    <Target className="h-3 w-3 mr-1" />
                                    {q.questionKey}
                                  </Badge>
                                  <Badge variant="secondary" className="text-xs">
                                    {Number(q.awardedMarks ?? 0)}/{Number(q.maxMarks ?? 0)}
                                  </Badge>
                                  <Badge variant="outline" className="text-xs">
                                    {Math.round(Number(q.confidence ?? 0))}%
                                </Badge>
                                </div>
                                <p className="text-sm">{q.summary || q.studentAnswerSummary || "—"}</p>

                                {mistakes.length ? (
                                  <ul className="mt-2 space-y-1 list-disc pl-5 text-xs text-muted-foreground">
                                    {mistakes.map((m: string, idx: number) => (
                                      <li key={`${q.questionKey}::m::${idx}`}>{m}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <div className="mt-2 text-xs text-muted-foreground">No issues detected for this question.</div>
                                )}

                                {Array.isArray(q?.rubricBreakdown) && q.rubricBreakdown.length > 0 ? (
                                  <div className="mt-2 space-y-2">
                                    <div className="text-xs font-semibold text-gray-900">Rubric breakdown</div>
                                    {q.rubricBreakdown.slice(0, 6).map((b: any, idx: number) => (
                                      <div key={`${q.questionKey}::rb::${idx}`} className="space-y-1">
                                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                          <span className="truncate">
                                            {String(b?.criterion || `Criterion ${idx + 1}`)}
                                          </span>
                                          <span className="shrink-0">
                                            {Number(b?.awarded ?? 0)}/{Number(b?.max ?? 0)}
                                          </span>
                                        </div>
                                        <Progress
                                          value={
                                            Number(b?.max ?? 0) > 0
                                              ? Math.round((Number(b?.awarded ?? 0) / Number(b?.max ?? 0)) * 100)
                                              : 0
                                          }
                                        />
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Manual Feedback Section */}
                  <Card className="h-full">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <CardTitle>Manual Feedback & Override</CardTitle>
                        {overall?.confidence != null && Number(overall.confidence) < 50 ? (
                          <Badge variant="destructive" className="shrink-0">
                            Low AI confidence ({Math.round(Number(overall.confidence))}%)
                          </Badge>
                        ) : null}
                      </div>
                      <CardDescription>Add additional comments or adjust the grade</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {overall?.confidence != null && Number(overall.confidence) < 50 ? (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-gray-900">
                          AI confidence is below 50%. Please review carefully and consider overriding grade/feedback before publishing.
                        </div>
                      ) : null}
                      <Textarea
                        placeholder="Add your feedback here..."
                        value={manualFeedback}
        onChange={(e) => {
          setManualFeedback(e.target.value);
          setFeedbackDirty(true);
        }}
                        className="min-h-[100px]"
                      />
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => {
                            const v = window.prompt("Override grade (number):", overrideGrade?.toString() || "");
                            if (v == null) return;
                            const n = Number(v);
                            if (!Number.isFinite(n)) {
                              toast({ title: "Invalid grade", description: "Please enter a valid number.", variant: "destructive" });
                              return;
                            }
                            setOverrideGrade(n);
                          }}
                          disabled={isProcessing || loading}
                        >
                          <Edit className="h-4 w-4 mr-2" />
                          Override Grade
                        </Button>
                        {/* AutoMark/Re-run analysis is initiated from the Submissions page */}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="code" className="space-y-4">
                {perQuestionScores?.length && questionKeysByCategory.code.length ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Code Marking</CardTitle>
                      <CardDescription>Per-question marks, feedback, and mistakes (coding questions)</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap items-center gap-2 mb-4">
                        <span className="text-sm font-semibold text-gray-900">Question:</span>
                        <div className="flex flex-wrap gap-2">
                          {(perQuestionScores || [])
                            .filter((q: any) => questionCategory(String(q?.questionKey || "")) === "code")
                            .map((q: any) => (
                              <Button
                                key={q.questionKey}
                                type="button"
                                variant={String(q.questionKey) === String(activeQuestionKey) ? "default" : "outline"}
                                className="h-8 px-3 text-sm"
                                onClick={() => setActiveQuestionKey(String(q.questionKey || "Q1"))}
                              >
                                {String(q.questionKey || "Q?")}{" "}
                                <span className="ml-2 text-xs opacity-80">
                                  {Number(q.awardedMarks ?? 0)}/{Number(q.maxMarks ?? 0)}
                                </span>
                              </Button>
                            ))}
                        </div>
                      </div>

                      {activeQuestion ? (
                        <div className="rounded-lg border border-primary/10 bg-muted/40 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-gray-900">
                              {String(activeQuestion.questionKey || "Question")} analysis
                            </div>
                            <div className="flex gap-2">
                              <Badge variant="secondary" className="text-xs">
                                {Number(activeQuestion.awardedMarks ?? 0)}/{Number(activeQuestion.maxMarks ?? 0)}
                              </Badge>
                              <Badge variant="outline" className="text-xs">
                                {Math.round(Number(activeQuestion.confidence ?? 0))}%
                              </Badge>
                            </div>
                          </div>
                          {String((activeQuestion as any)?.feedback || "").trim() ? (
                            <div className="mt-3 text-sm text-gray-900">
                              <div className="text-xs font-semibold text-muted-foreground mb-1">AI feedback</div>
                              <div className="whitespace-pre-wrap">{String((activeQuestion as any)?.feedback || "").trim()}</div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {Array.isArray(activeQuestion?.mistakes) && activeQuestion.mistakes.length ? (
                        <div className="mt-4 p-4 bg-muted rounded-lg">
                          <h4 className="font-semibold mb-2">Detected Mistakes</h4>
                          <div className="space-y-2">
                            {(() => {
                              const seen = new Set<string>();
                              const uniq = (Array.isArray(activeQuestion?.mistakes) ? activeQuestion.mistakes : []).filter((m: any) => {
                                const t = String(m?.feedback || m?.message || m?.type || "").toLowerCase().replace(/\s+/g, " ").trim();
                                if (!t) return true;
                                if (seen.has(t)) return false;
                                seen.add(t);
                                return true;
                              });
                              return uniq.slice(0, 20).map((m: any, idx: number) => (
                              <div key={`code-m-${idx}`} className="rounded-lg bg-white border border-primary/10 p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <Badge variant="destructive" className="text-xs">{String(m?.type || "mistake")}</Badge>
                                </div>
                                <div className="mt-2 text-sm text-gray-900 whitespace-pre-wrap">
                                  {String(m?.feedback || m?.message || "").trim() || "—"}
                                </div>
                                {String(m?.suggestion || m?.suggestedCorrection || "").trim() ? (
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    Suggested correction: {String(m?.suggestion || m?.suggestedCorrection || "")}
                                  </div>
                                ) : null}
                              </div>
                              ));
                            })()}
                          </div>
                        </div>
                      ) : null}

                      {/* For coding submissions (e.g. .ipynb/.py), show extracted code-text here (per active question). */}
                      <div className="mt-4 p-4 bg-muted rounded-lg">
                        <h4 className="font-semibold mb-2 flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-primary" />
                          Student Submission Text
                        </h4>
                        <p className="text-xs text-muted-foreground mb-2">
                          Status: {content?.extraction?.status || "pending"}{" "}
                          {content?.extraction?.extractor ? `• ${content.extraction.extractor}` : ""}
                        </p>
                        {(() => {
                          const rawText = String(content?.extraction?.rawText || "");
                          if (!rawText.trim()) return <div className="text-sm text-muted-foreground">Extraction not ready yet.</div>;

                          const splitExtractedTextByQuestion = (txt: string) => {
                            const lines = String(txt || "").split(/\r?\n/);
                            const byQ: Record<string, string[]> = {};
                            const all: string[] = [];
                            let currentQ: string | null = null;
                            let buf: string[] = [];
                            const flush = () => {
                              const s = buf.join("\n").trim();
                              if (!s) {
                                buf = [];
                                return;
                              }
                              all.push(s);
                              if (currentQ) {
                                byQ[currentQ] = byQ[currentQ] || [];
                                byQ[currentQ].push(s);
                              }
                              buf = [];
                            };
                            for (const line of lines) {
                              const m = String(line || "").match(/^\s*\[FILE:([^\]]+)\](?:\s*\[QUESTION:(Q\d{1,3})\])?/i);
                              if (m) {
                                flush();
                                const fileLabel = String(m[1] || "");
                                currentQ = String(m[2] || "").trim() || extractQKeyFromName(fileLabel) || null;
                                buf.push(line);
                                continue;
                              }
                              buf.push(line);
                            }
                            flush();
                            const out: Record<string, string> = {};
                            for (const [q, parts] of Object.entries(byQ)) out[q] = parts.join("\n\n").trim();
                            return { byQuestion: out, all: all.join("\n\n").trim() };
                          };

                          const split = splitExtractedTextByQuestion(rawText);
                          const selectedKey = String(activeQuestionKey || "Q1");
                          const bodyText =
                            String(split?.byQuestion?.[selectedKey] || "").trim() ||
                            String(split?.all || "").trim() ||
                            rawText;
                          const cleanedBodyText = normalizeOcrTextForDisplay(stripImageTextBlocks(bodyText));
                          const displayText = showRawExtractedText ? bodyText : cleanedBodyText;
                          const fileLineMatch = bodyText.match(/^\s*\[FILE:[^\]]+\](?:\s*\[QUESTION:(Q\d{1,3})\])?/i);
                          const fileLine = fileLineMatch ? fileLineMatch[0].trim() : "";

                          return (
                            <div className="rounded-xl border border-primary/10 bg-white shadow-sm">
                              {fileLine ? (
                                <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-primary/10 bg-gradient-to-r from-white to-primary/5">
                                  <div className="min-w-0 text-xs font-semibold text-muted-foreground truncate">
                                    {fileLine.replace(/^\[FILE:\s*/i, "").replace(/\]$/i, "")}
                                  </div>
                                  <Badge variant="outline" className="text-[10px]">
                                    extracted
                                  </Badge>
                                </div>
                              ) : null}
                              <div className="px-4 py-3">
                                {renderSubmissionTextWithQaLayout(cleanedBodyText, [])}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
              </TabsContent>

              <TabsContent value="text" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Text Answers</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {/* Uploaded documents (PDF/DOCX) including derived OCR-PDF */}
                      <div className="p-4 bg-muted rounded-lg">
                        <h4 className="font-semibold mb-2 flex items-center gap-2">
                          <FileText className="h-4 w-4 text-primary" />
                          Uploaded Documents
                        </h4>
                        {(() => {
                          const docs = (content?.grouped?.text || []).filter((f: any) => {
                            const name = String(f?.originalName || f?.filename || "").toLowerCase();
                            const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
                            // Never show code-like files in the Text tab.
                            if (CODE_EXTS.has(ext)) return false;
                            return true;
                          });
                          return !docs.length ? (
                          <div className="text-sm text-muted-foreground">No documents detected in this submission.</div>
                          ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {docs.map((f: any) => {
                              return (
                                <a
                                  key={f.id}
                                  href={f.fileUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-xl border border-primary/10 bg-white p-3 hover:shadow-md transition-all"
                                  onClick={(e) => {
                                    // If a code-like file ever ends up here (e.g. legacy data), route teacher to Code tab.
                                    const name = String(f?.originalName || f?.filename || "").toLowerCase();
                                    const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
                                    const isCodeLike = [".py", ".ipynb", ".js", ".ts", ".tsx", ".java", ".c", ".cpp", ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift"].includes(ext);
                                    if (isCodeLike) {
                                      e.preventDefault();
                                      setActiveTab("code");
                                      if (String(f?.id || "")) {
                                        setTimeout(() => loadCodeFile(String(f.id)), 0);
                                      }
                                    }
                                  }}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-semibold text-gray-900 truncate">{f.originalName}</span>
                                    <div className="flex items-center gap-2">
                                      <Badge variant="outline" className="text-xs">doc</Badge>
                                    </div>
                                  </div>
                                  <div className="text-xs text-muted-foreground mt-1 truncate">
                                    {f.mimeType || "document"}
                                  </div>
                                </a>
                              );
                            })}
                          </div>
                          );
                        })()}
                      </div>

                      {(() => {
                        const textQs = (perQuestionScores || []).filter(
                          (q: any) => questionCategory(String(q?.questionKey || "")) === "text"
                        );
                        if (!textQs.length) return null;

                        return (
                          <>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-gray-900">Question:</span>
                              <div className="flex flex-wrap gap-2">
                                {textQs.map((q: any) => (
                                  <Button
                                    key={q.questionKey}
                                    type="button"
                                    variant={String(q.questionKey) === String(activeQuestionKey) ? "default" : "outline"}
                                    className="h-8 px-3 text-sm"
                                    onClick={() => setActiveQuestionKey(String(q.questionKey || "Q1"))}
                                  >
                                    {String(q.questionKey || "Q?")}{" "}
                                    <span className="ml-2 text-xs opacity-80">
                                      {Number(q.awardedMarks ?? 0)}/{Number(q.maxMarks ?? 0)}
                                    </span>
                                  </Button>
                                ))}
                              </div>
                            </div>

                            {activeQuestion ? (
                              <div className="rounded-lg border border-primary/10 bg-muted/40 p-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="text-sm font-semibold text-gray-900">
                                    {String(activeQuestion.questionKey || "Question")} analysis
                                  </div>
                                  <div className="flex gap-2">
                                    <Badge variant="secondary" className="text-xs">
                                      {Number(activeQuestion.awardedMarks ?? 0)}/{Number(activeQuestion.maxMarks ?? 0)}
                                    </Badge>
                                    <Badge variant="outline" className="text-xs">
                                      {Math.round(Number(activeQuestion.confidence ?? 0))}%
                                    </Badge>
                                  </div>
                                </div>
                                {String(activeQuestion.summary || "").trim() ? (
                                  <div className="mt-2 text-xs text-muted-foreground">{String(activeQuestion.summary)}</div>
                                ) : null}
                                {String((activeQuestion as any)?.feedback || "").trim() ? (
                                  <div className="mt-3 text-sm text-gray-900">
                                    <div className="text-xs font-semibold text-muted-foreground mb-1">AI feedback</div>
                                    <div className="whitespace-pre-wrap">{String((activeQuestion as any)?.feedback || "").trim()}</div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="p-4 bg-muted rounded-lg">
                              <h4 className="font-semibold mb-2 flex items-center gap-2">
                                <Sparkles className="h-4 w-4 text-primary" />
                                Student Submission Text
                              </h4>
                              <p className="text-xs text-muted-foreground mb-2">
                                Status: {content?.extraction?.status || "pending"}{" "}
                                {content?.extraction?.extractor ? `• ${content.extraction.extractor}` : ""}
                              </p>
                              {(() => {
                                const rawText = String(content?.extraction?.rawText || "");
                                if (!rawText.trim()) {
                                  return <div className="text-sm text-muted-foreground">Extraction not ready yet.</div>;
                                }

                                const splitExtractedTextByQuestion = (txt: string) => {
                                  const lines = String(txt || "").split(/\r?\n/);
                                  const byQ: Record<string, string[]> = {};
                                  const all: string[] = [];
                                  let currentQ: string | null = null;
                                  let buf: string[] = [];
                                  const flush = () => {
                                    const s = buf.join("\n").trim();
                                    if (!s) {
                                      buf = [];
                                      return;
                                    }
                                    all.push(s);
                                    if (currentQ) {
                                      byQ[currentQ] = byQ[currentQ] || [];
                                      byQ[currentQ].push(s);
                                    }
                                    buf = [];
                                  };
                                  for (const line of lines) {
                                    const m = String(line || "").match(/^\s*\[FILE:([^\]]+)\](?:\s*\[QUESTION:(Q\d{1,3})\])?/i);
                                    if (m) {
                                      flush();
                                      const fileLabel = String(m[1] || "");
                                      currentQ = String(m[2] || "").trim() || extractQKeyFromName(fileLabel) || null;
                                      buf.push(line);
                                      continue;
                                    }
                                    buf.push(line);
                                  }
                                  flush();
                                  const out: Record<string, string> = {};
                                  for (const [q, parts] of Object.entries(byQ)) out[q] = parts.join("\n\n").trim();
                                  return { byQuestion: out, all: all.join("\n\n").trim() };
                                };

                                const split = splitExtractedTextByQuestion(rawText);

                                const allTextFiles = Array.isArray(content?.grouped?.text) ? content.grouped.text : [];
                                const ocrPdf = allTextFiles.find(
                                  (f: any) => Boolean(f?.isDerived) && String(f?.derivedType || "") === "ocr-pdf"
                                );
                                const anyPdf = allTextFiles.find((f: any) =>
                                  String(f?.fileUrl || "").toLowerCase().includes(".pdf")
                                );
                                const previewUrl = String(ocrPdf?.fileUrl || anyPdf?.fileUrl || "");

                                // Only show OCR-related UI when we actually have OCR-derived content.
                                // Text/code submissions (docx/ipynb/plain) should not display OCR warnings/badges.
                                const isOcrExtraction = Boolean(ocrPdf);

                                const renderOneQuestionText = (qKey: string, mistakes: any[]) => {
                                  const bodyText =
                                    String(split?.byQuestion?.[qKey] || "").trim() ||
                                    // Fallback: if extraction didn't label questions, show full text.
                                    String(split?.all || "").trim() ||
                                    rawText;

                                  const cleanedBodyText = normalizeOcrTextForDisplay(stripImageTextBlocks(bodyText));
                                  const displayText = showRawExtractedText ? bodyText : cleanedBodyText;
                                  const fileLineMatch = bodyText.match(/^\s*\[FILE:[^\]]+\](?:\s*\[QUESTION:(Q\d{1,3})\])?/i);
                                  const fileLine = fileLineMatch ? fileLineMatch[0].trim() : "";

                                  // IMPORTANT: When showing per-question slices, character indices no longer match.
                                  // Drop indices and rely on text_span / quote matching for highlights.
                                  const adjustedMistakes = (Array.isArray(mistakes) ? mistakes : []).map((x: any) => {
                                    const out = { ...(x || {}) };
                                    if (out?.start_index != null) out.start_index = null;
                                    if (out?.end_index != null) out.end_index = null;
                                    if (out?.spanStart != null) out.spanStart = null;
                                    if (out?.spanEnd != null) out.spanEnd = null;
                                    return out;
                                  });
                                  const ranges = buildHighlightRanges(bodyText, adjustedMistakes);
                                  const garbled = isOcrExtraction && looksGarbled(displayText);

                                  return (
                                    <div key={`extracted-${qKey}`} className="space-y-2">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="text-sm font-semibold text-gray-900">{qKey}</div>
                                        {fileLine ? (
                                          <Badge variant="outline" className="text-[10px]">
                                            extracted
                                          </Badge>
                                        ) : null}
                                      </div>

                                      {garbled && !showGarbledAnyway ? (
                                        <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-gray-900">
                                          The extracted text looks low quality for this question. Use the scanned preview for accurate reading.
                                          <div className="mt-3">
                                            <Button
                                              type="button"
                                              variant="outline"
                                              className="h-8"
                                              onClick={() => setShowGarbledAnyway(true)}
                                            >
                                              Show text anyway
                                            </Button>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="rounded-xl border border-primary/10 bg-white shadow-sm">
                                          {fileLine ? (
                                            <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-primary/10 bg-gradient-to-r from-white to-primary/5">
                                              <div className="min-w-0 text-xs font-semibold text-muted-foreground truncate">
                                                {fileLine.replace(/^\[FILE:\s*/i, "").replace(/\]$/i, "")}
                                              </div>
                                            </div>
                                          ) : null}
                                          <div className="px-4 py-3">{renderSubmissionTextWithQaLayout(displayText, ranges)}</div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                };

                                return (
                                  <div className="space-y-3">
                                    {isOcrExtraction && previewUrl ? (
                                      <div className="rounded-xl border border-primary/10 bg-white shadow-sm overflow-hidden">
                                        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-primary/10 bg-gradient-to-r from-white to-primary/5">
                                          <div className="text-xs font-semibold text-muted-foreground">Scanned document preview</div>
                                          <Button
                                            type="button"
                                            variant="outline"
                                            className="h-7 px-2 text-xs"
                                            onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
                                          >
                                            <Download className="h-3.5 w-3.5 mr-1" />
                                            Open PDF
                                          </Button>
                                        </div>
                                        <div className="h-[340px] bg-muted/30">
                                          <iframe title="submission-preview" src={previewUrl} className="h-full w-full" />
                                        </div>
                                      </div>
                                    ) : null}

                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        {isOcrExtraction ? (
                                          <>
                                            <Badge variant="outline" className="text-[11px]">
                                              OCR text
                                            </Badge>
                                            <span className="text-xs text-muted-foreground">May contain handwriting errors</span>
                                          </>
                                        ) : null}
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <Button
                                          type="button"
                                          variant={showExtractedText ? "default" : "outline"}
                                          className="h-7 px-2 text-xs"
                                          onClick={() => setShowExtractedText((v) => !v)}
                                        >
                                          {showExtractedText ? "Hide extracted text" : "Show extracted text"}
                                        </Button>
                                      </div>
                                    </div>

                                    {showExtractedText ? (
                                      <div className="space-y-5">
                                        {(textQs || [])
                                          .filter((q: any) => {
                                            const qKey = String(q?.questionKey || "").trim();
                                            if (!qKey) return false;
                                            return String(qKey) === String(activeQuestionKey || "");
                                          })
                                          .map((q: any) => {
                                          const qKey = String(q?.questionKey || "").trim();
                                          if (!qKey) return null;
                                          const mistakes = Array.isArray(q?.mistakes) ? q.mistakes : [];
                                          return renderOneQuestionText(qKey, mistakes);
                                        })}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })()}
                            </div>
                          </>
                        );
                      })()}

                      {Array.isArray(activeQuestion?.mistakes) && activeQuestion.mistakes.length ? (
                        <div className="p-4 bg-muted rounded-lg">
                          <h4 className="font-semibold mb-2">Detected Mistakes</h4>
                          <div className="space-y-2">
                            {(() => {
                              const seen = new Set<string>();
                              const uniq = (Array.isArray(activeQuestion?.mistakes) ? activeQuestion.mistakes : []).filter((m: any) => {
                                const t = String(m?.feedback || m?.message || m?.type || "").toLowerCase().replace(/\s+/g, " ").trim();
                                if (!t) return true;
                                if (seen.has(t)) return false;
                                seen.add(t);
                                return true;
                              });
                              return uniq.slice(0, 20).map((m: any, idx: number) => (
                              <div key={`m-${idx}`} className="rounded-lg bg-white border border-primary/10 p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <Badge variant="destructive" className="text-xs">{String(m?.type || "mistake")}</Badge>
                                </div>
                                <div className="mt-2 text-sm text-gray-900 whitespace-pre-wrap">
                                  {String(m?.feedback || m?.message || "").trim() || "—"}
                                </div>
                                {String(m?.suggestion || m?.suggestedCorrection || "").trim() ? (
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    Suggested correction: {String(m?.suggestion || m?.suggestedCorrection || "")}
                                  </div>
                                ) : null}
                                {String(m?.text_span || m?.evidenceQuote || "").trim() ? (
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    Text span: “{String(m?.text_span || m?.evidenceQuote || "").slice(0, 220)}”
                                  </div>
                                ) : null}
                              </div>
                              ));
                            })()}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="graphical" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Graphical Content</CardTitle>
                    <CardDescription>Images uploaded by the student</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {(() => {
                      const allImgs = Array.isArray(content?.grouped?.graphical) ? content.grouped.graphical : [];
                      const activeQ = String(activeQuestionKey || "").trim();
                      const byQ = activeQ
                        ? allImgs.filter((f: any) => String(f?.questionKey || "").trim() === activeQ)
                        : allImgs;
                      const toShow = byQ.length ? byQ : allImgs;

                      if (!toShow.length) {
                        return <div className="text-sm text-muted-foreground">No images detected in this submission.</div>;
                      }

                      return (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          {toShow.map((f: any) => (
                            <a
                              key={f.id}
                              href={f.fileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="group rounded-xl border border-primary/10 bg-white overflow-hidden hover:shadow-md transition-all"
                            >
                              <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                                <img
                                  src={f.fileUrl}
                                  alt={f.originalName}
                                  className="h-full w-full object-cover group-hover:scale-[1.01] transition-transform"
                                  loading="lazy"
                                />
                              </div>
                              <div className="p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-sm font-semibold text-gray-900 truncate">{f.originalName}</span>
                                  <div className="flex items-center gap-2">
                                    {String(f?.questionKey || "").trim() ? (
                                      <Badge variant="secondary" className="text-xs">{String(f.questionKey)}</Badge>
                                    ) : null}
                                    <Badge variant="outline" className="text-xs">image</Badge>
                                  </div>
                                </div>
                              </div>
                            </a>
                          ))}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
              </TabsContent>

              {header?.assessmentType === "assignment" ? (
                <TabsContent value="plagiarism" className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Plagiarism Detection Report</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-muted-foreground">
                          Compares student answers against other students in the same assessment.
                        </div>
                        <Button
                          type="button"
                          onClick={() => runPlagiarismCheck(plagiarismResult ? true : false)}
                          disabled={plagiarismLoading || isProcessing || loading}
                          className="bg-gradient-primary text-primary-foreground hover:shadow-glow"
                        >
                          {plagiarismLoading
                            ? plagiarismPhase === "phase1"
                              ? "Phase 1: Extracting text…"
                              : plagiarismPhase === "phase2"
                                ? "Phase 2: Calculating internal plagiarism…"
                                : plagiarismPhase === "phase3"
                                  ? "Phase 3: Calculating external plagiarism…"
                                  : "Checking…"
                            : plagiarismResult
                              ? "Re-run Plagiarism Check"
                              : "Run Plagiarism Check"}
                        </Button>
                      </div>

                      <Separator className="my-4" />

                      {/* Plagiarism Check Logs */}
                      {plagiarismLogs.length > 0 && (
                        <div className="space-y-2 mb-4">
                          <div className="text-sm font-semibold text-gray-900">Plagiarism Check Logs</div>
                          <div className="rounded-lg border border-primary/10 bg-slate-50 p-3 max-h-40 overflow-y-auto font-mono text-xs text-slate-700 space-y-1">
                            {plagiarismLogs.map((log, idx) => (
                              <div key={idx} className="text-slate-600">
                                {log.includes('✓') ? (
                                  <span className="text-green-600">{log}</span>
                                ) : log.includes('✗') ? (
                                  <span className="text-red-600">{log}</span>
                                ) : (
                                  log
                                )}
                              </div>
                            ))}
                            <div ref={logsEndRef} />
                          </div>
                        </div>
                      )}

                      {plagiarismResult ? (
                        <div className="space-y-3">
                          {/* Overall Plagiarism Score */}
                          <div className="rounded-lg border border-primary/20 bg-gradient-to-r from-blue-50 to-indigo-50 p-4">
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-xs font-semibold text-muted-foreground">PLAGIARISM SUMMARY</div>
                              {plagiarismResult?.cached && (
                                <Badge variant="secondary" className="text-xs">
                                  Cached Score
                                </Badge>
                              )}
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                              <div className="text-center">
                                <div className="text-2xl font-bold text-blue-600">{Number(plagiarismResult?.internalScore || 0)}%</div>
                                <div className="text-xs text-muted-foreground mt-1">Internal<br/>(Student-to-Student)</div>
                              </div>
                              <div className="text-center">
                                <div className="text-2xl font-bold text-amber-600">{Number(plagiarismResult?.aiScore || 0)}%</div>
                                <div className="text-xs text-muted-foreground mt-1">External<br/>(Online/AI)</div>
                              </div>
                              <div className="text-center">
                                <div className="text-2xl font-bold text-red-600">{Number(plagiarismResult?.overallScore || 0)}%</div>
                                <div className="text-xs text-muted-foreground mt-1">Overall<br/>(Combined)</div>
                              </div>
                            </div>
                            {plagiarismResult?.riskLevel && (
                              <div className="mt-3 pt-3 border-t border-primary/10 text-xs text-center">
                                <span className="font-semibold">Risk Level:</span> <Badge variant="outline" className="ml-1">{plagiarismResult.riskLevel.toUpperCase()}</Badge>
                              </div>
                            )}
                          </div>

                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold text-gray-900">Best match</div>
                            <Badge variant={Number(plagiarismResult?.bestMatchPercent || 0) >= 70 ? "destructive" : "outline"} className="text-base">
                              {Number(plagiarismResult?.bestMatchPercent || 0)}%
                            </Badge>
                          </div>

                          {plagiarismResult?.penalty ? (
                            <div className="rounded-lg border border-primary/10 bg-muted/30 p-3">
                              <div className="text-xs font-semibold text-muted-foreground">Policy decision</div>
                              <div className="mt-1 text-sm text-gray-900">
                                Band: <span className="font-semibold">{String(plagiarismResult.penalty.band || "—")}</span>
                                {"  "}• Penalty: <span className="font-semibold">{Number(plagiarismResult.penalty.penaltyPercent || 0)}%</span>
                              </div>
                            </div>
                          ) : null}

                          {Array.isArray(plagiarismResult?.matches) && plagiarismResult.matches.length ? (
                            <div className="space-y-2">
                              <div className="text-xs font-semibold text-muted-foreground mb-2">Similar Student Submissions</div>
                              {plagiarismResult.matches.map((m: any, idx: number) => (
                                <div key={`pl-${idx}`} className="rounded-lg border border-primary/10 bg-white p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs font-semibold text-muted-foreground">
                                      Matched:{" "}
                                      <span className="text-gray-900">
                                        {String(m?.studentName || "—")}
                                      </span>
                                    </div>
                                    <Badge variant="secondary" className="text-xs">
                                      {Number(m?.matchPercent || 0)}%
                                    </Badge>
                                  </div>
                                  {String(m?.snippet || "").trim() ? (
                                    <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap">
                                      {String(m.snippet)}
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-muted-foreground">No similar student submissions found for this assessment yet.</div>
                          )}

                          {Number(plagiarismResult?.aiScore || 0) > 0 ? (
                            <div className="mt-4 space-y-2">
                              <Separator />
                              <div className="text-xs font-semibold text-muted-foreground">Online Resources / AI-Generated</div>
                              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-xs font-semibold text-amber-900">AI-Generated Content Detected</div>
                                  <Badge variant="outline" className="text-xs bg-amber-100 text-amber-900 border-amber-200">
                                    {Number(plagiarismResult?.aiScore || 0)}%
                                  </Badge>
                                </div>
                                {plagiarismResult?.isGptGenerated && (
                                  <div className="mt-2 text-xs text-amber-800">
                                    ⚠️ Content appears to be generated by AI language models.
                                  </div>
                                )}
                                {String(plagiarismResult?.aiAdditionalFeedback || "").trim() && (
                                  <div className="mt-2 text-xs text-amber-800">
                                    {String(plagiarismResult.aiAdditionalFeedback)}
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-sm text-muted-foreground">
                          Click “Run Plagiarism Check” to generate a similarity report.
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              ) : null}
            </Tabs>
          </div>

          {/* Right Column - Stats */}
          <div className="space-y-6">
            {/* Comparison Stats */}
            <Card className="h-full">
              <CardHeader>
                <CardTitle>Course Performance</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-gradient-card rounded-lg">
                    <span className="text-sm font-medium">Average</span>
                    <Badge variant="outline" className="text-base">
                      {coursePerfLoading ? "…" : `${coursePerf?.averagePercent ?? coursePerf?.currentPercent ?? 0}%`}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gradient-card rounded-lg">
                    <span className="text-sm font-medium">Student Rank</span>
                    <Badge variant="success" className="text-base">
                      {coursePerfLoading
                        ? "…"
                        : coursePerf?.rank
                          ? `#${coursePerf.rank} of ${coursePerf.totalStudents || 0}`
                          : `#1 of ${coursePerf?.totalStudents ? coursePerf.totalStudents : 1}`}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gradient-card rounded-lg">
                    <span className="text-sm font-medium">Improvement</span>
                    <Badge variant="info" className="text-base">
                      {coursePerfLoading
                        ? "…"
                        : coursePerf?.improvementDelta == null
                          ? `+100% from last ${header?.assessmentType === "quiz" ? "quiz" : "assignment"}`
                          : `${coursePerf.improvementDelta >= 0 ? "+" : ""}${coursePerf.improvementDelta}% from last ${header?.assessmentType === "quiz" ? "quiz" : "assignment"}`}
                    </Badge>
                  </div>
                </div>
                
                <Separator />
                
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium mb-2">Performance Trend</p>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Previous {header?.assessmentType === "quiz" ? "quiz" : "assignment"}</span>
                        <span>
                          {coursePerf?.previousPercent == null
                            ? `No previous ${header?.assessmentType === "quiz" ? "quiz" : "assignment"}`
                            : `${coursePerf.previousPercent}%`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          Current {header?.assessmentType === "quiz" ? "quiz" : "assignment"} marks
                        </span>
                        <span className="font-bold text-primary">
                          {overall.awarded != null && overall.max != null
                            ? (() => {
                                const fmtMark = (n: any) => {
                                  const v = Number(n);
                                  if (!Number.isFinite(v)) return "—";
                                  // Show integer if already an integer; otherwise show 1 decimal (e.g., 2.59 -> 2.6, 2.5 stays 2.5)
                                  return Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toFixed(1);
                                };
                                return `${fmtMark(overall.awarded)}/${fmtMark(overall.max)}`;
                              })()
                            : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <Separator />
                  
                  <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
                    <p className="text-xs text-muted-foreground">
                      {coursePerf?.improvementDelta == null
                        ? "This is the first graded submission in this course for this assessment type."
                        : coursePerf.improvementDelta >= 0
                          ? "This student improved compared to their previous submission."
                          : "This student scored lower than their previous submission."}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AIGrading;