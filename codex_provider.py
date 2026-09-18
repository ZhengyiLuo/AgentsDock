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
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request as URLRequest, build_opener

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
EFFORT_OPTIONS = [{"value": value, "label": label} for value, label in (
    ("none", "None"), ("minimal", "Minimal"), ("low", "Low"), ("medium", "Medium"),
    ("high", "High"), ("xhigh", "Extra high"), ("max", "Max"), ("ultra", "Ultra"))]


def validate_model(value: object) -> str:
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 256 or any(ord(char) < 33 or ord(char) > 126 for char in value.strip()):
        raise HTTPException(400, "Enter a model ID without whitespace or control characters.")
    return value.strip()


def validate_selection(value: object, *, require_key: bool = True) -> dict:
    fields = {"base_url", "api_key"} if require_key else {"base_url"}
    if not isinstance(value, dict) or not fields.issubset(value) or set(value) - fields - {"model"}:
        raise HTTPException(400, "Provide the endpoint and a fresh provider API key.")
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
    result = {"base_url": urlunsplit((url.scheme.lower(), url.netloc.lower(), url.path, "", ""))}
    if model is not None:
        result["model"] = validate_model(model)
    if require_key:
        result["api_key"] = validate_api_key({"api_key": value["api_key"]})
    return result


def binding(selection: dict) -> str:
    return hashlib.sha256(json.dumps([selection["base_url"]], separators=(",", ":")).encode()).hexdigest()


def legacy_binding(selection: dict) -> str | None:
    model = selection.get("legacy_model") or selection.get("model")
    return hashlib.sha256(json.dumps([selection["base_url"], model], separators=(",", ":")).encode()).hexdigest() if model else None


