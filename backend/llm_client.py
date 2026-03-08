import os
from openai import OpenAI

_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return None
        _client = OpenAI(api_key=api_key)
    return _client


def _sanitize(text: str) -> str:
    """Strip angle brackets so user input can't break XML delimiters in prompts."""
    return text.replace("<", "").replace(">", "")


def generate_transition_summary(current_task: str, duration_minutes: int, next_task: str, notes: str = "") -> str:
    client = _get_client()
    if not client:
        return f"Worked on '{current_task}' for {duration_minutes} min. Pick up here when you return."

    current_task = _sanitize(current_task)
    next_task    = _sanitize(next_task)
    notes        = _sanitize(notes)

    notes_section = (
        f"\nThe user jotted these notes during the session:\n<notes>{notes}</notes>\n"
        if notes else ""
    )

    prompt = (
        f"The user just finished a {duration_minutes}-minute work session.\n"
        f"Current task: <task>{current_task}</task>\n"
        f"Next task: <next_task>{next_task}</next_task>"
        f"{notes_section}\n"
        "Write a single short paragraph (2-3 sentences) that:\n"
        "1. References their specific notes if provided, otherwise infers what they were working on\n"
        "2. Gives a concrete re-entry point so they can pick up exactly where they left off\n"
        "3. Is encouraging but brief\n"
        "Write in second person. Do not use bullet points."
    )

    resp = client.responses.create(model="gpt-4.1-mini", input=prompt)
    return resp.output_text.strip()
