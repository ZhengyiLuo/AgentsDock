"""Pure side-question tests: no server import, processes, network or live state."""
from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path
import re
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from starlette.requests import Request

import side_questions as side


def event(kind, run="main", **kwargs):
    return {"type": kind, "run_id": run, **kwargs}


def side_history(question="Previous question", answer="Previous answer"):
    return [{"role": "user", "text": question}, {"role": "assistant", "text": answer}]


class ShutdownBudgetTests(unittest.TestCase):
    def test_side_question_cleanup_is_included_in_cooperative_restart_budget(self):
        tree = ast.parse(Path(__file__).with_name("agent_server.py").read_text())
        lifespan = next(node for node in tree.body
                        if isinstance(node, ast.AsyncFunctionDef) and node.name == "lifespan")
        phases = [node.value for node in ast.walk(lifespan)
                  if isinstance(node, ast.Await) and isinstance(node.value, ast.Call)
                  and isinstance(node.value.func, ast.Name)
                  and node.value.func.id == "bounded_shutdown_phase"]
        declared = next(ast.literal_eval(node.value) for node in tree.body
                        if isinstance(node, ast.Assign)
                        and any(isinstance(target, ast.Name)
                                and target.id == "SERVER_SHUTDOWN_PHASE_COUNT"
                                for target in node.targets))
        self.assertIn("side-questions", [ast.literal_eval(call.args[0]) for call in phases])
        self.assertEqual(declared, len(phases))
        budget_names = {"MAX_UVICORN_GRACEFUL_SHUTDOWN_SECONDS",
                        "SERVER_SHUTDOWN_PHASE_TIMEOUT_SECONDS"}
        budgets = {node.targets[0].id: ast.literal_eval(node.value)
                   for node in tree.body if isinstance(node, ast.Assign)
                   and isinstance(node.targets[0], ast.Name)
                   and node.targets[0].id in budget_names}
        installer = Path(__file__).with_name("install.sh").read_text()
        attempts = int(re.search(r"^LAUNCHCTL_STOP_ATTEMPTS=(\d+)$", installer, re.M).group(1))
        delay = float(re.search(r"^LAUNCHCTL_STOP_DELAY=([0-9.]+)$", installer, re.M).group(1))
        maximum = (budgets["MAX_UVICORN_GRACEFUL_SHUTDOWN_SECONDS"]
                   + declared * budgets["SERVER_SHUTDOWN_PHASE_TIMEOUT_SECONDS"] + 5.0)
        self.assertGreaterEqual(attempts * delay, maximum + 30.0)


