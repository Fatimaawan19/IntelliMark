# CLO-Wise Performance Collection

## Overview

This collection stores aggregated learning outcome performance metrics for each student per CLO per assessment type per course. It enables tracking of how well students are achieving specific course learning outcomes across different assessment types (quizzes vs assignments).

## Data Model

### StudentCLOPerformance Schema

```javascript
{
  _id: ObjectId,
  
  // References
  studentId: String,              // Firebase UID
  courseId: ObjectId,             // Reference to Course
  courseCode: String,             // e.g., "CS101"
  courseName: String,             // e.g., "Computer Science 101"
  cloId: ObjectId,                // Reference to CLO
  cloNumber: Number,              // e.g., 1, 2, 3...
  cloDescription: String,         // CLO text
  
  // Assessment Type Filter
  assessmentType: String,         // 'quiz' or 'assignment'
  
  // Performance Metrics
  totalMarksObtained: Number,     // Sum of all marks obtained for this CLO
  totalMarksAvailable: Number,    // Sum of all available marks
  percentage: Number,             // (obtained/available) * 100, 0-100
  submissionCount: Number,        // Number of submissions for this CLO
  
  // Detailed Breakdown
  submissions: [
    {
      submissionId: ObjectId,
      assessmentId: ObjectId,
      assessmentTitle: String,
      marksObtained: Number,
      marksAvailable: Number,
      submittedAt: Date,
      gradedAt: Date,
      status: String               // 'graded', 'pending', 'submitted'
    }
  ],
  
  // Tracking
  teacherId: String,              // Teacher who created assessment
  lastUpdated: Date,
  createdAt: Date,
  updatedAt: Date
}
```

### Unique Constraint

Each record is unique per combination:
- **studentId + courseId + cloId + assessmentType**

This ensures one aggregated performance record per CLO per assessment type per student per course.

### Indexes

```
- Compound: { studentId, courseId, cloId, assessmentType } (UNIQUE)
- Lookup: { studentId, assessmentType }
- Lookup: { courseId, cloId }
- Lookup: { teacherId, courseId }
```

---

## How It Works

### Automatic Calculation

When a teacher grades a submission:

1. **gradeSubmission** endpoint is called (PATCH `/api/submissions/:submissionId/grade`)
2. Submission is marked as `graded` and saved
3. **CLO Performance Service** automatically calculates:
   - Which CLOs are involved in this assessment
   - Marks obtained vs available for each CLO
   - Updates or creates **StudentCLOPerformance** records
   - Recalculates overall percentage for that CLO

### Mark Distribution Logic

**If per-question scoring available:**
- Each question is linked to a CLO
- Marks from that question are attributed to its CLO
- Total CLO marks = sum of all question marks for that CLO

**Fallback (if no per-question data):**
- Total assessment marks are distributed equally among CLOs
- Each CLO gets: `totalAssessmentMarks / numberOfCLOs`
- Student marks are distributed proportionally

---

## API Endpoints

### 1. Get Student's CLO Performance in a Course

```
GET /api/clo-performance/student/{studentId}/course/{courseId}
```

**Response:**
```json
{
  "success": true,
  "courseId": "6569e3f...",
  "studentId": "usr_12345",
  "performance": [
    {
      "_id": "657a1e2...",
      "cloNumber": 1,
      "cloDescription": "Understand ML algorithms",
      "assessmentType": "quiz",
      "totalMarksObtained": 85,
      "totalMarksAvailable": 100,
      "percentage": 85,
      "submissionCount": 3,
      "submissions": [...]
    },
    {
      "cloNumber": 1,
      "assessmentType": "assignment",
      "percentage": 78,
      ...
    }
  ]
}
```

---

### 2. Get Performance by Assessment Type

```
GET /api/clo-performance/student/{studentId}/course/{courseId}/type/{assessmentType}
```

**Parameters:**
- `assessmentType`: 'quiz' or 'assignment'

**Response:** Same as above, filtered by assessment type

---

### 3. Get Course-Wide CLO Analytics

```
GET /api/clo-performance/course/{courseId}/analytics?assessmentType=quiz
```

**Response:**
```json
{
  "success": true,
  "courseId": "6569e3f...",
  "filter": { "assessmentType": "quiz" },
  "analytics": [
    {
      "_id": {
        "cloId": "656ab4e...",
        "cloNumber": 1,
        "assessmentType": "quiz"
      },
      "avgPercentage": 72,          // Class average
      "studentCount": 28,           // Number of students
      "totalMarksObtained": 2016,   // Sum of all students' marks
      "totalMarksAvailable": 2800
    }
  ]
}
```

---

### 4. Get Performance Summary for Specific CLO

```
GET /api/clo-performance/course/{courseId}/clo/{cloId}?assessmentType=quiz
```

**Response:**
```json
{
  "success": true,
  "courseId": "6569e3f...",
  "cloId": "656ab4e...",
  "assessmentType": "quiz",
  "summary": {
    "studentCount": 28,
    "avgPercentage": 72,
    "minPercentage": 45,
    "maxPercentage": 98,
    "totalSubmissions": 84
  },
  "performances": [
    {
      "studentId": "usr_001",
      "percentage": 85,
      "submissionCount": 3
    }
  ]
}
```

---

### 5. Recalculate Performance for Student-Course

```
POST /api/clo-performance/recalculate/{studentId}/course/{courseId}
```

