# Plagiarism Detection & Score Sync Flow

## Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    PLAGIARISM DETECTION FLOW                    │
└─────────────────────────────────────────────────────────────────┘

1. TEACHER INITIATES CHECK
   └─→ Teacher Dashboard → Plagiarism Button → POST /api/plagiarism/check/:id
       
2. BACKEND PROCESSING (plagiarismService.js)
   ├─→ Extract student's answer text (from SubmissionRaw)
   ├─→ Query FAISS for similar submissions (other students)
   │   ├─→ Internal score = top match similarity × 100
   │   └─→ Top 5 matches returned
   ├─→ Call ZeroGPT API (AI-generated content detection)
   │   ├─→ Success: Get AI score 0-100%
   │   └─→ Failure: Graceful fallback, return 0%
   └─→ Calculate overall score: (internal × 60%) + (AI × 40%)

3. STORAGE (Two Locations)
   ├─→ PlagiarismReport Collection
   │   ├─→ internalScore, aiScore, overallScore
   │   ├─→ topMatches with student names
   │   ├─→ riskLevel (low/medium/high)
   │   └─→ checkedAt timestamp
   └─→ Submission Model
       ├─→ plagiarismBestMatchPercent (internal score)
       ├─→ plagiarismAiScore (AI detection %)
       ├─→ plagiarismReport (full snapshot)
       └─→ plagiarismCheckedAt (timestamp)

4. FRONTEND FETCH
   ├─→ Student Views Report
   │   └─→ GET /api/submissions/:id/student-report
   │       └─→ Returns Submission with plagiarism fields
   │
   ├─→ Teacher Views Assessment
   │   └─→ GET /api/plagiarism/assessment/:assessmentId
   │       └─→ Returns sorted PlagiarismReport array
   │
   └─→ Teacher Views Single Report
       └─→ GET /api/plagiarism/report/:submissionId
           └─→ Returns full PlagiarismReport with details

5. FRONTEND DISPLAY
   ├─→ ViewReport.tsx
   │   ├─→ Shows "Student submission match: X%"
   │   ├─→ Shows "AI-generated content: Y%"
   │   └─→ Color codes: Red (>70%), Amber (>0%), Gray (0%)
   │
   └─→ Teacher Dashboard
       ├─→ Shows overall risk level
       ├─→ Shows top matches with similarity scores
       └─→ Shows detection mode (internal/external/both)
```

## Data Flow: Score Calculation

```
┌─────────────────────────────────┐
│  Student Submission Text        │
│  (from SubmissionRaw)           │
└────────────┬────────────────────┘
             │
      ┌──────▼──────────────────────────────────┐
      │ 1. INTERNAL PLAGIARISM (FAISS)          │
      │ ├─ Query: Find similar chunks           │
      │ ├─ Exclude: Same student + other assess │
      │ └─ Result: Top match = 45%              │
      └──────┬──────────────────────────────────┘
             │
      ┌──────▼──────────────────────────────────┐
      │ 2. EXTERNAL PLAGIARISM (ZeroGPT)        │
      │ ├─ Query: Send text to API              │
      │ ├─ Result: AI detection = 32%           │
      │ └─ Fallback: If API fails = 0%          │
      └──────┬──────────────────────────────────┘
             │
      ┌──────▼──────────────────────────────────┐
      │ 3. COMBINE SCORES (Weighted Average)    │
      │ ├─ Formula: (45% × 0.6) + (32% × 0.4)   │
      │ ├─ = 27% + 12.8%                        │
      │ └─ = 40% (rounded)                      │
      └──────┬──────────────────────────────────┘
             │
      ┌──────▼──────────────────────────────────┐
      │ 4. ASSESS RISK                          │
      │ ├─ 0-29%   = LOW RISK      🟢           │
      │ ├─ 30-59%  = MEDIUM RISK   🟡           │
      │ └─ 60-100% = HIGH RISK     🔴           │
      └──────┬──────────────────────────────────┘
             │
      ┌──────▼──────────────────────────────────┐
      │ 5. STORE RESULTS                        │
      │ ├─ PlagiarismReport (main)              │
      │ └─ Submission (sync copy)               │
      └──────────────────────────────────────────┘
