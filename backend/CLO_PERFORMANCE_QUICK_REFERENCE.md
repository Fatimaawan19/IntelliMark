# CLO Performance Real-Time Sync - Quick Reference

## What Changed

### 1. **StudentCLOPerformance Model** 
- ✅ NEW: `submissions[].feedback` - stores teacher feedback
- ✅ NEW: `submissions[].submissionRawId` - reference to SubmissionRaw
- ✅ NEW: `submissions[].lastSyncedAt` - tracks when data was synced
- ✅ NEW: `allFeedback[]` - aggregated feedback from all submissions
- ✅ NEW: `isSynced` boolean flag - marks record as current
- ✅ NEW: `lastSyncedAt` timestamp - when last sync happened
- ✅ NEW: Indexes on `isSynced` and `lastSyncedAt`

### 2. **CLO Performance Service** (`backend/utils/cloPerformanceService.js`)
- ✅ **UPDATED**: `updateCLOPerformanceForSubmission()` - now extracts real-time data from Submission collection
- ✅ **NEW**: `populateCLOPerformanceForCourse()` - bulk fetch from all submissions
- ✅ **UPDATED**: Now stores submission references for real-time data extraction
- ✅ **UPDATED**: Pulls marks, feedback, and metadata from latest submission state

### 3. **Submission Controller** (`backend/controllers/submissionController.js`)
- ✅ **UPDATED**: `gradeSubmission()` - now auto-syncs CLO performance
- ✅ **NEW**: `updateSubmissionMarks()` - allows editing marks/feedback after grading + auto-syncs

### 4. **Submission Routes** (`backend/routes/submissionRoutes.js`)
- ✅ **NEW**: `PATCH /api/submissions/:submissionId/update-marks` - edit marks and feedback

### 5. **Bulk Scripts**
- ✅ **NEW**: `backend/scripts/populate-clo-performance.js` - initialize CLO data for course
- ✅ **NEW**: `backend/scripts/sync-clo-performance.js` - re-sync all CLO performance records

---

## How It Works Now

### When Teacher Grades Submission

```
gradeSubmission() 
  ↓ 
Save submission with grade & feedback
  ↓
[Async] updateCLOPerformanceForSubmission()
  ↓
Extract REAL-TIME marks + feedback from Submission
  ↓
Store with submission references
  ↓
Mark as isSynced=true with timestamp
```

### When Teacher Edits Marks Later

```
updateSubmissionMarks()
  ↓
Update submission with new grade/feedback
  ↓
[Async] updateCLOPerformanceForSubmission()
  ↓
Re-fetch latest marks from Submission
  ↓
Recalculate everything with current data
  ↓
Update StudentCLOPerformance with newest values
```

### Key Features

✅ **Real-time data** - pulls marks/feedback from Submission collection on demand
✅ **Auto-sync** - happens automatically after grading/updates
✅ **Feedback included** - teacher feedback now stored in CLO performance
✅ **Update support** - marks can be edited anytime, CLO data updates automatically
✅ **Bulk operations** - scripts to populate/sync entire courses
✅ **Sync tracking** - `isSynced` flag and `lastSyncedAt` timestamp

---

## API Usage

### Edit Marks After Grading

```bash
PATCH /api/submissions/:submissionId/update-marks
{
  "grade": 90,
  "feedback": "Excellent work!",
  "teacherId": "teacher_uid"
}
```

Response: ✅ Submission updated + CLO performance auto-synced

### Get CLO Performance (Now with Real-Time Data)

```bash
GET /api/clo-performance/student/{studentId}/course/{courseId}
```

Returns: Latest marks & feedback from Submission collection

---

## Scripts Usage

### Initialize CLO Performance for Course

```bash
node backend/scripts/populate-clo-performance.js <courseId>
```

- ✅ Extracts data from ALL graded submissions
- ✅ Creates StudentCLOPerformance records
- ✅ Shows detailed progress

### Sync All CLO Performance Records

```bash
node backend/scripts/sync-clo-performance.js
```

- ✅ Re-syncs ALL records globally
- ✅ Pulls latest marks/feedback from Submission
- ✅ Updates isSynced flags
- ✅ Shows sync status

### Options

```bash
# Populate specific course
node backend/scripts/populate-clo-performance.js <courseId> --force

# Sync only one course
node backend/scripts/sync-clo-performance.js --courseId <courseId>

# Sync only one student
node backend/scripts/sync-clo-performance.js --studentId <studentId>

# Preview changes without saving
node backend/scripts/populate-clo-performance.js <courseId> --dry-run

# Clear and rebuild
node backend/scripts/sync-clo-performance.js --clear
```

---

## Data Flow Example

### Submission 1: Initial Grading
```
Student submits → Teacher grades: 80/100, "Good effort"
  ↓
StudentCLOPerformance created:
  - CLO1: 80/100 = 80%
  - feedback: "Good effort"
  - isSynced: true
  - lastSyncedAt: 2026-05-12 10:00:00
```

### Submission 1: Teacher Updates Grade
```
Teacher: "Actually this deserves 90"
  ↓
PATCH /api/submissions/656ab4.../update-marks
Body: { grade: 90, feedback: "Excellent work!" }
  ↓
Submission updated to grade=90, feedback="Excellent work!"
  ↓
StudentCLOPerformance recalculated:
  - CLO1: 90/100 = 90% (UPDATED)
  - feedback: "Excellent work!" (UPDATED)
  - isSynced: true
  - lastSyncedAt: 2026-05-12 11:30:00
```