**Use Cases:**
- Fixing incorrect grades (teacher manually grades after AI marking)
- Bulk re-grading
- Data correction

**Response:**
```json
{
  "success": true,
  "message": "Recalculated CLO performance...",
  "submissionsProcessed": 12,
  "recordsUpdated": 48,
  "details": [...]
}
```

---

### 6. List All CLO Performance Records (Admin)

```
GET /api/clo-performance?studentId=usr_001&courseId=656...&limit=50&page=1
```

**Query Parameters:**
- `studentId` (optional)
- `courseId` (optional)
- `assessmentType` (optional): 'quiz' or 'assignment'
- `limit` (optional, default 100, max 1000)
- `page` (optional, default 1)

**Response:**
```json
{
  "success": true,
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1243,
    "pages": 25
  },
  "records": [...]
}
```

---

## Usage Examples

### Example 1: Track Student Progress Across CLOs in One Course

```bash
curl http://localhost:5000/api/clo-performance/student/usr_12345/course/6569e3f/
```

Shows the student's performance on each CLO in that course, separated by quiz vs assignment.

---

### Example 2: Compare Class Performance on One CLO

```bash
curl http://localhost:5000/api/clo-performance/course/6569e3f/clo/656ab4e/?assessmentType=quiz
```

Shows:
- Average quiz performance on CLO 1
- Best and worst student performance
- Total number of students assessed on this CLO

---

### Example 3: Identify Struggling CLOs in Course

```bash
curl http://localhost:5000/api/clo-performance/course/6569e3f/analytics
```

Shows average performance per CLO. Teachers can identify:
- CLOs where students are struggling (avg < 60%)
- CLOs where students excel (avg > 85%)
- Different performance patterns: quiz vs assignment

---

## Integration Points

### When Data Is Collected

1. **On Submission Grading:**
   - Teacher manually grades: CLO performance updated
   - AI auto-grades: CLO performance updated
   - Teacher republishes grades: CLO performance recalculated

2. **On Assessment Publishing:**
   - When assessment grade is published to student

### What Triggers Updates

- `submissionController.gradeSubmission()` → calls `cloPerformanceService.updateCLOPerformanceForSubmission()`

### Related Models

- **Submission**: Contains grade, status, assessment details
- **Assessment**: Contains CLO IDs, marks, assessment type
- **CLO**: Contains CLO description and properties
- **Course**: Contains course info

---

## Example Scenarios

### Scenario 1: Quiz-based CLO Assessment

**Course:** ML 101
**Assessment:** Week 1 Quiz
- Question 1-3: CLO 1 (Understand ML algorithms) — 3 points each
- Question 4-6: CLO 2 (Apply algorithms) — 4 points each

**Student Performance:**
- Student A scores 8/9 on CLO 1, 11/12 on CLO 2
- **StudentCLOPerformance records created:**
  - CLO 1, Quiz: 8/9 = 89%
  - CLO 2, Quiz: 11/12 = 92%

---

### Scenario 2: Weekly Assignments - CLO Progression

**Course:** ML 101
**Assessments:**
- Week 1 Assignment (CLO 1, 2)
- Week 2 Assignment (CLO 2, 3)
- Week 3 Assignment (CLO 3, 4)

**Student A Results Over Time:**
```
CLO 1 Assignment: 85% (Week 1)
CLO 2 Assignment: 75% (Week 1) → 82% (Week 2)  ← Improvement
CLO 3 Assignment: 70% (Week 2) → 88% (Week 3)  ← Improvement
CLO 4 Assignment: 92% (Week 3)
```

Teacher can see student improvement trajectory per CLO.

---

## Querying Patterns

### Find Weak CLOs Per Student

```javascript
db.StudentCLOPerformance.find({
  studentId: "usr_12345",
  courseId: ObjectId("6569e3f..."),
  percentage: { $lt: 60 }
})
```

### Find Class Average Per CLO

```javascript
db.StudentCLOPerformance.aggregate([
  { $match: { courseId: ObjectId("6569e3f...") } },
  { $group: {
    _id: { cloId: "$cloId", cloNumber: "$cloNumber" },
    avgPercentage: { $avg: "$percentage" },
    studentCount: { $sum: 1 }
  }}
])
```

### Find Students Struggling on Quiz vs Assignment

```javascript
db.StudentCLOPerformance.aggregate([
  { $match: { courseId: ObjectId("6569e3f...") } },
  { $group: {
    _id: { studentId: "$studentId", assessmentType: "$assessmentType" },
    avgPercentage: { $avg: "$percentage" }
  }},
  { $match: { "avgPercentage": { $lt: 60 } } }
])
```

---

## Notes

- **Fallback Strategy**: If no per-question CLO mapping exists, marks are distributed equally among CLOs
- **Atomic Updates**: Each CLO-performance record is updated atomically to prevent race conditions
- **Async Processing**: CLO performance updates happen asynchronously after grading to not block the response
- **Recalculation**: Teachers can trigger manual recalculation if data becomes inconsistent

---

## Future Enhancements

1. **CLO Mastery Tracking**: Mark CLO as "Mastered" when student achieves 80%+ consistently
2. **Remediation Suggestions**: Recommend specific resources for CLOs where student is below threshold
3. **Predictive Analytics**: Predict final CLO mastery based on interim performance
4. **Bloom Level Analytics**: Aggregate by Bloom taxonomy level instead of just CLO
5. **Custom Thresholds**: Allow teachers to set per-CLO mastery thresholds
