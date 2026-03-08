# Flow

An intelligent work-session transition agent. Flow watches your daily schedule, tracks active focus sessions, fires warnings before block boundaries, and uses an LLM to generate a context-preservation summary when switching tasks — so you can pick up exactly where you left off.

## Stack

- **Backend**: Python 3.14 + FastAPI + Uvicorn
- **Database**: PostgreSQL 16 (via Docker)
- **LLM**: OpenAI `gpt-4.1-mini` (Responses API)
- **Frontend**: Vanilla HTML/CSS/JS, no build step

## Project Structure

```
.
├── backend/
│   ├── main.py           # FastAPI app — all routes
│   ├── llm_client.py     # OpenAI wrapper — transition summaries
│   └── DB/
│       ├── db.py         # SQLAlchemy engine + session factory
│       ├── models.py     # SessionContext ORM model
│       └── init_db.py    # One-time table creation script
├── frontend/
│   ├── index.html        # Setup, Dashboard, and Transition screens
│   ├── script.js         # All client-side logic
│   └── style.css         # Meridian design system styles
├── docker-compose.yml    # PostgreSQL service
└── .gitignore
```

## Prerequisites

- Python 3.14
- Docker (for PostgreSQL)
- An OpenAI API key

## Setup

### 1. Start the database

```bash
docker-compose up -d
```

### 2. Create `backend/.env`

```env
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+psycopg://miniagent:miniagent_password@localhost:5432/miniagent_db
```

> For production, replace the default password in both `.env` and `docker-compose.yml`.

### 3. Create a virtual environment and install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn pydantic openai python-dotenv sqlalchemy psycopg[binary]
```

### 4. Create database tables

```bash
source .venv/bin/activate
cd backend
python -m DB.init_db
```

### 5. Start the server

```bash
cd backend
uvicorn main:app --reload
```

The app runs at `http://127.0.0.1:8000`. Open it in your browser — no separate frontend server needed.

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serves the frontend |
| `GET` | `/health` | Liveness check — returns `{"status": "ok"}` |
| `POST` | `/transition` | Generates an AI context summary when switching tasks; persists session to DB |
| `GET` | `/context?task=<name>` | Fetches the most recent session summary for a given task |
| `GET` | `/history?limit=50` | Returns recent session records (for the session log panel) |
| `GET` | `/weekly` | Aggregates sessions from the past 7 days, grouped by day and task |

### `POST /transition`

```json
{
  "current_task": "Startup work",
  "duration_minutes": 47,
  "next_task": "Violin / Piano",
  "notes": "Finished auth flow, need to wire up the dashboard next"
}
```

Response:

```json
{ "summary": "You wrapped up 47 minutes deep in the auth flow..." }
```
