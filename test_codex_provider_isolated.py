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
import unittest
from unittest.mock import AsyncMock, patch

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
        self.assertNotIn(KEY, json.dumps(self.store.status()))
        self.assertNotIn(KEY, (self.store.root / "settings.json").read_text())
        for path in self.store.root.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        old = self.store.revision()
        self.store.save({**SELECTION, "api_key": "replacement-synthetic"})
        self.assertFalse((self.store.root / ("credential-" + old + ".json")).exists())
        self.store.reset()
        self.assertFalse(self.store.status()["configured"])

    def test_thread_binding_prevents_cross_endpoint_and_default_history(self):
        self.store.save(SELECTION)
        with self.assertRaises(HTTPException):
            self.store.require_thread("old-default-thread", SELECTION)
        self.store.record_thread("custom-thread/../../not-a-path", SELECTION)
        self.store.require_thread("custom-thread/../../not-a-path", SELECTION)
        with self.assertRaises(HTTPException):
            self.store.require_thread("custom-thread/../../not-a-path", {**SELECTION, "model": "different"})
        self.store.reset()
        with self.assertRaises(HTTPException):
            self.store.require_thread("custom-thread/../../not-a-path", None)
        self.store.require_thread("old-default-thread", None)

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
        app = FastAPI()
        app.middleware("http")(self.ns["require_agent_token"])
        app.include_router(provider.create_router(authorize=self.ns["require_native_admin_control"], store=self.store,
            mutate=self.ns["mutate_codex_provider"], probe=self.probe, available=lambda: True))
        app.include_router(codex_auth.create_router(authorize=self.ns["require_native_admin_control"],
            operation=self.ns["codex_auth_operation"], available=lambda: True,
            ))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_save_reset_only_retires_idle_codex_and_clears_its_readiness(self):
        response = self.client.put("/api/admin/codex/provider", headers=NATIVE, json=SELECTION)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["configured"])
        self.assertNotIn(KEY, response.text)
        self.manager.close.assert_awaited_once()
        self.ns["close_codex_app_server_manager"].assert_not_awaited()
        self.assertEqual(self.ns["RUNTIME_DIAGNOSTICS"], {"claude": {"ready": True}})
        self.assertFalse(self.ns["CODEX_GOALS_RECONFIGURING"])
        self.ns["CODEX_APP_SERVER_MANAGER"] = self.manager
        response = self.client.delete("/api/admin/codex/provider", headers=NATIVE)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["configured"])

    def test_custom_preserves_normal_login_and_busy_blocks_mutation(self):
        self.store.save(SELECTION)
        response = self.client.post("/api/admin/codex/auth/api-key", headers=NATIVE, json={"api_key": KEY})
        self.assertEqual(response.status_code, 409, response.text)
        self.manager.request.assert_not_awaited()
        self.assertEqual(self.store.selection(include_key=True), SELECTION)
        self.manager.client._turns_by_thread = {"native": SimpleNamespace(_completed=False)}
        response = self.client.delete("/api/admin/codex/provider", headers=NATIVE)
        self.assertEqual(response.status_code, 409, response.text)
        self.manager.close.assert_not_awaited()
        self.assertTrue(self.store.status()["configured"])

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
            self.assertTrue(self.ns["CODEX_GOALS_RECONFIGURING"])
            self.assertFalse(task.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse(self.ns["CODEX_GOALS_RECONFIGURING"])
        self.assertTrue(self.store.status()["configured"])


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

    async def test_probe_ephemeral_no_tool_flags_and_cleanup(self):
        turn = SimpleNamespace(next_notification=AsyncMock(side_effect=[
            {"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "CONNECTION_OK"}}},
            {"method": "turn/completed", "params": {"turn": {"status": "completed"}}}]), close=AsyncMock())
        config = {**provider.native_config(SELECTION), "cli_auth_credentials_store": "ephemeral", "mcp_servers": {"inherited": {}}}
        native = SimpleNamespace(client=SimpleNamespace(), start=AsyncMock(), request=AsyncMock(return_value={"config": config}),
            start_thread=AsyncMock(return_value="ephemeral"), read_thread=AsyncMock(return_value={"ephemeral": True, "path": None}),
            start_turn=AsyncMock(return_value=turn), close=AsyncMock())
        captured = {}
        def factory(*args, **kwargs):
            captured.update(kwargs)
            captured["environment"] = kwargs["env_factory"]().copy()
            return native
        verify = AsyncMock()
        result = await provider.test_connection(SELECTION, executable="synthetic-unused",
            environment={"OPENAI_API_KEY": "old", "HOME": "/synthetic-home", "CODEX_HOME": "/synthetic-existing-codex"},
            manager_factory=factory, verify_protocol=verify)
        self.assertTrue(result["ok"])
        verify.assert_awaited_once()
        self.assertNotIn(KEY, str(captured["app_server_args"]))
        self.assertEqual(captured["environment"][provider.ENV_KEY], KEY)
        self.assertNotIn("OPENAI_API_KEY", captured["environment"])
        self.assertEqual((captured["environment"]["HOME"], captured["environment"]["CODEX_HOME"]),
            ("/synthetic-home", captured["cwd"]))
        params = native.start_thread.call_args.args[0]
        self.assertEqual(params["environments"], [])
        self.assertEqual(params["dynamicTools"], [])
        self.assertEqual(params["config"]["mcp_servers"], {"inherited": {"enabled": False}})
        self.assertEqual(params["approvalPolicy"], "never")
        self.assertEqual(native.start_turn.call_args.kwargs["overrides"], {"environments": []})
        self.assertFalse(Path(captured["cwd"]).exists())
        native.close.assert_awaited_once()
        self.assertEqual(captured["env_factory"](), {})

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
                self.assertEqual(result, provider.test_result(expected))
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
