"""Synthetic-only native endpoint tests; never import or start agent_server."""
import ast
import asyncio
import errno
import json
import os
from pathlib import Path
import tempfile
import threading
import tomllib
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import codex_auth
import codex_provider as provider
from codex_app_server import CodexAppServerClient, CodexAppServerRequestError, CodexAppServerProtocolError
from test_codex_app_server import FakeProcessFactory, NO_RESPONSE
import test_codex_auth_isolated as auth_fixture
from test_codex_auth_isolated import NATIVE

KEY = "provider-synthetic-secret-not-valid"
SELECTION = {"base_url": "https://provider.example.invalid/v1", "model": "test/model", "api_key": KEY}


class StoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="provider-store-")
        self.addCleanup(temporary.cleanup)
        self.store = provider.ProviderStore(Path(temporary.name) / "private")

    def test_private_atomic_bound_credential_roundtrip_reset(self):
        self.assertFalse(self.store.status()["configured"])
        self.store.save(SELECTION)
        self.assertEqual(self.store.selection(include_key=True), SELECTION)
        self.assertEqual(self.store.status()["credential_id"], self.store.revision())
        self.assertEqual(self.store.catalog(available=True)["credential_id"], self.store.revision())
        self.assertNotIn(KEY, json.dumps(self.store.status()))
        self.assertNotIn(KEY, (self.store.root / "settings.json").read_text())
        for path in self.store.root.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        old = self.store.revision()
        self.store.save({**SELECTION, "api_key": "replacement-synthetic"})
        self.assertTrue((self.store.root / ("credential-" + old + ".json")).exists())
        self.assertEqual(self.store.selection(revision=old, include_key=True)["api_key"], KEY)
        self.store.reset()
        self.assertFalse(self.store.status()["configured"])

    def test_thread_binding_prevents_cross_endpoint_and_default_history(self):
        self.store.save(SELECTION)
        with self.assertRaises(HTTPException):
            self.store.require_thread("old-default-thread", SELECTION)
        self.store.record_thread("custom-thread/../../not-a-path", SELECTION)
        self.store.require_thread("custom-thread/../../not-a-path", SELECTION)
        self.store.require_thread("custom-thread/../../not-a-path", {**SELECTION, "model": "different"})
        with self.assertRaises(HTTPException):
            self.store.require_thread("custom-thread/../../not-a-path", {**SELECTION, "base_url": "https://other.example.invalid/v1"})
        self.store.reset()
        with self.assertRaises(HTTPException):
            self.store.require_thread("custom-thread/../../not-a-path", None)
        self.store.require_thread("old-default-thread", None)

    def test_model_capability_evidence_survives_refresh_without_crossing_credentials(self):
        self.store.save(SELECTION)
        listed = {"models": [{"value": "test/model", "label": "test/model"}, {"value": "other/model", "label": "other/model"}],
            "model_capabilities": {"test/model": {"kind": "chat", "reasoning_efforts": ["low", "high"]}}}
        self.store.cache_catalog(SELECTION, listed)
        self.store.cache_model_capability(SELECTION, {"compatibility": "verified", "api_key": KEY})
        self.store.cache_catalog(SELECTION, listed)
        catalog = self.store.cached_catalog(SELECTION)
        self.assertEqual(catalog["model_capabilities"]["test/model"], {"kind": "chat", "compatibility": "verified",
            "reasoning_efforts": ["low", "high"], "reasoning_supported": True})
        self.assertEqual(catalog["model_capabilities"]["other/model"]["compatibility"], "unverified")
        self.assertEqual(catalog["model_efforts"]["other/model"], [])
        self.assertEqual((catalog["efforts"], catalog["default_effort"]), ([], ""))
        self.assertNotIn(KEY, json.dumps(self.store._model_capabilities))
        revision = self.store.revision()
        self.store.save({**SELECTION, "api_key": "new-synthetic"})
        self.assertEqual(self.store.cached_catalog()["model_capabilities"]["test/model"]["compatibility"], "unverified")
        self.assertEqual(self.store.catalog(available=True, session={"codex_provider": "custom", "codex_provider_revision": revision})["model_capabilities"]["test/model"]["compatibility"], "verified")
        other_endpoint = {**SELECTION, "base_url": "https://other.example.invalid/v1"}
        self.store.cache_catalog(other_endpoint, listed)
        self.assertEqual(self.store.cached_catalog(other_endpoint)["model_capabilities"]["test/model"]["compatibility"], "unverified")

    def test_legacy_binding_migrates_without_key_reentry_and_survives_reset(self):
        self.store.save(SELECTION)
        revision = self.store.revision()
        self.store._atomic("credential-" + revision + ".json", {"api_key": KEY, "binding": provider.legacy_binding(SELECTION)})
        self.store._atomic(self.store._binding_name("legacy-thread"), {"binding": provider.legacy_binding(SELECTION)})
        selected = self.store.for_session({"codex_provider": "custom", "codex_provider_binding": provider.legacy_binding(SELECTION), "model": "another-model"})
        self.store.require_thread("legacy-thread", selected)
        self.store.save({"base_url": "https://next.example.invalid/v1", "api_key": "new-synthetic"})
        self.store.reset()
        retained = self.store.for_thread("legacy-thread", include_key=True)
        self.assertEqual((retained["credential_id"], retained["api_key"]), (revision, KEY))
        self.store.require_thread("legacy-thread", {**retained, "model": "third-model"})

    def test_failure_before_metadata_commit_retains_old_key(self):
        self.store.save(SELECTION)
        atomic = self.store._atomic
        def failing(name, value):
            if name == "settings.json":
                raise OSError(errno.ENOSPC, "synthetic")
            return atomic(name, value)
        with patch.object(self.store, "_atomic", side_effect=failing):
            with self.assertRaises(OSError):
                self.store.save({**SELECTION, "api_key": "new-synthetic"})
        self.assertEqual(self.store.selection(include_key=True), SELECTION)

    def test_directory_fsync_after_commit_never_dangles_selected_credential(self):
        self.store.save({**SELECTION, "api_key": "old-synthetic"})
        previous = self.store.revision()
        fsync = os.fsync
        import stat
        def failing(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EIO, "synthetic durability failure")
            fsync(fd)
        with patch.object(provider.os, "fsync", side_effect=failing):
            self.store.save(SELECTION)
        self.assertEqual(self.store.selection(include_key=True), SELECTION)
        self.assertTrue((self.store.root / ("credential-" + previous + ".json")).exists())

    def test_binding_tamper_and_symlink_fail_closed(self):
        self.store.save(SELECTION)
        metadata_path = self.store.root / "settings.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["base_url"] = "https://different.example.invalid"
        self.store._atomic("settings.json", metadata)
        with self.assertRaises(HTTPException):
            self.store.selection(include_key=True)
        metadata_path.unlink()
        metadata_path.symlink_to(self.store.root / "missing")
        with self.assertRaises(HTTPException):
            self.store.save(SELECTION)

    def test_validation_and_native_args_never_include_secret(self):
        for base in ["http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/?token=x", "https://example.invalid/#secret", "https://example.invalid/v1/responses", "https://example.invalid/v1/chat/completions"]:
            with self.subTest(base=base), self.assertRaises(HTTPException):
                provider.validate_selection({**SELECTION, "base_url": base})
        selected = provider.validate_selection({**SELECTION, "base_url": " http://127.0.0.1:7890/v1/ "})
        self.assertEqual(selected["base_url"], "http://127.0.0.1:7890/v1")
        args = provider.native_args(SELECTION)
        self.assertNotIn(KEY, str(args))
        self.assertIn("model_providers.agentsdock_custom.name=\"AgentsDock custom endpoint\"", args)
        self.assertFalse(any('."' in value.split("=", 1)[0] for value in args[1::2]))
        config = tomllib.loads("\n".join(args[1::2]))
        native = config["model_providers"][provider.PROVIDER_ID]
        self.assertFalse(native["requires_openai_auth"])
        self.assertEqual(native["wire_api"], "responses")
        self.assertEqual(native["request_max_retries"], 0)
        env = provider.native_environment({"OPENAI_API_KEY": "old", "CODEX_API_KEY": "old", "https_proxy": "old", "PATH": "safe"}, SELECTION)
        self.assertEqual(env, {"PATH": "safe", provider.ENV_KEY: KEY, "RUST_LOG": "off"})
        client = CodexAppServerClient("unused", cwd="/", env_factory=dict, sensitive_values=(KEY,))
        self.assertTrue(client._authentication_submitted)
        self.assertNotIn(KEY, str(client._redact_sensitive({"error": {"message": KEY, "data": [KEY]}, KEY: KEY})))


class RouterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fixture = auth_fixture.CodexAuthTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.ns = fixture.ns
        temporary = tempfile.TemporaryDirectory(prefix="provider-router-")
        self.addCleanup(temporary.cleanup)
        self.store = provider.ProviderStore(Path(temporary.name) / "private")
        self.manager = fixture.manager
        self.manager.close = AsyncMock()
        self.ns.update({"codex_provider": provider, "CODEX_PROVIDER_STORE": self.store,
            "CODEX_PROVIDER_SETTINGS_LOCK": asyncio.Lock(),
            "STORE": SimpleNamespace(_lock=asyncio.Lock(), sessions={}, save=AsyncMock()),
            "session_codex_thread_id": lambda session: session.get("codex_thread_id", ""),
            "CODEX_APP_SERVER_MANAGER": self.manager, "CODEX_APP_SERVER_MANAGER_EPOCH": 1,
            "CODEX_APP_SERVER_MANAGER_LOCK": asyncio.Lock(), "CODEX_APP_SERVER_THREAD_LRU_LOCK": asyncio.Lock(),
            "CODEX_APP_SERVER_EVICTING_THREADS": {}, "CODEX_APP_SERVER_THREAD_LRU": {},
            "CODEX_APP_SERVER_PINNED_THREADS": set(), "CODEX_APP_SERVER_THREAD_PIN_COUNTS": {},
            "CODEX_APP_SERVER_INVALIDATED_THREADS": set(), "CODEX_APPROVAL_ITEM_CACHE": {},
            "CODEX_PERMISSION_PROFILES_CACHE": {}, "RUNTIME_DIAGNOSTICS_LOCK": threading.RLock(),
            "RUNTIME_DIAGNOSTICS": {"codex": {"ready": False}, "claude": {"ready": True}}})
        source = Path(__file__).with_name("agent_server.py")
        nodes = [node for node in ast.parse(source.read_text()).body if isinstance(node, ast.AsyncFunctionDef) and node.name in {"mutate_codex_provider", "replace_codex_provider_settings", "join_task_despite_caller_cancellation"}]
        from contextlib import suppress
        self.ns["suppress"] = suppress
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), self.ns)
        self.probe = AsyncMock(return_value=provider.test_result("ready"))
        self.discover = Mock(return_value={**provider.test_result("ready"), "models": [{"value": "first/model", "label": "first/model"}], "default_model": "first/model"})
        app = FastAPI()
        app.middleware("http")(self.ns["require_agent_token"])
        app.include_router(provider.create_router(authorize=self.ns["require_native_admin_control"], store=self.store,
            mutate=self.ns["mutate_codex_provider"], probe=self.probe, available=lambda: True, discover=self.discover,
            session_lookup=lambda session_id: self.ns["STORE"].sessions.get(session_id)))
        app.include_router(codex_auth.create_router(authorize=self.ns["require_native_admin_control"],
            operation=self.ns["codex_auth_operation"], available=lambda: True,
            ))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_save_reset_preserve_manager_and_normal_readiness(self):
        response = self.client.put("/api/admin/codex/provider", headers=NATIVE, json=SELECTION)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["configured"])
        self.assertNotIn(KEY, response.text)
        self.manager.close.assert_not_awaited()
        self.ns["close_codex_app_server_manager"].assert_not_awaited()
        self.assertEqual(self.ns["RUNTIME_DIAGNOSTICS"], {"codex": {"ready": False}, "claude": {"ready": True}})
        self.assertFalse(self.ns["CODEX_GOALS_RECONFIGURING"])
        self.ns["CODEX_APP_SERVER_MANAGER"] = self.manager
        response = self.client.delete("/api/admin/codex/provider", headers=NATIVE)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["configured"])

    def test_custom_preserves_normal_login_and_busy_work_does_not_block_reset(self):
        self.store.save(SELECTION)
        response = self.client.post("/api/admin/codex/auth/api-key", headers=NATIVE, json={"api_key": KEY})
        self.assertEqual(response.status_code, 409, response.text)
        self.manager.request.assert_not_awaited()
        self.assertEqual(self.store.selection(include_key=True), SELECTION)
        self.manager.client._turns_by_thread = {"native": SimpleNamespace(_completed=False)}
        response = self.client.delete("/api/admin/codex/provider", headers=NATIVE)
        self.assertEqual(response.status_code, 200, response.text)
        self.manager.close.assert_not_awaited()
        self.assertFalse(self.store.status()["configured"])

    def test_save_pins_legacy_live_session_before_selecting_new_credentials(self):
        self.store.save(SELECTION)
        revision = self.store.revision()
        session = {"codex_provider": "custom", "codex_provider_binding": provider.legacy_binding(SELECTION), "codex_thread_id": "old-thread"}
        self.ns["STORE"].sessions["chat"] = session
        self.manager.client._turns_by_thread = {"old-thread": SimpleNamespace(_completed=False)}
        response = self.client.put("/api/admin/codex/provider", headers=NATIVE, json={"base_url": SELECTION["base_url"], "api_key": "new-synthetic"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(session["codex_provider_revision"], revision)
        self.assertEqual(self.store.for_session(session, include_key=True)["api_key"], KEY)
        self.assertEqual(self.store.for_thread("old-thread")["credential_id"], revision)
        self.ns["STORE"].save.assert_awaited_once_with(durable=True)
        self.manager.close.assert_not_awaited()

    def test_endpoint_only_save_and_explicit_discovery_cache_per_credential(self):
        selected = {"base_url": SELECTION["base_url"], "api_key": KEY}
        tested = self.client.post("/api/admin/codex/provider/test", headers=NATIVE, json=selected)
        self.assertEqual(tested.status_code, 200, tested.text)
        self.probe.assert_not_awaited()
        self.assertFalse(self.store.root.exists())
        response = self.client.put("/api/admin/codex/provider", headers=NATIVE, json=selected)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["model"])
        self.assertEqual(self.store.catalog(available=True)["default_model"], "first/model")
        self.assertEqual(self.discover.call_count, 1)
        response = self.client.get("/api/admin/codex/provider/models", headers=NATIVE)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.discover.call_count, 2)
        self.store.save({**selected, "api_key": "different-synthetic"})
        self.assertEqual(self.store.catalog(available=True)["models"], [])

    def test_model_refresh_uses_retained_chat_credentials_after_reset(self):
        self.store.save(SELECTION)
        session = {"codex_provider": "custom", "codex_provider_revision": self.store.revision(), "model": "chat/model"}
        self.ns["STORE"].sessions["chat"] = session
        self.store.reset()
        received = []
        def discover(selected):
            received.append(dict(selected))
            return {"ok": True, "status": "ready", "models": [{"value": "retained/model", "label": "retained/model"}]}
        self.discover.side_effect = discover
        response = self.client.get("/api/admin/codex/provider/models?session_id=chat", headers=NATIVE)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(received[0]["api_key"], KEY)
        self.assertNotIn(KEY, response.text)
        self.assertEqual(self.store.catalog(available=True, session=session)["models"][0]["value"], "retained/model")
        self.assertTrue(self.store.catalog(available=True, session=session)["available"])
        self.assertFalse(self.store.catalog(available=True)["available"])
        with patch.object(self.store, "_read", side_effect=AssertionError("projection must not read credentials")):
            summary = self.store.catalog(available=True, session=session, summary=True)
            self.assertTrue(summary["available"])
            self.assertNotIn("models", summary)
            self.assertNotIn(KEY, json.dumps(summary))

    def test_reset_with_missing_credential_never_initializes_a_provider(self):
        self.store.save(SELECTION)
        identifier = self.store.revision()
        (self.store.root / ("credential-" + identifier + ".json")).unlink()
        self.ns["CODEX_APP_SERVER_MANAGER"] = None
        response = self.client.delete("/api/admin/codex/provider", headers=NATIVE)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["configured"])
        self.ns["codex_app_server_manager"].assert_not_awaited()

    def test_auth_origin_transport_and_validation_fail_before_probe(self):
        for headers, expected in [({}, 401), ({**NATIVE, "Origin": "https://example.invalid"}, 403), ({**NATIVE, "Content-Type": "text/plain"}, 415)]:
            response = self.client.post("/api/admin/codex/provider/test", headers=headers, content=json.dumps(SELECTION))
            self.assertEqual(response.status_code, expected, response.text)
            self.assertNotIn(KEY, response.text)
        response = self.client.post("/api/admin/codex/provider/test", headers=NATIVE, json={**SELECTION, "api_key": [KEY]})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertNotIn(KEY, response.text)
        self.probe.assert_not_awaited()

    def test_test_isolated_no_store_write_and_safe_errors(self):
        response = self.client.post("/api/admin/codex/provider/test", headers=NATIVE, json=SELECTION)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "ready")
        self.assertFalse(self.store.root.exists())
        self.manager.close.assert_not_awaited()
        self.probe.side_effect = RuntimeError(KEY)
        response = self.client.post("/api/admin/codex/provider/test", headers=NATIVE, json=SELECTION)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(KEY, response.text)

    def test_saved_model_check_uses_pinned_chat_key_and_caches_only_that_model(self):
        self.store.save(SELECTION)
        revision = self.store.revision()
        self.ns["STORE"].sessions["chat"] = {"codex_provider": "custom", "codex_provider_revision": revision}
        self.store.save({**SELECTION, "api_key": "new-synthetic-key"})
        received = []
        async def probe(selected):
            received.append(dict(selected))
            return {**provider.test_result("ready"), "compatibility": "verified", "model": selected["model"]}
        self.probe.side_effect = probe
        response = self.client.post("/api/admin/codex/provider/test", headers=NATIVE,
            json={"model": "checked/model", "session_id": "chat", "credential_id": revision})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((received[0]["api_key"], received[0]["model"]), (KEY, "checked/model"))
        self.assertNotIn(KEY, response.text)
        cached = self.store.cached_catalog(received[0])["model_capabilities"]
        self.assertEqual(cached["checked/model"]["compatibility"], "verified")
        self.assertNotIn("checked/model", self.store.cached_catalog()["model_capabilities"])
        response = self.client.post("/api/admin/codex/provider/test", headers=NATIVE,
            json={"model": "checked/model", "credential_id": revision})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(received), 1)

    async def test_cancelled_save_keeps_admission_until_disk_commit_finishes(self):
        entered, release = threading.Event(), threading.Event()
        save = self.store.save
        def delayed_save(selected):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test release timeout")
            save(selected)
        with patch.object(self.store, "save", side_effect=delayed_save):
            task = asyncio.create_task(self.ns["mutate_codex_provider"](dict(SELECTION)))
            self.assertTrue(await asyncio.to_thread(entered.wait, 3))
            task.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.ns["CODEX_PROVIDER_SETTINGS_LOCK"].locked())
            self.assertFalse(self.ns["CODEX_GOALS_RECONFIGURING"])
            self.assertFalse(task.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse(self.ns["CODEX_GOALS_RECONFIGURING"])
        self.assertTrue(self.store.status()["configured"])


class DiscoveryTests(unittest.TestCase):
    def test_owned_models_endpoint_success_auth_failure_and_redirect_no_follow(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            status = 200
            def log_message(self, *args):
                pass
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                self.send_response(self.status)
                self.send_header("Location", "/must-not-follow")
                self.end_headers()
                self.wfile.write(json.dumps({"data": [
                    {"id": "model/one"}, {"id": "model/two", "type": "chat", "reasoning_efforts": ["low", "high", "not-a-native-effort"]},
                    {"id": "model/one"}, {"id": "invalid model"}, {"id": "text-embedding-3-small"}, {"id": "whisper-1"},
                    {"id": "provider/new-name", "task": "reranking"}, {"id": "provider/art", "architecture": {"output_modalities": ["image"]}},
                    {"id": "model/three", "reasoning_supported": False, "reasoning_efforts": ["high"]},
                    {"id": "chat-with-embedding-tools", "output_modalities": ["text", "image"]}
                ]}).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected = {"base_url": f"http://127.0.0.1:{server.server_port}/v1", "api_key": KEY}
            ready = provider.discover_models(selected)
            self.assertEqual([model["value"] for model in ready["models"]], ["model/one", "model/two", "model/three", "chat-with-embedding-tools"])
            self.assertEqual(ready["model_capabilities"]["model/one"], {"kind": "unknown", "compatibility": "unverified", "reasoning_efforts": [], "reasoning_supported": None})
            self.assertEqual(ready["model_efforts"], {"model/one": [], "model/two": [{"value": "low", "label": "Low"}, {"value": "high", "label": "High"}], "model/three": [], "chat-with-embedding-tools": []})
            self.assertFalse(ready["model_capabilities"]["model/three"]["reasoning_supported"])
            self.assertEqual((ready["efforts"], ready["default_effort"]), ([], ""))
            self.assertTrue(ready["ok"])
            Handler.status = 401
            self.assertEqual(provider.discover_models(selected)["status"], "authentication_failed")
            Handler.status = 302
            self.assertEqual(provider.discover_models(selected)["status"], "failed")
            self.assertEqual(requests, [("/v1/models", "Bearer " + KEY)] * 3)
            self.assertNotIn(KEY, json.dumps(ready))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class ManagerGenerationTests(unittest.IsolatedAsyncioTestCase):
    async def test_simultaneous_generations_freeze_credentials_without_touching_normal_manager(self):
        with tempfile.TemporaryDirectory(prefix="provider-managers-") as temporary:
            store = provider.ProviderStore(Path(temporary) / "private")
            store.save(SELECTION)
            revision = store.revision()
            source = Path(__file__).with_name("agent_server.py")
            names = {"codex_app_server_managers", "existing_codex_app_server_manager", "codex_app_server_manager"}
            nodes = [node for node in ast.parse(source.read_text()).body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
            created = []
            def factory(*args, **kwargs):
                manager = SimpleNamespace(client=SimpleNamespace(), add_notification_handler=Mock(), close=AsyncMock(), options=kwargs)
                created.append(manager)
                return manager
            normal_env = {"OPENAI_API_KEY": "normal-synthetic"}
            ns = {"asyncio": asyncio, "CODEX_PROVIDER_STORE": store, "codex_provider": provider,
                "CODEX_APP_SERVER_MANAGER": None, "CODEX_CUSTOM_APP_SERVER_MANAGERS": {},
                "CODEX_APP_SERVER_MANAGER_EPOCH": 0, "CODEX_GOALS_CONFIG_LOCK": asyncio.Lock(),
                "CODEX_APP_SERVER_MANAGER_LOCK": asyncio.Lock(), "CODEX_GOALS_ENABLED": True,
                "ensure_provider_manager_factory_admission": lambda **kwargs: None,
                "CodexAppServerManager": factory, "CODEX_BIN": "unused", "existing_cwd": lambda value: value,
                "DEFAULT_CWD": temporary, "SERVER_VERSION": "test", "HTTPException": HTTPException,
                "codex_app_server_env": lambda selected=None: provider.native_environment(normal_env, selected) if selected else dict(normal_env)}
            for name in ("CODEX_APP_SERVER_TIMEOUT_SECONDS", "CODEX_APP_SERVER_LIFECYCLE_TIMEOUT_SECONDS", "CODEX_APP_SERVER_JSONL_LIMIT_BYTES", "CODEX_APP_SERVER_NOTIFICATION_QUEUE_LIMIT"):
                ns[name] = 10
            for name in ("handle_codex_server_request", "register_codex_app_server_child", "unregister_codex_app_server_child", "project_codex_notification", "cache_codex_approval_item"):
                ns[name] = Mock()
            exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])), str(source), "exec"), ns)
            normal = await ns["codex_app_server_manager"]()
            old_session = {"codex_provider": "custom", "codex_provider_revision": revision}
            old = await ns["codex_app_server_manager"](old_session)
            store.save({"base_url": SELECTION["base_url"], "api_key": "replacement-synthetic"})
            new = await ns["codex_app_server_manager"]({"codex_provider": "custom", "model": "another-model"})
            self.assertIs(await ns["codex_app_server_manager"](old_session), old)
            with patch.object(store, "for_session", side_effect=AssertionError("lookup must not read credentials")):
                self.assertIs(ns["existing_codex_app_server_manager"](old_session), old)
            self.assertIs(await ns["codex_app_server_manager"](), normal)
            self.assertIsNot(old, new)
            self.assertEqual(old.options["env_factory"]()[provider.ENV_KEY], KEY)
            self.assertEqual(new.options["env_factory"]()[provider.ENV_KEY], "replacement-synthetic")
            self.assertEqual(normal.options["env_factory"](), normal_env)
            self.assertNotIn("OPENAI_API_KEY", old.options["env_factory"]())
            self.assertIn('cli_auth_credentials_store="ephemeral"', old.options["app_server_args"])
            self.assertNotIn(KEY, str(old.options["app_server_args"]))
            self.assertEqual(ns["codex_app_server_managers"](), tuple(created))
            for manager in created:
                manager.close.assert_not_awaited()


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_native_registration_preserves_effective_shell_exclusions(self):
        self.assertFalse(any(value.startswith("shell_environment_policy.exclude=") for value in provider.registration_args(SELECTION)))
        factory = FakeProcessFactory()
        client = CodexAppServerClient("unused", cwd="/tmp", env_factory=dict,
            process_factory=factory, protected_env_keys=(provider.ENV_KEY,), request_timeout=1)
        self.addAsyncCleanup(client.close)
        factory.process.responders["config/read"] = lambda _: {"config": {"shell_environment_policy": {"exclude": ["OPERATOR_SECRET_*", "PROJECT_PRIVATE"]}}}
        for method in ("thread/start", "thread/resume", "thread/fork"):
            factory.process.responders[method] = lambda _: {"thread": {"id": "synthetic"}}
            original = {"cwd": "/synthetic-project", "config": {"shell_environment_policy.exclude": ["THREAD_PRIVATE"], "unrelated": True}}
            await client.request(method, original)
            received = factory.process.messages[-1]["params"]
            self.assertEqual(received["config"]["shell_environment_policy.exclude"],
                ["OPERATOR_SECRET_*", "PROJECT_PRIVATE", "THREAD_PRIVATE", provider.ENV_KEY])
            self.assertTrue(received["config"]["unrelated"])
            self.assertEqual(original["config"]["shell_environment_policy.exclude"], ["THREAD_PRIVATE"])
            self.assertEqual(factory.process.messages[-2]["params"]["cwd"], "/synthetic-project")
        factory.process.responders["config/read"] = lambda _: {"config": {"shell_environment_policy": {"exclude": "invalid"}}}
        before = len([message for message in factory.process.messages if message["method"] == "thread/start"])
        with self.assertRaises(CodexAppServerProtocolError):
            await client.request("thread/start", {"cwd": "/synthetic-project"})
        self.assertEqual(len([message for message in factory.process.messages if message["method"] == "thread/start"]), before)

    async def test_custom_upstream_error_notification_and_stderr_are_redacted(self):
        factory = FakeProcessFactory()
        client = CodexAppServerClient("unused", cwd="/tmp", env_factory=dict,
            sensitive_values=(KEY,), process_factory=factory, request_timeout=1)
        self.addAsyncCleanup(client.close)
        seen = []
        client.add_notification_handler(seen.append)
        def reject(message):
            factory.process.feed_stderr(KEY)
            factory.process.feed({"method": "error", "params": {"message": KEY, "data": [KEY]}})
            factory.process.feed({"id": message["id"], "error": {"message": KEY, "data": KEY}})
            return NO_RESPONSE
        factory.process.responders["config/read"] = reject
        with self.assertRaises(CodexAppServerRequestError) as caught:
            await client.request("config/read", {})
        await asyncio.sleep(0)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertNotIn(KEY, str(caught.exception.error))
        self.assertNotIn(KEY, str(seen))
        self.assertTrue(seen)
        self.assertEqual(client.stderr_tail, [])

    async def test_probe_native_tool_roundtrip_followup_and_isolated_cleanup(self):
        config = {**provider.native_config(SELECTION), "cli_auth_credentials_store": "ephemeral", "mcp_servers": {"inherited": {}}}
        native = SimpleNamespace(client=SimpleNamespace(), start=AsyncMock(), request=AsyncMock(return_value={"config": config}),
            start_thread=AsyncMock(return_value="ephemeral"), read_thread=AsyncMock(return_value={"ephemeral": True, "path": None}),
            close=AsyncMock())
        captured, turns = {}, []
        token = ""
        async def start_turn(thread, inputs, *, overrides):
            nonlocal token
            self.assertEqual((thread, overrides), ("ephemeral", {**provider.turn_overrides(SELECTION["model"]), "environments": []}))
            if not turns:
                reply = await captured["server_request_handler"](1, "item/tool/call", {
                    "threadId": thread, "tool": provider.TEST_TOOL, "arguments": {}})
                self.assertTrue(reply["success"])
                token = reply["contentItems"][0]["text"]
            else:
                self.assertNotIn(token, str(inputs), "Follow-up must recover the previous result from native context")
            turn = SimpleNamespace(next_notification=AsyncMock(side_effect=[
                {"method": "turn/plan/updated", "params": {"plan": [{"step": "Compatibility check", "status": "completed"}]}},
                {"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": token}}},
                {"method": "turn/completed", "params": {"turn": {"status": "completed"}}}]), close=AsyncMock())
            turns.append(turn)
            return turn
        native.start_turn = AsyncMock(side_effect=start_turn)
        def factory(*args, **kwargs):
            captured.update(kwargs)
            captured["environment"] = kwargs["env_factory"]().copy()
            return native
        verify = AsyncMock()
        result = await provider.test_connection(SELECTION, executable="synthetic-unused",
            environment={"OPENAI_API_KEY": "old", "HOME": "/synthetic-home", "CODEX_HOME": "/synthetic-existing-codex"},
            manager_factory=factory, verify_protocol=verify)
        self.assertTrue(result["ok"])
        self.assertEqual(result["compatibility"], "verified")
        self.assertTrue(all(result["checks"].values()))
        self.assertEqual(len(turns), 2)
        for turn in turns:
            turn.close.assert_awaited_once()
        verify.assert_awaited_once()
        self.assertNotIn(KEY, str(captured["app_server_args"]))
        self.assertEqual(captured["environment"][provider.ENV_KEY], KEY)
        self.assertNotIn("OPENAI_API_KEY", captured["environment"])
        self.assertEqual((captured["environment"]["HOME"], captured["environment"]["CODEX_HOME"]),
            ("/synthetic-home", captured["cwd"]))
        params = native.start_thread.call_args.args[0]
        self.assertEqual(params["environments"], [])
        self.assertEqual(params["dynamicTools"][0]["name"], provider.TEST_TOOL)
        self.assertTrue(params["config"]["tools.update_plan.enabled"])
        self.assertEqual(params["config"]["mcp_servers"], {"inherited": {"enabled": False}})
        self.assertEqual(params["approvalPolicy"], "never")
        self.assertFalse(Path(captured["cwd"]).exists())
        native.close.assert_awaited_once()
        self.assertEqual(captured["env_factory"](), {})

    async def test_text_only_reply_does_not_claim_tool_compatibility(self):
        turn = SimpleNamespace(next_notification=AsyncMock(side_effect=[
            {"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "CONNECTION_OK"}}},
            {"method": "turn/completed", "params": {"turn": {"status": "completed"}}}]), close=AsyncMock())
        config = {**provider.native_config(SELECTION), "cli_auth_credentials_store": "ephemeral"}
        native = SimpleNamespace(client=SimpleNamespace(), start=AsyncMock(), request=AsyncMock(return_value={"config": config}),
            start_thread=AsyncMock(return_value="ephemeral"), read_thread=AsyncMock(return_value={"ephemeral": True, "path": None}),
            start_turn=AsyncMock(return_value=turn), close=AsyncMock())
        result = await provider.test_connection(SELECTION, executable="unused", environment={},
            manager_factory=lambda *args, **kwargs: native, verify_protocol=AsyncMock())
        self.assertEqual((result["ok"], result["compatibility"], result["status"]), (False, "unverified", "inconclusive"))
        native.start_turn.assert_awaited_once()
        native.close.assert_awaited_once()

    async def test_protocol_or_native_errors_are_safe_and_never_retry(self):
        verify = AsyncMock(side_effect=RuntimeError(KEY))
        factory = AsyncMock()
        result = await provider.test_connection(SELECTION, executable="unused", environment={}, manager_factory=factory, verify_protocol=verify)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn(KEY, str(result))
        factory.assert_not_called()

    async def test_first_native_error_finishes_before_completion_and_closes_without_retry(self):
        cases = [
            (True, "Connection failed: error sending request " + KEY, "connection_failed"),
            (False, "Upstream returned 401 Unauthorized " + KEY, "authentication_failed"),
            (True, "Unknown failure " + KEY, "failed"),
            (False, "Unsupported parameter: reasoning.effort " + KEY, "unsupported_parameter"),
            (False, {"message": "Invalid value: custom. Supported values: function", "param": "tools[0].type", "private": KEY}, "unsupported_parameter"),
        ]
        for will_retry, details, expected in cases:
            with self.subTest(will_retry=will_retry, expected=expected):
                turn = SimpleNamespace(next_notification=AsyncMock(side_effect=[
                    {"method": "error", "params": {"threadId": "ephemeral", "turnId": "probe-turn",
                        "willRetry": will_retry, "error": {"message": "Reconnecting... 1/4", "additionalDetails": details}}},
                    {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
                ]), close=AsyncMock())
                config = {**provider.native_config(SELECTION), "cli_auth_credentials_store": "ephemeral"}
                native = SimpleNamespace(client=SimpleNamespace(), start=AsyncMock(),
                    request=AsyncMock(return_value={"config": config}), start_thread=AsyncMock(return_value="ephemeral"),
                    read_thread=AsyncMock(return_value={"ephemeral": True, "path": None}),
                    start_turn=AsyncMock(return_value=turn), close=AsyncMock())
                result = await asyncio.wait_for(provider.test_connection(SELECTION, executable="unused", environment={},
                    manager_factory=lambda *args, **kwargs: native, verify_protocol=AsyncMock()), 1)
                self.assertEqual(result["status"], expected)
                self.assertNotIn(KEY, str(result))
                turn.next_notification.assert_awaited_once()
                turn.close.assert_awaited_once()
                native.start_turn.assert_awaited_once()
                native.close.assert_awaited_once()

    async def test_cancel_during_spawn_joins_owned_start_and_close(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def start():
            entered.set()
            await release.wait()
        native = SimpleNamespace(client=SimpleNamespace(), start=start, close=AsyncMock(), request=AsyncMock())
        task = asyncio.create_task(provider.test_connection(SELECTION, executable="unused", environment={},
            manager_factory=lambda *args, **kwargs: native, verify_protocol=AsyncMock()))
        await entered.wait()
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        native.close.assert_not_awaited()
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        native.close.assert_awaited_once()
        native.request.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
