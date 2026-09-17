"""Ephemeral Codex answers, never attached to the main provider thread."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import json
from pathlib import Path
import tempfile

from codex_app_server import CodexAppServerClient, CodexAppServerError
from side_questions import (
    MAX_OUTPUT_BYTES, SYSTEM_PROMPT, SideQuestionError,
    isolated_environment, run_isolated_command,
)


# No user/project hooks, integrations, subagents, or hosted tools. Environment
# access is separately disabled on BOTH thread/start and turn/start: read-only
# sandboxing alone would still permit reading the user's files.
DISABLED_FEATURES = (
    "apps", "plugins", "remote_plugin", "recommended_plugins", "hooks",
    "multi_agent", "multi_agent_v2", "goals", "image_generation", "memories",
    "shell_tool", "shell_snapshot", "shell_snapshot_v2", "computer_use",
    "browser_use", "browser_use_external", "in_app_browser", "artifact",
    "request_permissions_tool", "deferred_executor", "code_mode", "code_mode_only",
    "code_mode_host", "current_time_reminder", "sleep_tool", "token_budget",
    "context_management", "realtime_conversation",
    "background_paginated_rollout_migration",
)


def isolated_config() -> dict:
    return {
        **{f"features.{name}": False for name in DISABLED_FEATURES},
        "web_search": "disabled", "tools.update_plan.enabled": False,
        "tools.experimental_request_user_input.enabled": False,
        "agents.enabled": False, "notify": [],
        "orchestrator.skills.enabled": False, "orchestrator.mcp.enabled": False,
        "skills.include_instructions": False, "skills.bundled.enabled": False,
        "features.skip_host_skill_discovery": True,
        "project_doc_max_bytes": 0, "developer_instructions": SYSTEM_PROMPT,
    }


def supports_empty_environments(schema: dict) -> bool:
    definitions = schema.get("definitions", {})
    for name in ("ThreadStartParams", "TurnStartParams"):
        properties = definitions.get(name, {}).get("properties", {})
        environment = properties.get("environments", {})
        if "array" not in environment.get("type", []):
            return False
        # Fail closed for older protocols which silently ignore unknown fields.
        if "disables environment access" not in environment.get("description", ""):
            return False
    return "ephemeral" in definitions["ThreadStartParams"]["properties"]


async def _verify_protocol(executable: str, temporary: str, env: dict):
    target = Path(temporary) / "schema"
    await run_isolated_command(
        [executable, "app-server", "generate-json-schema", "--experimental", "--out", str(target)],
        prompt="", cwd=temporary, env=env, timeout=15,
    )
    try:
        source = target / "codex_app_server_protocol.v2.schemas.json"
        if source.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("schema too large")
        supported = supports_empty_environments(json.loads(source.read_text()))
    except (OSError, ValueError, TypeError, AttributeError):
        supported = False
    if not supported:
        raise SideQuestionError(503, "Update Codex to use isolated side questions")


async def answer_side_question(prompt: str, *, executable: str, model: str | None, env: dict) -> str:
    env = isolated_environment(env)
    with tempfile.TemporaryDirectory(prefix="agentsdock-side-question-") as temporary:
        await _verify_protocol(executable, temporary, env)
        config = isolated_config()
        # Keep Codex's configured runtime/auth state. A fresh sqlite_home while
        # retaining its history root triggers startup reindexing of all old
        # rollouts. The new ephemeral thread isolates conversation history;
        # this owned child shares only normal provider runtime state, like the
        # CLI, and cancellation still closes only this exact child process.
        config.update({
            "log_dir": str(Path(temporary) / "log"),
            "history.persistence": "none",
        })
        args = [part for key, value in config.items() for part in ("-c", f"{key}={json.dumps(value)}")]
        client = CodexAppServerClient(
            executable, cwd=temporary, env_factory=lambda: env,
            app_server_args=args, request_timeout=20, lifecycle_timeout=30,
            process_stream_limit=MAX_OUTPUT_BYTES, notification_queue_limit=512,
        )
        # Join a cancelled start before closing: cancellation must never lose
        # the exact new subprocess handle before its owner can reap it.
        starting = asyncio.create_task(client.start())
        try:
            await asyncio.shield(starting)
            effective = await client.request("config/read", {"includeLayers": False})
            settings = effective.get("config") if isinstance(effective, dict) else None
            if not isinstance(settings, dict):
                raise SideQuestionError(503, "Codex could not confirm isolated configuration")
            servers = settings.get("mcp_servers", {})
            if not isinstance(servers, dict):
                raise SideQuestionError(503, "Codex could not confirm isolated integrations")
            # Empty maps merge with inherited configuration; explicitly turn
            # off each configured server instead of assuming {} clears them.
            if any(not isinstance(value, dict) for value in servers.values()):
                raise SideQuestionError(503, "Codex could not confirm isolated integrations")
            # RPC config paths split on literal dots, even inside TOML quotes.
            # A nested map preserves integration names containing punctuation.
            config["mcp_servers"] = {
                name: {"enabled": False} for name in servers
            }
            params = {
                "ephemeral": True, "environments": [], "dynamicTools": [],
                "cwd": temporary, "approvalPolicy": "never", "sandbox": "read-only",
                "baseInstructions": SYSTEM_PROMPT, "developerInstructions": SYSTEM_PROMPT,
                "config": config,
            }
            if model:
                params["model"] = model
            thread_id = await client.start_thread(params)
            turn = await client.start_turn(thread_id, [{"type": "text", "text": prompt}],
                                           overrides={"environments": []})
            answers: dict[str, str] = {}
            while True:
                packet = await turn.next_notification()
                method, data = packet.get("method"), packet.get("params", {})
                if method == "item/completed":
                    item = data.get("item", {})
                    if item.get("type") == "agentMessage" and item.get("phase") in (None, "", "final_answer"):
                        text = item.get("text")
                        if isinstance(text, str):
                            answers[str(item.get("id", "answer"))] = text
                            if sum(len(value.encode("utf-8")) for value in answers.values()) > MAX_OUTPUT_BYTES:
                                raise SideQuestionError(502, "Side question response exceeded the output limit")
                elif method == "turn/completed":
                    completed = data.get("turn", {})
                    if completed.get("status") != "completed" or completed.get("error"):
                        raise SideQuestionError(503, "Codex did not complete the side question")
                    answer = "\n\n".join(answers.values()).strip()
                    if not answer:
                        raise SideQuestionError(502, "Codex did not return a side question answer")
                    return answer
        except CodexAppServerError:
            # Never expose raw provider configuration, credentials or private
            # paths in errors sent to a renderer; never retry ambiguous work.
            raise SideQuestionError(503, "Codex side question failed; check its installation and sign-in") from None
        finally:
            async def cleanup():
                with suppress(Exception):
                    await starting
                await client.close()
            cleaning = asyncio.create_task(cleanup())
            cancelled = False
            while not cleaning.done():
                try:
                    await asyncio.shield(cleaning)
                except asyncio.CancelledError:
                    cancelled = True
            cleaning.result()
            if cancelled:
                raise asyncio.CancelledError
