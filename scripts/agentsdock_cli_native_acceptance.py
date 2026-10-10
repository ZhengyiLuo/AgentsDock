#!/usr/bin/env python3
"""Exact paired npm packages on disposable GitHub native hosts only.

This is scoped CLI installation/lifecycle acceptance, not desktop, provider,
populated-history, managed-update, or logout/reboot acceptance. Never run by
spoofing the hosted-runner guards on a developer account.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import plistlib
import pwd
import re
import selectors
import shlex
import socket
import stat
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "ZhengyiLuo/AgentsDock"
WORKFLOW = "agentsdock-cli-native-acceptance.yml"
SELECTORS = ("AGENTS_SERVER_INSTALL_DIR", "AGENTS_SERVER_CONFIG_DIR", "AGENTS_SERVER_STATE_DIR",
             "AGENTSDOCK_STATE_DIR", "ZENITHBOT_AGENT_DIR", "AGENTS_SERVER_INSTANCE",
             "XDG_CONFIG_HOME", "XDG_DATA_HOME")
UNTESTED = ["provider-chat", "interactive-pairing-and-optional-dependency-prompts",
            "logout-or-reboot", "populated-native-history", "desktop",
            "managed-update", "legacy-migration", "busy-or-queued-work",
            "default-removal", "history-purge", "native-interactive-token-menu",
            "bulk-instance-controls", "native-name-release"]
PHASES = {"inputs", "clean-host", "automatic-setup", "default-health", "repeat-install",
          "read-only-commands", "named-create", "named-lifecycle", "named-removal",
          "default-lifecycle", "cache-independence", "default-removal", "complete"}
PUBLIC_CHECKS = {"private-token-file", "npm-output-token-privacy", "authenticated-default-health",
                 "service-path-independence", "exact-runtime-bytes-and-modes"}
PUBLIC_CHECKS |= {f"named-{action}-{check}" for action in ("stop", "start", "restart")
                 for check in ("command", "default-health", "default-instance-unchanged")}
PUBLIC_CHECKS |= {"named-stop-native-state"}
PUBLIC_CHECKS |= {f"named-{action}-{check}" for action in ("start", "restart")
                 for check in ("authenticated-health", "fresh-process-instance")}
DIAGNOSTIC_PRODUCT = "af31c2072ae17eb09a882048e06612bf1fa4040a"
DIAGNOSTIC_SOURCE_REF = "release/1.0.10-beta.6"
DIAGNOSTIC_HARNESS_REF = "release/1.0.10-beta.6-cli-diagnostics"
DIAGNOSTIC_MANIFEST = "31c3a959ea6095471ced4f972f2c27b4f444161dbe36a9586228f42ef9b4fbdf"
DIAGNOSTIC_CLI_RECEIPT = "af10c2f12dde4e53e53cac56db420b9364ba08513046b04fbce27381f8f4b756"
HARNESS_FILES = {f".github/workflows/{WORKFLOW}", "scripts/agentsdock_cli_native_acceptance.py",
                 "scripts/tests/test_agentsdock_cli_native_acceptance.py"}


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def release_pins(args):
    """A diagnostic descendant never substitutes its source for the product."""
    workflow_sha = getattr(args, "workflow_sha", "")
    harness_ref = getattr(args, "harness_ref", "")
    need(bool(workflow_sha) == bool(harness_ref), "Supply both diagnostic harness pins or neither.")
    if not workflow_sha:
        return args.source_sha, args.source_ref, False
    need(re.fullmatch(r"[a-f0-9]{40}", workflow_sha) is not None
         and workflow_sha != args.source_sha and harness_ref == DIAGNOSTIC_HARNESS_REF
         and args.source_sha == DIAGNOSTIC_PRODUCT and args.source_ref == DIAGNOSTIC_SOURCE_REF
         and args.manifest_sha256 == DIAGNOSTIC_MANIFEST and args.cli_receipt_sha256 == DIAGNOSTIC_CLI_RECEIPT,
         "Diagnostic mode requires the exact frozen beta.6 product, packages and separate harness ref.")
    return workflow_sha, harness_ref, True


def workflow_identity(args, env):
    workflow_sha, harness_ref, diagnostic = release_pins(args)
    need(env.get("GITHUB_SHA") == workflow_sha and env.get("GITHUB_REF") == f"refs/heads/{harness_ref}"
         and env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/.github/workflows/{WORKFLOW}@refs/heads/{harness_ref}"
         and (not env.get("GITHUB_WORKFLOW_SHA") or env["GITHUB_WORKFLOW_SHA"] == workflow_sha),
         "The real workflow identity differs from the explicit harness pins.")
    return workflow_sha, harness_ref, diagnostic


def validate_harness_diff(raw):
    """Retain modes and permit only modifications of three existing files."""
    fields = raw.split(b"\0")
    need(fields[-1] == b"" and (len(fields) - 1) % 2 == 0, "Malformed product/harness diff.")
    for index in range(0, len(fields) - 1, 2):
        header, filename = fields[index].decode("ascii"), fields[index + 1].decode("utf8")
        match = re.fullmatch(r":(100644|100755) (100644|100755) [a-f0-9]+ [a-f0-9]+ M", header)
        need(match is not None and match[1] == match[2] and filename in HARNESS_FILES,
             "Diagnostic changes exceed the exact regular-file harness allowlist.")


def verify_harness_source(args):
    workflow_sha, _, diagnostic = workflow_identity(args, os.environ)
    git = ["git", "--no-replace-objects", "-C", str(ROOT)]
    need(command([*git, "rev-parse", "HEAD"]).stdout.decode().strip() == workflow_sha,
         "Harness checkout differs from its reviewed workflow SHA.")
    need(not command([*git, "status", "--porcelain", "--untracked-files=normal"]).stdout.strip(),
         "Harness source must be clean and committed.")
    if diagnostic:
        command([*git, "merge-base", "--is-ancestor", args.source_sha, workflow_sha])
        raw = command([*git, "diff", "--raw", "--no-renames", "-z", args.source_sha, workflow_sha, "--"]).stdout
        need(bool(raw), "Diagnostic harness must contain reviewed harness-only changes.")
        validate_harness_diff(raw)
        need(command([*git, "rev-parse", "refs/remotes/origin/cli-reviewed-product"]).stdout.decode().strip()
             == args.source_sha, "Frozen product ref moved or was not fetched.")
    return workflow_sha


def read_regular(path: Path, maximum=1024 * 1024, *, private=False) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
             and not info.st_mode & 0o022 and info.st_size <= maximum,
             "Expected a bounded, safely owned regular file.")
        need(not private or stat.S_IMODE(info.st_mode) == 0o600, "Private file mode differs.")
        data = stream.read(maximum + 1)
        need(len(data) <= maximum, "File size limit exceeded.")
        return data


def owned_directory(path: Path):
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022,
         "Expected a safely owned, unlinked directory.")
    return info


def contained(path: Path, parent: Path):
    need(path.is_absolute() and path != parent and path.is_relative_to(parent)
         and ".." not in path.parts and path.resolve().is_relative_to(parent.resolve()),
         "Expected a bounded disposable path.")
    for current in (path, *path.parents):
        if current == parent:
            break
        need(not current.is_symlink(), "Symlinked paths are forbidden.")


def guard(args, *, environment=None, uid=None, system=None, machine=None):
    env = os.environ if environment is None else environment
    user = os.getuid() if uid is None else uid
    host = platform.system() if system is None else system
    architecture = platform.machine() if machine is None else machine
    workflow_identity(args, env)
    need(re.fullmatch(r"[a-f0-9]{40}", args.source_sha) is not None
         and all(re.fullmatch(r"[a-f0-9]{64}", value) for value in
                 (args.manifest_sha256, args.cli_receipt_sha256)), "Exact source and both acceptance hashes are required.")
    need((args.source_ref == "main" or re.fullmatch(r"release/[A-Za-z0-9][A-Za-z0-9._/-]*", args.source_ref))
         and ".." not in args.source_ref and "//" not in args.source_ref
         and not args.source_ref.endswith(("/", "."))
         and all(not part.endswith(".lock") for part in args.source_ref.split("/")), "Invalid reviewed source ref.")
    need(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
         and env.get("GITHUB_REPOSITORY") == REPOSITORY and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
         and env.get("GITHUB_JOB") == "cli-native" and env.get("CLI_NATIVE_ACCEPTANCE") == "true"
         and all(re.fullmatch(r"[1-9]\d*", env.get(name, "")) for name in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")),
         "Requires the pinned manual canonical workflow on a disposable GitHub-hosted runner.")
    need(user != 0 and ((host == "Linux" and env.get("RUNNER_OS") == "Linux") or
         (host == "Darwin" and architecture == "arm64" and env.get("RUNNER_OS") == "macOS")),
         "A non-root hosted Linux or Apple silicon macOS account is required.")
    home, temporary = Path(env.get("HOME", "")), Path(env.get("RUNNER_TEMP", ""))
    need(home.is_absolute() and temporary.is_absolute(), "Actual account and runner temporary roots required.")
    if environment is None:
        need(home.resolve() == Path(pwd.getpwuid(user).pw_dir).resolve(), "Redirected homes are forbidden.")
        owned_directory(home)
        owned_directory(temporary)
    default_xdg = host == "Linux" and env.get("XDG_CONFIG_HOME") == str(home / ".config")
    need(all(not env.get(name) for name in SELECTORS if name != "XDG_CONFIG_HOME")
         and (not env.get("XDG_CONFIG_HOME") or default_xdg), "Inherited custom installation selectors are forbidden.")
    for path in (args.runtime, args.cli, args.work, args.report):
        contained(path, temporary)
    need(args.runtime != args.cli and not args.runtime.is_relative_to(args.cli)
         and not args.cli.is_relative_to(args.runtime), "Runtime and CLI inputs must be separate.")
    need(args.work.name.startswith("agentsdock-cli-native-") and not args.work.exists()
         and not args.work.is_symlink() and not args.report.exists() and not args.report.is_symlink()
         and not args.report.is_relative_to(args.work)
         and not any(args.report.is_relative_to(path) or args.work.is_relative_to(path)
                     or path.is_relative_to(args.work) for path in (args.runtime, args.cli)),
         "Use new, separated native work and report paths.")
    return home


def command(argv, *, env=None, timeout=60, allowed=(0,)):
    """Drain bounded private command output in memory; never log tokens/errors."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=env)
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    poll = selectors.DefaultSelector()
    poll.register(process.stdout, selectors.EVENT_READ, "stdout")
    poll.register(process.stderr, selectors.EVENT_READ, "stderr")
    deadline = time.monotonic() + timeout
    try:
        while poll.get_map():
            need(time.monotonic() < deadline, "Bounded native command timed out; output withheld.")
            for key, _ in poll.select(timeout=0.2):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    poll.unregister(key.fileobj)
                else:
                    target = buffers[key.data]
                    target.extend(data[:max(0, 1024 * 1024 - len(target))])
        code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        need(code in allowed, "Native command returned a rejected status; output withheld.")
        return subprocess.CompletedProcess(argv, code, bytes(buffers["stdout"]), bytes(buffers["stderr"]))
    finally:
        poll.close()
        if process.poll() is None:
            process.kill()  # Only this child, never a managed service or another process.
            process.wait(timeout=10)
        process.stdout.close()
        process.stderr.close()


