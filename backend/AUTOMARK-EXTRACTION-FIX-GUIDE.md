# AutoMark Extraction Fix Guide

## What This Does

The `fix-failed-automark-extractions.js` script finds and fixes AutoMark jobs where extraction flags are set to false:

- ❌ `sampleAnswerExtracted: false` → ✅ `true` (if found)
- ❌ `relevantCourseMaterialChunksExtracted: false` → ✅ `true` (if found)

These flags indicate whether the system successfully found and indexed the sample answers and course materials needed for AutoMark to work properly.

## Why Extraction Might Fail

### sampleAnswerExtracted = false

**Reason 1: Sample Answer Not Uploaded**
- Teacher hasn't uploaded a sample answer PDF/DOCX
- Solution: Upload sample answer via Assessment → Sample Answer button

**Reason 2: Sample Answer Not Processed**
- File was uploaded but ingestion pipeline failed
- Check backend logs for ingestion errors
- Solution: Re-upload the sample answer file

### relevantCourseMaterialChunksExtracted = false

**Reason 1: Course Materials Not Ingested**
- Course materials (syllabus, lecture notes) not uploaded to FAISS index
- Solution: Run ingestion pipeline:
  ```bash
  cd backend/rag_marking
  python ingest_materials_to_faiss.py --course-id <COURSE_ID>
  ```

**Reason 2: FAISS Index Empty**
- Course exists but has no materials indexed
- Solution: Upload course materials and re-ingest

## How to Use

### Step 1: Check Current Status

```bash
cd backend
node scripts/fix-failed-automark-extractions.js --dry-run
```

This shows:
- How many jobs have failed extractions
- Which assessments are affected
- Whether sample answers and/or course materials are missing

### Step 2: Fix Specific Assessment (Optional)

To check only ONE assessment:

```bash
node scripts/fix-failed-automark-extractions.js --dry-run --assessment-id <ID>
```

### Step 3: Apply Fixes

```bash
node scripts/fix-failed-automark-extractions.js
```

This will:
- ✅ Try to extract sample answers for each job
- ✅ Try to extract course materials for each job
- ✅ Update flags to `true` if extraction succeeds
- ✅ Log detailed progress

## Understanding the Output

### When Extraction Succeeds

```
[1/10] PP_Assignment_02
   Sample extracted: false
   Course material extracted: false
   ✅ Sample answers found: 8 chunk(s)
   ✅ Course materials found: 12 chunk(s)
   ✏️  Fixed: sampleAnswerExtracted, relevantCourseMaterialChunksExtracted
```

→ Both flags will be set to `true` in database

### When Extraction Fails

```
[2/10] PP_Assignment_01
   Sample extracted: false
   Course material extracted: false
   ❌ No sample answers found (may not be uploaded)
   ❌ No course materials found (may not be ingested)
```

→ Flags remain `false` (nothing to extract)

## What Each Flag Means

### studentEvidenceExtracted = true
- ✅ Student submission text successfully extracted and indexed
- Used for: Finding similar chunks from student's past answers
- **If false**: Extraction pipeline failed, check backend logs

### sampleAnswerExtracted = true
- ✅ Sample answer successfully extracted and indexed
- Used for: Providing LLM with reference answer patterns
- **If false**: Sample answer not uploaded OR ingestion failed
- **Impact**: AutoMark still works but without reference answers

### relevantCourseMaterialChunksExtracted = true
- ✅ Course materials successfully extracted and indexed
- Used for: Providing LLM with course context
- **If false**: Course materials not ingested
- **Impact**: AutoMark still works but without course context

## When to Run This Script

Run this script **AFTER**:

1. ✅ Teachers uploaded sample answers
2. ✅ Course materials have been ingested via Python pipeline
3. ✅ AutoMark jobs failed to set extraction flags

**Do NOT run if:**
- ❌ Sample answers/course materials haven't been added yet
- ❌ You're still uploading files (wait for all uploads)
- ❌ Backend is not running

## Complete Workflow

### Step-by-Step Guide

#### Phase 1: Prepare Assessment

```
1. Create assessment in system
2. Upload assignment instructions
3. Upload sample answer PDF/DOCX ← KEY STEP
4. Set rubric criteria
5. Add questions
```

#### Phase 2: Prepare Course Materials

```bash
# From backend/rag_marking directory
python ingest_materials_to_faiss.py --course-id <ID>
```

This indexes:
- Syllabus
- Lecture notes
- Course PDFs
- Any attached learning materials

#### Phase 3: Run AutoMark

```
Teacher clicks AutoMark button
  ↓
Upload Sample Answer (if not done in Phase 1)
  ↓
Click "AutoMark" to run grading
  ↓
System checks extraction flags
  ↓
If flags are false:
  - Can't use sample answers
  - Can't use course context
  - Still grades, but quality may suffer
```

#### Phase 4: Fix Failed Extractions

```bash
node scripts/fix-failed-automark-extractions.js --dry-run
node scripts/fix-failed-automark-extractions.js
```

#### Phase 5: Re-Run AutoMark

```
Teacher clicks "Re-AutoMark" with fresh flags
  ↓
Now uses sample answers + course context
  ↓
Better quality grades
```

## Troubleshooting

### "No sample answers found" after uploading

**Problem**: Sample file was uploaded but not indexed

**Solution**:
1. Check if file is PDF/DOCX (other formats not supported)
2. Check backend logs for extraction errors
3. Try uploading again
4. Run fix script again

```bash
node scripts/fix-failed-automark-extractions.js --dry-run
```

### "No course materials found"

**Problem**: Course materials not ingested to FAISS

