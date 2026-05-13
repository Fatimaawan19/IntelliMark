# CLO Performance Real-Time Synchronization Guide

## Overview

The StudentCLOPerformance collection now extracts and maintains real-time data from Submission and SubmissionRaw collections. When teachers grade assignments or update marks/feedback, the CLO performance data is automatically kept in sync.

---

## Data Flow

```
Teacher Grades Submission (gradeSubmission)
        ↓
Submission saved with grade, feedback, status="graded"
        ↓
[Async] cloPerformanceService.updateCLOPerformanceForSubmission()
        ↓
Extract real-time data from Submission & SubmissionRaw
        ↓
StudentCLOPerformance record created/updated with:
  - Reference to submission (submissionId, submissionRawId)
  - Cached marks & feedback data
  - Calculation timestamp (lastSyncedAt)
  - isSynced=true flag
        ↓
Teacher Updates Marks (updateSubmissionMarks)
        ↓
Submission updated with new grade/feedback
        ↓
[Async] Re-sync CLO performance
        ↓
StudentCLOPerformance re-calculated from latest submission data
```

---

## Updated Model Fields

### StudentCLOPerformance Submission Detail

Each submission in the `submissions[]` array now includes:

```javascript
{
  submissionId: ObjectId,              // Reference to submission
  assessmentId: ObjectId,
  assessmentTitle: String,
  submissionRawId: ObjectId,           // NEW: Reference to SubmissionRaw
  submittedAt: Date,
  gradedAt: Date,
  status: String,
  
  // CACHED DATA (pulled from Submission collection)
  marksObtained: Number,               // submission.grade
  marksAvailable: Number,              // calculated from questions/CLO distribution
  feedback: String,                    // NEW: submission.feedback
  lastSyncedAt: Date                   // NEW: when data was last synced
}
```

### New Top-Level Fields

```javascript
{
  allFeedback: [String],               // Array of all feedback strings
  isSynced: Boolean,                   // Flag: is data current with Submission?
  lastSyncedAt: Date,                  // When was last sync performed?
  // ... existing fields
}
```

### New Indexes

```javascript
- { isSynced: 1 }                      // Quick lookup of unsynced records
- { lastSyncedAt: 1 }                  // Find old records needing sync
```

---

## API Endpoints

### 1. Grade Submission (Existing - Now with Auto-Sync)

```
PATCH /api/submissions/:submissionId/grade
Body: { grade: Number, feedback: String, teacherId: String }
```

**Behavior:**
- Grades the submission
- **Automatically triggers CLO performance sync** (async)
- Updates all related CLO performance records
- Sends notification to student

---

### 2. Update Submission Marks (NEW)

```
PATCH /api/submissions/:submissionId/update-marks
Body: { 
  grade?: Number,        // Optional: new grade
  feedback?: String,     // Optional: new feedback
  teacherId: String      // Required: teacher ID
}
```

**Use Cases:**
- Teacher realizes they gave wrong grade - can update it
- Teacher wants to add/edit feedback after grading
- Bulk grade corrections

**Behavior:**
- Updates submission with new marks/feedback
- **Automatically re-syncs CLO performance** (async)
- Recalculates all affected CLO records
- Returns updated submission and sync status

**Response:**
```json
{
  "success": true,
  "message": "Submission marks updated and CLO performance synced",
  "submission": {
    "id": "...",
    "grade": 85,
    "maxGrade": 100,
    "feedback": "Good work!",
    "status": "graded"
  }
}
```

---

### 3. Get Student CLO Performance (Existing - Now With Real-Time Data)

```
GET /api/clo-performance/student/{studentId}/course/{courseId}
```

**Returns:** CLO performance with submission details including:
- Latest marks from Submission collection
- Feedback from Submission collection
- Sync timestamp (lastSyncedAt)

---

## Bulk Operations Scripts

### Script 1: Populate CLO Performance for Entire Course

**File:** `backend/scripts/populate-clo-performance.js`

**Purpose:** 
- Initialize CLO performance data for a course
- Extracts data from all graded submissions
- Creates StudentCLOPerformance records from scratch

**Usage:**

```bash
# Populate data for course
node backend/scripts/populate-clo-performance.js 6569e3f1234567890abcdef

# With --force flag (clear existing records first)
node backend/scripts/populate-clo-performance.js 6569e3f1234567890abcdef --force

# Dry run (show what would happen)
node backend/scripts/populate-clo-performance.js 6569e3f1234567890abcdef --dry-run

# Dry run with force
node backend/scripts/populate-clo-performance.js 6569e3f1234567890abcdef --force --dry-run
```

**Output:**
```
📖 Course: CS101 - Computer Science 101
🔍 Fetching graded submissions...
   Found 45 graded submissions

📊 Processing submissions...
   [1/45] ✅ 656ab4e1234... - Updated: CLO1@85%, CLO2@92%
   [2/45] ✅ 656ab4e5678... - Updated: CLO1@78%, CLO3@88%
   ...

============================================================
POPULATION SUMMARY
============================================================
Course ID:                6569e3f1234567890abcdef
Course:                   CS101 - Computer Science 101
Total Submissions:        45
Processed:                45
Successful:               45
Failed:                   0
Total CLOs Updated:       135
CLO Performance Records:  135
Unique Students:          28
Unique CLOs:              5
============================================================
✅ Successfully populated CLO performance for 45 submissions!
```