def catalog_key(selected: dict) -> str:
    return hashlib.sha256((selected["base_url"] + "\0" + selected["api_key"]).encode()).hexdigest()


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
        self._catalogs: dict[str, dict] = {}
        self._public_selections: dict[str, dict] = {}
        self._revision_catalog_keys: dict[str, str] = {}

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

    def selection(self, *, include_key=False, revision: str | None = None, include_revision=False) -> dict | None:
        with self.lock:
            try:
                metadata = self._read("settings.json") or {}
                identifier = revision or metadata.get("credential_id")
                if not identifier and not metadata:
                    return None
                if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{32}", identifier):
                    raise ValueError("invalid credential identity")
                credential = self._read("credential-" + identifier + ".json")
                if not credential:
                    raise ValueError("missing credential")
                source = metadata if identifier == metadata.get("credential_id") else credential
                selected = validate_selection({name: source[name] for name in ("base_url", "model") if name in source}, require_key=False)
                legacy_model = credential.get("legacy_model") or source.get("model")
                if legacy_model:
                    selected["legacy_model"] = validate_model(legacy_model)
                if not credential.get("binding") or credential.get("binding") not in (binding(selected), legacy_binding(selected)):
                    raise ValueError("credential binding mismatch")
                key = validate_api_key({"api_key": credential.get("api_key")})
                self._public_selections[identifier] = {**selected, "credential_id": identifier}
                self._revision_catalog_keys[identifier] = catalog_key({**selected, "api_key": key})
                if include_key:
                    selected["api_key"] = key
                if include_revision or revision:
                    selected["credential_id"] = identifier
                if not include_revision and revision is None:
                    selected.pop("legacy_model", None)
                return selected
            except Exception:
                raise HTTPException(503, "Saved provider settings or credentials are unavailable.") from None

    def status(self, *, available=True) -> dict:
        selected = self.selection()
        return {"available": available, "configured": selected is not None,
            "base_url": selected["base_url"] if selected else None,
            "model": selected.get("model") if selected else None,
            "has_api_key": selected is not None, "wire_api": "responses"}

    def for_session(self, session: dict, *, include_key=False) -> dict | None:
        if session_choice(session.get("codex_provider")) == "default":
            return None
        revision = session.get("codex_provider_revision")
        selected = self.selection(include_key=include_key, revision=revision, include_revision=True)
        if selected is None:
            raise HTTPException(409, "Configure the custom Codex endpoint before using this chat.")
        if session.get("codex_provider_binding") not in (None, binding(selected), legacy_binding(selected)):
            raise HTTPException(409, "This conversation belongs to another Codex endpoint. Start a new Codex chat, or restore its original endpoint.")
        model = session.get("model") or selected.get("model") or self.cached_catalog(selected).get("default_model")
        if model:
            selected["model"] = validate_model(model)
        return selected

    def registration(self, *, include_key=False) -> dict | None:
        # A damaged optional endpoint must not prevent normal Codex startup.
        # Custom chat admission and the admin status route still fail closed.
        try:
            return self.selection(include_key=include_key, include_revision=True)
        except HTTPException:
            return None

    def catalog(self, *, available: bool, session: dict | None = None, summary=False) -> dict:
        try:
            # Immutable revisions permit public projections to reuse validated
            # metadata without reopening credential files for every event.
            selected = self._public_selections.get(session.get("codex_provider_revision")) if session else None
            selected = selected or (self.for_session(session) if session is not None else self.registration())
        except HTTPException:
            selected = None
        result = {"configured": selected is not None, "available": available and selected is not None,
            "model": selected.get("model") if selected else None,
            "base_url": selected["base_url"] if selected else None,
            **(self.cached_catalog(selected) if selected else {"models": [], "efforts": EFFORT_OPTIONS,
                "model_efforts": {}, "default_model": "", "default_effort": "high"})}
        if summary:
            result.pop("models", None)
            result.pop("model_efforts", None)
        return result

    def cached_catalog(self, selected: dict | None = None) -> dict:
        with self.lock:
            if selected is None:
                selected = self.registration(include_key=True)
            identifier = (selected or {}).get("credential_id")
            if selected and "api_key" not in selected and identifier not in self._revision_catalog_keys:
                selected = self.selection(include_key=True, revision=selected.get("credential_id"))
            key = (catalog_key(selected) if "api_key" in selected else self._revision_catalog_keys.get(identifier)) if selected else None
            cached = self._catalogs.get(key, {})
            return {"models": cached.get("models", []), "efforts": EFFORT_OPTIONS,
                "model_efforts": cached.get("model_efforts", {}),
                "default_model": cached.get("default_model") or (selected or {}).get("model") or "",
                "default_effort": "high"}

    def cache_catalog(self, selected: dict, catalog: dict):
        with self.lock:
            self._catalogs[catalog_key(selected)] = catalog

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
            accepted = {expected}
            if selected:
                accepted.add(legacy_binding(selected))
                accepted.discard(None)
            if (previous or {}).get("binding") not in accepted or (
                previous and previous.get("credential_id") and
                previous["credential_id"] != (selected or {}).get("credential_id")
            ):
                raise HTTPException(409, "This conversation belongs to another Codex endpoint. Start a new Codex chat, or restore its original endpoint.")

    def record_thread(self, thread_id: str, selected: dict | None):
        with self.lock:
            if selected:
                self._atomic(self._binding_name(thread_id), {"binding": binding(selected),
                    "credential_id": selected.get("credential_id")})

    def for_thread(self, thread_id: str, *, include_key=False) -> dict | None:
        with self.lock:
            record = self._read(self._binding_name(thread_id)) or {}
            revision = record.get("credential_id")
            if revision:
                return self.selection(revision=revision, include_key=include_key, include_revision=True)
            if record.get("binding"):
                selected = self.registration(include_key=include_key)
                if selected and record["binding"] in (binding(selected), legacy_binding(selected)):
                    return selected
                raise HTTPException(409, "This conversation's original Codex endpoint is unavailable.")
            return None

    def retain_current(self) -> dict | None:
        """Make the current generation independently readable before replacement."""
        selected = self.selection(include_key=True, include_revision=True)
        if selected:
            self._atomic("credential-" + selected["credential_id"] + ".json",
                {**selected, "binding": binding(selected)})
            for path in self.root.glob("thread-*.json"):
                previous = self._read(path.name) or {}
                if not previous.get("credential_id") and previous.get("binding") and previous["binding"] in (binding(selected), legacy_binding(selected)):
                    self._atomic(path.name, {"binding": binding(selected), "credential_id": selected["credential_id"]})
        return selected

    def save(self, selected: dict):
        with self.lock:
            try:
                self.retain_current()
            except HTTPException:
                # A missing old credential must not prevent an operator from
                # repairing the current selection with a fresh credential.
                pass
            identifier = uuid.uuid4().hex
            credential_name = "credential-" + identifier + ".json"
            self._atomic(credential_name, {**selected, "binding": binding(selected)})
            try:
                self._atomic("settings.json", {name: value for name, value in
                    {**selected, "credential_id": identifier}.items() if name != "api_key"})
            except BaseException:
                with suppress(OSError):
                    os.unlink(self.root / credential_name)
                raise

    def reset(self):
        with self.lock:
            try:
                self.retain_current()
            except (HTTPException, ValueError, UnicodeError):
                pass
            self._atomic("settings.json", {})


