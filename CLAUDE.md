# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

## Project Overview

**Flow** is an intelligent work-session transition agent. It watches a user-defined daily schedule, tracks active focus sessions, fires warnings before block boundaries, and uses an LLM to generate a context-preservation summary when switching tasks — so the user can pick up exactly where they left off.

Stack: Python 3.14 + FastAPI backend, vanilla HTML/CSS/JS frontend (no build step), PostgreSQL 16 (Docker), OpenAI `gpt-4.1-mini`.

---

## Directory Structure

```
.
├── backend/
│   ├── main.py           # FastAPI app — all routes defined here
│   ├── llm_client.py     # OpenAI wrapper — transition summaries only
│   ├── .env              # Local secrets (never commit)
│   └── DB/
│       ├── db.py         # SQLAlchemy engine + SessionLocal factory
│       ├── models.py     # ORM model: SessionContext
│       └── init_db.py    # One-time DB table creation script
├── frontend/
│   ├── index.html        # All three screens (Setup, Dashboard, Transition)
│   ├── script.js         # All client-side logic — schedule, session, timer, API calls
│   └── style.css         # Meridian design system styles
├── docker-compose.yml    # PostgreSQL 16 service
└── .gitignore
```

Legacy files (not connected to the project, safe to delete):
- `first-backend-product.py`
- `numbers.java`

---

## Running the Backend

```bash
# 1. Start Postgres
docker-compose up -d

# 2. Activate venv (from project root)
source .venv/bin/activate

# 3. Ensure backend/.env exists with required variables (see below)

# 4. Start the server
cd backend
uvicorn main:app --reload
# Server + frontend served at http://127.0.0.1:8000
```

No separate frontend server needed — `GET /` serves `index.html` via `FileResponse`.

---

## Environment Variables

Place in `backend/.env` (loaded via `python-dotenv`):

```env
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+psycopg://miniagent:miniagent_password@localhost:5432/miniagent_db
```

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI API key used by `llm_client.py` |
| `DATABASE_URL` | Yes | PostgreSQL connection string (psycopg3 driver) |

If `DATABASE_URL` is missing, `db.py` raises `RuntimeError` at import time. If `OPENAI_API_KEY` is missing, `llm_client.py` returns a fallback string instead of calling the API.

---

## Database Setup

```bash
# Start Postgres via Docker
docker-compose up -d

# Create tables (run once)
cd backend
python -m DB.init_db
```

`init_db.py` calls `Base.metadata.create_all()` — safe to re-run (idempotent).

---

## Database Schema

### `session_contexts` table

Stores one row per completed work session.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | auto-increment |
| `task_name` | TEXT | name of the task worked on |
| `summary` | TEXT | LLM-generated re-entry summary |
| `notes` | TEXT | user's in-session notes (may be empty) |
| `duration_minutes` | INTEGER | session length |
| `created_at` | TIMESTAMPTZ | server default `now()` |

---

## API Endpoints

All endpoints are in `backend/main.py`. CORS is open (`allow_origins=["*"]`).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serves `frontend/index.html` |
| `GET` | `/health` | Returns `{"status": "ok"}` |
| `POST` | `/transition` | Generates AI context summary; persists session to DB |
| `GET` | `/context?task=<name>` | Returns most recent `SessionContext` for a task |
| `GET` | `/history?limit=50` | Returns recent sessions ordered by `created_at DESC` |
| `GET` | `/weekly` | Aggregates past 7 days of sessions grouped by day and task |

### `POST /transition`

**Request:**
```json
{
  "current_task": "Startup work",
  "duration_minutes": 47,
  "next_task": "Violin / Piano",
  "notes": "Finished auth flow, need to wire up the dashboard next"
}
```

**Response:**
```json
{ "summary": "You wrapped up 47 minutes deep in the auth flow..." }
```

---

## Backend Modules

### `main.py`
- Loads `.env` before any other imports
- Mounts `frontend/` as `/static` (StaticFiles)
- All route handlers inline — no separate controller layer

