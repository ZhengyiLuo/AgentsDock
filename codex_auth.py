"""Native Codex authentication, with no credential storage or server side effects on import."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse


MAX_BODY_BYTES = 8192
MAX_API_KEY_CHARS = 4096
AUTH_TIMEOUT_SECONDS = 30.0
BUSY_MESSAGE = "Wait for Codex chats, goals, queued turns and Side chat requests to finish before changing authentication."


def capability(*, available: bool) -> dict:
    return {"available": available, "version": 1, "native_only": True,
            "api_key_login": True, "max_api_key_chars": MAX_API_KEY_CHARS}


def account_summary(result: object) -> dict:
    """Project only account kind and bounded display metadata; never return tokens."""
    if not isinstance(result, dict) or not isinstance(result.get("requiresOpenaiAuth"), bool):
        raise HTTPException(502, "Codex returned an invalid authentication status.")
    account = result.get("account")
    if account is not None and not isinstance(account, dict):
        raise HTTPException(502, "Codex returned an invalid authentication status.")
    mode = "none" if account is None else account.get("type")
    if mode not in ("none", "apiKey", "chatgpt"):
        mode = "other"
    email = plan = None
    if mode == "chatgpt":
        raw_email = account.get("email")
        if isinstance(raw_email, str) and len(raw_email) <= 254 and all(33 <= ord(char) <= 126 for char in raw_email) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", raw_email):
            email = raw_email
        raw_plan = account.get("planType")
        if raw_plan in ("free", "go", "plus", "pro", "team", "business", "enterprise", "edu", "unknown"):
            plan = raw_plan
    return {"available": True, "auth_mode": mode, "email": email,
            "plan_type": plan, "requires_openai_auth": result["requiresOpenaiAuth"]}


def validate_api_key(value: object) -> str:
    # Manual validation deliberately never serializes an invalid secret input,
    # unlike a framework validation error's standard `input` property.
    if not isinstance(value, dict) or set(value) != {"api_key"}:
        raise HTTPException(400, "Provide only an API key.")
    key = value["api_key"]
    if not isinstance(key, str) or not 1 <= len(key) <= MAX_API_KEY_CHARS or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise HTTPException(400, "API key must contain 1 to 4096 printable characters without whitespace.")
    return key


async def read_account(manager) -> dict:
    try:
        result = await manager.request("account/read", {"refreshToken": False}, timeout=AUTH_TIMEOUT_SECONDS)
    except Exception:
        raise HTTPException(503, "Codex authentication status is unavailable. Check Codex on this server and refresh.") from None
    return account_summary(result)


async def login_api_key(manager, key: str) -> dict:
    try:
        result = await manager.request("account/login/start", {"type": "apiKey", "apiKey": key}, timeout=AUTH_TIMEOUT_SECONDS)
    except Exception:
        # A timeout/disconnect may occur after native persistence. Never retry
        # or expose the provider error, which may contain the submitted key.
        raise HTTPException(502, "Codex could not confirm API key sign-in. Refresh authentication status before trying again.") from None
    if not isinstance(result, dict) or result.get("type") != "apiKey":
        raise HTTPException(502, "Codex could not confirm API key sign-in. Refresh authentication status before trying again.")
    return account_summary({"account": {"type": "apiKey"}, "requiresOpenaiAuth": True})


def create_router(*, authorize, operation, available) -> APIRouter:
    router = APIRouter()

    @router.get("/api/admin/codex/auth")
    async def status(request: Request):
        authorize(request)
        if not available():
            return JSONResponse({"available": False, "auth_mode": "none", "email": None,
                "plan_type": None, "requires_openai_auth": True,
                "message": "Codex authentication controls require the app-server transport."},
                headers={"Cache-Control": "no-store"})
        try:
            async with operation(mutate=False) as manager:
                result = await read_account(manager)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Codex authentication status is unavailable.") from None
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @router.post("/api/admin/codex/auth/api-key")
    async def login(request: Request):
        authorize(request)
        if not available():
            raise HTTPException(503, "Codex authentication controls require the app-server transport.")
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY_BYTES:
                raise HTTPException(413, "Codex authentication request is too large.")
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, "Provide a valid JSON API key request.") from None
        finally:
            raw.clear()
        key = validate_api_key(body)
        body.clear()
        try:
            async with operation(mutate=True) as manager:
                result = await login_api_key(manager, key)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Codex authentication is unavailable.") from None
        finally:
            key = ""
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    return router
