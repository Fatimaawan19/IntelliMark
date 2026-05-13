# Quick Fix Reference Card

**Save this** - Quick commands for fixing AutoMark and Plagiarism issues.

## Problem 1: AutoMark Not Using Sample Answers or Course Materials

### Symptoms
- AutoMark grades are lower quality than expected
- In backend logs see: `sampleAnswerExtracted: false` or `relevantCourseMaterialChunksExtracted: false`
- Backend shows 0 or few context chunks being used

### Fix (30 seconds)

```bash
cd backend
node scripts/fix-failed-automark-extractions.js --dry-run    # Preview
node scripts/fix-failed-automark-extractions.js              # Apply
```

### What It Does
- Finds all failed extraction flags
- Tries to extract sample answers from FAISS
- Tries to extract course materials from FAISS
- Updates flags to `true` if data found

### Expected Output
```
✅ Fixed: 3
✅ Unchanged: 7
❌ Errors: 0
```

### Next Step
- Teacher re-runs "AutoMark" or "Re-AutoMark"
- System now uses extracted chunks
- Grades should be higher quality

---

## Problem 2: Plagiarism Scores Wrong or Out of Sync

### Symptoms
- Frontend shows different plagiarism % than backend
- Scores don't match after you fixed bugs
- ZeroGPT API now works but shows 0% still
- Teacher re-logs-in and scores reset

### Fix (1-2 minutes)

```bash
cd backend
node scripts/fix-all-plagiarism-scores.js --dry-run     # Preview
node scripts/fix-all-plagiarism-scores.js               # Apply
```

### What It Does
- Finds all PlagiarismReport records
- Recalculates plagiarism scores from scratch
- Updates both database locations
- Compares old vs new scores

### Expected Output
```
✏️  LIVE MODE (changes applied)
✅ Fixed: 5
✅ Unchanged: 10
❌ Errors: 0
```

### Next Step
- No action needed
- Frontend auto-syncs when refreshed
- Student reports show updated plagiarism %

---

## Problem 3: One Specific Assessment Broken

### If AutoMark Extraction Failed

```bash
cd backend
node scripts/fix-failed-automark-extractions.js --assessment-id 6a03ea92607a94991f0252f0 --dry-run
node scripts/fix-failed-automark-extractions.js --assessment-id 6a03ea92607a94991f0252f0
```

### If Plagiarism Scores Wrong

```bash
cd backend
node scripts/fix-all-plagiarism-scores.js --assessment-id 6a03ea92607a94991f0252f0 --dry-run
node scripts/fix-all-plagiarism-scores.js --assessment-id 6a03ea92607a94991f0252f0
```

### If Sample Answer Not Found

```bash
# Teacher must upload sample answer first
# Then run fix script
node scripts/fix-failed-automark-extractions.js
```

### If Course Materials Not Found

```bash
# Admin must ingest course materials first
cd rag_marking
python ingest_materials_to_faiss.py --course-id YOUR_COURSE_ID

# Then run fix script
cd ..
node scripts/fix-failed-automark-extractions.js
```

---

## Complete Workflow (Recommended)

### When Starting Fresh

```
1. Create Assessment
   └─ Add instructions, questions

2. Upload Sample Answer
   └─ Click "Sample Answer" button, upload PDF/DOCX

3. Ingest Course Materials (ONE TIME PER COURSE)
   ```bash
   cd backend/rag_marking
   python ingest_materials_to_faiss.py --course-id YOUR_ID
   ```

4. Run AutoMark
   └─ Click "AutoMark" button in Assessment

5. Check AutoMark Status
   ```bash
   node scripts/fix-failed-automark-extractions.js --dry-run
   ```
   If false flags, run without `--dry-run` to fix

6. Run Plagiarism Check
   └─ Click "Plagiarism" button in Submission

7. Check Plagiarism Status (Optional)
   ```bash
   node scripts/fix-all-plagiarism-scores.js --dry-run
   ```
   Only needed if you changed detection logic or API key
```

---

## Manual Verification

### Check AutoMark Extraction Flags

```bash
# View job details
mongosh
> use InteliMark
> db.automarkJobs.find({sampleAnswerExtracted: false}).pretty()
```

### Check Plagiarism Scores

