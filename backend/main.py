from dotenv import load_dotenv
load_dotenv()

from llm_client import generate_transition_summary
from DB.models import SessionContext
from DB.db import SessionLocal

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

class TransitionRequest(BaseModel):
    current_task: str
    duration_minutes: int
    next_task: str
    notes: str = ""

frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=frontend_path), name="static")

@app.get("/")
def root():
    return FileResponse(os.path.join(frontend_path, "index.html"))

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/transition")
def transition(req: TransitionRequest):
    summary = generate_transition_summary(req.current_task, req.duration_minutes, req.next_task, req.notes)

    db = SessionLocal()
    try:
        db.add(SessionContext(
            task_name=req.current_task,
            summary=summary,
            notes=req.notes,
            duration_minutes=req.duration_minutes,
        ))
        db.commit()
    finally:
        db.close()

    return {"summary": summary}


@app.get("/context")
def get_context(task: str):
    db = SessionLocal()
    try:
        row = (
            db.query(SessionContext)
            .filter(SessionContext.task_name == task)
            .order_by(SessionContext.created_at.desc())
            .first()
        )
        if not row:
            return {"context": None}
        return {
            "context": {
                "summary": row.summary,
                "duration_minutes": row.duration_minutes,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
        }
    finally:
        db.close()


@app.get("/history")
def get_history(limit: int = 500):
    db = SessionLocal()
    try:
        rows = (
            db.query(SessionContext)
            .order_by(SessionContext.created_at.desc())
            .limit(limit)
            .all()
        )
        return {"sessions": [
            {
                "task_name": r.task_name,
                "duration_minutes": r.duration_minutes,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]}
    finally:
        db.close()


@app.get("/weekly")
def get_weekly():
    from datetime import datetime, timedelta, timezone
    from collections import defaultdict
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        since = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=now.weekday())
        rows = (
            db.query(SessionContext)
            .filter(SessionContext.created_at >= since)
            .order_by(SessionContext.created_at.desc())
            .all()
        )
        days = defaultdict(lambda: defaultdict(int))
        for r in rows:
            day = r.created_at.strftime('%Y-%m-%d')
            days[day][r.task_name] += r.duration_minutes

        result = []
        for day in sorted(days.keys(), reverse=True):
            tasks = [
                {"task": t, "minutes": m}
                for t, m in sorted(days[day].items(), key=lambda x: -x[1])
            ]
            result.append({
                "date": day,
                "total_minutes": sum(t["minutes"] for t in tasks),
                "tasks": tasks,
            })
        return {"days": result}
    finally:
        db.close()
