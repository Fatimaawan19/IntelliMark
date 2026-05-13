# Plagiarism Score Fix Guide

This guide explains how to recalculate and sync plagiarism scores across your InteliMark system.

## What This Does

The `fix-all-plagiarism-scores.js` script:

1. **Finds all graded submissions** with plagiarism reports that have been marked
2. **Recalculates scores correctly** using the latest plagiarism detection logic
3. **Compares old vs new scores** to identify which records need updating
4. **Updates both storage locations**:
   - `PlagiarismReport` collection (detailed reports)
   - `Submission` model (quick access fields)
5. **Syncs to frontend automatically** via existing API endpoints

## Why You Need This

Plagiarism scores might become outdated if:
- You fixed bugs in plagiarism detection logic
- You updated ZeroGPT API integration
- You changed score weighting (internal vs AI)
- You want to recalculate with a fresh API key

## How to Use

### Step 1: Test First (Dry Run)

Always run in dry-run mode first to see what would change:

```bash
cd backend
node scripts/fix-all-plagiarism-scores.js --dry-run
```

This will:
- ✅ Show which scores would change
- ✅ Display old vs new percentages
- ✅ NOT modify any data
- ✅ Let you review all changes first

**Example output:**
```
📊 Found 15 plagiarism report(s)
...
✅ Fixed: 3
✅ Unchanged: 12
❌ Errors: 0
Total: 15
```

### Step 2: Review Changes

The output will show:
- **Student name** whose submission was analyzed
- **Old scores** (internal%, AI%, overall%)
- **New scores** (recalculated)
- **Number of top matches** found

Look for:
- 🔴 Big score changes (>10%) → review carefully
- 🟡 Small changes (1-5%) → likely due to rounding or improved matching
- ❌ Errors → check submission data integrity

### Step 3: Apply Changes (Live Mode)

Once you're confident, run WITHOUT `--dry-run`:

```bash
cd backend
node scripts/fix-all-plagiarism-scores.js
```

This will:
- ✏️ Recalculate all plagiarism scores
- 📝 Update Submission documents
- 📊 Update PlagiarismReport documents
- ✅ Show detailed progress for each submission

### Step 4: Verify on Frontend

After running:

1. **Refresh teacher dashboard** to see updated scores
2. **Open ViewReport page** - plagiarism % should match new values
3. **Check API endpoints**:
   ```
   GET /api/plagiarism/assessment/{assessmentId}
   ```
   Should return updated `overallScore`, `internalScore`, `aiScore`

## Fix Specific Assessment

To fix plagiarism scores for only ONE assessment:

```bash
node scripts/fix-all-plagiarism-scores.js --assessment-id 6a03ea92607a94991f0252f0
```

Or with dry-run:

```bash
node scripts/fix-all-plagiarism-scores.js --assessment-id 6a03ea92607a94991f0252f0 --dry-run
```

## Understanding Score Changes

Scores might change due to:

### Internal Score (Student-to-Student Plagiarism)
- **Increases** if more similar students' submissions added
- **Decreases** if excluded students in that assessment
- **Formula**: Top FAISS similarity match × 100

### AI Score (AI-Generated Content)
- **Increases** if ZeroGPT API now works (was previously unavailable)
- **Decreases** if API fails (returns 0%)
- **Formula**: ZeroGPT fake_percentage directly

### Overall Score (Combined)
- **Formula**: (Internal × 60%) + (AI × 40%)
- **Range**: 0-100%

### Risk Level
- **Low**: Overall < 30%
- **Medium**: 30-59%
- **High**: 60%+

## Data Locations

After running the fix script, plagiarism data is stored in:

### 1. PlagiarismReport Collection (MongoDB)
```javascript
{
  submissionId: ObjectId,
  assessmentId: ObjectId,
  studentId: String,
  internalScore: Number (0-100),
  aiScore: Number (0-100),
  overallScore: Number (0-100),
  topMatches: Array,
  riskLevel: String ("low"|"medium"|"high"),
  checkedAt: Date
}
```

### 2. Submission Model Fields
```javascript
{
  plagiarismBestMatchPercent: Number,
  plagiarismAiScore: Number,
  plagiarismReport: Object,
  plagiarismCheckedAt: Date,
  plagiarismPenaltyPercent: Number
}
```

## Frontend Display

