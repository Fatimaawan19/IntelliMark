# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

InteliMark is an AI-powered educational assessment platform. Teachers create courses, generate quiz questions via LLM, and grade student submissions automatically using a RAG (Retrieval-Augmented Generation) pipeline backed by FAISS and local/cloud LLMs.

## Commands

### Frontend (React/Vite — port 8080)
```bash
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run build:dev    # Development build
npm run lint         # ESLint
npm run preview      # Preview production build
```

### Backend (Node.js/Express — port 5000)
```bash
# From repo root
npm run start        # Start backend (sets OLLAMA_QGEN_TIMEOUT_MS=300000)

# From backend/
npm run dev          # Same as above
```

Both servers must run simultaneously in separate terminals during development. The Vite proxy forwards `/api/*` requests to `http://localhost:5000`.

### Python RAG Pipeline
```bash
cd backend/rag_marking

# Setup (one-time — PyTorch CPU must be installed first)
python -m venv .venv-1
.\.venv-1\Scripts\activate
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.2.0
pip install -r requirements.txt

# Run ingestion
python ingest_materials_to_faiss.py                    # All course materials
python ingest_materials_to_faiss.py --course-id <ID>   # Single course
python ingest_materials_to_faiss.py --limit 5           # Test run
python ingest_submissions_to_faiss.py                  # Student submissions
python ingest_assessment_reference_to_faiss.py         # Reference materials
```

## Architecture

### Stack
- **Frontend**: React 18 + TypeScript, Vite, TailwindCSS, shadcn/ui, React Query, Firebase (auth/Firestore/Storage)
- **Backend**: Node.js + Express 5, MongoDB/Mongoose, Firebase Admin SDK, Multer (uploads), pdf-lib/pdfkit (PDF generation)
- **AI/LLM**: Ollama (phi3:mini for question generation, qwen2.5:7b for grading), Groq API (llama-3.1-8b-instant as grading fallback)
- **Python RAG**: sentence-transformers (all-MiniLM-L6-v2), FAISS, PyMuPDF, pdfplumber, Tesseract OCR (optional)

### Request Flow
```
Browser (React) → Vite proxy → Express API → Controllers → Services/Utils
                                                          ↓
                                              MongoDB (primary data)
                                              Firebase (auth, real-time, push)
                                              FAISS (semantic search vectors)
                                              Python scripts (text extraction + embeddings)
                                              Ollama / Groq API (LLM grading)
```

### AutoMark Pipeline (key feature)
When grading a student submission, [backend/utils/automarkLlmService.js](backend/utils/automarkLlmService.js) orchestrates:
1. Extract text from uploaded PDF/DOCX via Python scripts (OCR fallback via Tesseract)
2. Retrieve top-K semantic chunks from FAISS across four indexes:
   - Student's own past answers (`faiss_submissions_index/`)
   - Assessment reference materials (`faiss_assessment_reference_index/`)
   - Course learning materials (`faiss_index/`)
   - Course CLOs
3. Send question + context + rubric to Groq (primary) or Ollama (fallback)
4. Store per-question scores and feedback in MongoDB + Firebase

Python is invoked as child processes from Node via `PYTHON_BIN` env var pointing to the venv interpreter.

### User Roles
- **Student**: Submit assessments, view grades/feedback, CLO performance analytics, tutoring chatbot
- **Teacher**: Create courses/assessments, upload syllabi, auto-generate questions (Bloom's taxonomy levels), review submissions, run AutoMark
- **Admin (Owner)**: User management, system monitoring, database management, security audit logs

### Key Backend Services
| File | Purpose |
|------|---------|
| [backend/utils/ingestionService.js](backend/utils/ingestionService.js) | Orchestrates RAG ingestion (extract → chunk → embed → index) |
| [backend/utils/automarkLlmService.js](backend/utils/automarkLlmService.js) | LLM grading with RAG context |
| [backend/utils/courseMaterialRetrievalService.js](backend/utils/courseMaterialRetrievalService.js) | FAISS semantic search for course materials |
| [backend/utils/submissionRetrievalService.js](backend/utils/submissionRetrievalService.js) | FAISS semantic search for prior submissions |
| [backend/utils/notificationService.js](backend/utils/notificationService.js) | Firebase push notifications |
| [backend/utils/ollama.js](backend/utils/ollama.js) | Ollama LLM interface |
| [backend/utils/ocrService.js](backend/utils/ocrService.js) | Tesseract OCR integration |
| [backend/utils/cloPerformanceService.js](backend/utils/cloPerformanceService.js) | CLO analytics calculations |

### FAISS Index Locations
FAISS vector stores persist on disk across restarts:
- `backend/rag_marking/faiss_index/` — course materials
- `backend/rag_marking/faiss_submissions_index/` — student submissions
- `backend/rag_marking/faiss_assessment_reference_index/` — reference answers

## Environment Variables

**Frontend** (`.env` in root):
```
VITE_GROQ_API_KEY=
VITE_YOUTUBE_API_KEY=
VITE_GOOGLE_CSE_KEY=
VITE_GOOGLE_CSE_ID=
```

**Backend** (`.env` in `backend/`):
```
# MongoDB
MONGO_URI=mongodb+srv://...

# Ollama (local LLM)
OLLAMA_PATH=C:\...\ollama.exe
OLLAMA_API_URL=http://127.0.0.1:11434
OLLAMA_MODEL=phi3:mini
AUTOMARK_OLLAMA_MODEL=qwen2.5:7b
OLLAMA_QGEN_TIMEOUT_MS=300000
AUTOMARK_OLLAMA_TIMEOUT_MS=600000

# Groq (cloud LLM fallback for grading)
GROQ_API_AUTOMARK__KEY=gsk_...
GROQ_AUTOMARK_MODEL=llama-3.1-8b-instant

# Python RAG
PYTHON_BIN=.venv-1/Scripts/python.exe
RAG_ENABLE_OCR=true
RAG_AUTO_EXTRACT=true
RAG_AUTO_INGEST=true
EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
CUDA_VISIBLE_DEVICES=-1         # Force CPU-only on Windows

# Email OTP
OTP_EMAIL_USER=
OTP_EMAIL_PASS=

PORT=5000
```

## Important Constraints

- **CPU-only PyTorch**: The Python pipeline deliberately uses CPU-only PyTorch (`CUDA_VISIBLE_DEVICES=-1`) to avoid DLL/CUDA issues on Windows. Never switch to GPU builds without testing.
- **LLM timeouts**: Question generation has a 300s timeout; AutoMark grading has 600s. These are intentionally long to accommodate local LLM latency.
- **Groq → Ollama fallback**: AutoMark tries Groq first; if that fails, falls back to local Ollama. Both must be configured for reliable grading.
- **Python child processes**: Node spawns Python scripts synchronously via `child_process`. The `PYTHON_BIN` env var must point to the correct venv interpreter.