### Submission 2: Same Student, Same CLO
```
Student submits again → Teacher grades: 95/100
  ↓
StudentCLOPerformance updated:
  - submissions[]: now has 2 entries
  - totalMarksObtained: 90 + 95 = 185
  - totalMarksAvailable: 100 + 100 = 200
  - percentage: 185/200 = 92.5%
  - allFeedback: ["Excellent work!", feedback_for_submission_2]
  - submissionCount: 2
  - isSynced: true
  - lastSyncedAt: 2026-05-12 14:00:00
```

---

## Stored Data Structure

### StudentCLOPerformance Document

```javascript
{
  _id: ObjectId("..."),
  
  // References
  studentId: "usr_12345",
  courseId: ObjectId("6569e3f..."),
  cloId: ObjectId("656ab4e..."),
  assessmentType: "quiz",
  
  // Aggregated metrics
  totalMarksObtained: 175,
  totalMarksAvailable: 200,
  percentage: 87,
  submissionCount: 2,
  
  // Detailed breakdown with real-time data
  submissions: [
    {
      submissionId: ObjectId("656ab4e..."),
      assessmentId: ObjectId("656ac5f..."),
      assessmentTitle: "Week 1 Quiz",
      submissionRawId: ObjectId("656ad6g..."),
      marksObtained: 80,      // Real-time from Submission
      marksAvailable: 100,
      feedback: "Good effort",  // Real-time from Submission
      submittedAt: ISODate("2026-05-10..."),
      gradedAt: ISODate("2026-05-10..."),
      status: "graded",
      lastSyncedAt: ISODate("2026-05-11T11:30:00Z")  // When data was synced
    },
    {
      submissionId: ObjectId("656ae7h..."),
      assessmentId: ObjectId("656ac5f..."),
      assessmentTitle: "Week 1 Quiz",
      submissionRawId: ObjectId("656af8i..."),
      marksObtained: 95,
      marksAvailable: 100,
      feedback: "Excellent work!",
      submittedAt: ISODate("2026-05-11..."),
      gradedAt: ISODate("2026-05-11..."),
      status: "graded",
      lastSyncedAt: ISODate("2026-05-12T14:00:00Z")
    }
  ],
  
  // Summary
  allFeedback: ["Good effort", "Excellent work!"],
  
  // Sync tracking
  isSynced: true,
  lastSyncedAt: ISODate("2026-05-12T14:00:00Z"),
  
  // Metadata
  courseCode: "CS101",
  courseName: "Computer Science 101",
  cloNumber: 1,
  cloDescription: "Understand algorithms",
  teacherId: "teacher_uid",
  
  // Timestamps
  createdAt: ISODate("2026-05-10..."),
  updatedAt: ISODate("2026-05-12..."),
  lastUpdated: ISODate("2026-05-12...")
}
```

---

## Benefits

✅ **Always Current** - Data pulled from Submission on every sync
✅ **No Data Loss** - References stored, can rebuild anytime  
✅ **Feedback Included** - Teacher feedback now tracked per CLO
✅ **Edit Support** - Marks can be changed, CLO data updates automatically
✅ **Transparent** - isSynced flag and timestamp show data freshness
✅ **Reversible** - Can re-sync to fix discrepancies
✅ **Scalable** - Bulk scripts handle large courses

---

## Migration Guide

If upgrading from older version:

### Option 1: Quick (Update existing records)
```bash
node backend/scripts/sync-clo-performance.js --courseId <courseId>
```

### Option 2: Clean (Rebuild from scratch)
```bash
node backend/scripts/populate-clo-performance.js <courseId> --force
```

### Verify
```bash
# Check sync status
db.StudentCLOPerformance.countDocuments({ isSynced: true })
db.StudentCLOPerformance.countDocuments({ isSynced: false })
```

---

## Monitoring

### Check if records are synced
```javascript
// Unsynced records (old data)
const unsynced = await StudentCLOPerformance.find({ isSynced: false }).count();

// Stale records (not synced in 1 hour)
const stale = await StudentCLOPerformance.find({
  lastSyncedAt: { $lt: new Date(Date.now() - 60*60*1000) }
}).count();
```

### Run periodic sync
```bash
# Add to cron (runs daily at midnight)
0 0 * * * cd /path/to/backend && node scripts/sync-clo-performance.js
```

---

## Files Modified/Created

✅ Models:
- `backend/models/StudentCLOPerformance.js` - UPDATED with new fields

✅ Services:
- `backend/utils/cloPerformanceService.js` - UPDATED, now extracts real-time data

✅ Controllers:
- `backend/controllers/submissionController.js` - UPDATED gradeSubmission() + NEW updateSubmissionMarks()

✅ Routes:
- `backend/routes/submissionRoutes.js` - NEW route for update-marks

✅ Scripts:
- `backend/scripts/populate-clo-performance.js` - NEW
- `backend/scripts/sync-clo-performance.js` - NEW

✅ Documentation:
- `backend/CLO_PERFORMANCE_REALTIME_SYNC.md` - Complete guide
- `backend/CLO_PERFORMANCE_DOCUMENTATION.md` - Original (still valid)

---

## Need Help?

### CLO data not updating?
- Check logs: `setImmediate` runs after response
- Verify submission has `status="graded"`
- Run: `node backend/scripts/sync-clo-performance.js --courseId <id>`

### Want to update marks?
- Use: `PATCH /api/submissions/:id/update-marks`
- CLO performance auto-syncs (async)

### Need to initialize course?
- Run: `node backend/scripts/populate-clo-performance.js <courseId>`

### Want to verify data?
- Check: `db.StudentCLOPerformance.findOne({...})`
- Look at `submissions[].lastSyncedAt` timestamp
- Check `isSynced` flag