def child_environment(work: Path):
    # Invoked only after guard() and ensure_empty(). Omitting CI here exercises
    # normal npm lifecycle semantics inside an already verified disposable host;
    # it does not weaken the harness guard or change production skip behavior.
    keys = ("HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL",
            "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")
    result = {key: os.environ[key] for key in keys if os.environ.get(key)}
    for name in ("user.npmrc", "global.npmrc"):
        (work / name).touch(mode=0o600, exist_ok=False)
    result.update(npm_config_cache=str(work / "npm-cache"), npm_config_update_notifier="false",
                  npm_config_userconfig=str(work / "user.npmrc"),
                  npm_config_globalconfig=str(work / "global.npmrc"), TERM="dumb", NO_COLOR="1")
    return result


def roots(home: Path, name="default"):
    need(name in {"default", "cli-native"}, "Only exact disposable test instances are allowed.")
    return {"runtime": home / ".local/share" / ("agents-server" if name == "default" else f"agents-server-instances/{name}"),
            "config": home / ".config" / ("agents-server" if name == "default" else f"agents-server-instances/{name}"),
            "state": home / (".agentsdock" if name == "default" else f".agentsdock-instances/{name}")}


def service_files(home: Path, name="default"):
    need(name in {"default", "cli-native"}, "Unexpected service selector.")
    if platform.system() == "Darwin":
        labels = ("com.agentsdock.server", "com.agentsdock.gateway") if name == "default" else (f"com.agentsdock.server.{name}",)
        return [home / "Library/LaunchAgents" / f"{label}.plist" for label in labels]
    units = ("agents-server", "agents-server-gateway") if name == "default" else (f"agents-server-{name}",)
    return [home / ".config/systemd/user" / f"{unit}.service" for unit in units]