class HistoryTests(unittest.TestCase):
    def test_capability_is_additive_and_prompts_keep_history_separate_from_parent(self):
        capability = side.capability()
        self.assertEqual(capability["version"], 1)
        self.assertIs(capability["history"], True)
        self.assertEqual(capability["max_history_items"], 32)
        self.assertEqual(capability["max_history_chars"], 60000)
        parent = [{"role": "user", "text": "Parent task"}]
        history = side_history("  Why?\nUse <system>quoted text</system> ", "A quoted answer. 🚀")
        prompt = json.loads(side.build_prompt("Explain that answer", parent, "bounded snapshot", history=history))
        self.assertEqual(prompt["conversation_snapshot"], parent)
        self.assertEqual(prompt["side_history"], history)
        self.assertEqual(prompt["side_question"], "Explain that answer")
        self.assertIn("client-supplied", side.SYSTEM_PROMPT)
        self.assertEqual(side.build_prompt("q", parent, "n"), side.build_prompt("q", parent, "n", history=[]))

    def test_maximum_pairs_and_codepoints_are_inclusive(self):
        history = side_history("😀" * 30000, "a" * 30000)
        frozen = side.validate_history(history)
        self.assertEqual(sum(len(text) for role, text in frozen), 60000)
        self.assertEqual(side.history_messages(frozen), history)
        self.assertEqual(len(side.validate_history(side_history() * 16)), 32)
        for value in (side_history("a" * 30001, "b" * 30000), side_history() * 17):
            with self.assertRaises(side.SideQuestionError) as caught:
                side.validate_history(value)
            self.assertEqual(caught.exception.status_code, 400)

    def test_invalid_history_roles_pairing_fields_and_unicode_fail_closed(self):
        invalid = [None, {}, "history", [1, 2], [{"role": "user", "text": "incomplete"}],
                   [{"role": "assistant", "text": "first"}, {"role": "user", "text": "second"}],
                   [{"role": "user", "text": "first"}, {"role": "user", "text": "second"}],
                   [{"role": "system", "text": "policy"}, {"role": "assistant", "text": "answer"}],
                   [{"role": "user", "text": "q", "tools": []}, {"role": "assistant", "text": "a"}],
                   side_history("q", "\ud800"), side_history(" ", "a"), side_history("q", 123)]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(side.SideQuestionError) as caught:
                    side.validate_history(value)
                self.assertEqual(caught.exception.status_code, 400)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="side-question-test-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "events.jsonl"

    def write(self, events, suffix=b""):
        self.path.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in events) + suffix)

    def snapshot(self, project=lambda value: value):
        return side.read_context_snapshot(self.path, project)

    def test_preserves_user_and_completed_assistant_deduplicates_final_and_excludes_execution(self):
        self.write([
            event("turn_started", prompt="Why blue?"),
            event("assistant_text", phase="final_answer", text="It scatters."),
            event("assistant_text", phase="analysis", text="hidden raw reasoning"),
            event("tool_started", tool={"name": "danger", "input": "private"}),
            event("reasoning_summary", text="private reasoning"),
            event("turn_finished", result_text="It scatters."),
            event("turn_queued", prompt="queued instructions"),
            event("turn_started", run="job", purpose="scheduled_job", job_id="cron", prompt="auto"),
            event("assistant_text", run="job", text="job output"),
            event("turn_started", run="next", prompt="And red?"),
            event("reasoning_summary", run="next", phase="commentary", text="Checking the comparison."),
        ], b'{"type":"assistant_text","text":"partial')
        messages, note = self.snapshot()
        self.assertEqual(messages, [
            {"role": "user", "text": "Why blue?"}, {"role": "assistant", "text": "It scatters."},
            {"role": "user", "text": "And red?"},
            {"role": "assistant", "text": "Checking the comparison."},
        ])
        self.assertIn("excludes tool results", note)
        self.assertNotIn("Older text was omitted", note)

    def test_projector_removes_authority_and_hidden_import_segments(self):
        self.write([event("turn_started", prompt="user text AUTHORITY"),
                    event("assistant_text", text="answer"),
                    event("turn_started", prompt="hidden provider wake"),
                    event("assistant_text", text="hidden wake answer"),
                    event("turn_started", prompt="human question"),
                    event("assistant_text", text="human answer")])
        def project(row):
            if row.get("prompt") == "hidden provider wake":
                return {**row, "prompt": ""}
            return {**row, "prompt": str(row.get("prompt", "")).replace(" AUTHORITY", "")}
        messages, _ = self.snapshot(project)
        self.assertEqual([message["text"] for message in messages],
                         ["user text", "answer", "human question", "human answer"])

    def test_tail_requires_new_boundary_and_discloses_truncation(self):
        self.write([event("turn_started", prompt="old"), event("assistant_text", text="x" * 500),
                    event("assistant_text", text="unproven mid-run"),
                    event("turn_started", run="latest", prompt="latest question"),
                    event("assistant_text", run="latest", text="latest answer")])
        with patch.object(side, "MAX_LOG_BYTES", 390):
            messages, note = self.snapshot()
        self.assertEqual([message["text"] for message in messages], ["latest question", "latest answer"])
        self.assertIn("Older text was omitted", note)

    def test_context_budget_keeps_latest_message_and_labels_trim(self):
        self.write([event("turn_started", prompt="question"), event("assistant_text", text="abcdef" * 10)])
        with patch.object(side, "MAX_CONTEXT_CHARS", 20):
            messages, note = self.snapshot()
        self.assertEqual(messages[0]["text"], "[Beginning omitted]\n" + ("abcdef" * 10)[-20:])
        self.assertIn("Older text was omitted", note)

    def test_empty_context_fails_without_fake_prompt(self):
        self.write([event("turn_queued", prompt="not accepted"), event("assistant_text", text="orphan")])
        with self.assertRaises(side.SideQuestionError) as caught:
            self.snapshot()
        self.assertEqual(caught.exception.status_code, 409)

    def test_environment_strips_authority_without_replacing_auth_home(self):
        env = {"HOME": "/synthetic/auth-home", "PATH": "/bin", "ANTHROPIC_API_KEY": "synthetic",
               "AGENTSDOCK_CHAT_ID": "parent", "AGENTSDOCK_TEAM_AUTHORITY": "secret",
               "ZENITHBOT_AGENT_TOKEN": "secret", "CODEX_THREAD_ID": "parent",
               "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1", "TMUX": "parent"}
        self.assertEqual(side.isolated_environment(env),
                         {"HOME": "/synthetic/auth-home", "PATH": "/bin", "ANTHROPIC_API_KEY": "synthetic"})


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_history_is_frozen_for_receipt_identity_and_provider_input(self):
        answer = AsyncMock(return_value={"answer": "follow-up"})
        runtime = side.SideQuestions(answer)
        self.addAsyncCleanup(runtime.close)
        history = side_history()
        original = side_history()
        receipt = runtime.submit("owner", "chat", "id", "Why?", history=history)
        history[0]["text"] = "mutated by caller"
        history.append({"role": "user", "text": "new unpaired message"})
        self.assertEqual(await receipt.task, {"answer": "follow-up"})
        answer.assert_awaited_once_with("chat", "Why?", history=original)
        answer.await_args.kwargs["history"][1]["text"] = "mutated by provider callback"
        self.assertIs(runtime.submit("owner", "chat", "id", "Why?", history=original), receipt)
        for changed in (side_history(answer="Different answer"), []):
            with self.assertRaises(side.SideQuestionError) as caught:
                runtime.submit("owner", "chat", "id", "Why?", history=changed)
            self.assertEqual(caught.exception.status_code, 409)

    async def test_empty_and_omitted_history_replay_same_legacy_callback(self):
        answer = AsyncMock(return_value={"answer": "legacy"})
        runtime = side.SideQuestions(answer)
        self.addAsyncCleanup(runtime.close)
        receipt = runtime.submit("o", "s", "id", "q")
        self.assertIs(runtime.submit("o", "s", "id", "q", history=[]), receipt)
        await receipt.task
        answer.assert_awaited_once_with("s", "q")

    async def test_duplicate_identity_coalesces_and_changed_question_conflicts(self):
        ready = asyncio.Event()
        calls = []
        async def answer(sid, question):
            calls.append((sid, question))
            await ready.wait()
            return {"answer": "one"}
        runtime = side.SideQuestions(answer)
        first = runtime.submit("owner", "chat", "request", "question")
        self.assertIs(runtime.submit("owner", "chat", "request", "question"), first)
        with self.assertRaises(side.SideQuestionError):
            runtime.submit("owner", "chat", "request", "changed")
        ready.set()
        self.assertEqual(await first.task, {"answer": "one"})
        self.assertEqual(calls, [("chat", "question")])
        self.assertIs(runtime.submit("owner", "chat", "request", "question"), first)
        await runtime.close()

    async def test_cancel_only_exact_owner_session_request_and_reaps_before_return(self):
        entered = asyncio.Event()
        reaped = asyncio.Event()
        async def answer(sid, question):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                reaped.set()
        runtime = side.SideQuestions(answer)
        receipt = runtime.submit("owner", "chat", "request", "q")
        await entered.wait()
        self.assertEqual(await runtime.cancel("other", "chat", "request"), "not_found")
        self.assertEqual(await runtime.cancel("owner", "other", "request"), "not_found")
        self.assertFalse(receipt.task.done())
        self.assertEqual(await runtime.cancel("owner", "chat", "request"), "cancelled")
        self.assertTrue(reaped.is_set())
        self.assertTrue(receipt.task.cancelled())
        await runtime.close()

    async def test_delete_overtaking_post_fences_delayed_request(self):
        answer = AsyncMock()
        runtime = side.SideQuestions(answer)
        self.assertEqual(await runtime.cancel("owner", "chat", "request"), "not_found")
        with self.assertRaises(side.SideQuestionError) as caught:
            runtime.submit("owner", "chat", "request", "delayed")
        self.assertEqual(caught.exception.status_code, 409)
        answer.assert_not_awaited()

    async def test_failure_replays_without_second_provider_call_and_shutdown_cancels(self):
        answer = AsyncMock(side_effect=side.SideQuestionError(503, "unavailable"))
        runtime = side.SideQuestions(answer)
        receipt = runtime.submit("o", "s", "r", "q")
        with self.assertRaises(side.SideQuestionError):
            await receipt.task
        self.assertIs(runtime.submit("o", "s", "r", "q"), receipt)
        answer.assert_awaited_once()
        await runtime.close()
        self.assertEqual(runtime.receipts, {})


class RouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.calls = 0
        self.inputs = []
        async def answer(sid, question, *, history=None):
            self.calls += 1
            self.inputs.append({"session_id": sid, "question": question, "history": history})
            self.started.set()
            try:
                await self.finish.wait()
                return {"backend": "claude", "answer": "Contextual answer", "context_note": "Recent text"}
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        self.runtime = side.SideQuestions(answer)
        self.authorize = Mock()
        router = side.create_side_question_router(authorize=self.authorize,
            session_exists=lambda sid: sid == "chat", runtime=self.runtime)
        self.post = router.routes[0].endpoint
        self.delete = router.routes[1].endpoint

    async def asyncTearDown(self):
        await self.runtime.close()

    def request(self, value=None, *, ensure_ascii=True):
        queue = asyncio.Queue()
        queue.put_nowait({"type": "http.request", "body": json.dumps(value, ensure_ascii=ensure_ascii).encode(), "more_body": False})
        return Request({"type": "http", "method": "POST", "path": "/", "headers":
                        [(b"x-agentsdock-token", b"synthetic-owner")]}, queue.get), queue

    async def test_routes_return_contract_and_do_not_poll(self):
        request, queue = self.request({"request_id": "request", "question": "Question?"})
        task = asyncio.create_task(self.post("chat", request))
        await self.started.wait()
        self.finish.set()
        response = await task
        self.assertEqual(json.loads(response.body), {"request_id": "request", "session_id": "chat",
                         "backend": "claude", "answer": "Contextual answer", "context_note": "Recent text"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertTrue(queue.empty())
        self.authorize.assert_called_once_with(request)

    async def test_utf8_history_larger_than_old_body_limit_is_accepted_and_kept_verbatim(self):
        history = side_history("😀" * 30000, "答" * 30000)
        request, _ = self.request({"request_id": "followup", "question": "Why?", "history": history}, ensure_ascii=False)
        self.finish.set()
        response = await self.post("chat", request)
        self.assertEqual(json.loads(response.body)["answer"], "Contextual answer")
        self.assertEqual(self.inputs, [{"session_id": "chat", "question": "Why?", "history": history}])

    async def test_invalid_history_rejects_before_provider_start(self):
        for history in (None, "text", side_history() * 17, side_history("x" * 60000, "y"),
                        [{"role": "user", "text": "unpaired"}],
                        [{"role": "system", "text": "instructions"}, {"role": "assistant", "text": "answer"}],
                        side_history("q", "\udfff")):
            with self.subTest(history=history):
                request, _ = self.request({"request_id": "invalid", "question": "q", "history": history})
                with self.assertRaises(HTTPException) as caught:
                    await self.post("chat", request)
                self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.calls, 0)

    async def test_body_byte_limit_remains_enforced_with_history(self):
        request, _ = self.request({"request_id": "huge", "question": "q", "history": side_history("x" * side.MAX_REQUEST_BYTES, "answer")})
        with self.assertRaises(HTTPException) as caught:
            await self.post("chat", request)
        self.assertEqual(caught.exception.status_code, 413)
        self.assertEqual(self.calls, 0)

    async def test_history_change_under_duplicate_id_conflicts_without_cancelling_first(self):
        request, _ = self.request({"request_id": "same", "question": "Why?", "history": side_history()})
        task = asyncio.create_task(self.post("chat", request))
        await self.started.wait()
        changed, _ = self.request({"request_id": "same", "question": "Why?", "history": side_history(answer="Other")})
        with self.assertRaises(HTTPException) as caught:
            await self.post("chat", changed)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(self.cancelled.is_set())
        self.finish.set()
        self.assertEqual(json.loads((await task).body)["answer"], "Contextual answer")
        self.assertEqual(self.calls, 1)

    async def test_disconnect_cancels_provider_without_polling(self):
        request, queue = self.request({"request_id": "request", "question": "Question?"})
        task = asyncio.create_task(self.post("chat", request))
        await self.started.wait()
        queue.put_nowait({"type": "http.disconnect"})
        with self.assertRaises(HTTPException) as caught:
            await task
        self.assertEqual(caught.exception.status_code, 499)
        self.assertTrue(self.cancelled.is_set())

    async def test_one_duplicate_disconnect_keeps_other_waiter_alive(self):
        first, queue = self.request({"request_id": "same", "question": "Question?"})
        second, _ = self.request({"request_id": "same", "question": "Question?"})
        task1 = asyncio.create_task(self.post("chat", first))
        await self.started.wait()
        task2 = asyncio.create_task(self.post("chat", second))
        while next(iter(self.runtime.receipts.values())).waiters != 2:
            await asyncio.sleep(0)
        queue.put_nowait({"type": "http.disconnect"})
        with self.assertRaises(HTTPException):
            await task1
        self.assertFalse(self.cancelled.is_set())
        self.finish.set()
        self.assertEqual(json.loads((await task2).body)["answer"], "Contextual answer")
        self.assertEqual(self.calls, 1)

    async def test_delete_cancels_post_and_is_scoped(self):
        request, _ = self.request({"request_id": "request", "question": "Question?"})
        task = asyncio.create_task(self.post("chat", request))
        await self.started.wait()
        receipt = await self.delete("chat", "request", request)
        self.assertEqual(json.loads(receipt.body), {"request_id": "request", "status": "cancelled"})
        with self.assertRaises(HTTPException) as caught:
            await task
        self.assertEqual(caught.exception.status_code, 409)
        self.assertTrue(self.cancelled.is_set())

    async def test_auth_and_shape_fail_before_provider_start(self):
        for payload in ({"request_id": "x", "question": ""},
                        {"request_id": "x", "question": "a" * 8001},
                        {"request_id": "x", "question": "\ud800"},
                        {"request_id": "../parent", "question": "q"},
                        {"request_id": "x", "question": "q", "tools": ["Bash"]}):
            request, _ = self.request(payload)
            with self.assertRaises(HTTPException) as caught:
                await self.post("chat", request)
            self.assertEqual(caught.exception.status_code, 400)
        self.authorize.side_effect = HTTPException(401, "unauthorized")
        request, _ = self.request({"request_id": "x", "question": "q"})
        with self.assertRaises(HTTPException) as caught:
            await self.post("chat", request)
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(self.calls, 0)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        signals = patch.object(side.os, "killpg")
        self.killpg = signals.start()
        self.addCleanup(signals.stop)

    async def test_claude_has_empty_tools_safe_mode_and_no_persistence(self):
        help_text = "--safe-mode --tools --no-session-persistence --strict-mcp-config --name"
        runner = AsyncMock(side_effect=[help_text, '{"result":"A contextual answer","is_error":false}'])
        with patch.object(side, "run_isolated_command", runner), patch.object(side, "_CLAUDE_SUPPORTED", set()):
            answer = await side.answer_claude("snapshot", executable="synthetic-claude", model="sonnet",
                                              env={"HOME": "/synthetic", "AGENTSDOCK_CHAT_ID": "main"})
        self.assertEqual(answer, "A contextual answer")
        command = runner.await_args.args[0]
        for flag in ("--safe-mode", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("--tools") + 1], "")
        self.assertEqual(command[command.index("--name") + 1], "Side question")
        self.assertEqual(command[command.index("--setting-sources") + 1], "")
        self.assertEqual(json.loads(command[command.index("--mcp-config") + 1]), {"mcpServers": {}})
        self.assertNotIn("--resume", command)
        self.assertNotIn("--continue", command)
        self.assertNotIn("--fork-session", command)
        self.assertNotIn("AGENTSDOCK_CHAT_ID", runner.await_args.kwargs["env"])
        self.assertFalse(Path(runner.await_args.kwargs["cwd"]).exists())

    async def test_old_claude_fails_closed(self):
        runner = AsyncMock(return_value="--tools")
        with patch.object(side, "run_isolated_command", runner), patch.object(side, "_CLAUDE_SUPPORTED", set()):
            with self.assertRaises(side.SideQuestionError) as caught:
                await side.answer_claude("q", executable="old-claude", model=None, env={})
        self.assertEqual(caught.exception.status_code, 503)
        runner.assert_awaited_once()

    async def test_owned_process_reads_chunked_output_to_eof(self):
        proc = fake_process([b'{"res', b'ult":"ok"}', b''], [b'warning', b''])
        with patch.object(side.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            output = await side.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={})
        self.assertEqual(output, '{"result":"ok"}')
        self.assertEqual(proc.stdout.read.await_count, 3)
        self.assertEqual(proc.stderr.read.await_count, 2)

    async def test_output_limit_is_enforced_across_chunks(self):
        proc = fake_process([b'1234', b'5678', b''], [b''])
        with patch.object(side.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)), \
                patch.object(side, "MAX_OUTPUT_BYTES", 6):
            with self.assertRaises(side.SideQuestionError) as caught:
                await side.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={})
        self.assertEqual(caught.exception.status_code, 502)

    async def test_cancellation_during_spawn_joins_and_kills_only_owned_process(self):
        started, release = asyncio.Event(), asyncio.Event()
        proc = fake_process([b''], [b''])
        async def spawn(*args, **kwargs):
            self.assertTrue(kwargs["start_new_session"])
            started.set()
            await release.wait()
            return proc
        with patch.object(side.asyncio, "create_subprocess_exec", spawn):
            task = asyncio.create_task(side.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={}))
            await started.wait()
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual({call.args[0] for call in self.killpg.call_args_list}, {proc.pid})
        self.assertIsNotNone(proc.returncode)

    async def test_exited_leader_with_child_pipe_is_killed_on_cancellation(self):
        reading = asyncio.Event()
        proc = fake_process([], [b''])
        proc.returncode = 0
        async def read(_):
            reading.set()
            await asyncio.Event().wait()
        proc.stdout.read = read
        with patch.object(side.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            task = asyncio.create_task(side.run_isolated_command(["fake"], prompt="q", cwd="/synthetic", env={}))
            await reading.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual({call.args[0] for call in self.killpg.call_args_list}, {proc.pid})
        self.assertEqual(self.killpg.call_count, 2)


def fake_process(stdout, stderr):
    proc = SimpleNamespace(pid=123456, returncode=None,
        stdin=SimpleNamespace(write=Mock(), drain=AsyncMock(), close=Mock()),
        stdout=SimpleNamespace(read=AsyncMock(side_effect=stdout)),
        stderr=SimpleNamespace(read=AsyncMock(side_effect=stderr)))
    async def wait():
        proc.returncode = 0
        return 0
    proc.wait = AsyncMock(side_effect=wait)
    return proc


class ServerGlueTests(unittest.TestCase):
    def test_additive_glue_has_no_main_turn_or_state_writes(self):
        source = Path(__file__).with_name("agent_server.py")
        tree = ast.parse(source.read_text(), filename=str(source))
        selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name in {"side_question_context", "answer_side_question"}]
        self.assertEqual(len(selected), 2)
        text = "\n".join(ast.unparse(node) for node in selected)
        for forbidden in ("ACTIVE", "QUEUED_TURNS", "BUSY_SESSIONS", "post_turn", "emit(", "save(",
                          "provider_authority", "goal/", "resume_thread", "fork_thread"):
            self.assertNotIn(forbidden, text)
        self.assertIn("side_questions.answer_claude", text)
        self.assertIn("answer_codex_side_question", text)
        self.assertIn("asyncio.to_thread", text)
        health = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "health")
        self.assertIn("'side_questions': side_questions.capability()", ast.unparse(health))


class ServerCallbackTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).with_name("agent_server.py")
        tree = ast.parse(source.read_text(), filename=str(source))
        selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name in {"side_question_context", "answer_side_question"}]
        cls.code = compile(ast.fix_missing_locations(ast.Module(body=[ast.ImportFrom(
            module="__future__", names=[ast.alias(name="annotations")], level=0), *selected], type_ignores=[])),
            str(source), "exec")

    def setUp(self):
        from public_chat_transcript import PublicTranscriptError, make_public_event_projector
        temporary = tempfile.TemporaryDirectory(prefix="side-question-glue-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / "sessions" / "chat").mkdir(parents=True)
        self.path = root / "sessions" / "chat" / "events.jsonl"
        self.path.write_text(json.dumps(event("turn_started", prompt="Original user context")) + "\n")
        self.session = {"id": "chat", "backend": "claude", "model": "sonnet", "codex_goal": {"status": "active"}}
        self.parent_active = {"chat": {"run_id": "parent", "provider_turn_ready": True}}
        self.parent_queue = {"chat": [{"prompt": "queued work"}]}
        self.namespace = dict(asyncio=asyncio, side_questions=side, STATE_DIR=root,
            SERVER_SHUTTING_DOWN=False, STORE=SimpleNamespace(sessions={"chat": self.session}),
            DEFAULT_BACKEND="claude", BACKEND_CLAUDE="claude", BACKEND_CODEX="codex",
            CLAUDE_BIN="synthetic-claude", CODEX_BIN="synthetic-codex",
            ACTIVE=self.parent_active, QUEUED_TURNS=self.parent_queue,
            public_chat_share_session_exists=lambda sid: sid == "chat",
            session_dir=lambda sid: root / "sessions" / sid,
            events_path=lambda sid: root / "sessions" / sid / "events.jsonl",
            make_public_event_projector=make_public_event_projector, PublicTranscriptError=PublicTranscriptError,
            is_client_visible_event=lambda value: True, event_files_belong_to_session=lambda *args: True,
            project_provider_history_event_for_egress=lambda value, sid: value,
            strip_agentsdock_generated_user_text=lambda value, **kwargs: value,
            FORK_INTERNAL_PURPOSES=set(), runner_env=lambda: {"AGENTSDOCK_CHAT_ID": "parent", "HOME": "/synthetic"})
        exec(self.code, self.namespace)

    async def test_both_backends_use_real_snapshot_and_leave_busy_parent_untouched(self):
        initial_session = json.dumps(self.session, sort_keys=True)
        initial_active = json.dumps(self.parent_active, sort_keys=True)
        initial_queue = json.dumps(self.parent_queue, sort_keys=True)
        claude, codex = AsyncMock(return_value="Claude answer"), AsyncMock(return_value="Codex answer")
        with patch.object(side, "answer_claude", claude), \
                patch.dict(sys.modules, {"codex_side_question": SimpleNamespace(answer_side_question=codex)}):
            first = await self.namespace["answer_side_question"]("chat", "Why?")
            self.assertEqual(first["answer"], "Claude answer")
            self.assertEqual(json.loads(claude.await_args.args[0])["conversation_snapshot"],
                             [{"role": "user", "text": "Original user context"}])
            self.assertNotIn("AGENTSDOCK_CHAT_ID", claude.await_args.kwargs["env"])
            self.session["backend"] = "codex"
            self.session["model"] = "synthetic-model"
            second = await self.namespace["answer_side_question"]("chat", "Why?")
            self.assertEqual(second["answer"], "Codex answer")
            self.assertEqual(codex.await_args.kwargs["model"], "synthetic-model")
            self.session.update(backend="claude", model="sonnet")
        self.assertEqual(json.dumps(self.session, sort_keys=True), initial_session)
        self.assertEqual(json.dumps(self.parent_active, sort_keys=True), initial_active)
        self.assertEqual(json.dumps(self.parent_queue, sort_keys=True), initial_queue)
        self.assertEqual(self.path.read_text().count("\n"), 1)

    async def test_empty_snapshot_and_unsupported_backend_never_launch_provider(self):
        provider = AsyncMock()
        with patch.object(side, "answer_claude", provider):
            self.path.write_text("")
            with self.assertRaises(side.SideQuestionError) as caught:
                await self.namespace["answer_side_question"]("chat", "Why?")
            self.assertEqual(caught.exception.status_code, 409)
            self.session["backend"] = "cursor"
            with self.assertRaises(side.SideQuestionError) as caught:
                await self.namespace["answer_side_question"]("chat", "Why?")
            self.assertEqual(caught.exception.status_code, 503)
        provider.assert_not_awaited()

    async def test_followup_history_reaches_both_isolated_providers_without_parent_writes(self):
        history = side_history("Initial side question", "Initial side answer")
        initial_bytes = self.path.read_bytes()
        initial_active = json.dumps(self.parent_active, sort_keys=True)
        initial_queue = json.dumps(self.parent_queue, sort_keys=True)
        initial_session = json.dumps(self.session, sort_keys=True)
        claude, codex = AsyncMock(return_value="Claude follow-up"), AsyncMock(return_value="Codex follow-up")
        with patch.object(side, "answer_claude", claude), \
                patch.dict(sys.modules, {"codex_side_question": SimpleNamespace(answer_side_question=codex)}):
            await self.namespace["answer_side_question"]("chat", "Explain that", history=history)
            self.session["backend"] = "codex"
            await self.namespace["answer_side_question"]("chat", "Explain that", history=history)
            self.session["backend"] = "claude"
        for provider in (claude, codex):
            prompt = json.loads(provider.await_args.args[0])
            self.assertEqual(prompt["side_history"], history)
            self.assertEqual(prompt["conversation_snapshot"], [{"role": "user", "text": "Original user context"}])
            self.assertEqual(prompt["side_question"], "Explain that")
        self.assertEqual(self.path.read_bytes(), initial_bytes)
        self.assertEqual(json.dumps(self.parent_active, sort_keys=True), initial_active)
        self.assertEqual(json.dumps(self.parent_queue, sort_keys=True), initial_queue)
        self.assertEqual(json.dumps(self.session, sort_keys=True), initial_session)

    async def test_chat_removed_while_snapshot_loading_cannot_launch_provider(self):
        snapshot = self.namespace["side_question_context"]
        def removed_during_snapshot(sid):
            value = snapshot(sid)
            self.namespace["public_chat_share_session_exists"] = lambda sid: False
            return value
        self.namespace["side_question_context"] = removed_during_snapshot
        with patch.object(side, "answer_claude", AsyncMock()) as provider:
            with self.assertRaises(side.SideQuestionError) as caught:
                await self.namespace["answer_side_question"]("chat", "Why?")
        self.assertEqual(caught.exception.status_code, 404)
        provider.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
