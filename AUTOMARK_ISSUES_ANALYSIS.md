# AutoMark Issues - Root Cause Analysis & Fixes

## Issues Found

### 🔴 **CRITICAL ISSUE #1: Assessments Have No Questions**
- **44 out of 77 assessments** have `questionCount > 0` but NO questions in the database
- When AutoMark tries to grade, it fails because `assessment.questions = []`
- This causes the automark controller to return: `"Assessment has no questions to grade"`

**Evidence:**
```
❌ CRITICAL ISSUE: questionCount=10 but NO questions found in DB!
```

### 🔴 **CRITICAL ISSUE #2: "fetch failed" Error on Submission**
- One submission shows `Automark error: fetch failed`
- This indicates the LLM retrieval service is having issues
- Could be:
  - Network issue with Ollama API
  - FAISS vector database is not responding
  - Submission chunks were not properly extracted/ingested

**Evidence:**
```
- Automark status: failed
- Automark error: fetch failed
- Total awarded marks: 0
- ERROR: fetch failed
```

---

## How AutoMark Should Work

1. **User clicks "AutoMark" on a submission**
2. Backend fetches Assessment with its Questions
3. For each Question:
   - Retrieves student answer chunks from FAISS
   - Retrieves rubric/sample answer from assessment reference store
   - Retrieves course materials from vector DB
   - Calls Ollama LLM to grade the answer
   - LLM returns: marks, suggestions, mistakes, improvements
4. All results are stored in SubmissionRaw with status="completed"
5. Results are displayed in UI

---

## Why AutoMark Generates 0 Marks

### Root Cause 1: No Questions in Assessment
When `assessment.questions = []`, the automark process stops immediately:
- File: `backend/controllers/automarkController.js:202-210`
- File: `backend/controllers/submissionController.js:1523-1529`

```javascript
const questions = Array.isArray(assessment.questions) ? assessment.questions : [];
if (questions.length === 0) {
  return res.status(400).json({ success: false, error: "Assessment has no questions to grade" });
}
```

### Root Cause 2: LLM Retrieval Failures
Even if questions exist, if chunk retrieval fails:
- File: `backend/utils/automarkLlmService.js:240-248`
- The system gets 0 student chunks
- LLM call fails
- Automark marked as "failed"

### Root Cause 3: Questions Missing "marks" Field
If a question has `marks = 0` or `marks = null`:
- Max marks becomes 0
- All awarded marks are 0
- Report shows 0/0 or 0/null

---

## How to Fix

### FIX #1: Recreate Questions for Assessments
Run this MongoDB query to find assessments without questions:

```javascript
// Find assessments with no questions
db.assessments.find({ 
  questionCount: { $gt: 0 }, 
  $expr: { $eq: [{ $size: "$questions" }, 0] }
}).count()

// For each such assessment, you need to:
// 1. Create Question documents with the same assessmentId
// 2. OR fix the Assessment.questions array to point to existing questions

```

**How to do it via UI:**
1. Go to "Create Assessment" or "Edit Assessment"
2. Ensure questions are created/linked before saving
3. Verify Assessment.questions array is populated

### FIX #2: Ensure Questions Have Marks
Check that all questions have valid marks:

```javascript
// Find questions with no marks
db.questions.find({ $or: [
  { marks: null },
  { marks: 0 },
  { marks: { $exists: false } }
]})

// All questions MUST have marks > 0
```

### FIX #3: Extract Submissions First
Before automarking:
1. Go to Assessment
2. Click "Extract Submissions" button
3. Wait for status to show "Extraction Complete"
4. This populates FAISS vector store with student chunks

### FIX #4: Test AutoMark with Proper Assessment
Create a test assessment with:
- ✅ At least 1 question with marks > 0
- ✅ Student submission  
- ✅ Extracted chunks (run extraction first)
- ✅ Ollama running (`curl http://localhost:11434/api/tags`)

---

## Diagnostic Commands

### Check Assessments
```bash
node diagnose-automark.js
```

### Check LLM Connection
```bash
Invoke-WebRequest -Uri http://localhost:11434/api/tags -UseBasicParsing
```

### Check MongoDB
```javascript
// Count assessments with no questions
db.assessments.countDocuments({ 
  questionCount: { $gt: 0 },
  $expr: { $eq: [{ $size: "$questions" }, 0] }
})

// List them
db.assessments.find({ 
  questionCount: { $gt: 0 },
  $expr: { $eq: [{ $size: "$questions" }, 0] }
}, { title: 1, questionCount: 1 }).limit(5)
```

---

## Summary

| Issue | Impact | Fix |
|-------|--------|-----|
| No questions in assessment | AutoMark stops immediately | Recreate/link questions to assessment |
| Questions missing marks field | Awards 0 marks | Ensure all questions have marks > 0 |
| Chunks not extracted | "fetch failed" error | Run "Extract Submissions" first |
| Ollama not running | "fetch failed" on LLM call | Start Ollama: `ollama serve` |
| FAISS not ingested | No student context for grading | Run extraction, wait for "completed" |

---

## Next Steps

1. **Run diagnostic**: `node diagnose-automark.js`
2. **Check MongoDB**: Find assessments with no questions
3. **Fix data**: Either create missing questions or clean up bad assessment records
4. **Test**: Create a fresh assessment with questions and try automark
5. **Monitor**: Check `SubmissionRaw.automarkStatus` and `automarkError` fields
