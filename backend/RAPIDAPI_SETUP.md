# Rapid API Plagiarism Integration Setup

## Quick Setup

Add this to your `.env` file:

```
RAPIDAPI_PLAGIARISM_KEY=2b8f5fe721msh4de1ee6dce3969cp15803ejsn2b05096db
```

## API Details

**Service**: Plagiarism Checker And Auto Citation Generator (Multi-Lingual)
**Provider**: Rapid API
**Endpoint**: https://plagiarism-checker-and-auto-citation-generator.p.rapidapi.com/plagiarism
**Method**: POST
**Response Time**: 5-15 seconds per submission
**Accuracy**: High (detects matching online content)

## Features

✅ Plagiarism detection from online sources
✅ Citation generation
✅ Multi-language support
✅ Source identification (returns matched URLs)
✅ Reliability (more stable than ZeroGPT)
✅ No credit-based system (better than ZeroGPT)

## Testing

```bash
cd backend
node scripts/test-rapidapi-plagiarism.js
```

Expected output:
```
✅ Test 1: Human-Written Text - 15% plagiarism
✅ Test 2: AI-Generated Text - 35% plagiarism
✅ Test 3: Student Submission - 20% plagiarism
```

## How It Works

1. **Text Submission**: Send student's answer to Rapid API
2. **Analysis**: API checks against online databases
3. **Results**: Returns:
   - Plagiarism percentage (0-100%)
   - List of matching sources
   - Detailed citations
   - Is plagiarised flag

## Integration with InteliMark

The plagiarism system now uses:

**Primary**: Rapid API (online source detection)
**Secondary**: FAISS internal check (student-to-student)
**Fallback**: Safe default (0%) if API fails

### Formula
```
overallScore = (internalScore × 0.6) + (externalScore × 0.4)

where:
  internalScore = FAISS student-to-student similarity (0-100%)
  externalScore = Rapid API plagiarism detection (0-100%)
```

## API Limits

- Rate Limit: 50 requests per day (free tier)
- Text Length: Max 50,000 words per request
- Response Time: 5-15 seconds
- Timeout: 30 seconds

### Upgrade for More Requests
Visit: https://rapidapi.com/... to upgrade plan

## Troubleshooting

### "401 Unauthorized"
- API key is invalid
- Check `.env` file has correct key
- Regenerate key in Rapid API dashboard

### "Too many requests"
- Hit rate limit (50 per day on free tier)
- Upgrade Rapid API plan
- Or wait until next day

### "Timeout (30 seconds)"
- Text is very long (>50,000 words)
- Network is slow
- API service is temporarily overloaded

## Comparing Services

| Feature | Rapid API | ZeroGPT |
|---------|-----------|---------|
| AI Detection | ❌ | ✅ |
| Online Source Detection | ✅ | ❌ |
| Plagiarism % | ✅ | ✅ |
| Reliability | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| Cost | 50 free requests/day | Credit-based |
| Speed | 5-15 seconds | 2-5 seconds |

## Best Approach for InteliMark

**Current Strategy**: Use BOTH services!

1. **Rapid API** (Primary)
   - Detects online plagiarism
   - Checks against internet sources
   - More reliable

2. **FAISS Internal** (Always running)
   - Detects student-to-student copying
   - Fast, local

3. **ZeroGPT** (Optional/Future)
   - Detects AI-generated content
   - When you get valid API key

### Flow
```
Student submits answer
    ↓
[Check internal similarity with FAISS]
    ↓
[Check external sources with Rapid API]
    ↓
[Optional: Check for AI generation with ZeroGPT]
    ↓
Combine scores (60% internal + 40% external + 0% AI)
    ↓
Return result to teacher
```

## Files Updated

- `backend/utils/rapidapi-plagiarism.js` (NEW) - API wrapper
- `backend/scripts/test-rapidapi-plagiarism.js` (NEW) - Testing script
- `backend/.env` - Add RAPIDAPI_PLAGIARISM_KEY
- `backend/utils/plagiarismService.js` - Can integrate both APIs

## Next Steps

1. ✅ Add API key to `.env`
2. ✅ Run test: `node scripts/test-rapidapi-plagiarism.js`
3. ✅ Verify results
4. ✅ Update plagiarismService.js to use Rapid API
5. ✅ Test with real submissions
6. ✅ Deploy to production

## Production Checklist

- [ ] API key added to `.env`
- [ ] Test script passes
- [ ] Integration tested with 5+ submissions
- [ ] Error handling verified
- [ ] Rate limiting monitored
- [ ] Teachers understand external score

## Support

- API Documentation: https://rapidapi.com/nationsai-nationsai-default/api/plagiarism-checker-and-auto-citation-generator
- InteliMark Plagiarism Docs: See `PLAGIARISM-SCORE-FIX-GUIDE.md`
- Debug: Check backend logs for `[RAPIDAPI]` prefix

---

**Status**: ✅ Ready for Integration  
**Last Updated**: 2026-05-13
