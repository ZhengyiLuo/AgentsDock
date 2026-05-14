#!/usr/bin/env python3
# Copyright (c) 2026 Zhengyi Luo
"""Zenithbot Agent Server.

FastAPI service for a native Mac frontend. The server owns agent execution on
zen-nv and streams normalized events from Claude Code / Codex CLI runs.

This intentionally mirrors the newest Slack bot's runner shape while removing
Slack-specific transport, formatting, and upload constraints.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import re
import shutil
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
import uvicorn

logger = logging.getLogger("zenithbot-agent")

BACKEND_CLAUDE = "claude"
BACKEND_CODEX = "codex"
VALID_BACKENDS = {BACKEND_CLAUDE, BACKEND_CODEX}

STATE_DIR = Path(os.environ.get("ZENITHBOT_AGENT_DIR", Path.home() / ".zenithbot-agent"))
SESSIONS_FILE = STATE_DIR / "sessions.json"
JOBS_FILE = STATE_DIR / "jobs.json"
FILES_ROOT = STATE_DIR / "files"
CLAUDE_PROJECTS_ROOT = Path(os.environ.get("CLAUDE_PROJECTS_ROOT", Path.home() / ".claude" / "projects"))
CODEX_SESSIONS_ROOT = Path(os.environ.get("CODEX_SESSIONS_ROOT", Path.home() / ".codex" / "sessions"))
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
DEFAULT_CWD = os.environ.get("ZENITHBOT_AGENT_CWD", str(Path.home()))
DEFAULT_BACKEND = os.environ.get("ZENITHBOT_BACKEND", BACKEND_CLAUDE).lower()
if DEFAULT_BACKEND not in VALID_BACKENDS:
    DEFAULT_BACKEND = BACKEND_CLAUDE

REQUEST_TIMEOUT_SECONDS = int(os.environ.get("ZENITHBOT_REQUEST_TIMEOUT_SECONDS", "86400"))
CODEX_APP_SERVER_TIMEOUT_SECONDS = int(os.environ.get("ZENITHBOT_CODEX_APP_SERVER_TIMEOUT_SECONDS", "30"))
IDLE_WARN_SECONDS = int(os.environ.get("ZENITHBOT_IDLE_WARN_SECONDS", "1800"))
IDLE_KILL_SECONDS = int(os.environ.get("ZENITHBOT_IDLE_KILL_SECONDS", "21600"))
MAX_UPLOAD_BYTES = int(os.environ.get("ZENITHBOT_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024 * 1024)))
MAX_IMPORT_MESSAGES = int(os.environ.get("ZENITHBOT_HISTORY_IMPORT_LIMIT", "400"))
MAX_IMPORTED_TEXT_CHARS = int(os.environ.get("ZENITHBOT_HISTORY_IMPORT_TEXT_CHARS", "12000"))
MAX_FORK_MEMORY_CHARS = int(os.environ.get("ZENITHBOT_FORK_MEMORY_CHARS", "24000"))
MAX_FORK_MEMORY_ITEM_CHARS = int(os.environ.get("ZENITHBOT_FORK_MEMORY_ITEM_CHARS", "1800"))
DEFAULT_SESSION_EVENT_LIMIT = int(os.environ.get("ZENITHBOT_SESSION_EVENT_LIMIT", "100"))
MAX_EVENT_RESPONSE_LIMIT = int(os.environ.get("ZENITHBOT_MAX_EVENT_RESPONSE_LIMIT", "1000"))
AGENT_TOKEN = os.environ.get("ZENITHDOCK_AGENT_TOKEN") or os.environ.get("ZENITHBOT_AGENT_TOKEN") or ""

SYSTEM_PROMPT = """\
You are responding through Zenith Dock, a native Mac frontend for Zenithbot.

Use concise Markdown. Prefer clear sections, bullets, code fences, and direct
answers. The UI renders rich traces separately, so do not narrate every tool
call unless it matters to the user.

Files and artifacts:
- User uploads are available as local paths in the prompt.
- This is not Slack. Do not call Slack upload APIs or Slack file helpers.
- If your response creates files the user should receive, write a JSON manifest
  at exactly this path:
  {manifest_path}
- Manifest format:
  {{"files": ["/absolute/path/to/file.ext", {{"path": "/absolute/path/video.mp4", "title": "Demo", "text": "Optional note"}}]}}
- Include images, videos, PDFs, CSVs, notebooks, archives, logs, and documents
  that the user would reasonably want to preview or save.
- Do not include source files unless the user explicitly asks for them.
- Use absolute file paths. Videos should be normal playable files such as mp4
  or mov. If `python` is not installed, use `python3` or shell tools to write
  files and the manifest.
"""

CODEX_PROMPT_PRELUDE = """\
[Zenith Dock context]
You are responding through a native Mac frontend for Zenithbot.

Use concise Markdown. The UI renders tool calls, command output, reasoning
summaries, and artifacts separately, so keep the final answer focused.

This is Zenith Dock, not Slack. Do not call Slack upload APIs or Slack file
helpers. Create files locally on Zen-nv and publish them through the manifest.

If you create files the user should receive, write a JSON manifest at exactly:
{manifest_path}

Manifest format:
{{"files": ["/absolute/path/to/file.ext", {{"path": "/absolute/path/video.mp4", "title": "Demo", "text": "Optional note"}}]}}

Use absolute file paths. Videos should be normal playable files such as mp4 or
mov. If `python` is not installed, use `python3` or shell tools to write files
and the manifest.

User prompt follows.
]

"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_name(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in ("-", "_", ".", " ") else "_" for c in name)
    return cleaned.strip(" .") or "file"


def session_dir(session_id: str) -> Path:
    return STATE_DIR / "sessions" / session_id


def events_path(session_id: str) -> Path:
    return session_dir(session_id) / "events.jsonl"


def uploads_dir(session_id: str) -> Path:
    return session_dir(session_id) / "uploads"


def manifests_dir(session_id: str) -> Path:
    return session_dir(session_id) / "manifests"


def existing_cwd(requested: str | None) -> str:
    candidates = [requested, DEFAULT_CWD, str(Path.home()), "/tmp"]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(str(candidate)).expanduser()
        if path.is_dir():
            return str(path)
    return "/tmp"


def ensure_dirs(session_id: str | None = None) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    FILES_ROOT.mkdir(parents=True, exist_ok=True)
    if session_id:
        session_dir(session_id).mkdir(parents=True, exist_ok=True)
        uploads_dir(session_id).mkdir(parents=True, exist_ok=True)
        manifests_dir(session_id).mkdir(parents=True, exist_ok=True)


def token_matches(candidate: str | None) -> bool:
    if not AGENT_TOKEN:
        return True
    if not candidate:
        return False
    return hmac.compare_digest(candidate, AGENT_TOKEN)


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() == "bearer" and value:
        return value.strip()
    return None


def request_authorized(request: Request) -> bool:
    if not AGENT_TOKEN:
        return True
    return (
        token_matches(bearer_token(request.headers.get("authorization")))
        or token_matches(request.headers.get("x-zenithdock-token"))
        or token_matches(request.query_params.get("token"))
    )


def websocket_authorized(ws: WebSocket) -> bool:
    if not AGENT_TOKEN:
        return True
    return (
        token_matches(bearer_token(ws.headers.get("authorization")))
        or token_matches(ws.headers.get("x-zenithdock-token"))
        or token_matches(ws.query_params.get("token"))
    )


class CreateSessionRequest(BaseModel):
    title: str | None = None
    folder: str | None = None
    cwd: str | None = None
    backend: str | None = None
    model: str | None = None
    effort: str | None = None
    pinned: bool | None = None
    provider_session_id: str | None = None
    session_id: str | None = None
    claude_session_id: str | None = None
    codex_thread_id: str | None = None
    import_history: bool | None = None


class UpdateSessionRequest(BaseModel):
    title: str | None = None
    folder: str | None = None
    cwd: str | None = None
    backend: str | None = None
    model: str | None = None
    effort: str | None = None
    pinned: bool | None = None


class TurnRequest(BaseModel):
    prompt: str
    file_ids: list[str] = Field(default_factory=list)
    backend: str | None = None
    model: str | None = None
    effort: str | None = None


class ForkSessionRequest(BaseModel):
    title: str | None = None


class ImportHistoryRequest(BaseModel):
    force: bool = False
    limit: int | None = None


class CreateJobRequest(BaseModel):
    session_id: str
    title: str
    prompt: str
    interval_seconds: int | None = None
    loop: bool = False
    enabled: bool = True
    backend: str | None = None


