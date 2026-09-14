# InteliMark 🎓

**An intelligent, AI-powered course management and assessment system for educators and students.**

InteliMark helps teachers design CLO-based assessments, automatically generate exam questions using AI, grade submissions online, and communicate with students in real time — all from a single role-based platform.

> Final Year Project (FYP) — 100% complete, all planned modules fully functional.

---

## Table of Contents

- [Overview](#overview)
- [Problem Statement](#problem-statement)
- [Proposed Solution](#proposed-solution)
- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Running the Project](#running-the-project)
- [Core Workflows](#core-workflows)
- [API Endpoints](#api-endpoints)
- [Future Enhancements](#future-enhancements)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)
- [Author](#author)

---

## Overview

InteliMark automates the full lifecycle of academic assessment:

1. Teachers upload a course syllabus (PDF) → CLOs (Course Learning Outcomes) are automatically extracted and mapped to Bloom's Taxonomy levels.
2. Teachers create assessments by selecting CLOs → the system uses a locally-hosted LLM (Ollama) to generate aligned questions.
3. Professional assessment and answer-key PDFs are generated automatically.
4. Students view, download, and submit assessments (files or text).
5. Teachers grade submissions and provide feedback — students receive real-time notifications via Firebase.
6. A Groq-powered LLaMA chatbot provides on-demand tutoring support to students.

The system uses a hybrid database approach: **MongoDB** for structured transactional data and **Firebase Firestore** for real-time notifications and messaging.

---

## Problem Statement

Grading in academic institutions — especially in large Computer Science and Data Science classes — remains largely manual, leading to slow turnaround times and inconsistent evaluation standards across essays, short answers, coding exercises, and diagrams. Existing tools tend to address only a narrow slice of the problem, typically plagiarism detection or a single question format, without offering full-spectrum grading or domain-specific feedback. They also lack real-time performance tracking, GPA goal-setting, and mistake-based learning recommendations, and provide no built-in AI assistance for students needing quick help with grading, deadlines, or coursework. The result: teachers are overloaded with repetitive evaluation work, and students receive generic feedback with little direction on how to actually improve — a gap that becomes even more pronounced in hybrid and online learning environments.

## Proposed Solution

InteliMark is a unified, AI-powered assessment platform that automates grading across MCQs, short answers, essays, code, and graphical submissions using NLP, image recognition, and machine learning — while still letting teachers manually review or override results when needed. Beyond grading, it gives students a performance dashboard with progress tracking and GPA goal-setting, a mistake-tracking module with targeted improvement recommendations, built-in plagiarism detection (avoiding reliance on third-party tools), and an AI chatbot for instant academic support. Teachers can auto-generate quizzes from CLOs and difficulty levels, and admins retain full control over roles, enrollments, and platform security. By consolidating these normally-separate tools into one role-based system, InteliMark aims to cut administrative workload, speed up feedback, and support a more consistent, data-driven learning experience.

---

## Key Features

### 👩‍🏫 Teacher Module
- Course creation and management
- Syllabus upload with automatic CLO extraction (Bloom Taxonomy mapping)
- AI-powered question generation (Ollama, local LLM)
- Draft / Publish Immediately / Schedule for Later assessment workflow
- Auto-generated assessment PDFs and answer-key PDFs
- Online grading interface with feedback
- Advanced analytics dashboards (class-wide trends, mistake patterns, performance breakdowns)
- Predictive course planning support

### 🎓 Student Module
- View assigned assessments and deadlines
- Download assessment PDFs
- Submit solutions (files or text, with late-submission policy enforcement)
- View grades and feedback in real time
- AI chatbot tutor (Groq / LLaMA 3.1 8B) with conversation history
- Post-submission feedback (star ratings)

### 🛡️ Academic Integrity
- Built-in plagiarism detection for text and graphical submissions (no third-party tool required)

### 📱 Mobile & Integrations
- Mobile app version for students and teachers
- LMS integrations (Canvas, Blackboard, Moodle)

### 🛠️ Admin Module
- User management (create / edit / delete)
- Course oversight
- Security/audit logs
- System-wide notification management

### ⚡ Real-Time & Security
- Firebase Firestore listeners for instant notification updates (no custom WebSocket server needed)
- Role-based access control on all routes
- File upload validation (MIME type, size limits, path-traversal protection)
- Non-blocking, async notification pipeline

---

## System Architecture

InteliMark follows a **3-layer architecture**, chosen deliberately for FYP scope — clean separation of concerns, simple to test, and deployable as a single unit.

```
┌─────────────────────────────────────────────┐
│  Presentation Layer (Frontend)               │
│  React + TypeScript + Vite + Tailwind CSS    │
│  Role-based dashboards: Admin / Teacher /     │
│  Student                                      │
└───────────────────┬───────────────────────────┘
                     │ REST API
┌───────────────────▼───────────────────────────┐
│  Application Layer (Backend)                  │
│  Node.js + Express (modular controllers)      │
│  Multer (uploads) · PDFKit (generation) ·     │
│  pdf-parse (extraction) · node-cron (scheduler)│
└───────────────────┬───────────────────────────┘
                     │
┌───────────────────▼───────────────────────────┐
│  Data Layer                                    │
│  MongoDB (courses, CLOs, assessments,          │
│  submissions) + Firebase Firestore (real-time  │
│  notifications, feedback) + Local filesystem   │
│  (PDFs, uploads)                               │
└─────────────────────────────────────────────────┘
```

If this scaled beyond university-level usage (100–1000 users), the natural next step would be moving toward microservices — but for FYP scope, the monolithic layered design keeps things maintainable and easy to reason about.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend Framework | React 18.3.1 |
| Build Tool | Vite 7.2.4 |
| Language | TypeScript |
| Styling | Tailwind CSS 3.4.17 + shadcn/ui |
| Routing | React Router 6.30 |
| Forms | React Hook Form 7.61 |
| Charts | Recharts 2.15 |
| Animation | Framer Motion |
| Backend Framework | Express 5.2.1 |
| Runtime | Node.js (LTS) |
| File Uploads | Multer 2.0.2 |
| PDF Parsing | pdf-parse 1.1.4 |
| PDF Generation | PDFKit 0.17.2 |
| Scheduling | node-cron |
| Primary Database | MongoDB 9.1.6 + Mongoose ODM |
| Real-time Database | Firebase Firestore |
| Authentication | Firebase Auth + Admin SDK |
| Local LLM (question generation) | Ollama (phi3:mini) |
| Cloud LLM (chatbot) | Groq API (llama-3.1-8b-instant) |
| Package Manager | Bun |

---

## Project Structure

```
InteliMark/
├── backend/
│   ├── controllers/       # courseController, assessmentController, submissionController
│   ├── routes/             # /api/courses, /api/assessments, /api/submissions
│   ├── utils/              # pdfGenerator.js, assessmentScheduler.js, bloomTaxonomyUtils.js
│   ├── uploads/            # student submission files
│   ├── pdfs/               # generated assessment & answer-key PDFs
│   ├── server.js
│   └── package.json
├── src/                     # React frontend
│   ├── pages/               # Admin/Teacher/Student dashboards
│   ├── components/
│   ├── context/             # Auth + Notification context
│   ├── api/                 # chatAPI.ts, etc.
│   └── firebase.ts
├── .env.example
├── package.json
└── README.md
```
> Adjust this tree to match your actual folder layout before pushing — this is based on the described architecture.

---

## Getting Started

### Prerequisites

Make sure you have the following installed:

- [Node.js (LTS)](https://nodejs.org/)
- [Bun](https://bun.sh/) (or npm/yarn as an alternative)
- [MongoDB](https://www.mongodb.com/try/download/community) (local instance or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster)
- [Ollama](https://ollama.com/) (for local AI question generation)
- A [Firebase](https://firebase.google.com/) project (Firestore + Auth enabled)
- A [Groq API key](https://console.groq.com/) (for the student chatbot)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/InteliMark.git
cd InteliMark

# 2. Install backend dependencies
cd backend
bun install        # or: npm install

# 3. Install frontend dependencies
cd ..
bun install        # or: npm install
```

### Environment Variables

Create a `.env` file in the `backend/` folder (and one in the root for frontend variables if needed). Example:

```env
# backend/.env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/intelimark
OLLAMA_API_URL=http://localhost:11434
GROQ_API_KEY=your_groq_api_key_here
FIREBASE_PROJECT_ID=your_firebase_project_id
```

Also place your Firebase `serviceAccountKey.json` in the backend folder (never commit this file — see `.gitignore` notes below).

### Running the Project

```bash
# Terminal 1 — Start Ollama (local LLM for question generation)
ollama serve
ollama pull phi3:mini

# Terminal 2 — Start the backend
cd backend
npm run start        # or: bun run start

# Terminal 3 — Start the frontend
npm run dev           # or: bun run dev
```

The app will be available at `http://localhost:5173` (frontend) with the backend API running on `http://localhost:5000`.

Health check: `GET /health`

---

## Core Workflows

1. **Syllabus Upload → CLO Extraction** — Teacher uploads a PDF syllabus; the backend extracts text (`pdf-parse`), parses CLOs via NLP pattern matching, and maps each to a Bloom Taxonomy level.
2. **Assessment Creation & Publishing** — Teacher selects CLOs; Ollama generates aligned MCQ/short-answer questions; PDFKit produces a formatted assessment PDF and a separate answer-key PDF.
3. **Student Submission** — Students download the assessment, submit files or text before the deadline (late-submission policy enforced); a Firebase notification alerts the teacher instantly.
4. **Grading & Feedback** — Teacher grades and leaves feedback; the student receives a real-time Firebase notification with their result.
5. **Scheduled Auto-Publish** — A `node-cron` job checks every minute for assessments scheduled to go live and publishes them automatically.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/courses/upload-syllabus` | Upload syllabus PDF and extract CLOs |
| `POST /api/assessments/*` | Create, publish, schedule, and grade assessments |
| `POST /api/submissions/submit` | Student submission of files/text |
| `PATCH /api/submissions/:id/grade` | Teacher grades a submission |
| `GET /api/assessments/pdf/:filename` | Securely serve generated PDFs |
| `GET /health` | Server health check |
| `GET /api` | Server info |

---

## Future Enhancements

With all originally planned features complete, potential next steps beyond current scope include:
- Event-driven microservices architecture (for institution-scale deployment)
- Data warehouse for large-scale, cross-institution analytics
- Advanced multi-level approval workflows

---

## Known Limitations

- CLO extraction assumes a structured (non-scanned) PDF syllabus — OCR is not yet implemented.
- No automatic fallback question bank if Ollama generation fails after retries (currently reverts the assessment to draft).
- File storage is local filesystem only — not yet migrated to cloud storage (Firebase Storage / AWS S3).

---

## Contributing

This is a Final Year Project, but suggestions and pull requests are welcome:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes (`git commit -m "Add your feature"`)
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Pull Request

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## Author

**Fatima Khalil**
Bachelor's in Data Science — COMSATS University Islamabad
[LinkedIn](https://www.linkedin.com/in/fatima-khalil-679572277) · [GitHub](https://github.com/Fatimaawan19)