### In ViewReport.tsx
```
Student submission match: {plagiarismBestMatchPercent}%
AI-generated content: {plagiarismAiScore}%
```

### In Teacher Dashboard
```
Overall risk: [Low|Medium|High]
Internal match: {internalScore}%
Top matches: [List of 5 similar students]
```

## API Endpoints

All endpoints return fresh data (no caching):

### Get Assessment Reports
```
GET /api/plagiarism/assessment/:assessmentId
Returns: [PlagiarismReport, ...]
Sorted by: overallScore (descending)
```

### Get Single Report
```
GET /api/plagiarism/report/:submissionId
Returns: PlagiarismReport
```

### Check Single Submission
```
POST /api/plagiarism/check/:submissionId?refresh=true
Returns: PlagiarismReport with isCached flag
?refresh=true forces recalculation
```

## Troubleshooting

### "No plagiarism reports found"
- You haven't run plagiarism checks yet
- Run plagiarism detection from teacher dashboard first
- Then run fix script

### Scores didn't change
- They were already correct
- No bug fixes were applied to calculation logic
- Check dry-run output - it will say "✅ No change (already correct)"

### "Error: Submission not found"
- Submission was deleted
- Check MongoDB Submission collection
- Run without `--assessment-id` flag to see full error logs

### Very high scores that seem wrong
- Might be duplicate submissions from same student
- Check FAISS index for data corruption
- Review `topMatches` array to see which students matched

## Verification Checklist

After running the fix script:

- [ ] Dry-run shows expected changes
- [ ] Live run completes without errors
- [ ] Fixed count matches expected submissions
- [ ] No "❌ Errors" in summary
- [ ] Teacher dashboard loads without errors
- [ ] ViewReport shows updated plagiarism %
- [ ] GET /api/plagiarism endpoints respond correctly

## When to Run This Script

Run this script when:

1. **You fixed plagiarism detection bugs** - recalculate all scores
2. **You got a new ZeroGPT API key** - enable AI detection on old submissions
3. **ZeroGPT was unavailable** - now available again, recalculate
4. **You changed score weighting** - e.g., (70% internal + 30% AI) instead of (60%/40%)
5. **FAISS index was rebuilt** - similarity matches might differ

## DO NOT Run

Don't run this if:

- ❌ Teachers are actively grading (wait for them to finish)
- ❌ Students are viewing reports (brief frontend delay)
- ❌ Backend is not running (will timeout)
- ❌ MongoDB is not accessible (will fail)

## Quick Reference

```bash
# See what would change
npm run dev  # Terminal 1: start backend
node scripts/fix-all-plagiarism-scores.js --dry-run

# Apply the changes
node scripts/fix-all-plagiarism-scores.js

# Fix just one assessment
node scripts/fix-all-plagiarism-scores.js --assessment-id YOUR_ASSESSMENT_ID

# Watch the logs
# Terminal 2: node scripts/fix-all-plagiarism-scores.js
```

## Example Output

```
🔧 Plagiarism Score Fix Tool
════════════════════════════════

✅ Connected to MongoDB

📊 Found 15 plagiarism report(s)
════════════════════════════════════════════════════════════════════════════════════════════════════════════════

📊 Test Assessment Title
📊 Submission Count: 15
════════════════════════════════════════════════════════════════════════════════════════════════════════════════

📋 [1/15] Ahmad Hassan → Current: internal=45%, AI=0%, overall=27%
   ✏️  FIXED → internal=45%, AI=32%, overall=40%

📋 [2/15] Fatima Ali → Current: internal=0%, AI=0%, overall=0%
   ✅ No change (already correct)

...

════════════════════════════════════════════════════════════════════════════════════════════════════════════════
SUMMARY
════════════════════════════════════════════════════════════════════════════════════════════════════════════════

✏️  LIVE MODE (changes applied)
✅ Fixed: 3
✅ Unchanged: 12
❌ Errors: 0
Total: 15
```

## Need Help?

If something goes wrong:

1. Check the error message in console
2. Verify MongoDB is running: `mongosh`
3. Verify backend is running: Check port 5000
4. Run with `--dry-run` to see detailed analysis
5. Check backend logs for `[PLAGIARISM]` messages
6. Contact support with error output and assessment ID

---

**Created**: 2026-05-13  
**Last Updated**: 2026-05-13  
**Compatibility**: InteliMark v2.0+
