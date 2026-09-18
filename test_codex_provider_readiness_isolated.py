"""Production readiness projection without importing or starting agent_server."""
from __future__ import annotations

import ast
import json
from pathlib import Path
import re
import subprocess
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).with_name("agent_server.py")
NAMES = {"probe_runtime", "runtime_diagnostic_payload", "safe_runtime_version", "auth_failure_text", "discover_codex_catalog"}
NODES = [node for node in ast.parse(SOURCE.read_text()).body
         if isinstance(node, ast.FunctionDef) and node.name in NAMES]
assert {node.name for node in NODES} == NAMES
CODE = compile(ast.Module(body=NODES, type_ignores=[]), str(SOURCE), "exec")


class CodexProviderReadinessTests(unittest.TestCase):
    def setUp(self):
        self.store = SimpleNamespace(selection=Mock(return_value={"base_url": "https://gateway.example/v1", "model": "gpt-6-astra"}))
        self.command = Mock(return_value=subprocess.CompletedProcess([], 0, "Codex 0.153.3", ""))
        self.ns = {"Any": object, "Path": Path, "re": re, "time": time, "json": json, "subprocess": subprocess,
            "BACKEND_CODEX": "codex", "BACKEND_CLAUDE": "claude", "BACKEND_CURSOR": "cursor",
            "CODEX_PROVIDER_STORE": self.store, "CODEX_TRANSPORT": "app-server", "CODEX_TRANSPORT_EXEC": "exec",
            "runtime_display_name": lambda backend: backend, "runtime_action": lambda *args, **kwargs: None,
            "now_iso": lambda: "2026-09-17T00:00:00Z", "runtime_executable": lambda backend: backend,
            "runner_env": lambda: {"PATH": "/synthetic"}, "shutil": SimpleNamespace(which=lambda *args, **kwargs: "/synthetic/codex"),
            "runtime_command": self.command, "logger": Mock()}
        exec(CODE, self.ns)

    def test_custom_provider_skips_normal_login_and_never_contacts_endpoint(self):
        result = self.ns["probe_runtime"]("codex")
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["authenticated"])
        self.assertIn("configured", result["message"])
        self.assertIn("Test connection", result["message"])
        self.command.assert_called_once_with(["/synthetic/codex", "--version"])
        self.store.selection.assert_called_once_with()

    def test_normal_codex_login_path_unchanged(self):
        self.store.selection.return_value = None
        self.command.side_effect = [subprocess.CompletedProcess([], 0, "Codex 0.153.3", ""),
                                   subprocess.CompletedProcess([], 1, "", "Not logged in")]
        result = self.ns["probe_runtime"]("codex")
        self.assertEqual(result["status"], "unauthenticated")
        self.command.assert_called_with(["/synthetic/codex", "login", "status"])

    def test_storage_failure_fails_closed_without_secret_error_text(self):
        self.store.selection.side_effect = RuntimeError("synthetic-secret-do-not-display")
        result = self.ns["probe_runtime"]("codex")
        self.assertEqual(result["status"], "error")
        self.assertNotIn("synthetic-secret", str(result))
        self.command.assert_called_once()

    def test_exec_transport_does_not_claim_custom_endpoint_readiness(self):
        self.ns["CODEX_TRANSPORT"] = "exec"
        self.assertEqual(self.ns["probe_runtime"]("codex")["status"], "error")
        self.command.assert_called_once()

    def test_claude_does_not_read_or_use_codex_provider_settings(self):
        self.command.side_effect = [subprocess.CompletedProcess([], 0, "Claude 1.0", ""),
                                   subprocess.CompletedProcess([], 0, '{"loggedIn":true}', "")]
        self.assertEqual(self.ns["probe_runtime"]("claude")["status"], "ready")
        self.store.selection.assert_not_called()

    def test_custom_model_catalog_preserves_exact_model_and_skips_openai_discovery(self):
        self.store.selection.return_value = {"base_url": "https://gateway.example/v1", "model": "openai/openai/gpt-6-astra"}
        result = self.ns["discover_codex_catalog"]()
        self.assertEqual(result["default_model"], "openai/openai/gpt-6-astra")
        self.assertEqual([item["value"] for item in result["models"]], ["", "openai/openai/gpt-6-astra"])
        self.assertEqual(result["efforts"], [])
        self.assertEqual(result["model_efforts"], {"openai/openai/gpt-6-astra": []})
        self.command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