---

### Script 2: Sync CLO Performance Data

**File:** `backend/scripts/sync-clo-performance.js`

**Purpose:**
- Re-sync ALL StudentCLOPerformance records with Submission collection
- Update cached marks/feedback to latest values
- Ensure data consistency
- Can be run periodically or on-demand

**Usage:**

```bash
# Sync all CLO performance records globally
node backend/scripts/sync-clo-performance.js

# Sync only specific course
node backend/scripts/sync-clo-performance.js --courseId 6569e3f1234567890abcdef

# Sync only specific student
node backend/scripts/sync-clo-performance.js --studentId usr_12345

# Sync specific course AND student
node backend/scripts/sync-clo-performance.js --courseId 6569e3f1234567890abcdef --studentId usr_12345

# Dry run (see what would happen)
node backend/scripts/sync-clo-performance.js --dry-run

# Clear and rebuild from scratch
node backend/scripts/sync-clo-performance.js --clear
```

**Output:**
```
📚 Connecting to MongoDB...
✅ Connected to MongoDB

🔍 Finding CLO performance records to sync...
   Found 135 CLO performance records
   Filter: Course = CS101

📊 Fetching all relevant submissions...
   Found 45 graded submissions

🔄 Syncing CLO performance...
   [1/45] ✅ Synced: CLO1@85%, CLO2@92%
   [2/45] ✅ Synced: CLO1@78%, CLO3@88%
   ... Progress: 10/45
   ... Progress: 20/45
   ... Progress: 30/45
   ... Progress: 40/45

============================================================
SYNC SUMMARY
============================================================
Total Submissions Processed: 45
Successful:                 45
Errors:                     0
Duration:                   3s
Average per submission:     67ms
============================================================

📊 Current sync status:
   Synced records:   135
   Unsynced records: 0

✅ Successfully synced 45 submissions!
```

---

## Real-Time Sync Mechanism

### Automatic Triggers

CLO performance is **automatically updated** (asynchronously) when:

1. **Teacher grades a submission**
   ```
   POST /api/submissions/:submissionId/grade
   ```

2. **Teacher edits marks/feedback**
   ```
   PATCH /api/submissions/:submissionId/update-marks
   ```

3. **Any submission status changes to "graded"**

### Async Processing

- Sync happens **without blocking** the API response
- Updates processed in background via `setImmediate()`
- Teacher sees immediate response while data is synced
- Errors in sync don't affect the API response

### Data Consistency

- **isSynced flag** tracks whether record is current
- **lastSyncedAt timestamp** shows when last sync occurred
- **Submission references** stored to enable re-sync if needed
- Can manually re-sync with script if discrepancies occur

---

## Data Extraction Logic

When syncing CLO performance from a submission:

### Step 1: Get Submission Data
```javascript
// From Submission collection
const submission = await Submission.findById(submissionId)
  .populate('assessmentId') // Get CLOs
  .populate('courseId');

// Marks and feedback
const marksObtained = submission.grade;
const feedback = submission.feedback;
```

### Step 2: Get Detailed Marks
```javascript
// From SubmissionRaw collection (if available)
const submissionRaw = await SubmissionRaw.findOne({ submissionId });
const perQuestionScores = submissionRaw.perQuestionScores;

// Per-question marks are mapped to CLOs
// CLO 1 gets sum of marks from all questions tagged to CLO 1
```

### Step 3: Calculate CLO-wise Metrics
```javascript
// For each CLO in assessment
for (const clo of assessment.cloIds) {
  // Get all questions for this CLO
  const cloQuestions = questions.filter(q => q.cloId === clo._id);
  
  // Sum marks for this CLO's questions
  let cloMarksObtained = 0;
  let cloMarksAvailable = 0;
  
  for (const score of perQuestionScores) {
    if (cloQuestions.includes(score.questionId)) {
      cloMarksObtained += score.awardedMarks;
      cloMarksAvailable += score.maxMarks;
    }
  }
  
  // Calculate percentage
  const percentage = (cloMarksObtained / cloMarksAvailable) * 100;
}
```

### Step 4: Update StudentCLOPerformance
```javascript
const cloPerformanceRecord = {
  studentId,
  courseId,
  cloId,
  assessmentType: assessment.type,
  
  // Aggregated data
  totalMarksObtained,   // Sum of all submissions
  totalMarksAvailable,
  percentage,
  submissionCount,
  
  // Submissions array with latest data
  submissions: [
    {
      submissionId,
      marksObtained,
      feedback,
      lastSyncedAt: new Date()
    }
  ],
  
  // Tracking
  isSynced: true,
  lastSyncedAt: new Date()
}
```

---

## Troubleshooting

### Issue: CLO performance not updating after grading