class UpdateJobRequest(BaseModel):
    title: str | None = None
    prompt: str | None = None
    interval_seconds: int | None = None
    loop: bool | None = None
    enabled: bool | None = None
    backend: str | None = None


class SessionStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.sessions: dict[str, dict[str, Any]] = {}

    async def load(self) -> None:
        ensure_dirs()
        if SESSIONS_FILE.exists():
            try:
                self.sessions = json.loads(SESSIONS_FILE.read_text())
            except Exception as e:
                logger.warning("failed to load sessions: %s", e)
                self.sessions = {}

    async def save(self) -> None:
        ensure_dirs()
        tmp = SESSIONS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.sessions, indent=2))
        tmp.replace(SESSIONS_FILE)

    async def create(self, req: CreateSessionRequest, *, parent_id: str | None = None) -> dict[str, Any]:
        backend = (req.backend or DEFAULT_BACKEND).lower()
        if backend not in VALID_BACKENDS:
            raise HTTPException(status_code=400, detail=f"backend must be one of {sorted(VALID_BACKENDS)}")
        sid = f"sess_{uuid.uuid4().hex[:16]}"
        ensure_dirs(sid)
        now = now_iso()
        provider_id = req.provider_session_id or req.session_id
        claude_session_id = req.claude_session_id or (provider_id if backend == BACKEND_CLAUDE else None)
        codex_thread_id = req.codex_thread_id or (provider_id if backend == BACKEND_CODEX else None)
        active_provider_id = claude_session_id if backend == BACKEND_CLAUDE else codex_thread_id
        title = req.title or (
            f"Resumed {backend.title()} {str(active_provider_id)[:8]}" if active_provider_id else "New chat"
        )
        sess = {
            "id": sid,
            "title": title,
            "folder": req.folder or "General",
            "cwd": req.cwd or DEFAULT_CWD,
            "backend": backend,
            "model": req.model,
            "effort": req.effort,
            "session_id": active_provider_id,
            "claude_session_id": claude_session_id,
            "codex_thread_id": codex_thread_id,
            "parent_id": parent_id,
            "fork_from": None,
            "pinned": bool(req.pinned),
            "pinned_at": now if req.pinned else None,
            "created_at": now,
            "updated_at": now,
        }
        async with self._lock:
            self.sessions[sid] = sess
            await self.save()
        await append_event(sid, "session_created", {"session": public_session(sess)})
        return sess

    async def update(self, sid: str, patch: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            sess = self.sessions.get(sid)
            if not sess:
                raise HTTPException(status_code=404, detail="session not found")
            if "backend" in patch and patch["backend"] is not None:
                backend = str(patch["backend"]).lower()
                if backend not in VALID_BACKENDS:
                    raise HTTPException(status_code=400, detail=f"backend must be one of {sorted(VALID_BACKENDS)}")
                old = sess.get("backend") or DEFAULT_BACKEND
                if old != backend:
                    if sess.get("session_id"):
                        sess["claude_session_id" if old == BACKEND_CLAUDE else "codex_thread_id"] = sess["session_id"]
                    sess["session_id"] = sess.get("claude_session_id" if backend == BACKEND_CLAUDE else "codex_thread_id")
                    sess["backend"] = backend
                    await append_event(sid, "backend_changed", {"old": old, "new": backend})
            for key in ("title", "folder", "cwd", "model", "effort"):
                if key in patch and patch[key] is not None:
                    sess[key] = patch[key]
            if "pinned" in patch and patch["pinned"] is not None:
                pinned = bool(patch["pinned"])
                if pinned and not sess.get("pinned"):
                    sess["pinned_at"] = now_iso()
                elif not pinned:
                    sess["pinned_at"] = None
                sess["pinned"] = pinned
            sess["updated_at"] = now_iso()
            await self.save()
            return sess

    async def delete(self, sid: str) -> bool:
        async with self._lock:
            existed = self.sessions.pop(sid, None)
            await self.save()
        if existed:
            shutil.rmtree(session_dir(sid), ignore_errors=True)
        return existed is not None

    async def save_provider_session(self, sid: str, provider_id: str, backend: str) -> None:
        async with self._lock:
            sess = self.sessions.get(sid)
            if not sess:
                return
            sess["session_id"] = provider_id
            sess["backend"] = sess.get("backend") or backend
            sess["claude_session_id" if backend == BACKEND_CLAUDE else "codex_thread_id"] = provider_id
            if backend == BACKEND_CLAUDE and sess.get("fork_from") and provider_id != sess.get("fork_from"):
                sess["fork_from"] = None
            sess["updated_at"] = now_iso()
            await self.save()


STORE = SessionStore()


class JobStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self._scheduler_task: asyncio.Task | None = None

    async def load(self) -> None:
        ensure_dirs()
        if JOBS_FILE.exists():
            try:
                self.jobs = json.loads(JOBS_FILE.read_text())
            except Exception as e:
                logger.warning("failed to load jobs: %s", e)
                self.jobs = {}

    async def save(self) -> None:
        ensure_dirs()
        tmp = JOBS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.jobs, indent=2))
        tmp.replace(JOBS_FILE)

    async def create(self, req: CreateJobRequest) -> dict[str, Any]:
        if req.session_id not in STORE.sessions:
            raise HTTPException(status_code=404, detail="session not found")
        if req.backend and req.backend not in VALID_BACKENDS:
            raise HTTPException(status_code=400, detail=f"backend must be one of {sorted(VALID_BACKENDS)}")
        jid = f"job_{uuid.uuid4().hex[:16]}"
        now = now_iso()
        job = {
            "id": jid,
            "session_id": req.session_id,
            "title": req.title,
            "prompt": req.prompt,
            "interval_seconds": req.interval_seconds,
            "loop": req.loop,
            "enabled": req.enabled,
            "backend": req.backend,
            "created_at": now,
            "updated_at": now,
            "last_run_at": None,
            "next_run_at": time.time() + req.interval_seconds if req.enabled and req.interval_seconds else None,
            "run_count": 0,
        }
        async with self._lock:
            self.jobs[jid] = job
            await self.save()
        await append_event(req.session_id, "job_created", {"job": public_job(job)})
        return job

    async def update(self, jid: str, patch: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            job = self.jobs.get(jid)
            if not job:
                raise HTTPException(status_code=404, detail="job not found")
            if "backend" in patch and patch["backend"] is not None and patch["backend"] not in VALID_BACKENDS:
                raise HTTPException(status_code=400, detail=f"backend must be one of {sorted(VALID_BACKENDS)}")
            for key in ("title", "prompt", "interval_seconds", "loop", "enabled", "backend"):
                if key in patch and patch[key] is not None:
                    job[key] = patch[key]
            if job.get("enabled") and job.get("interval_seconds") and not job.get("next_run_at"):
                job["next_run_at"] = time.time() + int(job["interval_seconds"])
            if not job.get("enabled"):
                job["next_run_at"] = None
            job["updated_at"] = now_iso()
            await self.save()
            return job

    async def delete(self, jid: str) -> bool:
        async with self._lock:
            existed = self.jobs.pop(jid, None)
            await self.save()
            return existed is not None

    async def delete_for_session(self, session_id: str) -> int:
        async with self._lock:
            doomed = [jid for jid, job in self.jobs.items() if job.get("session_id") == session_id]
            for jid in doomed:
                self.jobs.pop(jid, None)
            await self.save()
            return len(doomed)

    async def mark_ran(self, jid: str) -> None:
        async with self._lock:
            job = self.jobs.get(jid)
            if not job:
                return
            job["last_run_at"] = now_iso()
            job["run_count"] = int(job.get("run_count") or 0) + 1
            if job.get("enabled") and job.get("interval_seconds"):
                job["next_run_at"] = time.time() + int(job["interval_seconds"])
            else:
                job["next_run_at"] = None
            job["updated_at"] = now_iso()
            await self.save()

    async def run_job(self, jid: str) -> dict[str, Any]:
        job = self.jobs.get(jid)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        req = TurnRequest(
            prompt=job["prompt"],
            file_ids=[],
            backend=job.get("backend"),
        )
        result = await start_turn(job["session_id"], req, queue_if_busy=False)
        await self.mark_ran(jid)
        await append_event(job["session_id"], "job_ran", {"job": public_job(self.jobs[jid]), "run_id": result["run_id"]})
        return result

    def start_scheduler(self) -> None:
        if self._scheduler_task is None or self._scheduler_task.done():
            self._scheduler_task = asyncio.create_task(self.scheduler_loop())

    async def scheduler_loop(self) -> None:
        logger.info("job scheduler started")
        while True:
            await asyncio.sleep(5)
            now = time.time()
            due = [
                job["id"] for job in list(self.jobs.values())
                if job.get("enabled") and job.get("next_run_at") and float(job["next_run_at"]) <= now
            ]
            for jid in due:
                job = self.jobs.get(jid)
                if not job:
                    continue
                async with ACTIVE_LOCK:
                    busy = job["session_id"] in BUSY_SESSIONS
                if busy:
                    job["next_run_at"] = time.time() + 30
                    await self.save()
                    continue
                try:
                    await self.run_job(jid)
                except Exception as e:
                    logger.warning("scheduled job %s failed: %s", jid, e)
                    if job.get("session_id"):
                        await append_event(job["session_id"], "job_error", {"job_id": jid, "message": str(e)})
                    job["next_run_at"] = time.time() + int(job.get("interval_seconds") or 300)
                    await self.save()


JOBS = JobStore()


class SubscriberHub:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, sid: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._subscribers.setdefault(sid, set()).add(ws)

    async def unsubscribe(self, sid: str, ws: WebSocket) -> None:
        async with self._lock:
            subs = self._subscribers.get(sid)
            if subs:
                subs.discard(ws)
                if not subs:
                    self._subscribers.pop(sid, None)

    async def broadcast(self, sid: str, event: dict[str, Any]) -> None:
        async with self._lock:
            subs = list(self._subscribers.get(sid, set()))
        stale: list[WebSocket] = []
        for ws in subs:
            try:
                await ws.send_json(event)
            except Exception:
                stale.append(ws)
        if stale:
            async with self._lock:
                current = self._subscribers.get(sid, set())
                for ws in stale:
                    current.discard(ws)


HUB = SubscriberHub()
ACTIVE: dict[str, dict[str, Any]] = {}
BUSY_SESSIONS: set[str] = set()
ACTIVE_LOCK = asyncio.Lock()
QUEUED_TURNS: dict[str, deque[dict[str, Any]]] = {}
QUEUE_LOCK = asyncio.Lock()


async def append_event(session_id: str, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    ensure_dirs(session_id)
    path = events_path(session_id)
    seq = 0
    if path.exists():
        with suppress(Exception):
            seq = sum(1 for _ in path.open("r", encoding="utf-8"))
    event = {
        "seq": seq + 1,
        "id": f"evt_{uuid.uuid4().hex[:16]}",
        "session_id": session_id,
        "type": event_type,
        "ts": now_iso(),
        **(payload or {}),
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, separators=(",", ":")) + "\n")
    await HUB.broadcast(session_id, event)
    return event


async def enqueue_turn(session_id: str, req: TurnRequest, sess: dict[str, Any]) -> dict[str, Any]:
    queued_id = f"queued_{uuid.uuid4().hex[:16]}"
    item = {
        "queued_id": queued_id,
        "prompt": req.prompt,
        "file_ids": list(req.file_ids),
        "backend": req.backend,
        "model": req.model,
        "effort": req.effort,
        "created_at": now_iso(),
    }
    async with QUEUE_LOCK:
        queue = QUEUED_TURNS.setdefault(session_id, deque())
        queue.append(item)
        position = len(queue)
    await append_event(session_id, "turn_queued", {
        "queued_id": queued_id,
        "backend": req.backend or sess.get("backend") or DEFAULT_BACKEND,
        "prompt": req.prompt,
        "file_ids": list(req.file_ids),
        "position": position,
    })
    return {
        "queued": True,
        "queued_id": queued_id,
        "position": position,
        "session": public_session(STORE.sessions[session_id]),
    }


async def unqueue_turn(session_id: str, queued_id: str) -> dict[str, Any]:
    if session_id not in STORE.sessions:
        raise HTTPException(status_code=404, detail="session not found")

    removed: dict[str, Any] | None = None
    async with QUEUE_LOCK:
        queue = QUEUED_TURNS.get(session_id)
        if queue:
            kept: deque[dict[str, Any]] = deque()
            for item in queue:
                if removed is None and item.get("queued_id") == queued_id:
                    removed = item
                    continue
                kept.append(item)
            if kept:
                QUEUED_TURNS[session_id] = kept
                remaining = len(kept)
            else:
                QUEUED_TURNS.pop(session_id, None)
                remaining = 0
        else:
            remaining = 0

    if removed is None:
        raise HTTPException(status_code=404, detail="queued turn not found")

    await append_event(session_id, "turn_unqueued", {
        "queued_id": queued_id,
        "backend": removed.get("backend") or STORE.sessions[session_id].get("backend") or DEFAULT_BACKEND,
        "prompt": removed.get("prompt") or "",
        "file_ids": list(removed.get("file_ids") or []),
        "message": "Removed queued message.",
        "remaining": remaining,
    })
    return {
        "ok": True,
        "unqueued": True,
        "queued_id": queued_id,
        "remaining": remaining,
    }


async def start_next_queued_turn(session_id: str) -> None:
    async with QUEUE_LOCK:
        queue = QUEUED_TURNS.get(session_id)
        item = queue.popleft() if queue else None
        if queue is not None and not queue:
            QUEUED_TURNS.pop(session_id, None)
    if not item:
        return

    req = TurnRequest(
        prompt=str(item.get("prompt") or ""),
        file_ids=list(item.get("file_ids") or []),
        backend=item.get("backend"),
        model=item.get("model"),
        effort=item.get("effort"),
    )
    try:
        await start_turn(session_id, req, queue_if_busy=False, queued_id=str(item["queued_id"]))
    except Exception as e:
        logger.warning("queued turn failed session=%s queued_id=%s: %s", session_id, item.get("queued_id"), e)
        await append_event(session_id, "error", {
            "queued_id": item.get("queued_id"),
            "message": f"queued turn failed: {e}",
        })


def schedule_next_queued_turn(session_id: str) -> None:
    asyncio.create_task(start_next_queued_turn(session_id))


async def release_turn_slot(session_id: str) -> None:
    async with ACTIVE_LOCK:
        ACTIVE.pop(session_id, None)
        BUSY_SESSIONS.discard(session_id)


async def clear_active_process(session_id: str) -> None:
    async with ACTIVE_LOCK:
        ACTIVE.pop(session_id, None)


def read_events(
    session_id: str,
    after: int = 0,
    before: int | None = None,
    limit: int = 500,
    *,
    tail: bool = False,
) -> list[dict[str, Any]]:
    path = events_path(session_id)
    if not path.exists():
        return []
    limit = max(1, min(int(limit or 500), MAX_EVENT_RESPONSE_LIMIT))
    out: list[dict[str, Any]] = []
    tail_out: deque[dict[str, Any]] | None = deque(maxlen=limit) if tail else None
    for line in path.open("r", encoding="utf-8", errors="ignore"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        seq = int(event.get("seq", 0))
        if seq > after and (before is None or seq < before):
            if tail_out is not None:
                tail_out.append(event)
            else:
                out.append(event)
        if tail_out is None and len(out) >= limit:
            break
    return list(tail_out) if tail_out is not None else out


def compact_import_text(text: str) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) <= MAX_IMPORTED_TEXT_CHARS:
        return text
    return text[:MAX_IMPORTED_TEXT_CHARS].rstrip() + "\n\n[import trimmed]"


def compact_memory_text(text: str, max_chars: int = MAX_FORK_MEMORY_ITEM_CHARS) -> str:
    text = re.sub(r"\n{3,}", "\n\n", str(text or "").strip())
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n[trimmed]"


def is_import_boilerplate(text: str) -> bool:
    stripped = text.strip()
    boilerplate_prefixes = (
        "<environment_context>",
        "<permissions instructions>",
        "<collaboration_mode>",
        "# AGENTS.md instructions",
        "# Context from my IDE setup:",
    )
    return any(stripped.startswith(prefix) for prefix in boilerplate_prefixes)


def text_from_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return compact_import_text(content)
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                block_type = block.get("type")
                if block_type in {"text", "input_text", "output_text"} and block.get("text"):
                    parts.append(str(block["text"]))
        return compact_import_text("\n".join(p for p in parts if p.strip()))
    if isinstance(content, dict):
        if content.get("text"):
            return compact_import_text(str(content["text"]))
        if content.get("message"):
            return compact_import_text(str(content["message"]))
    return ""


def message_text(message: Any) -> str:
    if isinstance(message, dict):
        return text_from_content(message.get("content"))
    return text_from_content(message)


def add_history_item(items: list[dict[str, str]], kind: str, text: str) -> None:
    text = compact_import_text(text)
    if not text or (kind == "user" and is_import_boilerplate(text)):
        return
    if items and items[-1]["kind"] == kind and items[-1]["text"].strip() == text.strip():
        return
    items.append({"kind": kind, "text": text})


def tail_limit_items(items: list[dict[str, str]], limit: int | None) -> list[dict[str, str]]:
    effective_limit = limit or MAX_IMPORT_MESSAGES
    if effective_limit > 0 and len(items) > effective_limit:
        return items[-effective_limit:]
    return items


def path_if_jsonl(value: str) -> Path | None:
    raw = value.strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if candidate.is_file() and candidate.suffix == ".jsonl":
        return candidate
    return None


def find_claude_history(provider_id: str) -> Path | None:
    direct = path_if_jsonl(provider_id)
    if direct:
        return direct
    if not CLAUDE_PROJECTS_ROOT.exists():
        return None
    matches = [p for p in CLAUDE_PROJECTS_ROOT.rglob("*.jsonl") if p.stem == provider_id]
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)