def service_state(item: Path):
    if platform.system() == "Darwin":
        result = command(["/bin/launchctl", "print", f"gui/{os.getuid()}/{item.stem}"], allowed=(0, 3, 5, 113))
        if result.returncode == 0:
            return "active"
        need(any(text in (result.stdout + result.stderr).lower() for text in
                 (b"could not find service", b"service not found", b"no such process")), "Native service absence is unproven.")
        return "absent"
    result = command(["systemctl", "--user", "show", item.name, "--property=LoadState", "--property=ActiveState"], allowed=(0, 1))
    values = dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)
    if values.get("LoadState") == "not-found":
        return "absent"
    need(values.get("LoadState") == "loaded", "Unexpected native service load state.")
    return "active" if values.get("ActiveState") == "active" else "inactive"


def ensure_empty(home: Path):
    paths = [*roots(home).values(), home / ".zenithbot-agent", home / ".config/agents-server-manager",
             home / ".local/share/agents-server-instances", home / ".config/agents-server-instances",
             home / ".agentsdock-instances", *service_files(home), *service_files(home, "cli-native"),
             home / ".config/systemd/user/zenithbot-agent.service"]
    for item in paths:
        contained(item, home)
        for parent in item.parents:
            if parent == home:
                break
            if parent.exists():
                owned_directory(parent)
        need(not item.exists() and not item.is_symlink(), "Existing service/state prevents installation.")
    if platform.system() == "Darwin":
        command(["/bin/launchctl", "print", f"gui/{os.getuid()}"])
    else:
        command(["systemctl", "--user", "show-environment"])
    for item in [*service_files(home), *service_files(home, "cli-native")]:
        need(service_state(item) == "absent", "An existing native service prevents installation.")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 7850))  # No fallback: first-setup default port must be free.