def native_config(selected: dict) -> dict:
    return {"model_provider": PROVIDER_ID, **({"model": selected["model"]} if selected.get("model") else {}),
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
    config.pop("model", None)
    # The client merges the dedicated secret exclusion per thread after
    # resolving native profile/project layers for that thread's cwd.
    config.pop("shell_environment_policy.exclude")
    return config_args(config)


def registration_environment(environment: dict, selected: dict) -> dict:
    return native_environment(environment, selected)


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


class _NoModelRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def discover_models(selected: dict) -> dict:
    """One bounded operator-requested listing; never forward a key on redirect."""
    request = URLRequest(selected["base_url"] + "/models", headers={
        "Authorization": "Bearer " + selected["api_key"], "Accept": "application/json"})
    try:
        with build_opener(ProxyHandler({}), _NoModelRedirects()).open(request, timeout=15) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("model response too large")
            payload = json.loads(raw)
        entries = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(entries, list):
            raise ValueError("invalid model list")
        models = []
        seen = set()
        for entry in entries[:2000]:
            if not isinstance(entry, dict):
                continue
            try:
                value = validate_model(entry.get("id"))
            except HTTPException:
                continue
            if value not in seen:
                seen.add(value)
                models.append({"value": value, "label": value})
            if len(models) == 512:
                break
        return {"ok": True, "status": "ready",
            "message": "The endpoint accepted the key and returned its model list. Choose a model in the chat.",
            "models": models, "efforts": EFFORT_OPTIONS, "model_efforts": {},
            "default_model": models[0]["value"] if models else "", "default_effort": "high"}
    except HTTPError as exc:
        if exc.code in (401, 403):
            return test_result("authentication_failed")
        if exc.code in (404, 405):
            return {**test_result("unsupported"),
                "message": "The endpoint does not provide model discovery. Save it and enter a model ID in the chat."}
        return test_result("failed")
    except (URLError, TimeoutError, ConnectionError):
        return test_result("connection_failed")
    except Exception:
        return test_result("failed")


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
        # A fresh SQLite database paired with the user's Codex home triggers
        # a full history reindex before native initialization can complete.
        # The probe needs only its explicit endpoint/model/key, so isolate its
        # configuration, auth and history together without changing HOME.
        env.update({"CODEX_HOME": temporary, "TMPDIR": temporary, "OTEL_SDK_DISABLED": "true"})
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


def create_router(*, authorize, store: ProviderStore, mutate, probe, available, discover=discover_models, session_lookup=None) -> APIRouter:
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

    async def catalog(selected):
        result = await asyncio.to_thread(discover, selected)
        if result.get("ok") is True:
            store.cache_catalog(selected, result)
        return result

    @router.get("/api/admin/codex/provider")
    async def status(request: Request):
        authorize(request)
        return JSONResponse(await asyncio.to_thread(store.status, available=available()), headers={"Cache-Control": "no-store"})

    @router.post("/api/admin/codex/provider/test")
    async def test(request: Request):
        access(request)
        selected = await body(request)
        try:
            result = await probe(selected) if selected.get("model") else await catalog(selected)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "Provider test is unavailable.") from None
        finally:
            selected.clear()

    @router.get("/api/admin/codex/provider/models")
    async def models(request: Request, session_id: str | None = None):
        access(request)
        if session_id is not None:
            session = session_lookup(session_id) if session_lookup else None
            if not session:
                raise HTTPException(404, "Chat not found.")
            selected = await asyncio.to_thread(store.for_session, session, include_key=True)
        else:
            selected = await asyncio.to_thread(store.selection, include_key=True)
        if selected is None:
            raise HTTPException(409, "Save a custom endpoint before refreshing its models.")
        try:
            return JSONResponse(await catalog(selected), headers={"Cache-Control": "no-store"})
        finally:
            selected.clear()

    @router.post("/api/admin/codex/provider/models")
    async def entered_models(request: Request):
        access(request)
        selected = await body(request)
        try:
            return JSONResponse(await catalog(selected), headers={"Cache-Control": "no-store"})
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
