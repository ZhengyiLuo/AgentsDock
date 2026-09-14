"""Checkpoint/native ownership proof using temporary files and AST public parsers only."""
import ast
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock
import codex_history_repair as repair

from codex_history_repair import (
    CodexNativeHistoryRepairCache, CodexNativeHistoryProofUnavailable,
    filter_native_codex_history_items, _native_assistant_text,
)
from test_codex_goal_history_isolated import load_projection

PROVIDER = "11111111-2222-3333-4444-555555555555"


class CodexNativeHistoryRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.events = self.root / "events.jsonl"
        self.source = self.root / f"rollout-{PROVIDER}.jsonl"
        self.cache = CodexNativeHistoryRepairCache()
        self.parse = load_projection()["codex_history_event_item"]
        self.raw, self.native = [], []
        for number, (prompt, answer) in enumerate((("Genuine human request", "Original answer"), ("Scheduled input", "Scheduled report")), 1):
            turn, run = f"turn-{number}", f"native-{number}"
            for role, text in (("user", prompt), ("assistant", answer)):
                self.raw.append({"type": "response_item", "timestamp": f"2026-09-11T12:0{number}:0{role == 'assistant' and 1 or 0}.123Z",
                    "payload": {"type": "message", "role": role, "id": f"item-{number}-{role}",
                        "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}],
                        "internal_chat_message_metadata_passthrough": {"turn_id": turn, "content_item_kinds": ["user.text"] if role == "user" else []}}})
            fields = {"job_id": "schedule", "purpose": "scheduled_job"} if number == 2 else {}
            self.native.extend([
                {"seq": number * 3 - 2, "id": f"native-input-{number}", "run_id": run, "type": "turn_started", "prompt": prompt, **fields},
                {"seq": number * 3 - 1, "id": f"native-answer-{number}", "run_id": run, "type": "assistant_text", "text": answer, **fields},
                {"seq": number * 3, "id": f"native-end-{number}", "run_id": run, "type": "turn_finished", "backend": "codex",
                    "transport": "app-server", "provider_thread_id": PROVIDER, "provider_turn_id": turn, "result_text": answer, **fields}])
        self.fixture()

    def fixture(self, mutate_checkpoint=None):
        source = [{"type": "session_meta", "payload": {"id": PROVIDER}}, *self.raw]
        raw = b"".join((json.dumps(row) + "\n").encode() for row in source)
        self.source.write_bytes(raw)
        stat = self.source.stat()
        checkpoint = {"version": 1, "previous_present": False, "previous_source_offset": 0, "previous_source_digest": "", "cursor": {
            "version": 1, "backend": "codex", "provider_session_id": PROVIDER, "source_path": str(self.source),
            "source_dev": stat.st_dev, "source_ino": stat.st_ino, "source_offset": len(raw), "source_digest": hashlib.sha256(raw).hexdigest()}}
        if mutate_checkpoint:
            mutate_checkpoint(checkpoint)
        self.imports = [{"seq": index + 101, "id": f"import-{index}", "run_id": "import_fixture", "backend": "codex", "imported": True,
            "type": "turn_started" if row["payload"]["role"] == "user" else "assistant_text", "ts": row["timestamp"],
            "provider_user_authored": row["payload"]["role"] == "user", "provider_history_sanitized": True,
            "prompt" if row["payload"]["role"] == "user" else "text": row["payload"]["content"][0]["text"]} for index, row in enumerate(self.raw)]
        rows = [*self.native, {"seq": 100, "type": "history_imported", "run_id": "import_fixture", "backend": "codex",
            "provider_session_id": PROVIDER, "source_path": str(self.source), "_history_sync_checkpoint": checkpoint}, *self.imports,
            {"seq": 200, "type": "turn_finished", "run_id": "import_fixture", "backend": "codex", "imported": True}]
        self.events.write_text("".join(json.dumps({"session_id": "chat", **row}) + "\n" for row in rows))

    def prepare(self):
        self.cache.prepare("chat", PROVIDER, self.events, self.source, self.root, self.parse)

    def test_exact_human_and_scheduled_copies_are_hidden_originals_unchanged(self):
        before = self.events.read_bytes(), self.source.read_bytes()
        self.prepare()
        projected = [self.cache.project_event("chat", row) for row in self.imports]
        self.assertTrue(all(projected))
        self.assertTrue(projected[0]["provider_user_authored"])
        self.assertEqual(projected[0]["prompt"], "")
        self.assertEqual(projected[2]["provider_origin"]["turn_id"], "turn-2")
        self.assertTrue(all(self.cache.project_event("chat", row) is None for row in self.native))
        self.assertEqual(before, (self.events.read_bytes(), self.source.read_bytes()))

    def test_unowned_same_text_different_turn_and_changed_import_stay_visible(self):
        self.raw.append({**self.raw[0], "timestamp": "2026-09-11T12:09:00Z", "payload": {**self.raw[0]["payload"],
            "id": "other-source-item", "internal_chat_message_metadata_passthrough": {"turn_id": "unowned-turn", "content_item_kinds": ["user.text"]}}})
        self.fixture(); self.prepare()
        self.assertIsNone(self.cache.project_event("chat", self.imports[-1]))
        self.assertIsNone(self.cache.project_event("chat", {**self.imports[0], "prompt": "Changed genuine text"}))
        self.assertIsNone(self.cache.project_event("different-chat", self.imports[0]))

    def test_tampered_checkpoint_and_wrong_terminal_thread_fail_visible(self):
        self.fixture(lambda value: value["cursor"].update(source_digest="0" * 64)); self.prepare()
        self.assertFalse(self.cache.signature("chat"))
        self.cache.forget("chat")
        for event in self.native:
            if event["type"] == "turn_finished":
                event["provider_thread_id"] = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.fixture(); self.prepare()
        self.assertFalse(self.cache.signature("chat"))

    def test_forward_verified_items_keep_unowned_message_and_no_source_rescan(self):
        items = [self.parse(row) for row in self.raw]
        extra = {**items[0], "provider_origin": {**items[0]["provider_origin"], "turn_id": "other-turn"}}
        result = filter_native_codex_history_items("chat", PROVIDER, self.events, [*items, extra])
        self.assertEqual(result[-1], extra)
        self.assertEqual([item["text"] for item in result[:-1]], ["", ""])
        self.assertTrue(all(item["provider_history_repair"] == "source_proven_native_replay" for item in result[:-1]))
        self.cache.prepare("chat", PROVIDER, self.events, None, self.root, self.parse)
        self.cache.forget("chat")
        self.prepare()
        self.assertEqual(len(self.cache.signature("chat")), 4)

    def test_assistant_normalization_matches_actual_native_cleaner(self):
        tree = ast.parse(Path(__file__).with_name("agent_server.py").read_text())
        selected = [node for node in tree.body if (
            isinstance(node, ast.FunctionDef) and node.name == "clean_assistant_text"
        ) or (isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "LEADING_DECORATION_RE" for target in node.targets
        ))]
        self.assertEqual(len(selected), 2)
        namespace = {"re": re}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "native-cleaner", "exec"), namespace)
        for text in ("✅ Scheduled report", "  :white_check_mark: Report\n⚠️ Detail", "  Unchanged text  ", "Text ✅ remains", "✅"):
            self.assertEqual(_native_assistant_text(text), namespace["clean_assistant_text"](text))

    def test_same_item_decorated_scheduled_assistant_repair_and_import_filter(self):
        self.raw[3]["payload"]["content"][0]["text"] = "✅ Scheduled report"
        self.native[4]["item_id"] = self.raw[3]["payload"]["id"]
        self.fixture()
        before = self.events.read_bytes(), self.source.read_bytes()
        self.prepare()
        projected = self.cache.project_event("chat", self.imports[3])
        self.assertEqual(projected["text"], "")
        self.assertEqual(projected["provider_origin"]["native_event_id"], self.native[4]["id"])
        self.assertEqual(projected["provider_origin"]["source_text_sha256"], hashlib.sha256("✅ Scheduled report".encode()).hexdigest())
        self.assertEqual(projected["ts"], self.imports[3]["ts"])
        items = [self.parse(row) for row in self.raw]
        self.assertEqual(len(filter_native_codex_history_items("chat", PROVIDER, self.events, items)), 2)
        self.assertTrue(all(self.cache.project_event("chat", row) is None for row in self.native))
        self.assertEqual(before, (self.events.read_bytes(), self.source.read_bytes()))

    def test_decorated_assistant_requires_same_public_item_and_complete_body(self):
        self.raw[3]["payload"]["content"][0]["text"] = "✅ Scheduled report"
        for item_id, event_type, text in (
            (None, "assistant_text", "Scheduled report"),
            ("different-item", "assistant_text", "Scheduled report"),
            ("item-2-assistant", "reasoning_summary", "Scheduled report"),
            ("item-2-assistant", "assistant_text", "Scheduled report changed"),
        ):
            with self.subTest(item_id=item_id, event_type=event_type, text=text):
                self.native[4].update(item_id=item_id, type=event_type, text=text)
                self.fixture(); self.cache.forget("chat"); self.prepare()
                self.assertIsNone(self.cache.project_event("chat", self.imports[3]))
                item = self.parse(self.raw[3])
                self.assertEqual(filter_native_codex_history_items("chat", PROVIDER, self.events, [item]), [item])

    def test_user_decorations_are_not_assistant_normalization_credits(self):
        self.raw[2]["payload"]["content"][0]["text"] = "✅ Scheduled input"
        self.native[3]["item_id"] = self.raw[2]["payload"]["id"]
        self.fixture(); self.prepare()
        self.assertIsNone(self.cache.project_event("chat", self.imports[2]))
        item = self.parse(self.raw[2])
        self.assertEqual(filter_native_codex_history_items("chat", PROVIDER, self.events, [item]), [item])

    def wake_fixture(self, **patch):
        self.wake_text = "Check the unread mailbox using the chat inbox tool."
        self.raw[0]["payload"]["content"][0]["text"] = self.wake_text
        self.native[0].update(prompt="", purpose="chat_mailbox_wake", provider_generated=True,
            mailbox_wake_id="mailwake_" + "a" * 32, mailbox_wake_through_seq=7,
            provider_input_sha256=hashlib.sha256(self.wake_text.encode()).hexdigest())
        self.native[0].update(patch)
        self.fixture()

    def test_mailbox_wake_exact_native_input_is_silent_without_losing_native_output(self):
        self.wake_fixture()
        before = self.events.read_bytes(), self.source.read_bytes()
        self.prepare()
        projected = self.cache.project_event("chat", self.imports[0])
        self.assertEqual(projected["prompt"], "")
        self.assertEqual(projected["provider_history_repair"], "source_proven_native_replay")
        self.assertEqual(projected["provider_origin"]["native_event_id"], self.native[0]["id"])
        self.assertTrue(all(self.cache.project_event("chat", row) is None for row in self.native))
        item = self.parse(self.raw[0])
        filtered = filter_native_codex_history_items("chat", PROVIDER, self.events, [item])
        self.assertEqual(filtered[0]["text"], "")
        self.assertTrue(filtered[0]["metadata_only"])
        self.assertEqual(before, (self.events.read_bytes(), self.source.read_bytes()))

    def test_mailbox_wake_incomplete_or_positive_human_native_metadata_is_not_proof(self):
        for patch in ({"provider_generated": False}, {"mailbox_wake_id": "missing-claim"},
                      {"mailbox_wake_through_seq": True}, {"provider_input_sha256": "0" * 64},
                      {"provider_user_authored": True}, {"client_user_message_id": "real-user"},
                      {"purpose": None}, {"prompt": "Visible human input"}):
            with self.subTest(patch=patch):
                self.native[0].pop("provider_user_authored", None)
                self.native[0].pop("client_user_message_id", None)
                self.wake_fixture(**patch); self.cache.forget("chat"); self.prepare()
                self.assertIsNone(self.cache.project_event("chat", self.imports[0]))
                item = self.parse(self.raw[0])
                self.assertEqual(filter_native_codex_history_items("chat", PROVIDER, self.events, [item]), [item])

    def test_mailbox_wake_same_words_unowned_or_ambiguous_source_are_preserved(self):
        self.wake_fixture()
        self.raw.append({**self.raw[0], "timestamp": "2026-09-11T12:09:00Z", "payload": {**self.raw[0]["payload"],
            "id": "genuine-user-item", "internal_chat_message_metadata_passthrough": {
                "turn_id": "unowned-human-turn", "content_item_kinds": ["user.text"]}}})
        self.fixture(); self.prepare()
        self.assertIsNotNone(self.cache.project_event("chat", self.imports[0]))
        self.assertIsNone(self.cache.project_event("chat", self.imports[-1]))
        self.raw[-1]["payload"]["internal_chat_message_metadata_passthrough"]["turn_id"] = "turn-1"
        self.fixture(); self.cache.forget("chat"); self.prepare()
        self.assertIsNone(self.cache.project_event("chat", self.imports[0]))
        items = [self.parse(self.raw[0]), self.parse(self.raw[-1])]
        self.assertEqual(filter_native_codex_history_items("chat", PROVIDER, self.events, items), items)

    def large_tool_fixture(self):
        """Actual bytes beyond the incident's 48 MB ledger / 213 MB rollout.

        Streaming fixture creation deliberately does not allocate/read back
        either whole log. Tools are irrelevant proof inputs, not fake messages.
        """
        source_rows = [json.loads(line) for line in self.source.read_text().splitlines()]
        ledger_rows = [json.loads(line) for line in self.events.read_text().splitlines()]
        body = "x" * (1024 * 1024)
        tool = (json.dumps({"type": "response_item", "payload": {
            "type": "function_call_output", "output": body}}) + "\n").encode()
        digest = hashlib.sha256()
        with self.source.open("wb") as stream:
            header = (json.dumps(source_rows[0]) + "\n").encode()
            stream.write(header); digest.update(header)
            while stream.tell() < 213_000_000:
                stream.write(tool); digest.update(tool)
            for row in source_rows[1:]:
                line = (json.dumps(row) + "\n").encode()
                stream.write(line); digest.update(line)
        stamp = self.source.stat()
        for row in ledger_rows:
            if row.get("type") == "history_imported":
                row["_history_sync_checkpoint"]["cursor"].update(
                    source_dev=stamp.st_dev, source_ino=stamp.st_ino,
                    source_offset=stamp.st_size, source_digest=digest.hexdigest())
        with self.events.open("wb") as stream:
            for row in ledger_rows:
                stream.write((json.dumps(row) + "\n").encode())
            seq = max(row["seq"] for row in ledger_rows)
            while stream.tell() < 48_104_032:
                seq += 1
                stream.write((json.dumps({"seq": seq, "type": "tool_completed",
                    "session_id": "chat", "run_id": "native-2", "output": body}) + "\n").encode())
        self.assertGreater(self.source.stat().st_size, 213_000_000)
        self.assertGreater(self.events.stat().st_size, 48_104_032)

    def test_actual_large_tool_heavy_logs_repair_cron_wake_without_hiding_real_user(self):
        self.wake_fixture()
        self.raw.append({**self.raw[0], "timestamp": "2026-09-11T12:09:00Z", "payload": {
            **self.raw[0]["payload"], "id": "genuine-user-item",
            "internal_chat_message_metadata_passthrough": {
                "turn_id": "unowned-human-turn", "content_item_kinds": ["user.text"]}}})
        self.fixture()
        self.large_tool_fixture()
        def identity(path):
            value = path.stat()
            return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns

        before = identity(self.events), identity(self.source)
        self.prepare()
        wake = self.cache.project_event("chat", self.imports[0])
        cron = self.cache.project_event("chat", self.imports[2])
        self.assertEqual(wake["prompt"], "")
        self.assertEqual(wake["provider_origin"]["native_event_id"], "native-input-1")
        self.assertEqual(cron["prompt"], "")
        self.assertEqual(cron["provider_origin"]["native_event_id"], "native-input-2")
        self.assertIsNone(self.cache.project_event("chat", self.imports[-1]))
        self.assertTrue(all(self.cache.project_event("chat", row) is None for row in self.native))
        self.assertEqual(self.native[3]["purpose"], "scheduled_job")
        items = [self.parse(row) for row in self.raw]
        filtered = filter_native_codex_history_items("chat", PROVIDER, self.events, items)
        self.assertEqual([row["text"] for row in filtered], ["", "", self.wake_text])
        self.assertEqual(before, (identity(self.events), identity(self.source)))

    def test_source_proof_stops_at_frozen_checkpoint_not_later_unrelated_tail(self):
        # Later source bytes are outside every imported checkpoint. Even a
        # partial in-progress record must not invalidate the immutable prefix.
        with self.source.open("ab") as stream:
            stream.write(b'{"type":"response_item","payload":')
        self.prepare()
        self.assertEqual(len(self.cache.signature("chat")), 4)

    def test_cancelled_or_expired_proof_is_not_cached_or_returned_as_raw_import(self):
        for arguments in ({"cancelled": lambda: True}, {"deadline": 0.0}):
            with self.subTest(arguments=arguments):
                with self.assertRaises(CodexNativeHistoryProofUnavailable):
                    self.cache.prepare("chat", PROVIDER, self.events, self.source, self.root, self.parse, **arguments)
                self.assertFalse(self.cache.is_prepared("chat", PROVIDER))
                with self.assertRaises(CodexNativeHistoryProofUnavailable):
                    filter_native_codex_history_items("chat", PROVIDER, self.events,
                                                     [self.parse(self.raw[0])], **arguments)
        self.prepare()
        self.assertEqual(len(self.cache.signature("chat")), 4)

    def test_relevant_key_budget_exhaustion_defers_instead_of_importing_raw_text(self):
        with mock.patch("codex_history_repair.MAX_KEYS", 1):
            with self.assertRaises(CodexNativeHistoryProofUnavailable):
                filter_native_codex_history_items("chat", PROVIDER, self.events, [self.parse(self.raw[0])])
            with self.assertRaises(CodexNativeHistoryProofUnavailable):
                self.prepare()
        self.assertFalse(self.cache.is_prepared("chat", PROVIDER))
        self.prepare()
        self.assertEqual(len(self.cache.signature("chat")), 4)

    def test_mid_scan_cancellation_and_prepared_projection_need_no_further_io(self):
        checks = 0

        def cancel_between_records():
            nonlocal checks
            checks += 1
            return checks >= 5

        with self.assertRaises(CodexNativeHistoryProofUnavailable):
            self.cache.prepare("chat", PROVIDER, self.events, self.source, self.root,
                               self.parse, cancelled=cancel_between_records)
        self.assertEqual(checks, 5)
        self.assertFalse(self.cache.is_prepared("chat", PROVIDER))
        self.prepare()
        with mock.patch("codex_history_repair._native_records", side_effect=AssertionError("hot-path read")):
            self.prepare()
            self.assertEqual(self.cache.project_event("chat", self.imports[0])["prompt"], "")
            self.assertIsNone(self.cache.project_event("chat", self.native[0]))

    def test_source_mutation_during_proof_never_publishes_or_caches_partial_proof(self):
        changed = False

        def mutating_parse(record):
            nonlocal changed
            item = self.parse(record)
            if item is not None and not changed:
                changed = True
                with self.source.open("ab") as stream:
                    stream.write(b'{}\n')
            return item

        with self.assertRaises(CodexNativeHistoryProofUnavailable):
            self.cache.prepare("chat", PROVIDER, self.events, self.source, self.root, mutating_parse)
        self.assertTrue(changed)
        self.assertFalse(self.cache.is_prepared("chat", PROVIDER))
        self.assertFalse(self.cache.signature("chat"))
        self.fixture(); self.prepare()
        self.assertEqual(len(self.cache.signature("chat")), 4)

    def test_ledger_mutation_or_bad_sequence_defers_new_import(self):
        calls = 0

        def mutate_without_cancel():
            nonlocal calls
            calls += 1
            if calls == 3:
                with self.events.open("ab") as stream:
                    stream.write(b'{"seq":201,"type":"tool_completed"}\n')
            return False

        with self.assertRaises(CodexNativeHistoryProofUnavailable):
            filter_native_codex_history_items("chat", PROVIDER, self.events,
                                             [self.parse(self.raw[0])], cancelled=mutate_without_cancel)
        self.fixture()
        with self.events.open("ab") as stream:
            stream.write(b'{"seq":1,"type":"tool_completed"}\n')
        with self.assertRaises(CodexNativeHistoryProofUnavailable):
            filter_native_codex_history_items("chat", PROVIDER, self.events, [self.parse(self.raw[0])])

    def test_retained_source_hash_must_be_absent_or_exact_digest(self):
        for value in ("f" * (2 * 1024 * 1024), "f" * 63, "g" * 64, {"hash": "f" * 64}):
            with self.subTest(kind=type(value).__name__, size=len(value)):
                self.assertIsNone(repair._replay_target({**self.imports[0], "source_text_sha256": value}))
        self.assertIsNotNone(repair._replay_target(self.imports[0]))
        self.assertIsNotNone(repair._replay_target({**self.imports[0], "source_text_sha256": "f" * 64}))

    def test_expiry_after_source_scan_stops_target_matching_without_cached_proof(self):
        clock = {"now": 0.0}
        original = repair._native_records

        def records_then_expire(path, *args, **kwargs):
            yield from original(path, *args, **kwargs)
            if path == self.source:
                clock["now"] = 6.0

        with mock.patch.object(repair, "_native_records", side_effect=records_then_expire), \
                mock.patch.object(repair.time, "monotonic", side_effect=lambda: clock["now"]):
            with self.assertRaises(CodexNativeHistoryProofUnavailable):
                self.cache.prepare("chat", PROVIDER, self.events, self.source, self.root, self.parse, deadline=5.0)
        self.assertFalse(self.cache.is_prepared("chat", PROVIDER))
        self.assertFalse(self.cache.signature("chat"))

    def test_expiry_acquiring_final_cache_lock_cannot_admit_completed_proof(self):
        clock = {"now": 0.0}

        class ExpiringLock:
            acquisitions = 0

            def __enter__(lock):
                lock.acquisitions += 1
                if lock.acquisitions == 2:
                    clock["now"] = 6.0

            def __exit__(lock, *_args):
                return False

        with mock.patch.object(self.cache, "_lock", ExpiringLock()), \
                mock.patch.object(repair.time, "monotonic", side_effect=lambda: clock["now"]):
            with self.assertRaises(CodexNativeHistoryProofUnavailable):
                self.cache.prepare("chat", PROVIDER, self.events, self.source, self.root, self.parse, deadline=5.0)
        self.assertFalse(self.cache.is_prepared("chat", PROVIDER))
        self.assertIsNone(self.cache._preparing)
        self.prepare()
        self.assertEqual(len(self.cache.signature("chat")), 4)


if __name__ == "__main__":
    unittest.main()