def find_codex_history(provider_id: str) -> Path | None:
    direct = path_if_jsonl(provider_id)
    if direct:
        return direct
    if not CODEX_SESSIONS_ROOT.exists():
        return None
    name_matches = [p for p in CODEX_SESSIONS_ROOT.rglob("*.jsonl") if provider_id in p.name]
    if name_matches:
        return max(name_matches, key=lambda p: p.stat().st_mtime)
    for path in sorted(CODEX_SESSIONS_ROOT.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        with suppress(Exception):
            first = path.open("r", encoding="utf-8", errors="ignore").readline()
            meta = json.loads(first)
            if meta.get("type") == "session_meta" and meta.get("payload", {}).get("id") == provider_id:
                return path
    return None


def parse_claude_history(path: Path, limit: int | None) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for line in path.open("r", encoding="utf-8", errors="ignore"):
        if not line.strip():
            continue
        with suppress(Exception):
            event = json.loads(line)
            event_type = event.get("type")
            if event_type == "user":
                add_history_item(items, "user", message_text(event.get("message")))
            elif event_type == "assistant":
                add_history_item(items, "assistant", message_text(event.get("message")))
    return tail_limit_items(items, limit)


def parse_codex_history(path: Path, limit: int | None) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for line in path.open("r", encoding="utf-8", errors="ignore"):
        if not line.strip():
            continue
        with suppress(Exception):
            event = json.loads(line)
            event_type = event.get("type")
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if event_type == "event_msg":
                payload_type = payload.get("type")
                if payload_type == "user_message":
                    add_history_item(items, "user", str(payload.get("message") or ""))
                elif payload_type == "agent_message":
                    add_history_item(items, "assistant", str(payload.get("message") or ""))
            elif event_type == "response_item" and payload.get("type") == "message":
                role = payload.get("role")
                if role == "user":
                    add_history_item(items, "user", text_from_content(payload.get("content")))
                elif role == "assistant":
                    add_history_item(items, "assistant", text_from_content(payload.get("content")))
    return tail_limit_items(items, limit)


def session_provider_id(sess: dict[str, Any]) -> str | None:
    backend = (sess.get("backend") or DEFAULT_BACKEND).lower()
    if backend == BACKEND_CLAUDE:
        return sess.get("claude_session_id") or sess.get("session_id")
    if backend == BACKEND_CODEX:
        return sess.get("codex_thread_id") or sess.get("session_id")
    return sess.get("session_id")


def provider_history(sess: dict[str, Any], limit: int | None) -> tuple[Path | None, list[dict[str, str]]]:
    backend = (sess.get("backend") or DEFAULT_BACKEND).lower()
    provider_id = session_provider_id(sess)
    if not provider_id:
        return None, []
    if backend == BACKEND_CLAUDE:
        path = find_claude_history(provider_id)
        return path, parse_claude_history(path, limit) if path else []
    if backend == BACKEND_CODEX:
        path = find_codex_history(provider_id)
        return path, parse_codex_history(path, limit) if path else []
    return None, []


async def import_session_history(sess: dict[str, Any], *, force: bool = False, limit: int | None = None) -> dict[str, Any]:
    session_id = sess["id"]
    provider_id = session_provider_id(sess)
    backend = (sess.get("backend") or DEFAULT_BACKEND).lower()
    if not provider_id:
        return {"imported": 0, "source_path": None, "message": "No provider session ID set."}
    if not force and any(event.get("type") == "history_imported" for event in read_events(session_id, limit=10000)):
        return {"imported": 0, "source_path": None, "message": "History already imported."}

    try:
        source_path, items = provider_history(sess, limit)
    except Exception as e:
        logger.warning("history import failed session=%s provider=%s: %s", session_id, provider_id, e)
        message = f"History import failed: {e}"
        await append_event(session_id, "history_imported", {
            "backend": backend,
            "provider_session_id": provider_id,
            "message": message,
        })
        return {"imported": 0, "source_path": None, "message": message}

    if not source_path:
        message = f"No local {backend} transcript found for {provider_id}."
        await append_event(session_id, "history_imported", {
            "backend": backend,
            "provider_session_id": provider_id,
            "message": message,
        })
        return {"imported": 0, "source_path": None, "message": message}

    if not items:
        message = f"Found {backend} transcript, but no chat messages to import."
        await append_event(session_id, "history_imported", {
            "backend": backend,
            "provider_session_id": provider_id,
            "source_path": str(source_path),
            "message": message,
        })
        return {"imported": 0, "source_path": str(source_path), "message": message}

    run_id = f"import_{uuid.uuid4().hex[:12]}"
    message = f"Imported {len(items)} rough messages from {backend} history."
    await append_event(session_id, "history_imported", {
        "run_id": run_id,
        "backend": backend,
        "provider_session_id": provider_id,
        "source_path": str(source_path),
        "message": message,
    })
    for item in items:
        if item["kind"] == "user":
            await append_event(session_id, "turn_started", {
                "run_id": run_id,
                "backend": backend,
                "prompt": item["text"],
                "imported": True,
            })
        elif item["kind"] == "assistant":
            await append_event(session_id, "assistant_text", {
                "run_id": run_id,
                "backend": backend,
                "text": item["text"],
                "imported": True,
            })
    return {"imported": len(items), "source_path": str(source_path), "message": message}


async def copy_fork_history(parent_id: str, child_id: str) -> int:
    parent_events = read_events(parent_id, limit=10000)
    assistant_runs = {
        event.get("run_id")
        for event in parent_events
        if event.get("type") == "assistant_text" and str(event.get("text") or "").strip()
    }
    copied = 0
    for event in parent_events:
        event_type = event.get("type")
        if event_type not in {"turn_started", "assistant_text", "reasoning_summary", "tool_started", "tool_finished", "artifact_created", "turn_finished"}:
            continue
        if event_type == "turn_finished":
            if not str(event.get("result_text") or "").strip() or event.get("run_id") in assistant_runs:
                continue
        payload = {
            key: value
            for key, value in event.items()
            if key not in {"seq", "id", "session_id", "ts"}
        }
        payload["forked"] = True
        payload["original_session_id"] = parent_id
        payload["original_seq"] = event.get("seq")
        await append_event(child_id, event_type, payload)
        copied += 1
    await append_event(parent_id, "session_forked", {"child_id": child_id})
    return copied


def build_fork_memory(parent: dict[str, Any], parent_id: str, *, reason: str | None = None) -> str:
    provider_id = session_provider_id(parent)
    header = [
        "[ZenithDock memory fork]",
        "This is a fresh provider thread seeded from a compact memory dump because the original provider-level fork was unavailable.",
        "Use this memory as background context. Do not treat it as a new user request.",
        "",
        f"Parent ZenithDock session: {parent_id}",
        f"Parent title: {parent.get('title') or 'Untitled'}",
        f"Backend: {parent.get('backend') or DEFAULT_BACKEND}",
        f"Working directory: {parent.get('cwd') or DEFAULT_CWD}",
    ]
    if provider_id:
        header.append(f"Original provider session/thread: {provider_id}")
    if reason:
        header.append(f"Fork fallback reason: {compact_memory_text(reason, 800)}")

    lines: list[str] = header + ["", "Recent rough conversation:"]
    events = read_events(parent_id, limit=160, tail=True)
    assistant_runs = {
        event.get("run_id")
        for event in events
        if event.get("type") == "assistant_text" and str(event.get("text") or "").strip()
    }

    for event in events:
        event_type = event.get("type")
        if event_type == "turn_started":
            text = compact_memory_text(event.get("prompt") or "")
            if text:
                lines.append(f"\nUser:\n{text}")
        elif event_type == "assistant_text":
            text = compact_memory_text(event.get("text") or "")
            if text:
                lines.append(f"\nAssistant:\n{text}")
        elif event_type == "turn_finished" and event.get("run_id") not in assistant_runs:
            text = compact_memory_text(event.get("result_text") or "")
            if text:
                lines.append(f"\nAssistant:\n{text}")
        elif event_type == "reasoning_summary":
            text = compact_memory_text(event.get("text") or "", 900)
            if text:
                lines.append(f"\nReasoning summary:\n{text}")
        elif event_type == "artifact_created":
            artifact = event.get("artifact") if isinstance(event.get("artifact"), dict) else {}
            title = artifact.get("title") or artifact.get("filename") or artifact.get("id") or "artifact"
            note = compact_memory_text(artifact.get("text") or "", 600)
            artifact_line = f"\nArtifact: {title}"
            if artifact.get("content_type"):
                artifact_line += f" ({artifact.get('content_type')})"
            if note:
                artifact_line += f"\n{note}"
            lines.append(artifact_line)

    memory = "\n".join(lines).strip()
    if len(memory) > MAX_FORK_MEMORY_CHARS:
        memory = memory[-MAX_FORK_MEMORY_CHARS:].lstrip()
        memory = "[ZenithDock memory fork]\n[Older memory trimmed]\n" + memory
    return memory


def public_session(sess: dict[str, Any]) -> dict[str, Any]:
    return {
        k: sess.get(k)
        for k in (
            "id", "title", "folder", "cwd", "backend", "model", "effort",
            "session_id", "claude_session_id", "codex_thread_id",
            "parent_id", "fork_from", "memory_forked", "memory_seed_used",
            "pinned", "pinned_at", "created_at", "updated_at",
        )
    }


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    out = dict(job)
    if out.get("next_run_at"):
        out["next_run_at_iso"] = datetime.fromtimestamp(float(out["next_run_at"]), tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return out


def runner_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    home = env.get("HOME", str(Path.home()))
    extra = [
        f"{home}/.local/bin",
        f"{home}/.npm-global/bin",
        f"{home}/.cargo/bin",
        f"{home}/.bun/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    nvm_root = Path(home) / ".nvm" / "versions" / "node"
    if nvm_root.exists():
        extra.extend(str(path / "bin") for path in sorted(nvm_root.glob("*"), reverse=True))
    env["PATH"] = ":".join(extra + [env.get("PATH", "/usr/bin:/bin")])
    return env


def build_claude_cmd(sess: dict[str, Any], manifest_path: Path) -> list[str]:
    cmd = [
        "claude", "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--append-system-prompt", SYSTEM_PROMPT.format(manifest_path=str(manifest_path)),
        "--disallowedTools", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
    ]
    if sess.get("model"):
        cmd.extend(["--model", str(sess["model"])])
    if sess.get("effort"):
        cmd.extend(["--effort", str(sess["effort"])])
    provider_id = sess.get("claude_session_id") or (
        sess.get("session_id") if sess.get("backend") == BACKEND_CLAUDE else None
    )
    if sess.get("fork_from"):
        provider_id = sess["fork_from"]
    if provider_id:
        cmd.extend(["--resume", provider_id])
    if sess.get("fork_from"):
        cmd.append("--fork-session")
        cmd.extend(["--name", f"Fork: {sess.get('title') or sess['id']}"])
    return cmd


def build_codex_cmd(sess: dict[str, Any], prompt: str, manifest_path: Path) -> list[str]:
    provider_id = sess.get("codex_thread_id") or (
        sess.get("session_id") if sess.get("backend") == BACKEND_CODEX else None
    )
    full_prompt = CODEX_PROMPT_PRELUDE.format(manifest_path=str(manifest_path)) + prompt
    cmd = [CODEX_BIN, "exec"]
    if provider_id:
        cmd.extend(["resume", provider_id])
    cmd.append("--json")
    cmd.extend(["-c", "model_reasoning_summary=detailed"])
    if not provider_id:
        cmd.append("--skip-git-repo-check")
    cmd.append("--dangerously-bypass-approvals-and-sandbox")
    cmd.append(full_prompt)
    return cmd


async def codex_app_server_request(method: str, params: dict[str, Any]) -> dict[str, Any]:
    env = runner_env()
    codex_dir = os.path.dirname(os.path.abspath(CODEX_BIN))
    if codex_dir and codex_dir not in env.get("PATH", "").split(os.pathsep):
        env["PATH"] = codex_dir + os.pathsep + env.get("PATH", "")
    proc = await asyncio.create_subprocess_exec(
        CODEX_BIN,
        "app-server",
        "--listen",
        "stdio://",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=DEFAULT_CWD,
        env=env,
    )
    stderr_lines: list[str] = []

    async def read_stderr() -> None:
        if not proc.stderr:
            return
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            stderr_lines.append(line.decode("utf-8", "replace").strip())

    async def send(request_id: int, request_method: str, request_params: dict[str, Any]) -> None:
        if not proc.stdin:
            raise RuntimeError("codex app-server stdin unavailable")
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": request_method,
            "params": request_params,
        }
        proc.stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()

    async def read_response(request_id: int) -> dict[str, Any]:
        if not proc.stdout:
            raise RuntimeError("codex app-server stdout unavailable")
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=CODEX_APP_SERVER_TIMEOUT_SECONDS)
            if not line:
                raise RuntimeError("codex app-server exited before response")
            try:
                message = json.loads(line.decode("utf-8", "replace"))
            except Exception:
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(json.dumps(message["error"], separators=(",", ":")))
            return message.get("result", {})

    stderr_task = asyncio.create_task(read_stderr())
    try:
        await send(1, "initialize", {
            "clientInfo": {"name": "zenithdock-agent-server", "version": "0"},
            "capabilities": {"experimentalApi": True},
        })
        await read_response(1)
        await send(2, method, params)
        return await read_response(2)
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        stderr_task.cancel()
        with suppress(asyncio.CancelledError):
            await stderr_task
        if stderr_lines:
            logger.debug("codex app-server stderr: %s", "\n".join(stderr_lines[-20:]))


async def fork_codex_thread(source_thread_id: str, sess: dict[str, Any]) -> str:
    cwd = existing_cwd(str(sess.get("cwd") or DEFAULT_CWD))
    params: dict[str, Any] = {
        "threadId": source_thread_id,
        "cwd": cwd,
        "sandbox": "danger-full-access",
        "approvalPolicy": "never",
        "ephemeral": False,
    }
    if sess.get("model"):
        params["model"] = sess["model"]
    result = await codex_app_server_request("thread/fork", params)
    thread = result.get("thread") if isinstance(result, dict) else None
    forked_id = thread.get("id") if isinstance(thread, dict) else None
    if not forked_id:
        raise RuntimeError("codex app-server did not return a forked thread id")
    return str(forked_id)


def artifact_record(session_id: str, entry: str | dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(entry, str):
        path = entry
        title = None
        text = None
    elif isinstance(entry, dict):
        path = entry.get("path", "")
        title = entry.get("title")
        text = entry.get("text")
    else:
        return None
    if not path or not os.path.isfile(path):
        return None
    file_id = f"art_{uuid.uuid4().hex[:16]}"
    src = Path(path)
    ext = src.suffix
    dest_dir = FILES_ROOT / file_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_name(src.name)
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
    rec = {
        "id": file_id,
        "session_id": session_id,
        "kind": "artifact",
        "title": title or src.name,
        "text": text,
        "path": str(dest),
        "source_path": str(src),
        "filename": dest.name,
        "size": dest.stat().st_size,
        "content_type": guess_content_type(dest.name),
        "created_at": now_iso(),
    }
    (dest_dir / "meta.json").write_text(json.dumps(rec, indent=2))
    return rec


def guess_content_type(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith((".mp4", ".m4v")):
        return "video/mp4"
    if lower.endswith(".mov"):
        return "video/quicktime"
    if lower.endswith(".webm"):
        return "video/webm"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if lower.endswith(".gif"):
        return "image/gif"
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".csv"):
        return "text/csv"
    if lower.endswith(".json"):
        return "application/json"
    return "application/octet-stream"


async def collect_manifest(session_id: str, manifest_path: Path) -> None:
    if not manifest_path.exists():
        return
    try:
        data = json.loads(manifest_path.read_text())
    except Exception as e:
        await append_event(session_id, "artifact_error", {"error": f"manifest parse failed: {e}"})
        return
    finally:
        with suppress(OSError):
            manifest_path.unlink()
    seen: set[str] = set()
    for entry in data.get("files", []):
        path = entry if isinstance(entry, str) else entry.get("path", "") if isinstance(entry, dict) else ""
        if not path or path in seen:
            continue
        seen.add(path)
        rec = artifact_record(session_id, entry)
        if rec:
            await append_event(session_id, "artifact_created", {"artifact": rec})
        else:
            await append_event(session_id, "artifact_error", {"path": path, "error": "file not found"})


async def run_claude(session_id: str, run_id: str, prompt: str, sess: dict[str, Any], manifest_path: Path) -> None:
    cmd = build_claude_cmd(sess, manifest_path)
    requested_cwd = str(sess.get("cwd") or DEFAULT_CWD)
    cwd = existing_cwd(requested_cwd)
    if str(Path(requested_cwd).expanduser()) != cwd:
        await append_event(session_id, "cwd_fallback", {"run_id": run_id, "requested_cwd": requested_cwd, "cwd": cwd})
    await append_event(session_id, "process_started", {"run_id": run_id, "backend": BACKEND_CLAUDE, "argv": cmd, "cwd": cwd})
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=runner_env(),
        )
    except Exception as e:
        await append_event(session_id, "error", {"run_id": run_id, "backend": BACKEND_CLAUDE, "message": f"failed to start Claude: {e}"})
        await append_event(session_id, "turn_finished", {
            "run_id": run_id,
            "backend": BACKEND_CLAUDE,
            "exit_code": None,
            "result_text": "",
        })
        await release_turn_slot(session_id)
        schedule_next_queued_turn(session_id)
        return
    async with ACTIVE_LOCK:
        BUSY_SESSIONS.add(session_id)
        ACTIVE[session_id] = {"proc": proc, "run_id": run_id, "backend": BACKEND_CLAUDE, "started_at": time.time()}
    if proc.stdin:
        proc.stdin.write(prompt.encode())
        await proc.stdin.drain()
        proc.stdin.close()

    final_text = ""
    text_parts: list[str] = []
    provider_id: str | None = None
    current_tools: dict[str, dict[str, Any]] = {}
    last_event = time.time()
    idle_killed = False

    try:
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=5)  # type: ignore[union-attr]
            except asyncio.TimeoutError:
                idle = time.time() - last_event
                if idle >= IDLE_WARN_SECONDS:
                    await append_event(session_id, "idle_warning", {"run_id": run_id, "idle_seconds": int(idle)})
                if idle >= IDLE_KILL_SECONDS:
                    idle_killed = True
                    proc.terminate()
                    break
                continue
            if not raw:
                break
            last_event = time.time()
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            await append_event(session_id, "raw_event", {"run_id": run_id, "backend": BACKEND_CLAUDE, "raw": line})
            try:
                event = json.loads(line)
            except Exception:
                continue
            if event.get("session_id") and not provider_id:
                provider_id = event["session_id"]
                await STORE.save_provider_session(session_id, provider_id, BACKEND_CLAUDE)
                await append_event(session_id, "provider_session", {"run_id": run_id, "backend": BACKEND_CLAUDE, "provider_session_id": provider_id})
            etype = event.get("type")
            if etype == "assistant":
                for block in event.get("message", {}).get("content", []):
                    btype = block.get("type")
                    if btype == "text" and block.get("text"):
                        text = block["text"]
                        text_parts.append(text)
                        await append_event(session_id, "assistant_text", {"run_id": run_id, "text": text})
                    elif btype == "thinking" and block.get("thinking"):
                        await append_event(session_id, "reasoning_summary", {"run_id": run_id, "text": block["thinking"]})
                    elif btype in ("tool_use", "server_tool_use"):
                        tid = block.get("id") or f"tool_{uuid.uuid4().hex[:8]}"
                        tool = {"id": tid, "name": block.get("name", "tool"), "input": block.get("input", {})}
                        current_tools[tid] = tool
                        await append_event(session_id, "tool_started", {"run_id": run_id, "tool": tool})
            elif etype == "user":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "tool_result":
                        tid = block.get("tool_use_id")
                        content = block.get("content", "")
                        await append_event(session_id, "tool_finished", {
                            "run_id": run_id,
                            "tool_id": tid,
                            "tool": current_tools.pop(tid, None),
                            "output": content,
                            "is_error": block.get("is_error") is True,
                        })
            elif etype == "result":
                final_text = event.get("result", "") or final_text
                if event.get("session_id"):
                    provider_id = event["session_id"]
    finally:
        with suppress(ProcessLookupError):
            if proc.returncode is None:
                proc.terminate()
        await proc.wait()
        await clear_active_process(session_id)

    stderr = ""
    if proc.stderr:
        stderr = (await proc.stderr.read()).decode("utf-8", "replace").strip()
    if idle_killed:
        await append_event(session_id, "error", {"run_id": run_id, "message": "killed after idle timeout"})
    if proc.returncode not in (0, None) and stderr:
        await append_event(session_id, "error", {"run_id": run_id, "message": stderr[:4000], "exit_code": proc.returncode})
    if provider_id:
        await STORE.save_provider_session(session_id, provider_id, BACKEND_CLAUDE)
    result_text = final_text or "\n\n".join(text_parts).strip()
    await collect_manifest(session_id, manifest_path)
    await append_event(session_id, "turn_finished", {
        "run_id": run_id,
        "backend": BACKEND_CLAUDE,
        "exit_code": proc.returncode,
        "result_text": result_text,
    })
    await release_turn_slot(session_id)
    schedule_next_queued_turn(session_id)