### `llm_client.py`
- `generate_transition_summary(current_task, duration_minutes, next_task, notes)` — crafts a prompt and returns a 2-3 sentence paragraph in second person; includes user notes if provided
- Uses the OpenAI **Responses API** (`client.responses.create` / `resp.output_text`), not Chat Completions

### `DB/db.py`
- SQLAlchemy engine with `pool_pre_ping=True`, `pool_size=5`, `max_overflow=15`
- `SessionLocal` — `sessionmaker` with `autoflush=False`, `autocommit=False`, `expire_on_commit=False`
- `Base` — `declarative_base()` shared by all models

### `DB/models.py`
- `SessionContext` — maps to `session_contexts` table, uses SQLAlchemy 2.x `Mapped`/`mapped_column` syntax

---

## Frontend Architecture

Single HTML file with three full-screen states. No framework, no build step.

### Screens

| Screen ID | Purpose |
|---|---|
| `setup-screen` | User defines their weekly schedule (time slots + labels) |
| `dashboard-screen` | Main focus view — current task, timer ring, next-up panel, session log |
| `transition-screen` | Shown at block boundary — displays AI context summary before switching |

### Key JS State Variables (`script.js`)

| Variable | Type | Description |
|---|---|---|
| `schedule` | `Array<{time, label}>` | Sorted list of time blocks for the day |
| `sessionActive` | boolean | Whether a focus session is currently running |
| `sessionStart` | `Date\|null` | Timestamp when the current session began |
| `currentTask` | string | Name of the in-progress task |
| `warningFired` | boolean | True once the 15-min warning has triggered |
| `transitionFired` | boolean | True once the auto-transition has triggered |
| `sessionLog` | `Array<{task, duration}>` | In-memory log of this page-session's completed tasks |

### Schedule Persistence
Saved to `localStorage` under `flow_schedule` (JSON array of `{time, label}`). Loaded on page open.

### Session Lifecycle

1. User types a task and clicks "Start session" (or `Cmd/Ctrl+Enter`)
2. `startSession(task)` sets state, calls `fetchReentryContext(task)` to show prior AI summary
3. Every second: `tickClock()` → `updateSessionTimer()`, `updateNextUp()`, `checkTransitionWarning()`
4. At T-15 min: warning chime + browser notification, timer turns amber
5. At T-0: `triggerTransition()` fires → shows transition screen, calls `POST /transition`
6. User confirms → `endSession(true)` logs to session panel, pre-fills next task in input

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Enter` | Toggle session start/end (dashboard only) |
| `Escape` | Dismiss transition screen or close weekly modal |

### Audio (Web Audio API)
`playChime(type)` synthesizes tones using `OscillatorNode`:
- `'warn'` — two-note chord at 440 Hz + 554 Hz
- `'transition'` — three-note chord at 528 Hz + 660 Hz + 784 Hz

---

## Dependencies

No `requirements.txt` — installed directly into `.venv`.

```bash
pip install fastapi uvicorn pydantic openai python-dotenv sqlalchemy psycopg[binary]
```

| Package | Purpose |
|---|---|
| `fastapi` | Web framework |
| `uvicorn` | ASGI server |
| `pydantic` | Request body validation |
| `openai` | OpenAI Responses API client |
| `python-dotenv` | `.env` file loading |
| `sqlalchemy` | ORM + connection pooling |
| `psycopg` (psycopg3) | PostgreSQL driver (`postgresql+psycopg://`) |

---

## Common Gotchas

- **Responses API**: `llm_client.py` uses `client.responses.create(...)` and reads `resp.output_text`. This is the OpenAI Responses API, not `client.chat.completions.create(...)`. Do not refactor to Chat Completions without updating response parsing.
- **DB driver**: `DATABASE_URL` must use `postgresql+psycopg://` (psycopg3). Do not use `psycopg2`.
- **CORS**: `allow_credentials=False` is intentional with `allow_origins=["*"]` — browsers block credentialed requests to wildcard origins.
- **Schedule is localStorage**: The JS `schedule` array is rebuilt from localStorage on each page load. Clearing localStorage resets the schedule to defaults.
- **Docker password**: The default `miniagent_password` in `docker-compose.yml` is fine for local dev. Change it for any non-local deployment.
