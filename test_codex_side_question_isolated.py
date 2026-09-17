"""Codex side-question adapter tests: no server import, provider or subprocess."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import codex_side_question as adapter
from side_questions import SideQuestionError


def protocol_schema():
    return {"definitions": {
        name: {"properties": {
            "environments": {"type": ["array", "null"],
                             "description": "Empty disables environment access for this turn."},
            **({"ephemeral": {"type": ["boolean", "null"]}} if name == "ThreadStartParams" else {}),
        }} for name in ("ThreadStartParams", "TurnStartParams")
    }}


def message(text="Answer", *, phase="final_answer", identifier="answer"):
    return {"method": "item/completed", "params": {"item": {
        "id": identifier, "type": "agentMessage", "phase": phase, "text": text,
    }}}


def completed(status="completed", error=None):
    return {"method": "turn/completed", "params": {"turn": {
        "status": status, "error": error,
    }}}


class ConfigurationTests(unittest.TestCase):
    def test_requires_explicit_empty_environment_semantics_on_both_boundaries(self):
        self.assertTrue(adapter.supports_empty_environments(protocol_schema()))
        for name in ("ThreadStartParams", "TurnStartParams"):
            for invalid in ({}, {"type": ["array", "null"], "description": "Optional environments"}):
                with self.subTest(name=name, invalid=invalid):
                    schema = protocol_schema()
                    schema["definitions"][name]["properties"]["environments"] = invalid
                    self.assertFalse(adapter.supports_empty_environments(schema))
        schema = protocol_schema()
        del schema["definitions"]["ThreadStartParams"]["properties"]["ephemeral"]
        self.assertFalse(adapter.supports_empty_environments(schema))

    def test_disables_model_selected_subagents_and_legacy_notification_commands(self):
        config = adapter.isolated_config()
        self.assertIs(config["agents.enabled"], False)
        self.assertEqual(config["notify"], [])
        self.assertEqual(config["web_search"], "disabled")
        self.assertIs(config["tools.update_plan.enabled"], False)
        self.assertIs(config["tools.experimental_request_user_input.enabled"], False)
        self.assertEqual(config["project_doc_max_bytes"], 0)
        for key in ("orchestrator.skills.enabled", "orchestrator.mcp.enabled",
                    "skills.include_instructions", "skills.bundled.enabled"):
            self.assertIs(config[key], False)
        self.assertIs(config["features.skip_host_skill_discovery"], True)
        for name in ("apps", "plugins", "hooks", "multi_agent", "multi_agent_v2", "goals",
                     "memories", "image_generation", "shell_tool", "browser_use", "computer_use"):
            self.assertIs(config[f"features.{name}"], False)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.turn = SimpleNamespace(next_notification=AsyncMock(side_effect=[message(), completed()]))
        self.client = SimpleNamespace(
            start=AsyncMock(), close=AsyncMock(),
            request=AsyncMock(return_value={"config": {"mcp_servers": {"ordinary": {}, "dotted.name": {}}}}),
            start_thread=AsyncMock(return_value="temporary-thread"),
            start_turn=AsyncMock(return_value=self.turn),
        )
        self.factory = Mock(return_value=self.client)
        self.verify = AsyncMock()
        self.enterContext(patch.object(adapter, "CodexAppServerClient", self.factory))
        self.enterContext(patch.object(adapter, "_verify_protocol", self.verify))

    async def answer(self):
        return await adapter.answer_side_question("quoted snapshot", executable="synthetic-codex",
            model="synthetic-model", env={"HOME": "/synthetic/auth", "PATH": "/bin",
                                         "AGENTSDOCK_CHAT_ID": "parent", "CODEX_THREAD_ID": "parent"})

    async def test_uses_fresh_ephemeral_thread_without_parent_or_workspace_authority(self):
        self.assertEqual(await self.answer(), "Answer")
        args, options = self.factory.call_args
        self.assertEqual(args, ("synthetic-codex",))
        self.assertEqual(options["env_factory"](), {"HOME": "/synthetic/auth", "PATH": "/bin"})
        self.assertTrue(options["cwd"].split("/")[-1].startswith("agentsdock-side-question-"))
        self.verify.assert_awaited_once_with("synthetic-codex", options["cwd"], options["env_factory"]())
        self.client.request.assert_awaited_once_with("config/read", {"includeLayers": False})
        params = self.client.start_thread.await_args.args[0]
        self.assertTrue(params["ephemeral"])
        self.assertEqual(params["environments"], [])
        self.assertEqual(params["dynamicTools"], [])
        self.assertEqual(params["cwd"], options["cwd"])
        self.assertEqual(params["approvalPolicy"], "never")
        self.assertEqual(params["sandbox"], "read-only")
        self.assertEqual(params["model"], "synthetic-model")
        self.assertNotIn("sqlite_home", params["config"])
        self.assertEqual(params["config"]["log_dir"], str(Path(options["cwd"]) / "log"))
        self.assertEqual(params["config"]["history.persistence"], "none")
        # These must be process startup overrides, not only thread overrides:
        # app-server can initialize databases before thread/start.
        cli = options["app_server_args"]
        cli_config = {cli[index + 1].split("=", 1)[0]: json.loads(cli[index + 1].split("=", 1)[1])
                      for index in range(0, len(cli), 2)}
        self.assertNotIn("sqlite_home", cli_config)
        for key in ("log_dir", "history.persistence"):
            self.assertEqual(cli_config[key], params["config"][key])
        self.assertNotIn("threadId", params)
        self.assertNotIn("parentThreadId", params)
        self.assertIs(params["config"]["mcp_servers"]["ordinary"]["enabled"], False)
        self.assertIs(params["config"]["mcp_servers"]["dotted.name"]["enabled"], False)
        self.client.start_turn.assert_awaited_once_with("temporary-thread",
            [{"type": "text", "text": "quoted snapshot"}], overrides={"environments": []})
        self.client.close.assert_awaited_once()

    async def test_preserves_provider_owned_runtime_location_without_reindexing_override(self):
        supplied = {"HOME": "/synthetic/auth", "CODEX_HOME": "/synthetic/provider",
                    "CODEX_SQLITE_HOME": "/synthetic/provider-state"}
        self.assertEqual(await adapter.answer_side_question("snapshot", executable="synthetic-codex",
            model=None, env=supplied), "Answer")
        options = self.factory.call_args.kwargs
        self.assertEqual(options["env_factory"](), supplied)
        self.assertFalse(any(value.startswith("sqlite_home=") for value in options["app_server_args"]))
        self.assertTrue(self.client.start_thread.await_args.args[0]["ephemeral"])
        self.assertEqual(self.client.start_thread.await_args.args[0]["environments"], [])
        self.assertEqual(self.client.start_turn.await_args.kwargs["overrides"]["environments"], [])

    async def test_unsupported_protocol_never_starts_provider(self):
        self.verify.side_effect = SideQuestionError(503, "Update Codex")
        with self.assertRaises(SideQuestionError):
            await self.answer()
        self.factory.assert_not_called()

    async def test_unconfirmed_integrations_fail_before_thread_start(self):
        for invalid in (None, {}, {"config": None}, {"config": {"mcp_servers": []}}):
            with self.subTest(invalid=invalid):
                self.client.request.return_value = invalid
                with self.assertRaises(SideQuestionError):
                    await self.answer()
        self.client.start_thread.assert_not_awaited()
        self.client.start_turn.assert_not_awaited()

    async def test_final_answer_ignores_commentary_and_duplicate_completion(self):
        self.turn.next_notification.side_effect = [
            message("Working", phase="commentary", identifier="progress"),
            message("Private reasoning", phase="analysis", identifier="private"),
            message("First"), message("First"),
            message("Second", identifier="answer2"), completed(),
        ]
        self.assertEqual(await self.answer(), "First\n\nSecond")

    async def test_failure_and_empty_completion_never_return_an_answer(self):
        for packets in ([completed("failed", {"message": "private provider error"})], [completed()]):
            with self.subTest(packets=packets):
                self.turn.next_notification.side_effect = packets
                with self.assertRaises(SideQuestionError) as caught:
                    await self.answer()
                self.assertNotIn("private", str(caught.exception))

    async def test_transport_error_is_sanitized_and_process_closed(self):
        self.client.start_turn.side_effect = adapter.CodexAppServerError("private credentials/path")
        with self.assertRaises(SideQuestionError) as caught:
            await self.answer()
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn("private", str(caught.exception))
        self.client.close.assert_awaited_once()

    async def test_output_is_bounded_in_utf8_bytes(self):
        self.turn.next_notification.side_effect = [message("é" * 6), completed()]
        with patch.object(adapter, "MAX_OUTPUT_BYTES", 10):
            with self.assertRaises(SideQuestionError) as caught:
                await self.answer()
        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("output limit", str(caught.exception))
        self.client.close.assert_awaited_once()

    async def test_cancel_during_pending_answer_closes_only_owned_client(self):
        entered = asyncio.Event()
        async def wait():
            entered.set()
            await asyncio.Event().wait()
        self.turn.next_notification.side_effect = wait
        task = asyncio.create_task(self.answer())
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.client.close.assert_awaited_once()

    async def test_cancel_during_start_joins_spawn_before_closing(self):
        entered, release = asyncio.Event(), asyncio.Event()
        order = []
        async def start():
            entered.set()
            await release.wait()
            order.append("started")
        async def close():
            order.append("closed")
        self.client.start.side_effect = start
        self.client.close.side_effect = close
        task = asyncio.create_task(self.answer())
        await entered.wait()
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(order, ["started", "closed"])
        self.client.start_thread.assert_not_awaited()

    async def test_repeated_cancellation_does_not_interrupt_process_cleanup(self):
        answering, closing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        reaped = []
        async def wait():
            answering.set()
            await asyncio.Event().wait()
        async def close():
            closing.set()
            await release.wait()
            reaped.append(True)
        self.turn.next_notification.side_effect = wait
        self.client.close.side_effect = close
        task = asyncio.create_task(self.answer())
        await answering.wait()
        task.cancel()
        await closing.wait()
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(reaped, [True])
        self.client.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
