import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  Brain,
  ChevronLeft,
  Upload,
  Search,
  Download,
  Calendar,
  FileText,
  User,
  AlertCircle,
  Scan,
  CheckCircle,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { auth } from "../../firebase";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type GroupedSubmission = {
  submissionId: string;
  studentId: string;
  studentName: string;
  status: string;
  isLate: boolean;
  submittedAt: string | null;
  uploadedFilesCount: number;
  grade: number | null;
  maxGrade: number | null;
};

type GroupedAssessment = {
  assessmentId: string;
  assessmentTitle: string;
  assessmentType: "quiz" | "assignment";
  submissions: GroupedSubmission[];
  stats: { total: number; graded: number; pending: number; late: number };
};

type GroupedCourse = {
  courseCode: string;
  courseName?: string;
  courseId?: string;
  types: {
    quiz: { assessments: GroupedAssessment[]; totals: any };
    assignment: { assessments: GroupedAssessment[]; totals: any };
  };
};

const Submissions = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [teacherId, setTeacherId] = useState("");
  const [courses, setCourses] = useState<GroupedCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // AutoMark UI state
  const [autoMarkOpen, setAutoMarkOpen] = useState(false);
  const [autoMarkTarget, setAutoMarkTarget] = useState<{ assessmentId: string; assessmentTitle: string; courseCode: string } | null>(null);
  const [autoMarkMeta, setAutoMarkMeta] = useState<any>(null);
  const [autoMarkPrimaryAction, setAutoMarkPrimaryAction] = useState<"automark" | "remark">("automark");
  const [autoMarkLoading, setAutoMarkLoading] = useState(false);
  const [sampleAnswerFile, setSampleAnswerFile] = useState<File | null>(null);
  const [uploadingSample, setUploadingSample] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchJob, setBatchJob] = useState<any>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchJobTypeHint, setBatchJobTypeHint] = useState<string>("");
  const [batchUiMessage, setBatchUiMessage] = useState<{ kind: "success" | "error"; title: string; detail?: string } | null>(null);
  const [lastJobByAssessment, setLastJobByAssessment] = useState<Record<string, { jobId: string; jobType: string }>>({});
  const [sampleStatusByAssessment, setSampleStatusByAssessment] = useState<Record<string, string>>({});
  const samplePollCancelRef = useRef(false);
  const batchPollCancelRef = useRef(false);
  const autoOpenHandledRef = useRef(false);

  // --- Sample-upload dialog ---
  const [sampleDialogOpen, setSampleDialogOpen] = useState(false);
  const [sampleDialogTarget, setSampleDialogTarget] = useState<{ assessmentId: string; assessmentTitle: string; courseCode: string } | null>(null);
  const [sampleDialogFile, setSampleDialogFile] = useState<File | null>(null);
  const [sampleDialogUploading, setSampleDialogUploading] = useState(false);
  const [sampleDialogMeta, setSampleDialogMeta] = useState<any>(null);
  const sampleDialogPollCancelRef = useRef(false);

  // --- Marking dialog (Extract + AutoMark) ---
  const [markingDialogOpen, setMarkingDialogOpen] = useState(false);
  const [markingDialogTarget, setMarkingDialogTarget] = useState<{ assessmentId: string; assessmentTitle: string; courseCode: string } | null>(null);
  const [markingDialogMeta, setMarkingDialogMeta] = useState<any>(null);
  const [markingDialogLoading, setMarkingDialogLoading] = useState(false);
  const [markingDialogAction, setMarkingDialogAction] = useState<"automark" | "remark">("automark");

  useEffect(() => {
    // Allow other screens (e.g., AI Grading) to deep-link into the existing AutoMark dialog.
    // We use navigation state so we don't need query params or new routes.
    const payload = (location.state as any)?.autoOpenAutoMark;
    if (!payload) return;
    if (autoOpenHandledRef.current) return;

    const assessmentId = String(payload?.assessmentId || "").trim();
    const assessmentTitle = String(payload?.assessmentTitle || "").trim();
    const courseCode = String(payload?.courseCode || "").trim();
    const primaryActionRaw = String(payload?.primaryAction || "automark").toLowerCase();
    const primaryAction = primaryActionRaw === "remark" ? "remark" : "automark";

    if (!assessmentId || !assessmentTitle || !courseCode) return;
    autoOpenHandledRef.current = true;

    openAutoMark(assessmentId, assessmentTitle, courseCode, { primaryAction }).catch(() => {});

    // Clear location.state so a refresh/back doesn't keep re-opening the dialog.
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const pollExistingJob = async (jobId: string, opts?: { jobTypeHint?: string; onFinally?: () => void }) => {
    setBatchOpen(true);
    setBatchLoading(true);
    setBatchUiMessage(null);
    batchPollCancelRef.current = false;
    if (opts?.jobTypeHint) setBatchJobTypeHint(opts.jobTypeHint);

    const fetchJob = async () => {
      // Auto-detect endpoint: try automark first, then extract.
      // This prevents 404s when jobTypeHint is stale or missing.
      try {
        const jr = await fetch(`http://localhost:5000/api/automark/jobs/${encodeURIComponent(jobId)}`);
        const jd = await jr.json().catch(() => ({}));
        if (jr.ok && jd?.success) return jd;
      } catch {}
      const jr2 = await fetch(`http://localhost:5000/api/extract/jobs/${encodeURIComponent(jobId)}`);
      const jd2 = await jr2.json().catch(() => ({}));
      if (jr2.ok && jd2?.success) return jd2;
      throw new Error(jd2?.error || `Job not found (${jr2.status})`);
    };

    const poll = async () => {
      if (batchPollCancelRef.current) return;
        try {
          const jd = await fetchJob();
          setBatchJob(jd.job);
          const st = String(jd.job?.status || "");
            if (st === "completed" || st === "failed") {
              setBatchLoading(false);
            opts?.onFinally?.();
              return;
            }
        } catch (e: any) {
          setBatchJob((prev: any) => ({
            ...(prev || { _id: jobId }),
            logs: [
              ...((prev?.logs || []) as any[]),
              { ts: new Date(), level: "error", message: `Failed to poll job: ${e?.message || String(e)}` },
            ],
          }));
        }
        setTimeout(poll, 1500);
    };
    poll();
  };

  const startAndPollJob = async (
    startUrl: string,
    onCompleted?: () => void,
    onFinally?: () => void
  ) => {
    setBatchOpen(true);
    setBatchLoading(true);
    setBatchJob(null);
    setBatchUiMessage(null);
    batchPollCancelRef.current = false;
    try {
      // Hint job type so the progress dialog title/description is correct before the first poll response arrives.
      try {
        const u = new URL(startUrl);
        const m = u.pathname.match(/\/assessments\/([^/]+)\/(extract-batch|digitize-batch|automark-batch|remark-batch|publish-batch)/i);
        const hint =
          m?.[2] === "extract-batch" ? "ExtractStudentChunks" :
          m?.[2] === "digitize-batch" ? "digitize" :
          m?.[2] === "remark-batch" ? "remark" :
          m?.[2] === "publish-batch" ? "publish" :
          "automark";
        setBatchJobTypeHint(hint);
      } catch {
        setBatchJobTypeHint("");
      }

      const startRes = await fetch(startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Retry-safe remark: don't redo re-ingestion/extraction on slow machines unless needed.
        body: JSON.stringify({
          teacherId,
          ...(startUrl.includes("/remark-batch") ? { skipReingest: true } : {}),
        }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !startData?.success) {
        throw new Error(startData?.error || `Failed to start job (${startRes.status})`);
      }
      const jobId = String(startData.jobId || "");
      if (!jobId) throw new Error("jobId missing");

      // Remember the latest job for this assessment (so closing/reopening doesn't reset progress)
      try {
        const u = new URL(startUrl);
        const m = u.pathname.match(/\/assessments\/([^/]+)\/(extract-batch|digitize-batch|automark-batch|remark-batch|publish-batch)/i);
        const assessmentId = m?.[1] ? decodeURIComponent(m[1]) : "";
        const jobType =
          m?.[2] === "extract-batch" ? "ExtractStudentChunks" :
          m?.[2] === "digitize-batch" ? "digitize" :
          m?.[2] === "remark-batch" ? "remark" :
          m?.[2] === "publish-batch" ? "publish" :
          "automark";
        if (assessmentId) {
          setLastJobByAssessment((prev) => ({ ...prev, [assessmentId]: { jobId, jobType } }));
        }
      } catch {}

      const poll = async () => {
        if (batchPollCancelRef.current) return;
        try {
          // Auto-detect endpoint like pollExistingJob.
          let jr = await fetch(`http://localhost:5000/api/automark/jobs/${encodeURIComponent(jobId)}`);
          let jd = await jr.json().catch(() => ({}));
          if (!(jr.ok && jd?.success)) {
            jr = await fetch(`http://localhost:5000/api/extract/jobs/${encodeURIComponent(jobId)}`);
            jd = await jr.json().catch(() => ({}));
          }
          if (jr.ok && jd?.success) {
            setBatchJob(jd.job);
            const st = String(jd.job?.status || "");
            if (st === "completed") {
              setBatchLoading(false);
              const title = String(autoMarkTarget?.assessmentTitle || "").trim();
              const jobTypeLower = String((jd.job?.jobType || batchJobTypeHint) || "").toLowerCase();
              if (jobTypeLower === "remark" && title) {
                setBatchUiMessage({
                  kind: "success",
                  title: `${title} has been auto-marked again`,
                  detail: "Re-ingestion + LLM re-run completed successfully.",
                });
              }
              onCompleted?.();
              onFinally?.();
              return;
            }
            if (st === "failed") {
              setBatchLoading(false);
              setBatchUiMessage({
                kind: "error",
                title: "AutoMark failed",
                detail: String(jd.job?.error || "").trim() || "Check backend logs for details.",
              });
              toast({
                title: "Job failed",
                description: jd.job?.error || "Check backend logs for details.",
                variant: "destructive",
              });
              onFinally?.();
              return;
            }
          }
        } catch (e: any) {
          setBatchJob((prev: any) => ({
            ...(prev || { _id: jobId, jobType: batchJobTypeHint }),
            logs: [
              ...((prev?.logs || []) as any[]),
              { ts: new Date(), level: "error", message: `Failed to poll job: ${e?.message || String(e)}` },
            ],
          }));
        }
        setTimeout(poll, 1500);
      };
      poll();
    } catch (e: any) {
      setBatchLoading(false);
      toast({
        title: "Failed to start",
        description: e?.message || String(e),
        variant: "destructive",
      });
      setBatchUiMessage({
        kind: "error",
        title: "Failed to start job",
        detail: e?.message || String(e),
      });
      onFinally?.();
    }
  };

  const getSampleStatus = async (assessmentId: string) => {
    const res = await fetch(`http://localhost:5000/api/assessments/${encodeURIComponent(assessmentId)}/automark-meta`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.success) throw new Error(data?.error || `Failed to fetch automark meta (${res.status})`);
    const sample = String(data?.sampleAnswerStatus || "missing");
    const rubric = String(data?.rubricStatus || "missing");
    const clo = String(data?.cloStatus || "missing");

    const assessmentType = String(data?.assessment?.type || "").toLowerCase();
    // Quizzes often have no standalone rubric (sample answer contains the marking guidance),
    // so treat rubric as optional for quizzes.
    const rubricRequired = assessmentType !== "quiz";
    const rubricOk = rubricRequired ? rubric === "ready" : rubric === "ready" || rubric === "missing";

    const allReady = sample === "ready" && rubricOk && clo === "ready";
    const anyFailed = sample === "failed" || rubric === "failed" || clo === "failed";
    const anyPending = sample === "pending" || rubric === "pending" || clo === "pending";
    const anyMissing = sample === "missing" || rubric === "missing" || clo === "missing";

    // Combined readiness status for UI gating
    const status = allReady ? "ready" : anyFailed ? "failed" : anyPending || anyMissing ? "pending" : "pending";

    const meta = { ...data, automarkAllStatus: status, automarkReady: allReady };
    setSampleStatusByAssessment((prev) => ({ ...prev, [assessmentId]: status }));
    return { status, meta };
  };

  const statusBadgeVariant = (stRaw: any) => {
    const st = String(stRaw || "").toLowerCase();
    if (st === "ready") return "success";
    if (st === "failed") return "destructive";
    if (st === "pending") return "warning";
    return "outline";
  };

  const statusLabel = (stRaw: any) => {
    const st = String(stRaw || "").toLowerCase();
    if (st === "ready") return "Extracted";
    if (st === "failed") return "Failed";
    if (st === "pending") return "Extracting…";
    return "Missing";
  };

  const waitForAutomarkReady = async (assessmentId: string, opts?: { toastTitle?: string }) => {
    const processingToast = toast({
      title: opts?.toastTitle || "Processing sample answer…",
      description: "Starting extraction/embedding. Status will update as Sample, Rubric, and CLO complete.",
      duration: 1000000,
    });

    const startedAt = Date.now();
    const timeoutMs = 6 * 60 * 1000;
    samplePollCancelRef.current = false;

    try {
      while (!samplePollCancelRef.current) {
        const { status, meta } = await getSampleStatus(assessmentId);
        setAutoMarkMeta(meta);

        if (status === "ready") {
          processingToast.update({
            id: processingToast.id,
            title: "Sample answer ready",
            description: "Extraction and embedding completed.",
            duration: 4000,
          } as any);
          return true;
        }

        if (status === "failed") {
          processingToast.update({
            id: processingToast.id,
            title: "Sample answer failed",
            description: "Extraction/embedding failed. Check backend logs for details.",
            variant: "destructive",
            duration: 8000,
          } as any);
          return false;
        }

        if (Date.now() - startedAt > timeoutMs) {
          processingToast.update({
            id: processingToast.id,
            title: "Still processing…",
            description: "This is taking longer than expected. You can keep the dialog open and try again shortly.",
            duration: 8000,
          } as any);
          return false;
        }

        await new Promise((r) => setTimeout(r, 1500));
      }

      processingToast.dismiss();
      return false;
    } catch (e: any) {
      processingToast.update({
        id: processingToast.id,
        title: "Status check failed",
        description: e?.message || String(e),
        variant: "destructive",
        duration: 8000,
      } as any);
      return false;
    }
  };

  const fetchTeacherGrouped = async (uid: string) => {
    if (!uid) return;

    try {
      const response = await fetch(`http://localhost:5000/api/submissions/teacher/${uid}/grouped`);
      const data = await response.json();

      if (data.success && Array.isArray(data.courses)) {
        setCourses(data.courses);
      } else {
        setCourses([]);
      }
    } catch (error) {
      console.error("Failed to fetch teacher grouped submissions:", error);
      setCourses([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        setTeacherId(user.uid);
        fetchTeacherGrouped(user.uid);
      } else {
        setTeacherId("");
        setCourses([]);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!teacherId) return;

    const interval = setInterval(() => {
      fetchTeacherGrouped(teacherId);
    }, 4000); // near real-time polling

    return () => clearInterval(interval);
  }, [teacherId]);

  const filteredCourses = useMemo(() => {
    if (!searchQuery.trim()) return courses;
    const q = searchQuery.trim().toLowerCase();

    return courses
      .map((c) => {
        const filterAssessments = (assessments: GroupedAssessment[]) =>
          assessments
            .map((a) => {
              const subs = a.submissions.filter((s) => {
      return (
                  String(s.studentName || "").toLowerCase().includes(q) ||
                  String(s.studentId || "").toLowerCase().includes(q)
      );
    });
              const matchAssessment =
                String(a.assessmentTitle || "").toLowerCase().includes(q) ||
                String(c.courseCode || "").toLowerCase().includes(q) ||
                String(c.courseName || "").toLowerCase().includes(q);
              return matchAssessment ? a : { ...a, submissions: subs, stats: { ...a.stats, total: subs.length } };
            })
            .filter((a) => a.submissions.length > 0 || String(a.assessmentTitle || "").toLowerCase().includes(q));

        const quizAssessments = filterAssessments(c.types.quiz.assessments || []);
        const assignmentAssessments = filterAssessments(c.types.assignment.assessments || []);

        return {
          ...c,
          types: {
            quiz: { ...c.types.quiz, assessments: quizAssessments },
            assignment: { ...c.types.assignment, assessments: assignmentAssessments },
          },
        };
      })
      .filter((c) => c.types.quiz.assessments.length > 0 || c.types.assignment.assessments.length > 0);
  }, [courses, searchQuery]);

  const openAutoMark = async (
    assessmentId: string,
    assessmentTitle: string,
    courseCode: string,
    opts?: { primaryAction?: "automark" | "remark" }
  ) => {
    setAutoMarkOpen(true);
    setAutoMarkTarget({ assessmentId, assessmentTitle, courseCode });
    setAutoMarkMeta(null);
    setAutoMarkPrimaryAction(opts?.primaryAction || "automark");
    setSampleAnswerFile(null);
    setAutoMarkLoading(true);
    try {
      const { meta } = await getSampleStatus(assessmentId);
      setAutoMarkMeta(meta);
      // If there is an existing running job for this assessment, re-open its progress without resetting.
      const last = lastJobByAssessment[assessmentId];
      if (last?.jobId) {
        const currentStatus = String(batchJob?.status || "").toLowerCase();
        const isActive = currentStatus === "queued" || currentStatus === "running";
        if (isActive) {
          // keep showing the current batch job
        } else {
          // try polling the last job id; if it's completed/failed it will stop quickly
          pollExistingJob(last.jobId, { jobTypeHint: last.jobType }).catch(() => {});
        }
      }
    } catch (e: any) {
      toast({
        title: "AutoMark metadata failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
      setAutoMarkMeta(null);
    } finally {
      setAutoMarkLoading(false);
    }
  };

  const uploadSampleAnswer = async () => {
    if (!autoMarkTarget?.assessmentId) return;
    if (!sampleAnswerFile) {
      toast({
        title: "Sample answer required",
        description: "Please choose a PDF/DOCX/JPG/PNG file.",
        variant: "destructive",
      });
      return;
    }

    setUploadingSample(true);
    try {
      const currentStatus = String(autoMarkMeta?.sampleAnswerStatus || "").toLowerCase();
      const needsReplaceConfirm = currentStatus === "ready" || currentStatus === "pending";
      if (needsReplaceConfirm) {
        const ok = window.confirm(
          "A sample answer already exists for this assessment. Uploading will REPLACE it. Continue?"
        );
        if (!ok) return;
      }

      const fd = new FormData();
      fd.append("sampleAnswerFile", sampleAnswerFile, sampleAnswerFile.name);

      const replace = needsReplaceConfirm ? "true" : "false";
      const res = await fetch(
        `http://localhost:5000/api/assessments/${encodeURIComponent(autoMarkTarget.assessmentId)}/upload-sample-answer?replace=${replace}`,
        { method: "POST", body: fd }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Upload failed (${res.status})`);
      }

      toast({
        title: "Sample answer uploaded",
        description: "Extraction/ingestion started.",
      });
      // Poll until sample + rubric + clo are fully ready (enables Extract/AutoMark buttons).
      await waitForAutomarkReady(autoMarkTarget.assessmentId, { toastTitle: "Sample answer uploaded — processing…" });
    } catch (e: any) {
      toast({
        title: "Upload failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    } finally {
      setUploadingSample(false);
    }
  };

  useEffect(() => {
    // Cancel any polling when dialog closes/unmounts.
    if (!autoMarkOpen) {
      samplePollCancelRef.current = true;
    }
    return () => {
      samplePollCancelRef.current = true;
    };
  }, [autoMarkOpen]);

  useEffect(() => {
    // Do NOT cancel polling when modal closes; jobs should continue in background.
    // Polling is cancelled only when starting a new job or unmounting.
    return () => {};
  }, [batchOpen]);

  useEffect(() => {
    if (!sampleDialogOpen) sampleDialogPollCancelRef.current = true;
    return () => { sampleDialogPollCancelRef.current = true; };
  }, [sampleDialogOpen]);

  // Pre-fetch sample status for all visible assessments so the brain button is correctly enabled/disabled.
  useEffect(() => {
    if (!teacherId || courses.length === 0) return;
    courses.forEach((c) => {
      (["quiz", "assignment"] as const).forEach((t) => {
        c.types[t].assessments.forEach((a) => {
          if (!sampleStatusByAssessment[a.assessmentId]) {
            getSampleStatus(a.assessmentId).catch(() => {});
          }
        });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses]);

  const openReview = async (assessmentId: string, submissions: GroupedSubmission[], submissionId: string) => {
    // queue = ALL submissions (graded + ungraded) so teacher can step through everyone
    const queue = Array.isArray(submissions) ? submissions : [];
    const queueSubmissionIds = queue.map((s) => s.submissionId);
    const queueIndex = Math.max(0, queueSubmissionIds.indexOf(submissionId));

    navigate("/ai-grading", {
      state: {
        submissionId,
        assessmentId,
        queueSubmissionIds,
        queueIndex,
        teacherView: true,
      },
    });
  };

  const openSubmissionFile = async (submissionId: string) => {
    try {
      const res = await fetch(`http://localhost:5000/api/submissions/${encodeURIComponent(submissionId)}/content?teacherId=${encodeURIComponent(teacherId)}`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Failed to load submission files");
      }

      const file = Array.isArray(data.files) && data.files[0] ? data.files[0] : null;
      if (!file || !file.fileUrl) {
        throw new Error("No submission file available to open");
      }

      window.open(String(file.fileUrl), "_blank", "noopener,noreferrer");
    } catch (e: any) {
      toast({
        title: "Unable to open submission",
        description: e?.message || String(e),
        variant: "destructive",
      });
    }
  };

  const openExtractFlow = async (assessment: GroupedAssessment) => {
    try {
      const { status } = await getSampleStatus(assessment.assessmentId);
      if (status !== "ready") {
        toast({
          title: "Sample answer not ready",
          description: "Upload and extract the sample answer first.",
          variant: "destructive",
        });
        return;
      }

      const ungraded = assessment.submissions.filter((s) => String(s.status || "") !== "graded");
      if (ungraded.length === 0) {
        toast({
          title: "No pending submissions",
          description: "All submissions for this assessment are already graded.",
        });
        return;
      }

      await startAndPollJob(
        `http://localhost:5000/api/assessments/${encodeURIComponent(assessment.assessmentId)}/extract-batch`,
        () => {
          toast({ title: "Extraction completed", description: "All pending submissions were extracted." });
          fetchTeacherGrouped(teacherId);
        }
      );
    } catch (e: any) {
      toast({
        title: "Extraction failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    }
  };

  const openDigitizeFlow = async (assessment: GroupedAssessment) => {
    try {
      const ungraded = assessment.submissions.filter((s) => String(s.status || "") !== "graded");
      if (ungraded.length === 0) {
        toast({
          title: "No pending submissions",
          description: "There are no submissions to digitize for this assessment.",
        });
        return;
      }

      await startAndPollJob(
        `http://localhost:5000/api/assessments/${encodeURIComponent(assessment.assessmentId)}/digitize-batch`,
        () => {
          toast({ title: "Digitization completed", description: "OCR PDFs were generated for image submissions." });
          fetchTeacherGrouped(teacherId);
        }
      );
    } catch (e: any) {
      toast({
        title: "Digitization failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    }
  };

  const openAutoMarkFlow = async (assessment: GroupedAssessment) => {
    try {
      const { status } = await getSampleStatus(assessment.assessmentId);
      if (status !== "ready") {
        toast({
          title: "Sample answer not ready",
          description: "Upload and extract the sample answer first.",
          variant: "destructive",
        });
        return;
      }

      const ungraded = assessment.submissions.filter((s) => String(s.status || "") !== "graded");
      if (ungraded.length === 0) {
        toast({
          title: "No pending submissions",
          description: "All submissions for this assessment are already graded.",
        });
        return;
      }

      await startAndPollJob(
        `http://localhost:5000/api/assessments/${encodeURIComponent(assessment.assessmentId)}/automark-batch`,
        () => {
          toast({ title: "AutoMark completed", description: "All pending submissions were auto-marked." });
          fetchTeacherGrouped(teacherId);
          navigate("/ai-grading", {
            state: {
              submissionId: ungraded[0].submissionId,
              assessmentId: assessment.assessmentId,
              queueSubmissionIds: ungraded.map((s) => s.submissionId),
              queueIndex: 0,
              teacherView: true,
              autoRun: false,
            },
          });
        }
      );
    } catch (e: any) {
      toast({
        title: "AutoMark failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    }
  };

  const openRemarkFlow = async (assessment: GroupedAssessment) => {
    try {
      const { status } = await getSampleStatus(assessment.assessmentId);
      if (status !== "ready") {
        toast({
          title: "Sample answer not ready",
          description: "Upload and extract the sample answer first.",
          variant: "destructive",
        });
        return;
      }

      const ok = window.confirm(
        "Re-mark will re-generate AI reports for ALL submissions (including graded) and replace previous AI results. Continue?"
      );
      if (!ok) return;

      await startAndPollJob(
        `http://localhost:5000/api/assessments/${encodeURIComponent(assessment.assessmentId)}/remark-batch`,
        () => {
          toast({ title: "Re-mark completed", description: "AI reports were regenerated and replaced." });
          fetchTeacherGrouped(teacherId);
        }
      );
    } catch (e: any) {
      toast({
        title: "Re-mark failed",
        description: e?.message || String(e),
        variant: "destructive",
      });
    }
  };

  // Opens the sample-answer upload dialog for an assessment.
  const openSampleDialog = async (assessment: GroupedAssessment, courseCode: string) => {
    setSampleDialogOpen(true);
    setSampleDialogTarget({ assessmentId: assessment.assessmentId, assessmentTitle: assessment.assessmentTitle, courseCode });
    setSampleDialogFile(null);
    setSampleDialogMeta(null);
    sampleDialogPollCancelRef.current = false;
    try {
      const { meta } = await getSampleStatus(assessment.assessmentId);
      setSampleDialogMeta(meta);
    } catch {}
  };

  const doUploadSampleInDialog = async () => {
    if (!sampleDialogTarget?.assessmentId) return;
    if (!sampleDialogFile) {
      toast({ title: "File required", description: "Choose a PDF, DOCX, JPG, or PNG file.", variant: "destructive" });
      return;
    }
    setSampleDialogUploading(true);
    sampleDialogPollCancelRef.current = false;
    try {
      const currentStatus = String(sampleDialogMeta?.sampleAnswerStatus || "").toLowerCase();
      if (currentStatus === "ready" || currentStatus === "pending") {
        const ok = window.confirm("A sample answer already exists for this assessment. Uploading will REPLACE it. Continue?");
        if (!ok) return;
      }
      const fd = new FormData();
      fd.append("sampleAnswerFile", sampleDialogFile, sampleDialogFile.name);
      const replace = (currentStatus === "ready" || currentStatus === "pending") ? "true" : "false";
      const res = await fetch(
        `http://localhost:5000/api/assessments/${encodeURIComponent(sampleDialogTarget.assessmentId)}/upload-sample-answer?replace=${replace}`,
        { method: "POST", body: fd }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) throw new Error(data?.error || `Upload failed (${res.status})`);

      toast({ title: "Uploaded — extracting…", description: "CLO, rubric, and text extraction has started." });

      // Poll until sample + rubric + CLO are fully extracted.
      const startedAt = Date.now();
      while (!sampleDialogPollCancelRef.current) {
        const { status, meta } = await getSampleStatus(sampleDialogTarget.assessmentId);
        setSampleDialogMeta(meta);
        if (status === "ready" || status === "failed") break;
        if (Date.now() - startedAt > 6 * 60 * 1000) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e: any) {
      toast({ title: "Upload failed", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setSampleDialogUploading(false);
    }
  };

  // Opens the Extract + AutoMark dialog (requires sample answer already in Mongo).
  const openMarkingDialog = async (
    assessment: GroupedAssessment,
    courseCode: string,
    action: "automark" | "remark" = "automark"
  ) => {
    setMarkingDialogOpen(true);
    setMarkingDialogTarget({ assessmentId: assessment.assessmentId, assessmentTitle: assessment.assessmentTitle, courseCode });
    setMarkingDialogMeta(null);
    setMarkingDialogLoading(true);
    setMarkingDialogAction(action);
    try {
      const { meta } = await getSampleStatus(assessment.assessmentId);
      setMarkingDialogMeta(meta);
    } catch {
      setMarkingDialogMeta(null);
    } finally {
      setMarkingDialogLoading(false);
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
                onClick={() => navigate("/teacher-dashboard")}
                className="hover:bg-primary/10 transition-all p-2 rounded-lg"
              >
                <ChevronLeft className="h-5 w-5 text-gray-700" />
              </Button>
              <div className="flex items-center gap-2">
                <Brain className="h-6 sm:h-8 w-6 sm:w-8 text-primary" />
                <div>
                  <h1 className="text-lg sm:text-2xl font-bold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                    Submissions
                  </h1>
                  <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">
                    View uploaded answers from students for quizzes and assignments
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="space-y-8">
          <Card className="border-2 border-primary/20 shadow-md bg-white">
            <CardHeader className="pb-3 bg-gradient-to-r from-primary/5 to-primary/10 rounded-t-xl border-b border-primary/10">
              <CardTitle className="text-xl font-bold text-gray-900">Search Submissions</CardTitle>
              <CardDescription className="text-sm">Find by student, assessment, course code, or filename</CardDescription>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search submissions..."
                  className="pl-10 border-primary/20 h-11 text-base"
                />
              </div>
            </CardContent>
          </Card>

          {loading ? (
            <Card className="border-2 border-primary/20 shadow-md bg-white">
              <CardContent className="py-12 text-center text-muted-foreground">
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary/30 border-t-primary mx-auto mb-3" />
                Loading submissions...
              </CardContent>
            </Card>
          ) : filteredCourses.length === 0 ? (
            <Card className="border-2 border-primary/20 shadow-md bg-white">
              <CardContent className="py-14 text-center">
                <Upload className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                <p className="font-semibold text-gray-900">No submissions yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  When students submit answers, they will appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Accordion type="multiple" className="space-y-5">
              {filteredCourses.map((course) => (
                <AccordionItem
                  key={`${course.courseCode}-${course.courseId || ""}`}
                  value={`${course.courseCode}-${course.courseId || ""}`}
                  className="border-2 border-primary/15 shadow-md bg-white rounded-2xl px-2"
                >
                  <AccordionTrigger className="px-6 py-5 hover:no-underline">
                    <div className="flex items-start justify-between w-full pr-3 gap-4">
                      <div className="min-w-0 text-left">
                        <div className="font-bold text-gray-900 truncate text-xl sm:text-2xl">
                          {course.courseCode} {course.courseName ? `• ${course.courseName}` : ""}
                        </div>
                        <div className="text-sm text-muted-foreground mt-1">
                          Quizzes: {course.types.quiz.totals.assessments} • Assignments: {course.types.assignment.totals.assessments}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <Badge variant="outline" className="text-sm px-3 py-1">
                          {course.types.quiz.totals.submissions + course.types.assignment.totals.submissions} submissions
                        </Badge>
                        <Badge variant="success" className="text-sm px-3 py-1">
                          {course.types.quiz.totals.graded + course.types.assignment.totals.graded} graded
                        </Badge>
                        <Badge variant="warning" className="text-sm px-3 py-1">
                          {course.types.quiz.totals.pending + course.types.assignment.totals.pending} pending
                        </Badge>
                      </div>
                              </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-6 pb-6">
                    <Tabs defaultValue="quiz" className="space-y-5">
                      <TabsList className="h-11">
                        <TabsTrigger value="quiz" className="text-base px-4">Quizzes</TabsTrigger>
                        <TabsTrigger value="assignment" className="text-base px-4">Assignments</TabsTrigger>
                      </TabsList>

                      {(["quiz", "assignment"] as const).map((type) => (
                        <TabsContent key={type} value={type} className="space-y-4">
                          {course.types[type].assessments.length === 0 ? (
                            <div className="text-base text-muted-foreground">No {type} submissions for this course yet.</div>
                          ) : (
                            <Accordion type="multiple" className="space-y-3">
                              {course.types[type].assessments.map((assessment) => (
                                <AccordionItem
                                  key={assessment.assessmentId}
                                  value={assessment.assessmentId}
                                  className="border border-primary/10 rounded-2xl bg-white shadow-sm"
                                >
                                  <AccordionTrigger className="px-5 py-4 hover:no-underline">
                                    <div className="flex items-start justify-between w-full pr-3 gap-3">
                                      <div className="min-w-0 text-left">
                                        <div className="font-semibold text-gray-900 truncate text-lg sm:text-xl">
                                          {assessment.assessmentTitle}
                                        </div>
                                        <div className="text-sm text-muted-foreground mt-1">
                                          Total: {assessment.stats.total} • Graded: {assessment.stats.graded} • Pending: {assessment.stats.pending} • Late: {assessment.stats.late}
                              </div>
                                </div>
                                      <div className="flex items-center gap-2">
                                        {Number(assessment?.stats?.pending ?? 0) === 0 && Number(assessment?.stats?.graded ?? 0) > 0 ? (
                                          <Badge variant="success" className="text-sm px-3 py-1">
                                            AutoMarked
                                          </Badge>
                                        ) : (
                                          <Badge variant={type === "quiz" ? "info" : "secondary"} className="capitalize text-sm px-3 py-1">
                                            {type}
                                          </Badge>
                              )}
                            </div>
                          </div>
                                  </AccordionTrigger>
                                  <AccordionContent className="px-5 pb-5 space-y-4">
                                    <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
                                      <div className="text-sm text-muted-foreground">
                                        Upload sample answer to extract CLO &amp; rubric, then run AutoMark per assessment.
                                      </div>
                                      <div className="flex gap-2 flex-wrap">
                                        <Button
                                          variant="secondary"
                                          className="bg-primary/10 hover:bg-primary/15 text-primary h-11 text-base px-5"
                                          onClick={() => openDigitizeFlow(assessment)}
                                        >
                                          <Scan className="h-4 w-4 mr-2" />
                                          Digitize (OCR)
                                        </Button>

                                        {/* Sample Answer button — turns green once uploaded */}
                                        {sampleStatusByAssessment[assessment.assessmentId] === "ready" ? (
                                          <Button
                                            variant="outline"
                                            className="border-emerald-500/40 text-emerald-600 hover:bg-emerald-50 h-11 text-base px-5"
                                            onClick={() => openSampleDialog(assessment, course.courseCode)}
                                          >
                                            <CheckCircle className="h-4 w-4 mr-2" />
                                            Uploaded
                                          </Button>
                                        ) : (
                                          <Button
                                            variant="secondary"
                                            className="bg-primary/10 hover:bg-primary/10 text-primary h-11 text-base px-5"
                                            onClick={() => openSampleDialog(assessment, course.courseCode)}
                                          >
                                            <Upload className="h-4 w-4 mr-2" />
                                            Sample Answer
                                          </Button>
                                        )}

                                        {/* Brain button — disabled until sample answer is in Mongo */}
                                        <Button
                                          variant="secondary"
                                          className="bg-primary/10 hover:bg-primary/15 text-primary h-11 text-base px-5 disabled:opacity-50 disabled:cursor-not-allowed"
                                          disabled={sampleStatusByAssessment[assessment.assessmentId] !== "ready"}
                                          onClick={() =>
                                            openMarkingDialog(
                                              assessment,
                                              course.courseCode,
                                              Number(assessment?.stats?.pending ?? 0) === 0 && Number(assessment?.stats?.graded ?? 0) > 0
                                                ? "remark"
                                                : "automark"
                                            )
                                          }
                                        >
                                          <Brain className="h-4 w-4 mr-2" />
                                          {Number(assessment?.stats?.pending ?? 0) === 0 && Number(assessment?.stats?.graded ?? 0) > 0
                                            ? "Re-AutoMark"
                                            : "AutoMark"}
                                        </Button>
                                      </div>
                                    </div>

                                    <div className="space-y-3">
                                      {assessment.submissions.map((s) => {
                                        const canReview =
                                          String(s.status || "") === "graded" || typeof s.grade === "number";
                                        const am = String((s as any)?.automarkStatus || "").toLowerCase();
                                        const showAutomark =
                                          am === "processing" || am === "completed" || am === "failed";
                                        return (
                                          <div
                                            key={s.submissionId}
                                            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 rounded-xl border border-primary/10 bg-gradient-to-r from-white to-primary/5"
                                          >
                                          <div className="min-w-0">
                                            <div className="flex items-center gap-2 min-w-0">
                                              <User className="h-4 w-4 text-muted-foreground" />
                                              <span className="font-semibold text-gray-900 truncate text-base">{s.studentName}</span>
                                              {String(s.status || "") !== "graded" ? (
                                                <Badge variant="warning" className="text-xs px-2 py-0.5">
                                                  Pending Marking
                                                </Badge>
                                              ) : (
                                                <Badge variant="success" className="text-xs px-2 py-0.5">
                                                  Graded
                                                </Badge>
                                              )}
                                              {showAutomark ? (
                                                am === "processing" ? (
                                                  <Badge variant="warning" className="text-xs px-2 py-0.5">
                                                    LLM Processing
                                                  </Badge>
                                                ) : am === "completed" ? (
                                                  <Badge variant="success" className="text-xs px-2 py-0.5">
                                                    LLM Completed
                                                  </Badge>
                                                ) : (
                                                  <Badge variant="destructive" className="text-xs px-2 py-0.5">
                                                    LLM Failed
                                                  </Badge>
                                                )
                                              ) : null}
                                              {s.isLate ? <Badge variant="destructive">Late</Badge> : null}
                                            </div>
                                            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                                              <Calendar className="h-3.5 w-3.5" />
                                              <span className="truncate">{s.submittedAt ? new Date(s.submittedAt).toLocaleString() : "—"}</span>
                                              <span className="hidden sm:inline">•</span>
                                              <span className="truncate">Status: {s.status}</span>
                                            </div>
                                          </div>
                                          <div className="flex gap-2">
                        {String(s.status || "") === "graded" ? (
                          <Button
                            variant="outline"
                            className="border-primary/30 h-11 text-base px-5"
                            onClick={() => openReview(assessment.assessmentId, assessment.submissions, s.submissionId)}
                          >
                            Review
                          </Button>
                        ) : null}
                        <Button
                          className="bg-gradient-primary text-primary-foreground h-11 text-base px-5"
                          onClick={() => openSubmissionFile(s.submissionId)}
                        >
                          Open
                        </Button>
                      </div>
                    </div>
                                        );
                                      })}
                                    </div>
                                  </AccordionContent>
                                </AccordionItem>
                              ))}
                            </Accordion>
                          )}
                        </TabsContent>
                      ))}
                    </Tabs>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}

          <Card className="border border-amber-200 bg-amber-50/60">
            <CardContent className="py-3 flex items-center gap-2 text-amber-800 text-sm">
              <AlertCircle className="h-4 w-4" />
              This page auto-refreshes every 15 seconds to show new student uploads.
            </CardContent>
          </Card>
        </div>
      </main>

      {/* ===== Sample Answer Upload Dialog ===== */}
      <Dialog open={sampleDialogOpen} onOpenChange={(open) => { if (!open) sampleDialogPollCancelRef.current = true; setSampleDialogOpen(open); }}>
        <DialogContent className="max-w-lg p-0 overflow-hidden">
          <DialogHeader>
            <div className="px-6 pt-6 pb-4 bg-gradient-to-r from-primary/5 to-primary/10 border-b border-primary/10">
              <DialogTitle className="text-xl font-bold text-gray-900">Sample Answer</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                {sampleDialogTarget?.assessmentTitle} &bull; PDF, DOCX, JPG, JPEG, PNG
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="px-6 py-5 space-y-4 bg-white">
            <div className="rounded-xl border border-primary/10 bg-gradient-to-r from-white to-primary/5 p-4 space-y-3">
              <div className="text-sm font-semibold text-gray-900">Upload Sample Answer File</div>
              <Input
                type="file"
                accept=".pdf,.docx,.jpg,.jpeg,.png"
                onChange={(e) => setSampleDialogFile(e.target.files?.[0] || null)}
                disabled={sampleDialogUploading}
              />
              <Button
                className="w-full h-11 text-base"
                onClick={doUploadSampleInDialog}
                disabled={sampleDialogUploading || !sampleDialogFile}
              >
                {sampleDialogUploading ? "Uploading & Extracting…" : "Upload Sample Answer"}
              </Button>
            </div>

            <div className="rounded-xl border border-primary/10 bg-muted/40 p-4 space-y-3">
              <div className="text-sm font-semibold text-gray-900">Extraction Status</div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={statusBadgeVariant(sampleDialogMeta?.sampleAnswerStatus) as any}>
                  Sample: {statusLabel(sampleDialogMeta?.sampleAnswerStatus)}
                </Badge>
                <Badge variant={statusBadgeVariant(sampleDialogMeta?.rubricStatus) as any}>
                  Rubric: {statusLabel(sampleDialogMeta?.rubricStatus)}
                </Badge>
                <Badge variant={statusBadgeVariant(sampleDialogMeta?.cloStatus) as any}>
                  CLO: {statusLabel(sampleDialogMeta?.cloStatus)}
                </Badge>
              </div>
              {sampleDialogMeta?.automarkReady && (
                <div className="text-sm font-semibold text-emerald-600 flex items-center gap-1.5">
                  <CheckCircle className="h-4 w-4" />
                  All extracted — ready for AutoMark
                </div>
              )}
              {!sampleDialogMeta && (
                <div className="text-xs text-muted-foreground">Loading status…</div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ===== Marking Dialog (Extract + AutoMark) ===== */}
      <Dialog open={markingDialogOpen} onOpenChange={setMarkingDialogOpen}>
        <DialogContent className="max-w-xl p-0 overflow-hidden">
          <DialogHeader>
            <div className="px-6 pt-6 pb-4 bg-gradient-to-r from-primary/5 to-primary/10 border-b border-primary/10">
              <DialogTitle className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <Brain className="h-5 w-5 text-primary" />
                {markingDialogAction === "remark" ? "Re-AutoMark" : "AutoMark"} &mdash; {markingDialogTarget?.assessmentTitle}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Extract student submissions then run AI grading
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="px-6 py-5 space-y-4 bg-white">
            {markingDialogLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                Loading assessment status…
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-primary/10 bg-muted/40 p-4 space-y-3">
                  <div className="text-sm font-semibold text-gray-900">Readiness</div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={statusBadgeVariant(markingDialogMeta?.sampleAnswerStatus) as any}>
                      Sample: {statusLabel(markingDialogMeta?.sampleAnswerStatus)}
                    </Badge>
                    <Badge variant={statusBadgeVariant(markingDialogMeta?.rubricStatus) as any}>
                      Rubric: {statusLabel(markingDialogMeta?.rubricStatus)}
                    </Badge>
                    <Badge variant={statusBadgeVariant(markingDialogMeta?.cloStatus) as any}>
                      CLO: {statusLabel(markingDialogMeta?.cloStatus)}
                    </Badge>
                  </div>
                  {!markingDialogMeta?.automarkReady && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      Upload &amp; extract a sample answer first before running AutoMark.
                    </div>
                  )}
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <Button
                    variant="secondary"
                    className="bg-primary/10 hover:bg-primary/15 text-primary h-11 text-base"
                    disabled={batchLoading || !markingDialogMeta?.automarkReady}
                    onClick={async () => {
                      if (!markingDialogTarget?.assessmentId) return;
                      await startAndPollJob(
                        `http://localhost:5000/api/assessments/${encodeURIComponent(markingDialogTarget.assessmentId)}/extract-batch`,
                        () => {
                          toast({ title: "Extraction completed", description: "All pending submissions were extracted." });
                          fetchTeacherGrouped(teacherId);
                        },
                        async () => {
                          try {
                            const { meta } = await getSampleStatus(markingDialogTarget.assessmentId);
                            setMarkingDialogMeta(meta);
                          } catch {}
                        }
                      );
                    }}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Extract Submissions
                  </Button>

                  <Button
                    className="bg-gradient-primary text-primary-foreground h-11 text-base"
                    disabled={batchLoading || !markingDialogMeta?.automarkReady}
                    onClick={async () => {
                      if (!markingDialogTarget?.assessmentId) return;
                      await startAndPollJob(
                        `http://localhost:5000/api/assessments/${encodeURIComponent(markingDialogTarget.assessmentId)}/${
                          markingDialogAction === "remark" ? "remark-batch" : "automark-batch"
                        }`,
                        () => {
                          toast({
                            title: markingDialogAction === "remark" ? "Re-AutoMark completed" : "AutoMark completed",
                            description:
                              markingDialogAction === "remark"
                                ? "All submissions were re-graded."
                                : "All pending submissions were auto-marked.",
                          });
                          fetchTeacherGrouped(teacherId);
                        },
                        async () => {
                          try {
                            const { meta } = await getSampleStatus(markingDialogTarget.assessmentId);
                            setMarkingDialogMeta(meta);
                          } catch {}
                        }
                      );
                    }}
                  >
                    <Brain className="h-4 w-4 mr-2" />
                    {markingDialogAction === "remark" ? "Re-AutoMark" : "AutoMark"}
                  </Button>
                </div>

                {!markingDialogMeta?.automarkReady && (
                  <div className="text-xs text-muted-foreground">
                    Both buttons unlock after the sample answer, rubric, and CLO are fully extracted.
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={autoMarkOpen} onOpenChange={setAutoMarkOpen}>
          <DialogContent className="max-w-2xl p-0 overflow-hidden">
          <DialogHeader>
            <div className="px-6 pt-6 pb-4 bg-gradient-to-r from-primary/5 to-primary/10 border-b border-primary/10">
              <DialogTitle className="text-xl font-bold text-gray-900">Upload Sample Answer</DialogTitle>
              <DialogDescription className="text-sm">
                Accepted file types: PDF, DOCX, JPG, JPEG, PNG
            </DialogDescription>
            </div>
          </DialogHeader>

          <div className="px-6 py-5 space-y-4 bg-white">
            <div className="rounded-xl border border-primary/10 bg-gradient-to-r from-white to-primary/5 p-4 space-y-3">
              <div className="text-sm font-semibold text-gray-900">Sample Answer File</div>
            <Input
              type="file"
              accept=".pdf,.docx,.jpg,.jpeg,.png"
              onChange={(e) => setSampleAnswerFile(e.target.files?.[0] || null)}
            />
              <Button className="w-full h-11 text-base" onClick={uploadSampleAnswer} disabled={uploadingSample}>
                {uploadingSample ? "Uploading…" : "Upload Sample Answer"}
              </Button>
            </div>

            <div className="rounded-xl border border-primary/10 bg-muted/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-gray-900">Status</div>
              </div>

              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant={statusBadgeVariant(autoMarkMeta?.sampleAnswerStatus) as any}>
                  Sample: {statusLabel(autoMarkMeta?.sampleAnswerStatus)}
                </Badge>
                <Badge variant={statusBadgeVariant(autoMarkMeta?.rubricStatus) as any}>
                  Rubric: {statusLabel(autoMarkMeta?.rubricStatus)}
                </Badge>
                <Badge variant={statusBadgeVariant(autoMarkMeta?.cloStatus) as any}>
                  CLO: {statusLabel(autoMarkMeta?.cloStatus)}
                </Badge>
              </div>

              <div className="grid sm:grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  className="bg-primary/10 hover:bg-primary/15 text-primary h-11 text-base"
                  onClick={async () => {
                    if (!autoMarkTarget?.assessmentId) return;
                    await startAndPollJob(
                      `http://localhost:5000/api/assessments/${encodeURIComponent(autoMarkTarget.assessmentId)}/extract-batch`,
                      () => {
                        toast({ title: "Extraction completed", description: "All pending submissions were extracted." });
                        fetchTeacherGrouped(teacherId);
                      },
                      async () => {
                        // Keep dialog usable after failures; refresh sample/rubric/CLO readiness.
                        try {
                          const { meta } = await getSampleStatus(autoMarkTarget.assessmentId);
                          setAutoMarkMeta(meta);
                        } catch {}
                      }
                    );
                  }}
                  disabled={batchLoading || !Boolean(autoMarkMeta?.automarkReady)}
                >
                  Extract Submissions
                </Button>
                <Button
                  className="bg-gradient-primary text-primary-foreground h-11 text-base"
                  onClick={async () => {
                    if (!autoMarkTarget?.assessmentId) return;
                    await startAndPollJob(
                      `http://localhost:5000/api/assessments/${encodeURIComponent(autoMarkTarget.assessmentId)}/${autoMarkPrimaryAction === "remark" ? "remark-batch" : "automark-batch"}`,
                      () => {
                        toast({
                          title: autoMarkPrimaryAction === "remark" ? "Re-AutoMark completed" : "AutoMark completed",
                          description:
                            autoMarkPrimaryAction === "remark"
                              ? "All submissions were re-graded (vectors replaced + LLM re-run)."
                              : "All pending submissions were auto-marked.",
                        });
                        fetchTeacherGrouped(teacherId);
                      },
                      async () => {
                        // After AutoMark completes or fails, re-fetch meta so the dialog stays accurate/enabled.
                        try {
                          const { meta } = await getSampleStatus(autoMarkTarget.assessmentId);
                          setAutoMarkMeta(meta);
                        } catch {}
                      }
                    );
                  }}
                  disabled={batchLoading || !Boolean(autoMarkMeta?.automarkReady)}
                >
                  {autoMarkPrimaryAction === "remark" ? "Re-AutoMark" : "AutoMark"}
                </Button>
              </div>

              {!autoMarkMeta?.automarkReady ? (
                <div className="text-xs text-muted-foreground">
                  Extract/AutoMark will unlock after the sample answer, rubric, and CLO are fully extracted and embedded.
                </div>
              ) : null}
            </div>

            {autoMarkLoading && (
              <div className="text-xs text-muted-foreground">
                Fetching assessment metadata in background…
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {["extract", "extractstudentchunks"].includes(String((batchJob?.jobType || batchJobTypeHint) || "").toLowerCase())
                ? "Submission Preparation Progress"
                : String((batchJob?.jobType || batchJobTypeHint) || "").toLowerCase() === "remark"
                ? "Re-Mark Progress"
                : "AutoMark Progress"}
            </DialogTitle>
            <DialogDescription>Live logs will appear below.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                Status: <span className="font-semibold text-gray-900">{batchJob?.status || (batchLoading ? "starting" : "—")}</span>
                {batchJob?.currentStudentName ? (
                  <span className="text-muted-foreground"> • Current: {batchJob.currentStudentName}</span>
                ) : null}
              </div>
              <Badge variant="outline">
                {Number(batchJob?.processed ?? 0)}/{Number(batchJob?.total ?? 0)}
              </Badge>
            </div>

            {batchUiMessage ? (
              <div
                className={
                  batchUiMessage.kind === "success"
                    ? "rounded-lg border border-success/30 bg-success/10 p-3 text-sm"
                    : "rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
                }
              >
                <div className="font-semibold text-gray-900">{batchUiMessage.title}</div>
                {batchUiMessage.detail ? <div className="mt-1 text-muted-foreground">{batchUiMessage.detail}</div> : null}
              </div>
            ) : null}

            <div className="max-h-[320px] overflow-auto rounded-lg border border-primary/10 bg-muted p-3 text-sm">
              {(batchJob?.logs || []).slice(-80).map((l: any, idx: number) => (
                <div key={idx} className="py-1">
                  <span className="text-xs text-muted-foreground">
                    {l?.ts ? new Date(l.ts).toLocaleTimeString() : ""}
                  </span>{" "}
                  <span className={l?.level === "error" ? "text-destructive" : "text-gray-900"}>
                    {l?.message || ""}
                  </span>
                </div>
              ))}
              {(!batchJob?.logs || batchJob.logs.length === 0) && (
                <div className="text-muted-foreground">Waiting for logs…</div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setBatchOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Submissions;