```bash
# View reports
mongosh
> use InteliMark
> db.plagiarismreports.find({}).sort({overallScore: -1}).pretty()
```

### Check Backend Logs

```bash
# Look for extraction/plagiarism messages
npm run dev  # Terminal 1
# Terminal 2: grep logs for [PLAGIARISM] or [AUTOMARK]
```

---

## When Scripts Can't Fix Automatically

| Problem | Manual Action |
|---------|---|
| `sampleAnswerExtracted` still false | Teacher: Upload sample answer PDF/DOCX |
| `relevantCourseMaterialChunks` still false | Admin: Run `python ingest_materials_to_faiss.py` |
| Plagiarism shows 0% AI score | Get valid ZeroGPT API key, update `.env` |
| FAISS index seems corrupted | Rebuild indices: Re-ingest all course materials |

---

## Dry-Run vs Live Mode

### --dry-run (SAFE)
```bash
node scripts/fix-failed-automark-extractions.js --dry-run
```
- ✅ Shows what would be fixed
- ✅ No database changes
- ✅ Safe to run multiple times
- ❌ Doesn't apply fixes

### Live Mode (APPLIES CHANGES)
```bash
node scripts/fix-failed-automark-extractions.js
```
- ✅ Applies all fixes to database
- ✅ Updates all affected documents
- ❌ Modifies production data
- ❌ Can't undo easily

**Best Practice**: Always run with `--dry-run` first!

---

## Common Commands

```bash
# START HERE: See what's broken
node scripts/fix-failed-automark-extractions.js --dry-run
node scripts/fix-all-plagiarism-scores.js --dry-run

# FIX AUTOMARK
node scripts/fix-failed-automark-extractions.js

# FIX PLAGIARISM
node scripts/fix-all-plagiarism-scores.js

# FIX SPECIFIC ASSESSMENT
node scripts/fix-failed-automark-extractions.js --assessment-id ID
node scripts/fix-all-plagiarism-scores.js --assessment-id ID

# INGEST COURSE MATERIALS (if needed)
cd backend/rag_marking
python ingest_materials_to_faiss.py --course-id ID

# VERIFY WITH MONGOSH
mongosh
> use InteliMark
> db.automarkJobs.findOne()
> db.plagiarismreports.findOne()
```

---

## Troubleshooting Quick Answers

**Q: "Found 0 jobs" when I know there are failures**
A: Script only finds failed extractions. If all flags are `true`, there's nothing to fix.

**Q: "No sample answers found" but I uploaded a file**
A: File might be corrupted. Try uploading again. Script will find it next run.

**Q: Plagiarism scores haven't changed**
A: They were already correct. Script shows "No change (already correct)".

**Q: Backend timeout error**
A: MongoDB not running. Start MongoDB first: `mongosh`

**Q: "Assessment not found"**
A: Assessment was deleted. Script safely skips it and continues.

---

## Emergency Reset (If Something Breaks)

### Reset AutoMark Job (Start Over)

```bash
mongosh
> use InteliMark
> db.automarkJobs.deleteOne({_id: ObjectId("YOUR_JOB_ID")})
```

### Reset Plagiarism Report (Start Over)

```bash
mongosh
> use InteliMark
> db.plagiarismreports.deleteOne({submissionId: ObjectId("YOUR_SUB_ID")})
> db.submissions.findByIdAndUpdate({_id: ObjectId("...")}, {
    plagiarismBestMatchPercent: null,
    plagiarismAiScore: null
  })
```

Then re-run AutoMark or plagiarism check to regenerate.

---

## When to Contact Support

If after running both fix scripts you still see:
- ❌ `sampleAnswerExtracted: false` AND sample answer uploaded
- ❌ `relevantCourseMaterialChunks: false` AND materials ingested
- ❌ Plagiarism scores show 0% AI AND ZeroGPT API is valid
- ❌ Errors in backend logs with stack traces
- ❌ MongoDB connection failures

Then there may be a system-level issue. Provide:
1. Error message from backend logs
2. Output from `--dry-run` mode
3. Assessment/Submission ID
4. MongoDB version and status

---

**Print this card** - Keep it handy for quick reference!

**Updated**: 2026-05-13  
**For**: InteliMark v2.0+