async def run_codex(session_id: str, run_id: str, prompt: str, sess: dict[str, Any], manifest_path: Path) -> None:
    cmd = build_codex_cmd(sess, prompt, manifest_path)
    requested_cwd = str(sess.get("cwd") or DEFAULT_CWD)
    cwd = existing_cwd(requested_cwd)
    if str(Path(requested_cwd).expanduser()) != cwd:
        await append_event(session_id, "cwd_fallback", {"run_id": run_id, "requested_cwd": requested_cwd, "cwd": cwd})
    await append_event(session_id, "process_started", {"run_id": run_id, "backend": BACKEND_CODEX, "argv": cmd[:-1] + ["<prompt>"], "cwd": cwd})
    env = runner_env()
    codex_dir = os.path.dirname(os.path.abspath(CODEX_BIN))
    if codex_dir and codex_dir not in env.get("PATH", "").split(os.pathsep):
        env["PATH"] = codex_dir + os.pathsep + env.get("PATH", "")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
        )
    except Exception as e:
        await append_event(session_id, "error", {"run_id": run_id, "backend": BACKEND_CODEX, "message": f"failed to start Codex: {e}"})
        await append_event(session_id, "turn_finished", {
            "run_id": run_id,
            "backend": BACKEND_CODEX,
            "exit_code": None,
            "result_text": "",
        })
        await release_turn_slot(session_id)
        schedule_next_queued_turn(session_id)
        return
    async with ACTIVE_LOCK:
        BUSY_SESSIONS.add(session_id)
        ACTIVE[session_id] = {"proc": proc, "run_id": run_id, "backend": BACKEND_CODEX, "started_at": time.time()}

    text_parts: list[str] = []
    provider_id: str | None = None
    last_event = time.time()
    idle_killed = False

    try:
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=5)  # type: ignore[union-attr]
            except asyncio.TimeoutError:
                idle = time.time() - last_event
                if idle >= IDLE_WARN_SECONDS:
                    await append_event(session_id, "idle_warning", {"run_id": run_id, "idle_seconds": int(idle)})
                if idle >= IDLE_KILL_SECONDS:
                    idle_killed = True
                    proc.terminate()
                    break
                continue
            if not raw:
                break
            last_event = time.time()
            line = raw.decode("utf-8", "replace").strip()
            if not line or not line.startswith("{"):
                continue
            await append_event(session_id, "raw_event", {"run_id": run_id, "backend": BACKEND_CODEX, "raw": line})
            try:
                event = json.loads(line)
            except Exception:
                continue
            etype = event.get("type", "")
            if etype == "thread.started" and event.get("thread_id"):
                provider_id = event["thread_id"]
                await STORE.save_provider_session(session_id, provider_id, BACKEND_CODEX)
                await append_event(session_id, "provider_session", {"run_id": run_id, "backend": BACKEND_CODEX, "provider_session_id": provider_id})
                continue
            if etype in ("item.started", "item.completed"):
                item = event.get("item", {}) or {}
                itype = item.get("type", "")
                if itype == "command_execution":
                    tool = {
                        "id": item.get("id") or f"cmd_{uuid.uuid4().hex[:8]}",
                        "name": "Bash",
                        "input": {"command": item.get("command", "")},
                    }
                    if etype == "item.started":
                        await append_event(session_id, "tool_started", {"run_id": run_id, "tool": tool})
                    else:
                        await append_event(session_id, "tool_finished", {
                            "run_id": run_id,
                            "tool_id": tool["id"],
                            "tool": tool,
                            "output": item.get("aggregated_output", ""),
                            "exit_code": item.get("exit_code"),
                        })
                elif itype == "agent_message" and etype == "item.completed":
                    text = (item.get("text") or "").strip()
                    if text:
                        text_parts.append(text)
                        await append_event(session_id, "assistant_text", {"run_id": run_id, "text": text})
                elif itype in ("reasoning", "agent_reasoning") and etype == "item.completed":
                    text = (item.get("text") or "").strip()
                    if not text and isinstance(item.get("summary"), list):
                        text = "\n".join(x.get("text", "") for x in item["summary"] if isinstance(x, dict)).strip()
                    if text:
                        await append_event(session_id, "reasoning_summary", {"run_id": run_id, "text": text})
    finally:
        with suppress(ProcessLookupError):
            if proc.returncode is None:
                proc.terminate()
        await proc.wait()
        await clear_active_process(session_id)

    stderr = ""
    if proc.stderr:
        stderr = (await proc.stderr.read()).decode("utf-8", "replace").strip()
    if idle_killed:
        await append_event(session_id, "error", {"run_id": run_id, "message": "killed after idle timeout"})
    if proc.returncode not in (0, None) and stderr:
        await append_event(session_id, "error", {"run_id": run_id, "message": stderr[:4000], "exit_code": proc.returncode})
    if provider_id:
        await STORE.save_provider_session(session_id, provider_id, BACKEND_CODEX)
    await collect_manifest(session_id, manifest_path)
    await append_event(session_id, "turn_finished", {
        "run_id": run_id,
        "backend": BACKEND_CODEX,
        "exit_code": proc.returncode,
        "result_text": "\n\n".join(text_parts).strip(),
    })
    await release_turn_slot(session_id)
    schedule_next_queued_turn(session_id)