```

## Detection Modes

### Mode 1: BOTH (Multiple Submissions)
```
Assessment has 3+ submissions
┌─────────────────────────────┐
├─ Internal plagiarism: ON    │ (compare with other students)
├─ External plagiarism: ON    │ (ZeroGPT AI detection)
└─ Returns: overallScore      │ (weighted combination)
```

### Mode 2: EXTERNAL_ONLY (Single Submission)
```
Assessment has only 1 submission
┌─────────────────────────────┐
├─ Internal plagiarism: OFF   │ (no other students to compare)
├─ External plagiarism: ON    │ (ZeroGPT AI detection)
└─ Returns: aiScore as 0%     │ (can't detect internal)
```

## Score Persistence

```
┌──────────────────────────┐
│ Plagiarism Check Run     │
│ (e.g., May 13, 2026)     │
└───────────┬──────────────┘
            │
     ┌──────▼──────────────────────┐
     │ Scores LOCKED               │
     │ ├─ internalScore: 45%       │
     │ ├─ aiScore: 32%             │
     │ ├─ overallScore: 40%        │
     │ └─ checkedAt: May 13        │
     └──────┬───────────────────────┘
            │
  ┌─────────▼──────────────────────────────┐
  │ Teacher Re-runs Same Assessment         │
  │ on May 20                               │
  └─────────────────────────────────────────┘
            │
  ┌─────────▼──────────────────────────────┐
  │ Cached Result Returned                 │
  │ ├─ SAME internalScore: 45%             │
  │ ├─ SAME aiScore: 32%                   │
  │ ├─ SAME overallScore: 40%              │
  │ └─ Still checkedAt: May 13             │
  │                                        │
  │ ✅ Ensures stability                   │
  │ ✅ Prevents score drift                │
  │ ✅ If refresh needed: ?refresh=true    │
  └────────────────────────────────────────┘
```

## Frontend Sync Guarantee

```
┌──────────────────────┐
│ fix-all-plagiarism   │
│ -scores.js runs      │
└────────┬─────────────┘
         │
    ┌────▼────────────────────────────────┐
    │ 1. Recalculate all scores           │
    │    (PlagiarismReport collection)    │
    └────┬─────────────────────────────────┘
         │
    ┌────▼────────────────────────────────┐
    │ 2. Update Submission fields         │
    │    (sync copy for quick access)     │
    └────┬─────────────────────────────────┘
         │
    ┌────▼────────────────────────────────┐
    │ 3. Frontend reads Submission         │
    │    GET /submissions/:id/            │
    │    student-report                   │
    └────┬─────────────────────────────────┘
         │
    ┌────▼────────────────────────────────┐
    │ 4. ViewReport.tsx displays:         │
    │    plagiarismBestMatchPercent       │
    │    plagiarismAiScore                │
    └────────────────────────────────────┘
```

## Error Handling

```
┌─────────────────────────────────┐
│ ZeroGPT API Call                │
└─────────┬───────────────────────┘
          │
    ┌─────┴──────────┬────────────────────┐
    │                │                    │
 SUCCESS          TIMEOUT              ERROR
    │                │                    │
    │           (>20 sec)           (401/403/5xx)
    │                │                    │
    ▼                ▼                    ▼
Return AI         Fallback to         Fallback to
Score 0-100%      aiScore = 0%        aiScore = 0%
    │                │                    │
    └────────┬───────┴────────────────────┘
             │
             ▼
    ┌─────────────────────────┐
    │ Continue with score     │
    │ (plagiarism check       │
    │  never crashes)         │
    └─────────────────────────┘
```

## API Response Structure

### GET /api/plagiarism/assessment/:assessmentId

```json
{
  "success": true,
  "count": 15,
  "reports": [
    {
      "_id": "ObjectId",
      "submissionId": "ObjectId",
      "assessmentId": "ObjectId",
      "studentId": "student123",
      "studentName": "Ahmad Hassan",
      "internalScore": 45,
      "aiScore": 32,
      "overallScore": 40,
      "riskLevel": "medium",
      "topMatches": [
        {
          "submissionId": "ObjectId",
          "studentName": "Fatima Ali",
          "similarityPercent": 87,
          "matchedText": "..."
        }
      ],
      "checkedAt": "2026-05-13T10:30:00Z"
    }
  ]
}
```

### GET /api/submissions/:id/student-report

```json
{
  "success": true,
  "submission": {
    "studentName": "Ahmad Hassan",
    "assessmentTitle": "Final Exam",
    "plagiarismBestMatchPercent": 45,
    "plagiarismAiScore": 32,
    "plagiarismCheckedAt": "2026-05-13T10:30:00Z"
  },
  "content": {
    "extraction": {
      "rawText": "..."
    }
  }
}
```

## Fix Script Operation

```
┌─────────────────────────────────────┐
│ fix-all-plagiarism-scores.js        │
│ --dry-run / --assessment-id X       │
└────────┬────────────────────────────┘
         │
    ┌────▼──────────────────────────────┐
    │ 1. Find all PlagiarismReports     │
    │    (or filtered by assessment)    │
    └────┬─────────────────────────────┘
         │
    ┌────▼──────────────────────────────┐
    │ 2. For each submission:           │
    │    checkPlagiarism(id, refresh=true)
    │    └─ Force recalculation         │
    └────┬─────────────────────────────┘
         │
    ┌────▼──────────────────────────────┐
    │ 3. Compare old vs new scores      │
    │    Show differences               │
    └────┬─────────────────────────────┘
         │
    ┌────▴──────────────────────────────┐
    │                                   │
 --dry-run                         NO --dry-run
    │                                   │
    ▼                                   ▼
DISPLAY ONLY                    UPDATE DATABASE
Print changes                   ├─ Update Submission
No database mods                ├─ Update PlagiarismReport
Review before                   └─ Show actual changes
running live
```

---

**Key Points:**

1. ✅ **Dual Storage**: Data in both PlagiarismReport and Submission
2. ✅ **Caching**: Scores locked until `?refresh=true` or manual rerun
3. ✅ **Graceful Degradation**: API failures don't crash system
4. ✅ **Mode Detection**: Auto-switches between internal/external modes
5. ✅ **Frontend Auto-Sync**: No manual cache invalidation needed
6. ✅ **Score Lock**: Ensures stability across teacher re-logins