**Check:**
1. Is submission status "graded"?
2. Check server logs for CLO sync errors
3. Run manual sync script:
   ```bash
   node backend/scripts/sync-clo-performance.js --courseId <courseId> --studentId <studentId>
   ```

### Issue: Discrepancy between Submission and CLOPerformance

**Fix:**
1. Run sync script with `--clear` flag:
   ```bash
   node backend/scripts/sync-clo-performance.js --courseId <courseId> --clear
   ```
2. Or rebuild entire course:
   ```bash
   node backend/scripts/populate-clo-performance.js <courseId> --force
   ```

### Issue: Slow CLO performance updates

**Optimize:**
- Sync happens async, shouldn't block responses
- Check MongoDB indexes: `isSynced`, `lastSyncedAt`
- If many submissions, use:
  ```bash
  node backend/scripts/sync-clo-performance.js --courseId <courseId> --dry-run
  ```
  to estimate time needed

---

## Monitoring Sync Health

### Check Sync Status

```javascript
// Get unsynced records
const unsynced = await StudentCLOPerformance.find({ isSynced: false });

// Get old records (not synced in last hour)
const stale = await StudentCLOPerformance.find({
  lastSyncedAt: { $lt: new Date(Date.now() - 60*60*1000) }
});

// Get sync statistics
const stats = await StudentCLOPerformance.aggregate([
  {
    $group: {
      _id: "$isSynced",
      count: { $sum: 1 },
      oldestSync: { $min: "$lastSyncedAt" }
    }
  }
]);
```

### Verify Data Accuracy

```bash
# Compare submission marks with CLO performance
db.Submission.aggregate([
  { $match: { status: "graded" } },
  { $group: {
    _id: "$_id",
    grade: { $first: "$grade" }
  }}
]).forEach(sub => {
  const clo = db.StudentCLOPerformance.findOne({ 
    "submissions.submissionId": sub._id 
  });
  console.log(`Submission ${sub._id}: grade=${sub.grade}, clo_marks=${clo.submissions[0].marksObtained}`);
});
```

---

## Best Practices

1. **Run populate script** when setting up CLO performance for first time
2. **Monitor sync status** regularly via MongoDB queries
3. **Run sync script periodically** (e.g., daily at midnight):
   ```bash
   # Add to cron job
   0 0 * * * cd /path/to/backend && node scripts/sync-clo-performance.js
   ```
4. **Check logs** if sync fails - errors are logged but don't break the API
5. **Backup database** before running `--force` or `--clear` operations
6. **Test with `--dry-run`** before running actual sync operations

---

## Example Workflow

### Initial Setup
```bash
# 1. Create course and assessments in UI
# 2. Add CLOs to assessments
# 3. Import students and create questions

# 4. Initialize CLO performance data
node backend/scripts/populate-clo-performance.js <courseId>
```

### Daily Operations
```
# Teacher grades submissions via UI
# → Automatically syncs CLO performance (async)
# → Student can view performance in "Student Feedback" page

# Teacher realizes they gave wrong grade
# → PATCH /api/submissions/:submissionId/update-marks
# → CLO performance re-synced automatically
```

### Maintenance
```bash
# Weekly sync verification
node backend/scripts/sync-clo-performance.js --courseId <courseId> --dry-run

# Monthly deep sync
node backend/scripts/sync-clo-performance.js --courseId <courseId>
```

---

## API Integration Examples

### Update Marks via API

```bash
curl -X PATCH http://localhost:5000/api/submissions/656ab4e123/update-marks \
  -H "Content-Type: application/json" \
  -d '{
    "grade": 88,
    "feedback": "Improved understanding, but needs more practice",
    "teacherId": "teacher_uid_123"
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Submission marks updated and CLO performance synced",
  "submission": {
    "id": "656ab4e123",
    "grade": 88,
    "maxGrade": 100,
    "feedback": "Improved understanding, but needs more practice",
    "status": "graded"
  }
}
```

### Get Updated CLO Performance

```bash
curl http://localhost:5000/api/clo-performance/student/usr_12345/course/656...
```

**Response shows:**
```json
{
  "success": true,
  "performance": [
    {
      "cloNumber": 1,
      "percentage": 88,        # Updated from latest submission
      "submissions": [
        {
          "marksObtained": 88,
          "feedback": "Improved understanding...",
          "lastSyncedAt": "2026-05-12T10:30:45.123Z"
        }
      ],
      "isSynced": true,
      "lastSyncedAt": "2026-05-12T10:30:45.123Z"
    }
  ]
}
```

---

## Migration Notes

If upgrading from previous version:

1. **Existing StudentCLOPerformance records** will work but `isSynced` will be `false`
2. **Run populate script** to rebuild with new structure:
   ```bash
   node backend/scripts/populate-clo-performance.js <courseId> --force
   ```
3. **Or run sync script** to update existing records:
   ```bash
   node backend/scripts/sync-clo-performance.js --courseId <courseId>
   ```
4. **New submissions** will automatically have `isSynced=true` from grade time