async def start_turn(
    session_id: str,
    req: TurnRequest,
    *,
    queue_if_busy: bool = True,
    queued_id: str | None = None,
) -> dict[str, Any]:
    sess = STORE.sessions.get(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")
    reserved = False
    should_queue = False
    async with ACTIVE_LOCK:
        if session_id in BUSY_SESSIONS:
            if queue_if_busy:
                should_queue = True
            else:
                raise HTTPException(status_code=409, detail="session already has a running turn")
        else:
            BUSY_SESSIONS.add(session_id)
            reserved = True
    if should_queue:
        return await enqueue_turn(session_id, req, sess)

    try:
        if req.backend:
            sess = await STORE.update(session_id, {"backend": req.backend})
        if req.model or req.effort:
            sess = await STORE.update(session_id, {"model": req.model, "effort": req.effort})

        run_id = f"run_{uuid.uuid4().hex[:16]}"
        manifest_path = manifests_dir(session_id) / f"{run_id}.json"
        prompt = req.prompt
        uploads = []
        for file_id in req.file_ids:
            rec_path = FILES_ROOT / file_id / "meta.json"
            if rec_path.exists():
                with suppress(Exception):
                    rec = json.loads(rec_path.read_text())
                    uploads.append(rec)
        if uploads:
            prompt += "\n\n[Attached files]\n"
            for rec in uploads:
                prompt += f"- {rec.get('path')} ({rec.get('filename')}, {rec.get('content_type')})\n"
            prompt += "Use these local paths directly when needed.\n"

        backend = sess.get("backend") or DEFAULT_BACKEND
        memory_seed = str(sess.get("memory_seed") or "").strip()
        if backend == BACKEND_CODEX and memory_seed and not sess.get("memory_seed_used"):
            prompt = f"{memory_seed}\n\n[Current user prompt]\n{prompt}"
            async with STORE._lock:
                current = STORE.sessions.get(session_id)
                if current:
                    current["memory_seed_used"] = True
                    current["updated_at"] = now_iso()
                    sess = current
                    await STORE.save()
            await append_event(session_id, "history_imported", {
                "run_id": run_id,
                "backend": BACKEND_CODEX,
                "message": "Applied memory fork context to this first Codex turn.",
            })

        started_payload = {
            "run_id": run_id,
            "backend": backend,
            "prompt": req.prompt,
            "file_ids": req.file_ids,
        }
        if queued_id:
            started_payload["queued_id"] = queued_id
        await append_event(session_id, "turn_started", started_payload)
        task = run_codex(session_id, run_id, prompt, dict(sess), manifest_path) if backend == BACKEND_CODEX else run_claude(session_id, run_id, prompt, dict(sess), manifest_path)
        asyncio.create_task(task)
        current_title = str(sess.get("title") or "").strip()
        if not current_title or current_title == "New chat":
            first_line = (req.prompt.strip().splitlines() or ["New chat"])[0]
            await STORE.update(session_id, {"title": first_line[:72] or "New chat"})
        else:
            await STORE.update(session_id, {})
        return {"run_id": run_id, "queued": False, "session": public_session(STORE.sessions[session_id])}
    except Exception:
        if reserved:
            await release_turn_slot(session_id)
        raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    await STORE.load()
    await JOBS.load()
    ensure_dirs()
    JOBS.start_scheduler()
    logger.info("agent server ready state=%s sessions=%d jobs=%d", STATE_DIR, len(STORE.sessions), len(JOBS.jobs))
    yield


app = FastAPI(title="Zenithbot Agent Server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_agent_token(request: Request, call_next):
    if request.method == "OPTIONS" or not request.url.path.startswith("/api/"):
        return await call_next(request)
    if not request_authorized(request):
        logger.warning("unauthorized request method=%s path=%s host=%s", request.method, request.url.path, request.client.host if request.client else "-")
        return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    async with ACTIVE_LOCK:
        active = sorted(BUSY_SESSIONS)
    async with QUEUE_LOCK:
        queued = {sid: len(queue) for sid, queue in QUEUED_TURNS.items() if queue}
    return {
        "ok": True,
        "state_dir": str(STATE_DIR),
        "default_backend": DEFAULT_BACKEND,
        "default_cwd": existing_cwd(DEFAULT_CWD),
        "auth_required": bool(AGENT_TOKEN),
        "active": active,
        "queued": queued,
        "jobs": len(JOBS.jobs),
    }


@app.get("/api/sessions")
async def list_sessions() -> dict[str, Any]:
    sessions = [public_session(s) for s in STORE.sessions.values()]
    sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    sessions.sort(key=lambda s: not bool(s.get("pinned")))
    return {"sessions": sessions}


@app.post("/api/sessions")
async def create_session(req: CreateSessionRequest) -> dict[str, Any]:
    sess = await STORE.create(req)
    provider_id = session_provider_id(sess)
    should_import = bool(provider_id) if req.import_history is None else req.import_history
    if should_import:
        await import_session_history(sess)
    return {"session": public_session(sess)}


@app.get("/api/sessions/{session_id}")
async def get_session(
    session_id: str,
    after: int = 0,
    before: int | None = None,
    limit: int = DEFAULT_SESSION_EVENT_LIMIT,
    tail: bool = True,
) -> dict[str, Any]:
    sess = STORE.sessions.get(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")
    events = read_events(session_id, after=after, before=before, limit=limit, tail=tail and after <= 0)
    omitted_before = max(0, int(events[0].get("seq", 1)) - 1) if tail and after <= 0 and events else 0
    return {
        "session": public_session(sess),
        "events": events,
        "events_omitted_before": omitted_before,
    }


@app.post("/api/sessions/{session_id}/import-history")
async def import_history(session_id: str, req: ImportHistoryRequest) -> dict[str, Any]:
    sess = STORE.sessions.get(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")
    result = await import_session_history(sess, force=req.force, limit=req.limit)
    return {"ok": True, **result}


@app.patch("/api/sessions/{session_id}")
async def update_session(session_id: str, req: UpdateSessionRequest) -> dict[str, Any]:
    sess = await STORE.update(session_id, req.model_dump(exclude_unset=True))
    return {"session": public_session(sess)}


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, Any]:
    async with ACTIVE_LOCK:
        active = ACTIVE.pop(session_id, None)
        BUSY_SESSIONS.discard(session_id)
    async with QUEUE_LOCK:
        QUEUED_TURNS.pop(session_id, None)
    if active:
        proc = active.get("proc")
        if proc:
            with suppress(ProcessLookupError):
                proc.terminate()
    deleted = await STORE.delete(session_id)
    deleted_jobs = await JOBS.delete_for_session(session_id)
    return {"ok": True, "deleted": deleted, "deleted_jobs": deleted_jobs}


@app.post("/api/sessions/{session_id}/fork")
async def fork_session(session_id: str, req: ForkSessionRequest) -> dict[str, Any]:
    parent = STORE.sessions.get(session_id)
    if not parent:
        raise HTTPException(status_code=404, detail="session not found")
    parent_backend = (parent.get("backend") or DEFAULT_BACKEND).lower()
    parent_codex_thread_id = parent.get("codex_thread_id") or (
        parent.get("session_id") if parent_backend == BACKEND_CODEX else None
    )
    forked_codex_thread_id: str | None = None
    codex_fork_error: str | None = None

    if parent_backend == BACKEND_CODEX and parent_codex_thread_id:
        try:
            forked_codex_thread_id = await fork_codex_thread(str(parent_codex_thread_id), parent)
            logger.info(
                "forked codex thread parent_session=%s source_thread=%s forked_thread=%s",
                session_id,
                parent_codex_thread_id,
                forked_codex_thread_id,
            )
        except Exception as e:
            logger.warning(
                "codex fork failed parent_session=%s source_thread=%s: %s",
                session_id,
                parent_codex_thread_id,
                e,
            )
            codex_fork_error = str(e)

    child = await STORE.create(
        CreateSessionRequest(
            title=req.title or f"Fork of {parent.get('title') or session_id}",
            folder=parent.get("folder"),
            cwd=parent.get("cwd"),
            backend=parent_backend,
            model=parent.get("model"),
            effort=parent.get("effort"),
            provider_session_id=forked_codex_thread_id if parent_backend == BACKEND_CODEX else None,
            codex_thread_id=forked_codex_thread_id if parent_backend == BACKEND_CODEX else None,
        ),
        parent_id=session_id,
    )
    if parent_backend == BACKEND_CODEX and codex_fork_error:
        child["memory_seed"] = build_fork_memory(parent, session_id, reason=codex_fork_error)
        child["memory_seed_used"] = False
        child["memory_forked"] = True
        child["memory_fork_reason"] = codex_fork_error[:2000]
        async with STORE._lock:
            STORE.sessions[child["id"]] = child
            await STORE.save()
    if parent_backend == BACKEND_CLAUDE and (parent.get("claude_session_id") or parent.get("session_id")):
        child["fork_from"] = parent.get("claude_session_id") or parent.get("session_id")
        async with STORE._lock:
            STORE.sessions[child["id"]] = child
            await STORE.save()
    copied = await copy_fork_history(session_id, child["id"])
    if forked_codex_thread_id:
        await append_event(
            child["id"],
            "provider_session",
            {
                "backend": BACKEND_CODEX,
                "provider_session_id": forked_codex_thread_id,
                "forked_from_provider_id": parent_codex_thread_id,
            },
        )
    elif codex_fork_error:
        await append_event(
            child["id"],
            "history_imported",
            {
                "backend": BACKEND_CODEX,
                "provider_session_id": parent_codex_thread_id,
                "message": "Codex provider fork was too large, so this is a memory fork with bounded rough history. The first turn will seed a fresh Codex thread with the memory dump.",
                "error": codex_fork_error[:4000],
                "copied_events": copied,
            },
        )
    return {"session": public_session(child)}


@app.post("/api/sessions/{session_id}/turns")
async def post_turn(session_id: str, req: TurnRequest) -> dict[str, Any]:
    return await start_turn(session_id, req)


@app.delete("/api/sessions/{session_id}/queue/{queued_id}")
async def delete_queued_turn(session_id: str, queued_id: str) -> dict[str, Any]:
    return await unqueue_turn(session_id, queued_id)


@app.post("/api/sessions/{session_id}/stop")
async def stop_turn(session_id: str) -> dict[str, Any]:
    async with ACTIVE_LOCK:
        active = ACTIVE.get(session_id)
    if not active:
        return {"ok": True, "stopped": False}
    proc = active.get("proc") if active else None
    if proc:
        with suppress(ProcessLookupError):
            proc.terminate()
    await append_event(session_id, "turn_stopped", {"run_id": active.get("run_id") if active else None})
    return {"ok": True, "stopped": True}


@app.get("/api/jobs")
async def list_jobs() -> dict[str, Any]:
    jobs = sorted(
        (public_job(j) for j in JOBS.jobs.values()),
        key=lambda j: j.get("updated_at") or "",
        reverse=True,
    )
    return {"jobs": jobs}


@app.post("/api/jobs")
async def create_job(req: CreateJobRequest) -> dict[str, Any]:
    job = await JOBS.create(req)
    return {"job": public_job(job)}


@app.patch("/api/jobs/{job_id}")
async def update_job(job_id: str, req: UpdateJobRequest) -> dict[str, Any]:
    job = await JOBS.update(job_id, req.model_dump(exclude_unset=True))
    return {"job": public_job(job)}


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str) -> dict[str, Any]:
    deleted = await JOBS.delete(job_id)
    return {"ok": True, "deleted": deleted}


@app.post("/api/jobs/{job_id}/run")
async def run_job(job_id: str) -> dict[str, Any]:
    return await JOBS.run_job(job_id)


@app.websocket("/api/sessions/{session_id}/events")
async def session_events(session_id: str, ws: WebSocket, after: int = 0) -> None:
    if not websocket_authorized(ws):
        await ws.close(code=4401)
        return
    if session_id not in STORE.sessions:
        await ws.close(code=4404)
        return
    await HUB.subscribe(session_id, ws)
    try:
        for event in read_events(session_id, after=after):
            await ws.send_json(event)
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await HUB.unsubscribe(session_id, ws)


@app.post("/api/sessions/{session_id}/files")
async def upload_file(session_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    if session_id not in STORE.sessions:
        raise HTTPException(status_code=404, detail="session not found")
    file_id = f"file_{uuid.uuid4().hex[:16]}"
    dest_dir = FILES_ROOT / file_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe_name(file.filename or "upload")
    size = 0
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="upload too large")
            out.write(chunk)
    meta = {
        "id": file_id,
        "session_id": session_id,
        "kind": "upload",
        "filename": dest.name,
        "path": str(dest),
        "size": size,
        "content_type": file.content_type or guess_content_type(dest.name),
        "created_at": now_iso(),
    }
    (dest_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    await append_event(session_id, "file_uploaded", {"file": meta})
    return {"file": meta}


def load_file_meta(file_id: str) -> dict[str, Any]:
    meta_path = FILES_ROOT / file_id / "meta.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    file_dir = FILES_ROOT / file_id
    if not file_dir.is_dir():
        raise HTTPException(status_code=404, detail="file not found")
    files = [p for p in file_dir.iterdir() if p.is_file() and p.name != "meta.json"]
    if len(files) != 1:
        raise HTTPException(status_code=404, detail="file not found")
    path = files[0]
    meta = {
        "id": file_id,
        "kind": "artifact",
        "filename": path.name,
        "path": str(path),
        "size": path.stat().st_size,
        "content_type": guess_content_type(path.name),
        "created_at": now_iso(),
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    return meta


@app.get("/api/files/{file_id}")
@app.head("/api/files/{file_id}")
async def get_file(file_id: str) -> FileResponse:
    meta = load_file_meta(file_id)
    return FileResponse(
        meta["path"],
        media_type=meta.get("content_type"),
        filename=meta.get("filename"),
        content_disposition_type="inline",
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Zenithbot Agent Server")
    parser.add_argument("cmd", nargs="?", default="serve", choices=["serve"])
    parser.add_argument("--bind", default=os.environ.get("ZENITHBOT_AGENT_BIND", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZENITHBOT_AGENT_PORT", "7850")))
    args = parser.parse_args()
    uvicorn.run("agent_server:app", host=args.bind, port=args.port, app_dir=str(Path(__file__).parent), log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
