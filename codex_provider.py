"""Explicit custom Responses endpoints for the native Codex runtime."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import uuid
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from codex_auth import validate_api_key
from codex_app_server import CodexAppServerManager
from codex_side_question import isolated_config, _verify_protocol
from side_questions import isolated_environment


PROVIDER_ID = "agentsdock_custom"
ENV_KEY = "AGENTSDOCK_CODEX_PROVIDER_API_KEY"
MAX_BODY_BYTES = 16 * 1024
TEST_TIMEOUT_SECONDS = 45
TEST_PROMPT = "Reply with exactly CONNECTION_OK. Do not use tools."


def validate_selection(value: object, *, require_key: bool = True) -> dict:
    fields = {"base_url", "model", "api_key"} if require_key else {"base_url", "model"}
    if not isinstance(value, dict) or set(value) != fields:
        raise HTTPException(400, "Provide the endpoint, model and a fresh provider API key.")
    base, model = value.get("base_url"), value.get("model")
    if not isinstance(base, str) or not 1 <= len(base.strip()) <= 2048:
        raise HTTPException(400, "Enter a valid provider base URL.")
    base = base.strip().rstrip("/")
    if any(ord(char) < 33 or ord(char) > 126 for char in base) or "\\" in base:
        raise HTTPException(400, "Enter a valid provider base URL.")
    try:
        url = urlsplit(base)
        port = url.port
        valid = bool(url.hostname) and url.scheme in {"https", "http"} and url.username is None and url.password is None and not url.query and not url.fragment
        valid = valid and (url.scheme == "https" or url.hostname in {"localhost", "127.0.0.1", "::1"})
        valid = valid and not url.path.lower().endswith(("/responses", "/chat/completions"))
        if port is not None and not 1 <= port <= 65535:
            valid = False
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(400, "Use an HTTPS base URL, or HTTP on loopback, without credentials, query, fragment or an API operation suffix.")
    if not isinstance(model, str) or not 1 <= len(model.strip()) <= 256 or any(ord(char) < 33 or ord(char) > 126 for char in model.strip()):
        raise HTTPException(400, "Enter a model ID without whitespace or control characters.")
    result = {"base_url": urlunsplit((url.scheme.lower(), url.netloc.lower(), url.path, "", "")), "model": model.strip()}
    if require_key:
        result["api_key"] = validate_api_key({"api_key": value["api_key"]})
    return result


def binding(selection: dict) -> str:
    return hashlib.sha256(json.dumps([selection["base_url"], selection["model"]], separators=(",", ":")).encode()).hexdigest()


def session_choice(value) -> str:
    choice = "default" if value is None else value
    if not isinstance(choice, str) or choice not in {"default", "custom"}:
        raise HTTPException(400, "Codex provider must be default or custom.")
    return choice


class ProviderStore:
    """Atomic metadata pointer plus private, endpoint-bound credential records."""
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.RLock()

    def _directory(self, *, create=False):
        if self.root.is_symlink() or self.root.parent.is_symlink():
            raise HTTPException(503, "Provider credential storage is unavailable.")
        if create:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.exists():
            info = self.root.stat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise HTTPException(503, "Provider credential storage must be private to the server user.")

    def _read(self, name: str) -> dict | None:
        self._directory()
        try:
            fd = os.open(self.root / name, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        except OSError:
            raise HTTPException(503, "Provider credential storage is unavailable.") from None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > MAX_BODY_BYTES:
                raise ValueError("unsafe credential file")
            with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as stream:
                value = json.load(stream)
            if not isinstance(value, dict):
                raise ValueError("invalid record")
            return value
        finally:
            os.close(fd)

    def _atomic(self, name: str, value: dict):
        self._directory(create=True)
        target = self.root / name
        if target.is_symlink():
            raise HTTPException(503, "Provider credential storage is unavailable.")
        fd, temporary = tempfile.mkstemp(prefix=".write-", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(value, stream, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            # replace is the commit point; durability failure must not make
            # save delete the credential now selected by the metadata pointer.
            durable = False
            with suppress(OSError):
                directory = os.open(self.root, os.O_RDONLY)
                try:
                    os.fsync(directory)
                    durable = True
                finally:
                    os.close(directory)
            return durable
        finally:
            with suppress(FileNotFoundError):
                os.unlink(temporary)

    def selection(self, *, include_key=False) -> dict | None:
        with self.lock:
            try:
                metadata = self._read("settings.json")
                if not metadata:
                    return None
                selected = validate_selection({name: metadata.get(name) for name in ("base_url", "model")}, require_key=False)
                identifier = metadata.get("credential_id")
                if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{32}", identifier):
                    raise ValueError("invalid credential identity")
                credential = self._read("credential-" + identifier + ".json")
                if not credential or credential.get("binding") != binding(selected):
                    raise ValueError("credential binding mismatch")
                key = validate_api_key({"api_key": credential.get("api_key")})
                if include_key:
                    selected["api_key"] = key
                return selected
            except Exception:
                raise HTTPException(503, "Saved provider settings or credentials are unavailable.") from None

    def status(self, *, available=True) -> dict:
        selected = self.selection()
        return {"available": available, "configured": selected is not None,
            "base_url": selected["base_url"] if selected else None,
            "model": selected["model"] if selected else None,
            "has_api_key": selected is not None, "wire_api": "responses"}

    def for_session(self, session: dict, *, include_key=False) -> dict | None:
        if session_choice(session.get("codex_provider")) == "default":
            return None
        selected = self.selection(include_key=include_key)
        if selected is None:
            raise HTTPException(409, "Configure the custom Codex endpoint before using this chat.")
        if session.get("codex_provider_binding") not in (None, binding(selected)):
            raise HTTPException(409, "This conversation belongs to another Codex endpoint. Start a new Codex chat, or restore its original endpoint and model.")
        return selected

    def registration(self, *, include_key=False) -> dict | None:
        # A damaged optional endpoint must not prevent normal Codex startup.
        # Custom chat admission and the admin status route still fail closed.
        try:
            return self.selection(include_key=include_key)
        except HTTPException:
            return None

    def catalog(self, *, available: bool) -> dict:
        selected = self.registration()
        return {"configured": selected is not None, "available": available and selected is not None,
            "model": selected["model"] if selected else None,
            "base_url": selected["base_url"] if selected else None}

    def revision(self):
        with self.lock:
            return (self._read("settings.json") or {}).get("credential_id")

    def _binding_name(self, thread_id: str) -> str:
        return "thread-" + hashlib.sha256(thread_id.encode()).hexdigest() + ".json"

    def require_thread(self, thread_id: str, selected: dict | None):
        if not thread_id:
            return
        with self.lock:
            previous = self._read(self._binding_name(thread_id))
            expected = binding(selected) if selected else None
            if (previous or {}).get("binding") != expected:
                raise HTTPException(409, "This conversation belongs to another Codex endpoint. Start a new Codex chat, or restore its original endpoint and model.")

    def record_thread(self, thread_id: str, selected: dict | None):
        with self.lock:
            if selected:
                self._atomic(self._binding_name(thread_id), {"binding": binding(selected)})

    def save(self, selected: dict):
        with self.lock:
            previous = self._read("settings.json")
            identifier = uuid.uuid4().hex
            credential_name = "credential-" + identifier + ".json"
            self._atomic(credential_name, {"binding": binding(selected), "api_key": selected["api_key"]})
            try:
                durable = self._atomic("settings.json", {"base_url": selected["base_url"], "model": selected["model"], "credential_id": identifier})
            except BaseException:
                with suppress(OSError):
                    os.unlink(self.root / credential_name)
                raise
            if durable:
                self._remove_previous(previous)

    def _remove_previous(self, previous):
        identifier = previous.get("credential_id") if isinstance(previous, dict) else None
        if isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{32}", identifier):
            with suppress(OSError):
                os.unlink(self.root / ("credential-" + identifier + ".json"))

    def reset(self):
        with self.lock:
            try:
                previous = self._read("settings.json")
            except (ValueError, UnicodeError):
                previous = None
            if self._atomic("settings.json", {}):
                self._remove_previous(previous)


def native_config(selected: dict) -> dict:
    return {"model_provider": PROVIDER_ID, "model": selected["model"],
        "model_providers": {PROVIDER_ID: {"name": "AgentsDock custom endpoint",
            "base_url": selected["base_url"], "env_key": ENV_KEY, "requires_openai_auth": False,
            "wire_api": "responses", "request_max_retries": 0, "stream_max_retries": 0,
            "supports_websockets": False}},
        "shell_environment_policy.exclude": [ENV_KEY, "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_AUTH_TOKEN"]}


def native_args(selected: dict) -> tuple[str, ...]:
    return config_args(native_config(selected))


def registration_args(selected: dict) -> tuple[str, ...]:
    config = native_config(selected)
    config.pop("model_provider")
    config.pop("model")
    # Do not overwrite the normal provider's effective shell policy. The
    # shared client merges the dedicated secret exclusion per thread after
    # resolving native profile/project layers for that thread's cwd.
    config.pop("shell_environment_policy.exclude")
    return config_args(config)


def registration_environment(environment: dict, selected: dict) -> dict:
    # One native manager serves both providers. Keep its original normal
    # credentials; the custom definition requires only its dedicated env_key.
    return {**environment, ENV_KEY: selected["api_key"], "RUST_LOG": "off"}


def config_args(config: dict) -> tuple[str, ...]:
    # CLI overrides consume TOML, not JSON objects. Primitive and array JSON
    # values are TOML-compatible; maps require separate dotted keys.
    result = []
    def add(name, value):
        if isinstance(value, dict):
            for key, child in value.items():
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", key):
                    raise ValueError("unsupported native configuration key")
                # Codex's override parser splits paths itself and retains
                # quotes literally; our fixed schema uses bare safe keys.
                add(name + "." + key, child)
        else:
            result.extend(("-c", name + "=" + json.dumps(value)))
    for name, value in config.items():
        add(name, value)
    return tuple(result)


def native_environment(environment: dict, selected: dict) -> dict:
    clean = {name: value for name, value in environment.items() if name.upper() not in {
        "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_AUTH_TOKEN", "OPENAI_BASE_URL", "OPENAI_API_BASE",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", ENV_KEY}}
    clean[ENV_KEY] = selected["api_key"]
    clean["RUST_LOG"] = "off"
    return clean


def test_result(status: str) -> dict:
    messages = {"ready": "The native Codex runtime completed a response using this endpoint and model.",
        "unsupported": "The endpoint did not accept the Responses protocol required by Codex.",
        "authentication_failed": "The endpoint rejected the provider API key.",
        "model_unavailable": "The endpoint did not accept this model ID.",
        "connection_failed": "The connection test could not reach the endpoint or timed out.",
        "failed": "The native Codex connection test did not complete. Check the endpoint, model and provider access."}
    return {"ok": status == "ready", "status": status, "message": messages[status]}


def classify_failure(value) -> str:
    # Inspect in memory only; upstream error messages may contain credentials.
    if isinstance(value, (TimeoutError, ConnectionError)):
        return "connection_failed"
    text = str(value).lower()
    if any(marker in text for marker in ("401", "403", "invalid_api_key", "unauthorized", "forbidden", "incorrect api key")):
        return "authentication_failed"
    if any(marker in text for marker in ("model_not_found", "model not found", "unknown model", "model does not exist")):
        return "model_unavailable"
    if any(marker in text for marker in ("405", "unsupported protocol", "/responses is not supported", "cannot post /v1/responses")):
        return "unsupported"
    if any(marker in text for marker in ("connection refused", "dns error", "failed to lookup address", "connection timed out", "request timed out", "connection failed:", "error sending request")):
        return "connection_failed"
    return "failed"


async def test_connection(selected: dict, *, executable: str, environment: dict,
                          manager_factory=CodexAppServerManager, verify_protocol=_verify_protocol) -> dict:
    native = None
    opening = None
    with tempfile.TemporaryDirectory(prefix="agentsdock-provider-test-") as temporary:
        config = {**isolated_config(), **native_config(selected), "cli_auth_credentials_store": "ephemeral",
            "log_dir": str(Path(temporary) / "logs"), "sqlite_home": str(Path(temporary) / "db"),
            "history.persistence": "none", "check_for_update_on_startup": False,
            "analytics.enabled": False, "otel.exporter": "none", "otel.trace_exporter": "none"}
        args = config_args(config)
        env = native_environment(isolated_environment(environment), selected)
        env.update({"TMPDIR": temporary, "OTEL_SDK_DISABLED": "true"})
        try:
            async with asyncio.timeout(TEST_TIMEOUT_SECONDS):
                await verify_protocol(executable, temporary, {name: value for name, value in env.items() if name != ENV_KEY})
                native = manager_factory(executable, cwd=temporary, env_factory=lambda: env,
                    app_server_args=args, request_timeout=15, lifecycle_timeout=15,
                    sensitive_values=(selected["api_key"],))
                # Env-carried credentials deserve the same diagnostic suppression
                # as native account/login/start, including startup diagnostics.
                native.client._authentication_submitted = True
                # Retain ownership if cancellation races subprocess spawn.
                opening = asyncio.create_task(native.start())
                await asyncio.shield(opening)
                effective = await native.request("config/read", {"includeLayers": False})
                settings = effective.get("config", {})
                provider = settings.get("model_providers", {}).get(PROVIDER_ID, {})
                if settings.get("cli_auth_credentials_store") != "ephemeral" or settings.get("model_provider") != PROVIDER_ID or provider.get("requires_openai_auth") is not False or provider.get("env_key") != ENV_KEY or provider.get("base_url") != selected["base_url"]:
                    return test_result("failed")
                servers = settings.get("mcp_servers", {})
                if not isinstance(servers, dict):
                    return test_result("failed")
                config["mcp_servers"] = {name: {"enabled": False} for name in servers}
                thread = await native.start_thread({"ephemeral": True, "cwd": temporary, "model": selected["model"],
                    "modelProvider": PROVIDER_ID, "approvalPolicy": "never", "sandbox": "read-only",
                    "baseInstructions": TEST_PROMPT, "developerInstructions": TEST_PROMPT,
                    "config": config, "dynamicTools": [], "environments": []})
                metadata = await native.read_thread(thread, include_turns=False)
                if metadata.get("ephemeral") is not True or metadata.get("path") is not None:
                    return test_result("failed")
                turn = await native.start_turn(thread, [{"type": "text", "text": TEST_PROMPT}], overrides={"environments": []})
                answered = False
                try:
                    while True:
                        packet = await turn.next_notification()
                        data = packet.get("params", {})
                        if packet.get("method") == "error":
                            # This scoped probe is one explicit attempt. Native
                            # retry notices are not terminal for normal chats,
                            # but must not silently retry a connection test.
                            return test_result(classify_failure(data.get("error") or data.get("message")))
                        if packet.get("method") == "item/completed" and data.get("item", {}).get("type") == "agentMessage":
                            answered = bool(data["item"].get("text"))
                        if packet.get("method") == "turn/completed":
                            completed = data.get("turn", {})
                            return test_result("ready" if answered and completed.get("status") == "completed" and not completed.get("error") else classify_failure(completed.get("error")))
                finally:
                    await turn.close()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return test_result(classify_failure(exc))
        finally:
            async def cleanup():
                if opening is not None:
                    with suppress(BaseException):
                        await opening
                if native is not None:
                    await native.close()
            closing = asyncio.create_task(cleanup())
            cancelled = False
            try:
                while not closing.done():
                    try:
                        await asyncio.shield(closing)
                    except asyncio.CancelledError:
                        cancelled = True
                closing.result()
            finally:
                env.clear()
            if cancelled:
                raise asyncio.CancelledError


def create_router(*, authorize, store: ProviderStore, mutate, probe, available) -> APIRouter:
    router = APIRouter()

    async def body(request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > MAX_BODY_BYTES:
                raise HTTPException(413, "Provider request is too large.")
        try:
            return validate_selection(json.loads(raw))
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, "Provide a valid provider request.") from None
        finally:
            raw.clear()

    def access(request):
        authorize(request)
        if not available():
            raise HTTPException(503, "Custom providers require native Codex app-server transport.")

    @router.get("/api/admin/codex/provider")
    async def status(request: Request):
        authorize(request)
        return JSONResponse(await asyncio.to_thread(store.status, available=available()), headers={"Cache-Control": "no-store"})

    @router.post("/api/admin/codex/provider/test")
    async def test(request: Request):
        access(request)
        selected = await body(request)
        try:
            return JSONResponse(await probe(selected), headers={"Cache-Control": "no-store"})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Provider test is unavailable.") from None
        finally:
            selected.clear()

    @router.put("/api/admin/codex/provider")
    async def save(request: Request):
        access(request)
        selected = await body(request)
        try:
            await mutate(selected)
            return JSONResponse(await asyncio.to_thread(store.status), headers={"Cache-Control": "no-store"})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Provider settings could not be saved.") from None
        finally:
            selected.clear()

    @router.delete("/api/admin/codex/provider")
    async def reset(request: Request):
        access(request)
        try:
            await mutate(None)
            return JSONResponse(await asyncio.to_thread(store.status), headers={"Cache-Control": "no-store"})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Provider settings could not be reset.") from None

    return router