**Solution**:
```bash
cd backend/rag_marking
python ingest_materials_to_faiss.py --course-id <COURSE_ID>
```

Then run fix script again:
```bash
node scripts/fix-failed-automark-extractions.js
```

### Still showing false after fix script runs

**Problem**: Extraction pipeline can't find the data

**Reasons**:
1. Sample answer file is corrupted
2. FAISS index is corrupted
3. Database indices need rebuild
4. Python extraction script failed

**Solution**:
1. Check backend logs: `grep -i "error\|fail" logs.txt`
2. Re-upload sample answer
3. Re-ingest course materials
4. Restart backend and try again

### "Unchanged" count is high

**Problem**: Most extraction flags are already correct

**Reason**: AutoMark is working fine, system auto-set flags correctly

**Action**: No action needed! You can still run the script to verify.

## Database Impact

### Before Fix Script

```javascript
{
  _id: "job123",
  assessmentId: "assess456",
  sampleAnswerExtracted: false,      // ❌ Can't use sample answers
  relevantCourseMaterialChunksExtracted: false,  // ❌ Can't use course context
  status: "completed"
}
```

### After Fix Script (if extractions exist)

```javascript
{
  _id: "job123",
  assessmentId: "assess456",
  sampleAnswerExtracted: true,       // ✅ Now can use sample answers
  relevantCourseMaterialChunksExtracted: true,   // ✅ Now can use course context
  status: "completed"
}
```

## Impact on AutoMark Quality

| Scenario | sampleAnswer | courseMaterial | AutoMark Quality |
|----------|:---:|:---:|---|
| Both extracted | ✅ | ✅ | 🟢 Excellent |
| Only student evidence | ❌ | ❌ | 🟡 Basic |
| Sample only | ✅ | ❌ | 🟡 Good |
| Course only | ❌ | ✅ | 🟡 Good |
| Sample + Course | ✅ | ✅ | 🟢 Excellent |

**Note**: AutoMark still works with low quality, but results are better with both extractions.

## API Impact

After running fix script, the AutoMark job object will include:

```json
{
  "_id": "objectId",
  "sampleAnswerExtracted": true,
  "relevantCourseMaterialChunksExtracted": true,
  "status": "completed",
  "results": [{...}, {...}]
}
```

Frontend can then display:
- ✅ "Extraction complete" status
- 🟢 "All context available" badge
- Confidence in grading quality

## Example Scenarios

### Scenario 1: Everything Works

```bash
$ node scripts/fix-failed-automark-extractions.js --dry-run

📊 Found 1 job(s) with failed extractions

[1/1] Final Exam
   Sample extracted: false
   Course material extracted: false
   ✅ Sample answers found: 5 chunk(s)
   ✅ Course materials found: 18 chunk(s)
   ✏️  Fixed: sampleAnswerExtracted, relevantCourseMaterialChunksExtracted

✅ Fixed: 1
✅ Unchanged: 0
❌ Errors: 0
```

→ Run `node scripts/fix-failed-automark-extractions.js` (without --dry-run) to apply

### Scenario 2: Missing Sample Answers

```bash
$ node scripts/fix-failed-automark-extractions.js --dry-run

📊 Found 5 job(s) with failed extractions

[1/5] Quiz 01
   Sample extracted: false
   Course material extracted: false
   ❌ No sample answers found (may not be uploaded)
   ✅ Course materials found: 15 chunk(s)
   ✏️  Fixed: relevantCourseMaterialChunksExtracted

[2/5] Quiz 02
   Sample extracted: false
   Course material extracted: false
   ❌ No sample answers found (may not be uploaded)
   ✅ Course materials found: 12 chunk(s)
   ✏️  Fixed: relevantCourseMaterialChunksExtracted
...

✅ Fixed: 4
✅ Unchanged: 1
❌ Errors: 0
```

→ Teachers need to upload sample answers for Quiz 01 and Quiz 02

### Scenario 3: Missing Course Materials

```bash
$ node scripts/fix-failed-automark-extractions.js --dry-run

📊 Found 3 job(s) with failed extractions

[1/3] Assignment 1
   Sample extracted: false
   Course material extracted: false
   ✅ Sample answers found: 8 chunk(s)
   ❌ No course materials found (may not be ingested)
   ✏️  Fixed: sampleAnswerExtracted
...

✅ Fixed: 2
✅ Unchanged: 1
❌ Errors: 0
```

→ Run: `python backend/rag_marking/ingest_materials_to_faiss.py --course-id <ID>`

## Quick Reference

```bash
# Check status (no changes)
npm run dev  # Terminal 1: Start backend
node scripts/fix-failed-automark-extractions.js --dry-run

# Apply fixes to all jobs
node scripts/fix-failed-automark-extractions.js

# Check specific assessment
node scripts/fix-failed-automark-extractions.js --dry-run --assessment-id YOUR_ID

# If sample answers missing:
# Teachers must upload sample answer files in Assessment → Sample Answer

# If course materials missing:
cd backend/rag_marking
python ingest_materials_to_faiss.py --course-id COURSE_ID

# Then re-run fix script
node scripts/fix-failed-automark-extractions.js
```

## Files Involved

- **AutomarkJob Model**: `backend/models/AutomarkJob.js`
- **Extraction Logic**: `backend/controllers/automarkController.js` (lines 300-350)
- **Reference Retrieval**: `backend/utils/assessmentReferenceRetrievalService.js`
- **Course Material Retrieval**: `backend/utils/courseMaterialRetrievalService.js`
- **Fix Script**: `backend/scripts/fix-failed-automark-extractions.js`

---

**Created**: 2026-05-13  
**Last Updated**: 2026-05-13  
**Compatibility**: InteliMark v2.0+