def token_at(home, name="default"):
    raw = read_regular(roots(home, name)["config"] / "env", private=True).decode()
    tokens = [line.partition("=")[2] for line in raw.splitlines() if line.startswith("AGENTSDOCK_AGENT_TOKEN=")]
    need(len(tokens) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{32,}", tokens[0]), "One private token is required.")
    return tokens[0]


def health(port, token, version, *, identity=None, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request("GET", "/api/health", headers={"X-AgentsDock-Token": token})
            response = connection.getresponse()
            data = response.read(1024 * 1024 + 1)
            need(response.status == 200 and len(data) <= 1024 * 1024, "Health request failed.")
            value = json.loads(data)
            need(value.get("ok") is True and value.get("server_version") == version
                 and bool(value.get("server_identity")) and bool(value.get("server_instance_id")), "Exact authenticated health not reached.")
            need(identity is None or value["server_identity"] == identity, "Server identity changed.")
            return value
        except (OSError, RuntimeError, ValueError, http.client.HTTPException):
            if time.monotonic() >= deadline:
                raise RuntimeError("Authenticated health deadline exceeded; private response withheld.") from None
            time.sleep(1)
        finally:
            connection.close()


def verify_runtime(home, name, archive, version):
    root = roots(home, name)["runtime"]
    runtime = root / "releases" / version
    owned_directory(runtime)
    need((root / "current").is_symlink() and (root / "current").resolve() == runtime,
         "Permanent versioned runtime activation differs.")
    count = 0
    with tarfile.open(archive) as package:
        installer = package.extractfile("package/server/install.sh").read()
        need(len(package.getmembers()) <= 500, "Unexpected package inventory.")
        for member in package.getmembers():
            if not member.name.startswith("package/server/"):
                continue
            relative = Path(member.name).relative_to("package/server")
            need(member.isfile() and ".." not in relative.parts, "Unsafe runtime member.")
            installed = runtime / relative
            contained(installed, runtime)
            mode = member.mode & 0o7777
            if mode == 0o644 and len(relative.parts) == 1 and re.fullmatch(r"[A-Za-z0-9_.-]+", relative.name):
                # Preserve only the exact executable rule present in the signed
                # installer; archive mode is otherwise authoritative.
                rule = b'"$STAGE_DIR/' + relative.name.encode() + b'"'
                lines = [line for line in installer.splitlines() if line.startswith(b"chmod 755 ")]
                if any(rule in line.split() for line in lines):
                    mode = 0o755
            need(read_regular(installed, 200 * 1024 * 1024) == package.extractfile(member).read()
                 and stat.S_IMODE(installed.stat().st_mode) == mode, "Installed runtime bytes or modes differ.")
            count += 1
    need(count > 0, "No runtime files compared.")
    return count


def verify_services(home, name, work):
    files = [item for item in service_files(home, name) if item.exists()]
    need(files and files[0] == service_files(home, name)[0], "Native worker registration missing.")
    runtime = roots(home, name)["runtime"]
    for item in files:
        raw = read_regular(item)
        need(str(work).encode() not in raw, "Service depends on staging or npm cache.")
        if platform.system() == "Darwin":
            value = plistlib.loads(raw)
            need(value.get("Label") == item.stem, "Native service label differs.")
            argv = value.get("ProgramArguments", [])
        else:
            lines = [line[10:] for line in raw.decode().splitlines() if line.startswith("ExecStart=")]
            need(len(lines) == 1, "Native service executable missing.")
            argv = shlex.split(lines[0])
            if argv and argv[0] == "/usr/bin/env":
                argv = argv[1:]
                while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
                    argv = argv[1:]
        need(argv and argv[0].startswith(str(runtime) + "/"), "Service is not in permanent owned runtime.")
    return files


def inspect_inputs(args):
    owned_directory(args.runtime)
    owned_directory(args.cli)
    verify_harness_source(args)
    descriptor = json.loads(read_regular(args.runtime / "agents-server-npm-manifest.json", 8192))
    receipt = json.loads(read_regular(args.cli / "agentsdock-cli-receipt.json", 8192))
    version = read_regular(ROOT / "server/VERSION", 200).decode().strip()
    need(re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?", version), "Invalid version.")
    need(sorted(path.name for path in args.runtime.iterdir()) == sorted([
        "agents-server-npm-manifest.json", "agents-server-npm-manifest.sig", f"server-{version}.tgz"])
        and sorted(path.name for path in args.cli.iterdir()) == sorted([
        "agentsdock-cli-receipt.json", f"agentsdock-{version}.tgz"]), "Unexpected paired input inventory.")
    command(["node", str(ROOT / "scripts/verify_agentsdock_cli_publication.mjs"), "inspect",
             str(args.cli), version, args.source_sha, args.cli_receipt_sha256,
             str(args.runtime), args.manifest_sha256, "absent"], timeout=90)
    inspect_runtime_archive(args.runtime / descriptor["archive"]["name"], version)
    # 'absent' is a required offline-verifier argument, not a claim about a
    # registry baseline. This harness never publishes or queries floating tags.
    return descriptor, receipt


def inspect_runtime_archive(archive, version):
    """No unreviewed runtime npm hook executes alongside the CLI postinstall."""
    with tarfile.open(archive) as package:
        members = package.getmembers()
        names = [member.name for member in members]
        need(len(members) <= 500 and len(names) == len(set(names)) and all(
            member.isfile() and member.name.startswith("package/") and ".." not in member.name.split("/")
            for member in members), "Unsafe runtime package inventory.")
        member = package.getmember("package/package.json")
        need(member.size <= 65536, "Runtime package metadata is too large.")
        metadata = json.load(package.extractfile(member))
        need(metadata.get("name") == "@agentsdock/server" and metadata.get("version") == version
             and not metadata.get("private") and not any(key in metadata for key in (
                 "scripts", "dependencies", "optionalDependencies", "peerDependencies",
                 "bundledDependencies", "bundleDependencies")), "Unexpected runtime identity, hooks or dependencies.")
        member = package.getmember("package/server/VERSION")
        need(member.size <= 200 and package.extractfile(member).read().decode().strip() == version,
             "Runtime payload version differs.")


def stopped_default(files, pids, *, removed=False, timeout=30):
    """Observe both owned services and former processes; never kill or repair."""
    deadline = time.monotonic() + timeout
    while True:
        states = [service_state(item) for item in files]
        processes = [command(["/bin/ps", "-p", str(pid), "-o", "pid="], allowed=(0, 1)).stdout.strip()
                     for pid in pids]
        if all(value == "absent" if removed else value != "active" for value in states) and not any(processes):
            return
        need(time.monotonic() < deadline, "Both owned default components did not stop or unregister.")
        time.sleep(1)


def exercise_default_removal(home, binary, env, version, last, runtime, count, observations):
    """Actual CLI stop/cancel/remove, only after the guarded exact-pair journey.

    Cancellation preserves token/configuration; confirmed uninstall deliberately
    removes them. Only synthetic history retention is observed, never real chats.
    """
    paths = roots(home)
    files = service_files(home)
    need(len(files) == 2 and all(item.is_file() and not item.is_symlink() for item in files),
         "Both native default registrations are required before removal.")
    pids = []
    for name in ("gateway", "execution_service"):
        component = last.get(name)
        need(isinstance(component, dict) and component.get("protocol") == 1
             and component.get("version") == version and type(component.get("pid")) is int
             and 1 < component["pid"] < 2 ** 31 and bool(component.get("instance_id"))
             and component.get("maintenance_held") is not True,
             "Both exact-version default components must be healthy before removal.")
        pids.append(component["pid"])
    need(len(set(pids)) == 2, "Default component processes must be distinct.")
    token = token_at(home)
    config = read_regular(paths["config"] / "env", private=True)
    registrations = {item: read_regular(item) for item in files}
    identities = {name: (info.st_dev, info.st_ino, info.st_uid)
                  for name, path in paths.items() for info in [owned_directory(path)]}
    marker = paths["state"] / "cli-native-default-synthetic-preservation.txt"
    marker_bytes = b"Synthetic default-removal marker; not real native chat history.\n"
    fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(marker_bytes)

    def preserved(names):
        for name in names:
            info = owned_directory(paths[name])
            need((info.st_dev, info.st_ino, info.st_uid) == identities[name],
                 "Default removal replaced a retained directory.")
        need(read_regular(marker, private=True) == marker_bytes, "Synthetic default history changed.")

    stopped = command([binary, "stop", "default"], env=env, timeout=240)
    need(token.encode() not in stopped.stdout + stopped.stderr, "Stop output disclosed the private token.")
    stopped_default(files, pids)
    preserved(paths)
    need(read_regular(paths["config"] / "env", private=True) == config and token_at(home) == token,
         "Stopping default changed its configuration or token.")
    cancelled = command([binary, "remove", "default"], env=env, allowed=(1,))
    need(b"Not confirmed" in cancelled.stderr and token.encode() not in cancelled.stdout + cancelled.stderr,
         "Default removal did not safely require confirmation.")
    stopped_default(files, pids)
    preserved(paths)
    need(read_regular(paths["config"] / "env", private=True) == config and token_at(home) == token
         and all(read_regular(item) == raw for item, raw in registrations.items())
         and verify_runtime(home, "default", runtime, version) == count,
         "Cancelled default removal changed configuration, registrations or exact runtime.")
    observations["defaultStoppedRemovalCancellationPreservesRuntimeConfigTokenAndSyntheticState"] = True
    removed = command([binary, "remove", "default", "--yes"], env=env, timeout=240)
    need(token.encode() not in removed.stdout + removed.stderr, "Removal output disclosed the private token.")
    stopped_default(files, pids, removed=True)
    need(all(not item.exists() and not item.is_symlink() for item in files)
         and all(not paths[name].exists() and not paths[name].is_symlink() for name in ("runtime", "config")),
         "Confirmed default removal left runtime, configuration or native registrations.")
    preserved(("state",))
    observations["defaultRemovalRequiresConfirmationAndPreservesSyntheticState"] = True


def diagnose_named_stop(home, observations):
    """Read-only samples after an already failed assertion; never make it pass."""
    samples = []
    for delay, elapsed in ((0, 0), (1, 1), (2, 3)):
        if delay:
            time.sleep(delay)
        try:
            states = [service_state(item) for item in service_files(home, "cli-native")]
            # On macOS the existing assertion calls any registered job active;
            # this does not establish a running process or its identity.
            samples.append({"minimumDelaySeconds": elapsed, "registered": any(state != "absent" for state in states),
                            "assertionActive": "active" in states})
        except Exception:
            # No raw native output, paths, exception text or environment escapes.
            samples.append({"minimumDelaySeconds": elapsed, "registered": None, "assertionActive": None})
    observations["diagnosticNamedStopAfterFailure"] = samples


def require_named_stopped(args, home, observations):
    try:
        need(all(service_state(item) != "active" for item in service_files(home, "cli-native")), "Named service remained active.")
    except RuntimeError:
        if release_pins(args)[2]:
            diagnose_named_stop(home, observations)
        raise  # Later convergence is diagnostic only, never an acceptance pass.


def exercise(args, home, descriptor, receipt, observations, progress):
    progress("clean-host")
    ensure_empty(home)
    args.work.mkdir(mode=0o700)
    env = child_environment(args.work)
    runtime = args.runtime / descriptor["archive"]["name"]
    cli = args.cli / receipt["archive"]["name"]
    prefix = args.work / "prefix"
    version = descriptor["version"]
    install = ["npm", "install", "--global", "--prefix", str(prefix), "--no-audit", "--no-fund",
               "--offline", "--foreground-scripts", str(runtime), str(cli)]
    # Real npm resolver and lifecycle, exact immutable pair, no registry lookup,
    # --ignore-scripts, synthetic runtime or preinstalled default service.
    progress("automatic-setup")
    installed = command(install, env=env, timeout=1500)
    need(b"Server " in installed.stdout and b" is ready at " in installed.stdout,
         "Automatic first setup did not report readiness.")
    binary = str(prefix / "bin/agentsdock")
    need(command([binary, "version"], env=env).stdout.decode().strip() == version, "Installed CLI version differs.")
    progress("default-health", "private-token-file")
    token = token_at(home)
    progress("default-health", "npm-output-token-privacy")
    need(token.encode() not in installed.stdout + installed.stderr, "npm output disclosed the private token.")
    progress("default-health", "authenticated-default-health")
    first = health(7850, token, version)
    progress("default-health", "service-path-independence")
    verify_services(home, "default", args.work)
    progress("default-health", "exact-runtime-bytes-and-modes")
    count = verify_runtime(home, "default", runtime, version)
    observations.update(automaticFirstGlobalSetup=True, authenticatedDefaultHealth=True,
                        exactRuntimeFilesCompared=count, privateTokenAbsentFromNpmOutput=True)
    progress("repeat-install")
    repeated = command([*install, "--force"], env=env, timeout=180)
    need(b"left unchanged" in repeated.stdout and token.encode() not in repeated.stdout + repeated.stderr,
         "Repeated npm installation did not safely no-op.")
    now = health(7850, token, version, identity=first["server_identity"])
    need(now["server_instance_id"] == first["server_instance_id"] and token_at(home) == token,
         "Repeated npm installation restarted or replaced the existing server.")
    for log in (args.work / "npm-cache/_logs").glob("*.log"):
        need(token.encode() not in read_regular(log, 8 * 1024 * 1024), "npm log disclosed the private token.")
    observations["existingGlobalReinstallPreservesProcessIdentityAndToken"] = True
    progress("read-only-commands")
    for argv in ([binary, "list"], [binary, "status"], [binary, "info", "default"]):
        result = command(argv, env=env)
        need(token.encode() not in result.stdout + result.stderr, "Listing exposed the token.")
    need(command([binary, "token", "default"], env=env).stdout.decode().strip() == token,
         "Explicit token command returned a different token.")
    for action in ("start", "stop", "restart", "remove", "uninstall"):
        result = command([binary, action], env=env, allowed=(1,))
        need(b"Select exactly one instance or --all" in result.stderr, "Omitted selector did not safely refuse.")
    observations["readOnlyCommandsAndExplicitSelectorGuards"] = True
    progress("named-create")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        named_port = listener.getsockname()[1]
    command([binary, "new", "cli-native", "--port", str(named_port), "--bind", "127.0.0.1"], env=env, timeout=1500)
    named_token = token_at(home, "cli-native")
    named_first = health(named_port, named_token, version)
    need(named_first["server_identity"] != first["server_identity"] and named_token != token,
         "Named instance is not independent from default.")
    verify_services(home, "cli-native", args.work)
    verify_runtime(home, "cli-native", runtime, version)
    marker = roots(home, "cli-native")["state"] / "cli-native-synthetic-preservation.txt"
    marker.write_text("Synthetic acceptance marker; not real native chat history.\n")
    marker.chmod(0o600)
    observations["namedCreationAndIndependentIdentity"] = True
    progress("named-lifecycle")
    for action in ("stop", "start", "restart"):
        progress("named-lifecycle", f"named-{action}-command")
        command([binary, action, "cli-native"], env=env, timeout=240)
        if action == "stop":
            progress("named-lifecycle", "named-stop-native-state")
            require_named_stopped(args, home, observations)
        else:
            progress("named-lifecycle", f"named-{action}-authenticated-health")
            value = health(named_port, named_token, version, identity=named_first["server_identity"])
            progress("named-lifecycle", f"named-{action}-fresh-process-instance")
            need(value["server_instance_id"] != named_first["server_instance_id"], "Named process did not change.")
            named_first = value
        progress("named-lifecycle", f"named-{action}-default-health")
        default_health = health(7850, token, version, identity=first["server_identity"])
        progress("named-lifecycle", f"named-{action}-default-instance-unchanged")
        need(default_health["server_instance_id"] == first["server_instance_id"],
             "Named action disturbed default server.")
    observations["namedStartStopRestartAndDefaultUnaffected"] = True
    progress("named-removal")
    cancelled = command([binary, "remove", "cli-native"], env=env, allowed=(1,))
    need(b"Not confirmed" in cancelled.stderr and marker.is_file(), "Unconfirmed removal did not preserve state.")
    need(health(named_port, named_token, version)["server_instance_id"] == named_first["server_instance_id"],
         "Cancelled removal changed the named process.")
    command([binary, "remove", "cli-native", "--yes"], env=env, timeout=240)
    need(marker.is_file() and not roots(home, "cli-native")["runtime"].exists()
         and all(service_state(item) != "active" for item in service_files(home, "cli-native")),
         "Named removal failed to remove the service while preserving synthetic state.")
    observations["namedRemovalRequiresConfirmationAndPreservesSyntheticState"] = True
    progress("default-lifecycle")
    # Current code may safely refuse split default bindings. That is a failed
    # acceptance case, never a reason to bypass guards or control one process.
    for action in ("stop", "start", "restart"):
        result = command([binary, action, "default"], env=env, timeout=240, allowed=(0, 1))
        if result.returncode:
            observations["defaultLifecycleAccepted"] = False
            observations["defaultLifecycleRejectedWithoutChangingProcess"] = (
                health(7850, token, version, identity=first["server_identity"])["server_instance_id"] == first["server_instance_id"])
            raise RuntimeError("Default lifecycle command rejected; no service-binding bypass attempted.")
        if action == "stop":
            need(all(service_state(item) != "active" for item in service_files(home)), "Split default component remained active.")
        else:
            value = health(7850, token, version, identity=first["server_identity"])
            need(value["server_instance_id"] != first["server_instance_id"], "Default process did not change.")
            first = value
    observations["defaultLifecycleAccepted"] = True
    progress("cache-independence")
    # Retire only owned temporary directories; never delete user state. Invoke
    # the relocated npm bin for restart, proving services do not use old paths.
    retired = args.work / "prefix-retired"
    prefix.rename(retired)
    cache = args.work / "npm-cache"
    owned_directory(cache)
    cache.rename(args.work / "npm-cache-retired")
    command([str(retired / "bin/agentsdock"), "restart", "default"], env=env, timeout=240)
    last = health(7850, token, version, identity=first["server_identity"])
    need(last["server_instance_id"] != first["server_instance_id"] and token_at(home) == token,
         "Post-cache-retirement restart did not preserve server identity and token.")
    need(verify_runtime(home, "default", runtime, version) == count, "Runtime inventory changed.")
    observations["serviceIndependentOfOriginalNpmPrefixAndCacheAfterRestart"] = True
    progress("default-removal")
    named_marker = read_regular(marker, private=True)
    named_state = owned_directory(roots(home, "cli-native")["state"])
    named_identity = (named_state.st_dev, named_state.st_ino, named_state.st_uid)
    named_services = [service_state(item) for item in service_files(home, "cli-native")]
    exercise_default_removal(home, str(retired / "bin/agentsdock"), env, version, last, runtime, count, observations)
    named_state = owned_directory(roots(home, "cli-native")["state"])
    need(read_regular(marker, private=True) == named_marker
         and (named_state.st_dev, named_state.st_ino, named_state.st_uid) == named_identity
         and not roots(home, "cli-native")["runtime"].exists()
         and "active" not in named_services
         and [service_state(item) for item in service_files(home, "cli-native")] == named_services,
         "Default removal disturbed the separately removed named instance.")
    observations["defaultRemovalLeavesNamedSyntheticStateUntouched"] = True


def make_report(args, descriptor, observations, phase, passed, check=None):
    need(phase in PHASES, "Unknown public report phase.")
    need(check is None or check in PUBLIC_CHECKS, "Unknown public report check.")
    _, harness_ref, diagnostic = release_pins(args)
    return {"schema": 1, "kind": "agentsdock-cli-native-diagnostic" if diagnostic else "agentsdock-cli-native-acceptance",
            "scope": "paired-npm-cli-native-diagnostic" if diagnostic else "paired-npm-cli-native",
            **({"diagnosticOnly": True, "harnessRef": harness_ref} if diagnostic else {}),
            "status": "passed" if passed else "failed", "phase": phase, "productPublicationEligible": False,
            "failedCheck": check if not passed else None,
            "fullAcceptance": False, "sourceSha": args.source_sha, "sourceRef": args.source_ref,
            "runtimeManifestSha256": args.manifest_sha256, "cliReceiptSha256": args.cli_receipt_sha256,
            "version": descriptor.get("version") if descriptor else None,
            "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "harnessSha": os.environ["GITHUB_SHA"], "repository": REPOSITORY,
            "platform": platform.system(), "observations": observations,
            "notTested": [item for item in UNTESTED if item != "default-removal" or not (
                observations.get("defaultRemovalRequiresConfirmationAndPreservesSyntheticState") is True
                and observations.get("defaultRemovalLeavesNamedSyntheticStateUntouched") is True)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("runtime", "cli", "work", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("source-sha", "source-ref", "manifest-sha256", "cli-receipt-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--workflow-sha", default="")
    parser.add_argument("--harness-ref", default="")
    args = parser.parse_args()
    home = guard(args)  # No report or arbitrary write on rejected host/path.
    owned_directory(args.report.parent)
    descriptor, observations, phase, passed, check = None, {}, "inputs", False, None

    def progress(value, current_check=None):
        nonlocal phase, check
        need(value in PHASES, "Unknown phase.")
        need(current_check is None or current_check in PUBLIC_CHECKS, "Unknown check.")
        phase, check = value, current_check

    try:
        descriptor, receipt = inspect_inputs(args)
        exercise(args, home, descriptor, receipt, observations, progress)
        phase, passed = "complete", True
    finally:
        report = make_report(args, descriptor, observations, phase, passed, check)
        fd = os.open(args.report, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(report, stream, indent=2, sort_keys=True)
            stream.write("\n")
    print("Diagnostic native CLI checks completed; this is not an acceptance receipt." if release_pins(args)[2]
          else "Scoped exact-pair native CLI acceptance passed; see the report for untested boundaries.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Native CLI acceptance failed; private output withheld. Inspect only the bounded report if present.", file=sys.stderr)
        sys.exit(1)
