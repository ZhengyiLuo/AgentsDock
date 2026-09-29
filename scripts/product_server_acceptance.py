#!/usr/bin/env python3
"""Exercise sealed server packages on disposable GitHub-hosted native runners.

This is deliberately not a general installer or a developer-host smoke test.
It never manufactures release acceptance: each invocation records only the
native observations it made. Provider chats, reboot/logout, UI, busy-work,
rollback and multi-client acceptance require their own real journeys.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import platform
import plistlib
import pwd
import re
import selectors
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import threading
import time
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?")
SELECTORS = ("AGENTS_SERVER_INSTALL_DIR", "AGENTS_SERVER_CONFIG_DIR",
             "AGENTS_SERVER_STATE_DIR", "AGENTSDOCK_STATE_DIR", "ZENITHBOT_AGENT_DIR",
             "XDG_CONFIG_HOME", "XDG_DATA_HOME", "AGENTS_SERVER_INSTANCE")
SESSION_KEYS = ("id", "title", "folder", "cwd", "backend", "model", "effort",
                "codex_provider", "session_id", "claude_session_id", "codex_thread_id",
                "cursor_session_id", "opencode_session_id", "claude_permission_mode",
                "cursor_permission_mode", "opencode_permission_mode", "codex_approval_policy",
                "codex_sandbox_mode", "codex_permission_profile", "provider_jobs_access")
# Audited install.sh: acquire the exact install lock, normalize the validated
# install-root inode to 0700, then prepare dependencies. Failed preparation and
# rollback deliberately do not restore broader legacy directory permissions.
# Keep this whole-file pin: changed installer logic requires another review,
# not a looser source-pattern match or a changed signed candidate.
ROOT_NORMALIZING_INSTALLER_SHA256 = "df21400431ea5f79a78d4f6cede5cfae4f7584166798565c38f5dffff70f38e3"


def need(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def read_regular(path: Path, maximum: int = 1024 * 1024, *, private: bool = False) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= maximum,
             "Acceptance input must be a bounded, unlinked regular file.")
        if private:
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
                 "Private acceptance data must be owned by this user with mode 0600.")
        data = os.read(fd, maximum + 1)
        need(len(data) <= maximum, "Acceptance input exceeded its bound.")
        return data
    finally:
        os.close(fd)


def write_private(path: Path, value: object, *, replace: bool = False) -> None:
    data = canonical(value) + b"\n"
    temporary = path.with_name(path.name + ".next") if replace else path
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if replace:
        read_regular(path, private=True)
        os.replace(temporary, path)


def bounded_run(args: list[str], *, timeout: int, env: dict | None) -> subprocess.CompletedProcess:
    """Drain both pipes, retaining at most 1 MiB each without writing logs."""
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    maximum = 1024 * 1024
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=env)
    poll = selectors.DefaultSelector()
    poll.register(process.stdout, selectors.EVENT_READ, "stdout")
    poll.register(process.stderr, selectors.EVENT_READ, "stderr")
    deadline = time.monotonic() + timeout
    try:
        while poll.get_map():
            need(time.monotonic() < deadline, "Native command exceeded its bounded deadline; private output was withheld.")
            for key, _ in poll.select(timeout=min(0.2, max(0, deadline - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    poll.unregister(key.fileobj)
                    continue
                target = buffers[key.data]
                target.extend(data[:max(0, maximum - len(target))])
        status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return subprocess.CompletedProcess(args, status, bytes(buffers["stdout"]), bytes(buffers["stderr"]))
    finally:
        poll.close()
        if process.poll() is None:
            # Only the child created above is signaled. Managed services belong
            # to the disposable runner and are left to the CI job lifecycle.
            process.kill()
            process.wait(timeout=10)
        process.stdout.close()
        process.stderr.close()


def command(args: list[str], *, timeout: int = 60, env: dict | None = None,
            allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess:
    # Installer output and launchctl output can include tokens. Never echo them,
    # including on failure. Public evidence contains only measured properties.
    result = bounded_run(args, timeout=timeout, env=env)
    label = Path(args[0]).name
    if label == "launchctl" and len(args) > 1 and args[1] in {"print", "bootout", "bootstrap"}:
        label += " " + args[1]
    need(result.returncode in allowed,
         f"Native command failed ({label}, exit {result.returncode}); private output was withheld.")
    return result


def child_environment(work: Path) -> dict[str, str]:
    allow = ("HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL",
             "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
             "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")
    result = {key: os.environ[key] for key in allow if os.environ.get(key)}
    result.update(UV_CACHE_DIR=str(work / "uv-cache"), npm_config_cache=str(work / "npm-cache"),
                  npm_config_update_notifier="false", NO_COLOR="1")
    return result


def stage_fault_delegate(argv: list[str], config_path: Path) -> int:
    """Fail one exact owned dependency stage; never edit uv, runtime or fences."""
    config = json.loads(read_regular(config_path, 8192, private=True))
    control_directory = config_path.parent
    owned_directory(control_directory)
    delegate = Path(config["delegate"])
    directory = owned_directory(delegate.parent)
    need([directory.st_dev, directory.st_ino] == config["delegateDirectoryBinding"]
         and sha(read_regular(delegate, 8192)) == config["delegateSha256"],
         "Owned dependency delegate changed.")
    real_uv = Path(config["realUv"])
    info = real_uv.lstat()
    need(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022
         and os.access(real_uv, os.X_OK)
         and [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns] == config["realUvIdentity"],
         "Trusted dependency executable changed.")
    control = control_directory / "armed.json"
    # Normal version/prerequisite calls and all unarmed calls are real uv.
    # install.sh invokes this absolute executable in its sanitized environment.
    if argv and argv[0] == "sync" and argv.count("--project") == 1 and control.exists():
        index = argv.index("--project")
        need(index + 1 < len(argv), "Dependency project is missing.")
        stage = Path(argv[index + 1])
        root = Path(config["installRoot"])
        contained(stage, root)
        need(stage.parent == root / "releases"
             and re.fullmatch(r"\.staging-" + re.escape(config["version"]) + r"-[1-9]\d*", stage.name),
             "Fault may only target the exact new candidate stage.")
        root_info = owned_directory(root)
        need([root_info.st_dev, root_info.st_ino] == config["rootBinding"], "Owned installation root changed.")
        stage_info = owned_directory(stage)
        need(read_regular(stage / "VERSION", 200).decode().strip() == config["version"]
             and sha(read_regular(stage / "install.sh", 2 * 1024 * 1024)) == config["installerSha256"],
             "Fault stage differs from the signed candidate runtime.")
        marker = {"sourceSha": config["sourceSha"], "receiptSha256": config["receiptSha256"]}
        need(json.loads(read_regular(control, 8192, private=True)) == marker,
             "Dependency fault belongs to a different candidate.")
        consumed = control_directory / "consumed.json"
        need(not consumed.exists() and not consumed.is_symlink(), "Dependency fault was already consumed.")
        # The native installer owns the install lock; this one-shot marker does
        # not alter its stage, lock, update journal, maintenance hold or fence.
        control.rename(consumed)
        write_private(control_directory / "observed.json", {
            **marker, "version": config["version"], "stage": str(stage),
            "stageDevice": stage_info.st_dev, "stageInode": stage_info.st_ino,
            "installerSha256": config["installerSha256"], "dependencyExitCode": 73})
        return 73
    os.execv(str(real_uv), [str(real_uv), *argv])
    raise AssertionError("execv unexpectedly returned")


def prepare_stage_fault_delegate(args: argparse.Namespace, receipt: dict, home: Path, env: dict) -> None:
    need(args.candidate and args.kind == "legacy" and sys.platform == "darwin",
         "Staging-failure fixture requires a disposable candidate macOS legacy job.")
    actual = shutil.which("uv", path=env.get("PATH"))
    need(actual is not None, "Trusted uv is required before creating a dependency delegate.")
    real_uv = Path(actual).resolve(strict=True)
    info = real_uv.lstat()
    need(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022 and os.access(real_uv, os.X_OK),
         "Trusted uv must be a safe executable.")
    descriptor = json.loads(read_regular(args.bundle / "npm/agents-server-npm-manifest.json", 8192))
    need(descriptor.get("version") == receipt["version"], "Dependency fault candidate differs from its descriptor.")
    with tarfile.open(args.bundle / "npm" / descriptor["archive"]["name"], "r:gz") as archive:
        member = archive.getmember("package/server/install.sh")
        need(member.isfile() and member.size <= 2 * 1024 * 1024, "Candidate installer is not a bounded regular member.")
        with archive.extractfile(member) as stream:
            installer_hash = sha(stream.read())
    # Do not put a QA work/cache directory in native service registration.
    # This is an explicitly labelled external dependency fixture, not proof of
    # independence from every QA dependency. It persists until the CI VM ends;
    # it must never be removed while these owned services can still call it.
    run = os.environ["GITHUB_RUN_ID"]
    attempt = os.environ["GITHUB_RUN_ATTEMPT"]
    need(re.fullmatch(r"[1-9]\d*", run) and re.fullmatch(r"[1-9]\d*", attempt), "Invalid disposable run binding.")
    directory = home / ".local/libexec" / f"agentsdock-acceptance-{run}-{attempt}"
    contained(directory, home)
    for parent in (home / ".local", home / ".local/libexec"):
        if not parent.exists() and not parent.is_symlink():
            parent.mkdir(mode=0o700)
        owned_directory(parent)
    directory.mkdir(mode=0o700)  # Refuse existing directories, including symlinks.
    directory_info = owned_directory(directory)
    controls = args.work / "dependency-delegate"
    controls.mkdir(mode=0o700)
    delegate = directory / "uv"
    payload = (f"#!{sys.executable}\nimport runpy, sys\nfrom pathlib import Path\n"
               "try:\n"
               f"    module = runpy.run_path({str(ROOT / 'scripts/product_server_acceptance.py')!r})\n"
               f"    result = module['stage_fault_delegate'](sys.argv[1:], Path({str(controls / 'config.json')!r}))\n"
               "except Exception:\n"
               "    print('Owned dependency fixture failed safely.', file=sys.stderr)\n"
               "    raise SystemExit(74)\n"
               "raise SystemExit(result)\n").encode()
    fd = os.open(delegate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)
    write_private(controls / "config.json", {
        "realUv": str(real_uv), "realUvIdentity": [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns],
        "delegate": str(delegate), "delegateDirectoryBinding": [directory_info.st_dev, directory_info.st_ino],
        "delegateSha256": sha(payload), "installRoot": str(paths(home)["installRoot"]),
        "version": receipt["version"], "sourceSha": receipt["sourceSha"],
        "receiptSha256": args.receipt_sha256, "installerSha256": installer_hash})
    env["PATH"] = str(directory) + os.pathsep + env.get("PATH", "")


def bind_stage_fault_delegate(args: argparse.Namespace, fixture: dict) -> None:
    path = args.work / "dependency-delegate/config.json"
    config = json.loads(read_regular(path, 8192, private=True))
    config["rootBinding"] = fixture["rootBindings"]["installRoot"]
    write_private(path, config, replace=True)
    fixture["dependencyFaultFixture"] = {"configurationSha256": sha(read_regular(path, private=True))}


def owned_directory(path: Path) -> os.stat_result:
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid()
         and not info.st_mode & 0o022, "Expected a safely permissioned owned directory.")
    return info


def contained(path: Path, parent: Path) -> None:
    need(path.is_absolute() and path != parent and path.is_relative_to(parent)
         and ".." not in path.parts and path.resolve().is_relative_to(parent.resolve()),
         "Acceptance files must remain inside their disposable runner directory.")
    current = path
    while current != parent:
        need(not current.is_symlink(), "Symlinked acceptance paths are not permitted.")
        current = current.parent


def guard(receipt: dict, work: Path, *, environment: dict | None = None,
          uid: int | None = None, system: str | None = None, candidate: bool = False,
          candidate_server_linux: bool = False) -> Path:
    env = os.environ if environment is None else environment
    user = os.getuid() if uid is None else uid
    host = platform.system() if system is None else system
    workflow_ref = str(env.get("GITHUB_WORKFLOW_REF", ""))
    need(not (candidate and candidate_server_linux), "Candidate execution scopes are mutually exclusive.")
    if candidate_server_linux:
        need(env.get("GITHUB_JOB") == "candidate-server-rollback-linux", "Linux replay requires its explicit server-only job.")
    if candidate or candidate_server_linux:
        source_ref = receipt.get("sourceRef", "")
        need(receipt.get("schema") == 1 and receipt.get("kind") == "agentsdock-macos-candidate"
             and receipt.get("scope") == "darwin-app-server" and receipt.get("publicationEligible") is False
             and ((host == "Darwin" and env.get("RUNNER_OS") == "macOS" and candidate)
                  or (host == "Linux" and env.get("RUNNER_OS") == "Linux" and candidate_server_linux))
             and isinstance(source_ref, str) and re.fullmatch(r"release/[A-Za-z0-9][A-Za-z0-9._/-]*", source_ref) is not None
             and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
             and workflow_ref == f"ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/{source_ref}",
             "Test-only candidates require the deliberate exact-branch CI dispatch and cannot become production acceptance.")
    else:
        need(receipt.get("kind") != "agentsdock-macos-candidate"
             and workflow_ref.startswith("ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/"),
             "Production acceptance requires its own workflow and a production receipt.")
    need(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
         and env.get("GITHUB_REPOSITORY") == "ZhengyiLuo/AgentsDock"
         and env.get("GITHUB_EVENT_NAME") in {"workflow_dispatch", "workflow_call"}
         and (re.fullmatch(r"[a-f0-9]{40}", str(env.get("GITHUB_SHA", ""))) is not None if candidate or candidate_server_linux
              else env.get("GITHUB_SHA") == receipt.get("sourceSha"))
         and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ID", "")) is not None
         and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ATTEMPT", "")) is not None,
         "Native acceptance is restricted to the exact-source canonical workflow on a disposable hosted runner.")
    need(user != 0 and host in {"Linux", "Darwin"}, "A non-root native Linux/macOS runner is required.")
    home = Path(env.get("HOME", ""))
    need(home.is_absolute(), "The actual runner account home is required.")
    if environment is None:
        need(home.resolve() == Path(pwd.getpwuid(user).pw_dir).resolve(),
             "Do not redirect HOME: acceptance requires the disposable account's real service session.")
        owned_directory(home)
    # Hosted Ubuntu exports this account-default selector. Match the existing
    # npm-native guard, but only for the explicit Linux server-only rehearsal.
    # A custom/literal/symlinked root, another account or macOS remains refused.
    xdg = env.get("XDG_CONFIG_HOME")
    default_xdg = False
    if candidate_server_linux and host == "Linux" and xdg and xdg == str(home / ".config"):
        try:
            if home.resolve() == Path(pwd.getpwuid(user).pw_dir).resolve():
                owned_directory(home)
                contained(home / ".config", home)
                if (home / ".config").exists():
                    owned_directory(home / ".config")
                default_xdg = True
        except (OSError, RuntimeError, KeyError, ValueError):
            pass
    offending = [key for key in SELECTORS if env.get(key)
                 and not (key == "XDG_CONFIG_HOME" and default_xdg)]
    need(not offending, "Custom or inherited server roots are not allowed. Offending selector keys: "
         + ", ".join(offending))
    temporary = Path(env.get("RUNNER_TEMP", ""))
    need(temporary.is_absolute(), "RUNNER_TEMP must identify the disposable runner.")
    contained(work, temporary)
    need(work.name.startswith("agentsdock-acceptance-"), "Use a dedicated agentsdock-acceptance-* directory.")
    # Only normalize this process's one verified default after every host/path
    # guard passes. Never rewrite HOME, unset other selectors or change settings.
    if default_xdg:
        env.pop("XDG_CONFIG_HOME")
    return home


def paths(home: Path) -> dict[str, Path]:
    return {"installRoot": home / ".local/share/agents-server", "stateRoot": home / ".agentsdock",
            "configRoot": home / ".config/agents-server"}


def service_files(home: Path) -> list[Path]:
    if platform.system() == "Darwin":
        return [home / "Library/LaunchAgents" / f"{label}.plist"
                for label in ("com.agentsdock.server", "com.agentsdock.gateway")]
    return [home / ".config/systemd/user" / unit
            for unit in ("agents-server.service", "agents-server-gateway.service")]


def ensure_empty(home: Path) -> None:
    for item in [*paths(home).values(), home / ".zenithbot-agent", *service_files(home),
                 home / ".config/systemd/user/zenithbot-agent.service"]:
        contained(item, home)
        for parent in item.parents:
            if parent == home:
                break
            if parent.exists():
                owned_directory(parent)
        need(not item.exists() and not item.is_symlink(),
             "Runner already has server state/configuration/service; no installation was attempted.")
    if platform.system() == "Darwin":
        command(["/bin/launchctl", "print", f"gui/{os.getuid()}"])
        for label in ("com.agentsdock.server", "com.agentsdock.gateway"):
            need(launchd_query_state(f"gui/{os.getuid()}/{label}") == "absent",
                 "An existing or unverifiable native service prevents fresh acceptance.")
    else:
        command(["systemctl", "--user", "show-environment"])
        for unit in ("agents-server.service", "agents-server-gateway.service", "zenithbot-agent.service"):
            result = command(["systemctl", "--user", "show", unit, "--property=LoadState", "--value"], allowed=(0, 1))
            need(result.stdout.strip() == b"not-found", "An existing native service prevents fresh acceptance.")


def token_at(config: Path) -> str:
    lines = read_regular(config / "env", private=True).decode().splitlines()
    values = [line.partition("=")[2] for line in lines if line.startswith("AGENTSDOCK_AGENT_TOKEN=")]
    need(len(values) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{32,}", values[0]) is not None,
         "Installer did not create one private valid service token.")
    return values[0]


def request(fixture: dict, path: str, body: object | None = None, *, expected: tuple[int, ...] = (200,)) -> dict:
    url = urlsplit(fixture["serverUrl"])
    need(url.scheme == "http" and url.hostname == "127.0.0.1" and url.port is not None
         and not url.username and not url.password and url.path == "" and not url.query and not url.fragment,
         "Acceptance only talks to its literal loopback server.")
    need(path.startswith("/api/") and "\n" not in path, "Invalid acceptance API path.")
    connection = http.client.HTTPConnection("127.0.0.1", url.port, timeout=10)
    try:
        data = canonical(body) if body is not None else None
        headers = {"X-AgentsDock-Token": fixture["token"]}
        if data is not None:
            headers["Content-Type"] = "application/json"
        connection.request("POST" if body is not None else "GET", path, body=data, headers=headers)
        response = connection.getresponse()
        payload = response.read(8 * 1024 * 1024 + 1)
        need(response.status in expected and len(payload) <= 8 * 1024 * 1024,
             f"Native acceptance API request failed (HTTP {response.status}); body withheld.")
        value = json.loads(payload)
        need(isinstance(value, dict), "API response must be an object.")
        return value
    finally:
        connection.close()


def health(fixture: dict, version: str, *, timeout: int = 180) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        try:
            value = request(fixture, "/api/health")
            need(value.get("ok") is True and value.get("server_version") == version,
                 "Service did not reach the exact expected version.")
            if fixture.get("serverIdentity"):
                need(value.get("server_identity") == fixture["serverIdentity"], "Server identity changed.")
            need(bool(value.get("server_identity")) and bool(value.get("server_instance_id")),
                 "Authenticated health omitted server/process identity.")
            return value
        except (OSError, RuntimeError, ValueError, http.client.HTTPException):
            if time.monotonic() >= deadline:
                raise RuntimeError("Exact authenticated native service health was not reached; response withheld.") from None
            time.sleep(1)


def registered_services(fixture: dict) -> list[Path]:
    root = Path(fixture["installRoot"])
    home = Path(fixture["home"])
    files = [item for item in service_files(home) if item.exists()]
    need(files and files[0] == service_files(home)[0], "Installed worker service is missing.")
    for item in files:
        info = item.lstat()
        need(info.st_uid == os.getuid() and not info.st_mode & 0o022,
             "Native service registration is not safely owned by the disposable account.")
        raw = read_regular(item)
        if platform.system() == "Darwin":
            value = plistlib.loads(raw)
            args = value.get("ProgramArguments")
            need(value.get("Label") == item.stem and isinstance(args, list) and args and str(args[0]).startswith(str(root) + "/"),
                 "Installed service does not run from its permanent owned runtime.")
        else:
            entries = [line[10:] for line in raw.decode().splitlines() if line.startswith("ExecStart=")]
            need(len(entries) == 1, "Installed service must have one executable command.")
            args = shlex.split(entries[0])
            # Split-execution units use /usr/bin/env to reassert authoritative
            # bindings above EnvironmentFile. This is the real unit format,
            # not a shell or a substitute service in the acceptance harness.
            if args and args[0] == "/usr/bin/env":
                args = args[1:]
                while args and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", args[0]):
                    args = args[1:]
            need(bool(args) and args[0].startswith(str(root) + "/"),
                 "Installed service does not run from its permanent owned runtime.")
        need(str(fixture["workDirectory"]).encode() not in raw,
             "Native service still depends on staging or npm cache paths.")
    return files


def launchd_registration(item: Path, expected_sha: str) -> None:
    info = item.lstat()
    need(info.st_uid == os.getuid() and not info.st_mode & 0o022 and sha(read_regular(item)) == expected_sha,
         "Owned launchd registration changed during the native service operation.")


def launchd_query_state(target: str, *, timeout: float = 10) -> str:
    need(target in {f"gui/{os.getuid()}/com.agentsdock.server", f"gui/{os.getuid()}/com.agentsdock.gateway"},
         "Launchd observation must target an exact disposable AgentsDock service.")
    result = command(["/bin/launchctl", "print", target],
                     timeout=timeout, allowed=(0, 3, 5, 113))
    if result.returncode == 0:
        return "loaded"
    output = result.stdout + result.stderr
    need(any(label in output.lower() for label in (b"could not find service", b"service not found", b"no such process")),
         f"Native command failed (launchctl print, exit {result.returncode}); service absence was not proven and private output was withheld.")
    return "absent"


def launchd_state(item: Path, expected_sha: str, *, timeout: float = 10) -> str:
    launchd_registration(item, expected_sha)
    return launchd_query_state(f"gui/{os.getuid()}/{item.stem}", timeout=timeout)


def wait_launchd_absent(item: Path, expected_sha: str, *, timeout: float = 185) -> None:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        need(remaining > 0, "Native launchctl removal timed out; no bootstrap was attempted.")
        if launchd_state(item, expected_sha, timeout=min(10, remaining)) == "absent":
            return
        time.sleep(min(0.1, remaining))


def stop_launchd(item: Path, expected_sha: str) -> None:
    if launchd_state(item, expected_sha) == "absent":
        return
    launchd_registration(item, expected_sha)
    result = command(["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{item.stem}"],
                     timeout=240, allowed=(0, 5, 113))
    if result.returncode != 0:
        need(launchd_state(item, expected_sha) == "absent",
             f"Native command failed (launchctl bootout, exit {result.returncode}); owned service remained loaded and private output was withheld.")
    # bootout only acknowledges teardown; it does not prove removal completed.
    wait_launchd_absent(item, expected_sha)


def start_launchd(item: Path, expected_sha: str) -> None:
    wait_launchd_absent(item, expected_sha)
    for attempt in range(3):
        launchd_registration(item, expected_sha)
        result = command(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(item)],
                         timeout=60, allowed=(0, 5, 37))
        if result.returncode == 0:
            need(launchd_state(item, expected_sha) == "loaded",
                 "Native launchctl bootstrap succeeded but did not register the owned service.")
            return
        output = result.stdout + result.stderr
        transient = (b"Operation already in progress" in output or
                     (result.returncode == 5 and b"Bootstrap failed: 5: Input/output error" in output))
        need(transient and attempt < 2,
             f"Native command failed (launchctl bootstrap, exit {result.returncode}); retry unavailable or exhausted and private output was withheld.")
        # Retry only the exact registered fixture after proving it absent again.
        # Never turn a loaded job or an unknown status-5 error into success.
        wait_launchd_absent(item, expected_sha)
        time.sleep(0.1)


def service(fixture: dict, action: str) -> None:
    files = registered_services(fixture)
    bindings = {item: sha(read_regular(item)) for item in files}
    # Offline is a public-gateway outage for split services, preserving work.
    selected = files if action == "restart" else files[-1:]
    for item in reversed(selected) if action in {"stop", "restart"} else []:
        if platform.system() == "Darwin":
            stop_launchd(item, bindings[item])
        else:
            command(["systemctl", "--user", "stop", item.name], timeout=240)
    for item in selected if action in {"start", "restart"} else []:
        if platform.system() == "Darwin":
            start_launchd(item, bindings[item])
        else:
            command(["systemctl", "--user", "start", item.name], timeout=60)
    if action == "stop":
        url = urlsplit(fixture["serverUrl"])
        deadline = time.monotonic() + 30
        while True:
            try:
                with socket.create_connection(("127.0.0.1", url.port), timeout=1):
                    pass
            except OSError:
                break
            need(time.monotonic() < deadline, "Owned public service did not stop.")
            time.sleep(0.2)


DIAGNOSTIC_PHASES = frozenset({"idle", "available", "current", "pending", "starting", "checking", "downloading",
    "verifying", "installing", "restarting", "complete", "failed", "prepared", "guarded", "quiescing", "quiesced",
    "linking", "linked", "stopping", "stopped", "fencing", "fenced", "authorizing", "authority", "candidate-starting",
    "candidate-healthy", "committing", "committed", "rolling-back", "rolled-back", "rollback-healthy"})


def diagnostic_version(value: object, fixture: dict) -> str:
    return "candidate" if value == fixture["targetVersion"] else "baseline" if value == fixture["baselineVersion"] else "other-or-unknown"


def diagnostic_legacy_failure(message: object) -> dict:
    """Classify legacy str(exc), never publish it or infer a previous phase.

    The 1.0.3 runner stores exceptions only as `message`, not error/error_code.
    In particular, an empty cryptography InvalidSignature string has no unique
    identifier here and must remain unclassified rather than becoming proof.
    """
    if message is None:
        return {"messageState": "missing", "categories": [], "knownError": None}
    if not isinstance(message, str):
        return {"messageState": "invalid-type", "categories": [], "knownError": None}
    if len(message) > 8192:
        return {"messageState": "oversized", "categories": [], "knownError": None}
    if not message.strip():
        return {"messageState": "empty", "categories": [], "knownError": None}
    # These exact fixed errors are from the signed legacy updater's validation
    # paths. Dynamic values are matched below but never copied into evidence.
    exact = {
        "release public key is not an Ed25519 key": ("manifest-verification", "release-key-type"),
        "release manifest must be a JSON object": ("manifest-verification", "manifest-not-object"),
        "release manifest contains an invalid version": ("manifest-verification", "manifest-version-invalid"),
        "release manifest version does not match its immutable release tag": ("manifest-verification", "manifest-tag-mismatch"),
        "release manifest prerelease metadata is inconsistent": ("manifest-verification", "manifest-prerelease-mismatch"),
        "release manifest track metadata is inconsistent": ("manifest-verification", "manifest-track-mismatch"),
        "release manifest is missing archive metadata": ("manifest-verification", "manifest-archive-missing"),
        "release archive location is not trusted": ("manifest-verification", "archive-location-untrusted"),
        "release archive checksum is invalid": ("manifest-verification", "archive-checksum-invalid"),
        "release archive checksum does not match the signed manifest": ("archive-verification", "archive-checksum-mismatch"),
        "release archive contains an unsafe path": ("archive-extraction", "archive-unsafe-path"),
        "release archive must not contain links": ("archive-extraction", "archive-links-forbidden"),
        "release archive has an invalid layout": ("archive-extraction", "archive-layout-invalid"),
        "GitHub releases response must be a JSON array": ("release-discovery", "release-list-not-array"),
        "GitHub releases response is invalid JSON": ("release-discovery", "release-list-invalid-json"),
        "No signed AgentsServer release has been published yet.": ("release-discovery", "release-list-not-found"),
        "expected release version is invalid": ("release-selection", "requested-version-invalid"),
        "server update health credential is empty": ("health-authorization", "health-credential-empty"),
        "managed update is missing the stable server identity": ("identity-admission", "stable-identity-missing"),
        "managed update is missing a valid update ID": ("identity-admission", "update-identity-invalid"),
        "AgentsServer stable identity changed before restart": ("identity-admission", "incumbent-identity-mismatch"),
        "updated AgentsServer stable identity does not match": ("post-install-health", "candidate-identity-mismatch"),
        "updated AgentsServer secure-peer state is unavailable": ("post-install-health", "candidate-peer-unavailable"),
        "updated AgentsServer lost or changed its Team Hub identity": ("post-install-health", "candidate-hub-identity-mismatch"),
        "updated AgentsServer changed its Team Hub transport": ("post-install-health", "candidate-hub-transport-mismatch"),
        "updated AgentsServer changed its legacy Team Hub transport": ("post-install-health", "candidate-legacy-hub-transport-mismatch"),
        "updated AgentsServer changed its Team Hub routes": ("post-install-health", "candidate-hub-routes-mismatch"),
        "updated AgentsServer did not repair its Team Hub host": ("post-install-health", "candidate-hub-repair-failed"),
    }
    categories: set[str] = set()
    known = None
    if message in exact:
        category, known = exact[message]
        categories.add(category)
    variable = (
        (r"Signed (?:stable|beta) AgentsServer release [^\r\n ]+ is unavailable\.", "descriptor-fetch", "signed-descriptor-not-found"),
        (r"No signed (?:stable|beta) AgentsServer release is available\.", "release-discovery", "release-track-empty"),
        (r"release manifest is not on the requested (?:stable|beta) track", "manifest-verification", "manifest-wrong-track"),
        (r"expected release [^\r\n ]+ is not on the requested (?:stable|beta) track", "release-selection", "requested-track-mismatch"),
        (r"requested (?:stable|beta) release [^\r\n ]+ is no longer the latest signed (?:stable|beta) release [^\r\n ]+", "release-selection", "requested-not-latest"),
        (r"resolved signed release is [^\r\n ]+, not [^\r\n ]+", "release-selection", "resolved-version-mismatch"),
        (r"resolved release [^\r\n ]+ is not newer than installed version [^\r\n;]+; managed updates only permit forward updates or an explicit beta-to-stable channel switch", "release-selection", "forward-update-required"),
        (r"download exceeds the [0-9]+-byte safety limit", "download", "download-size-limit"),
        (r"AgentsServer startup readiness timed out after [0-9.]+ seconds", "health-readiness", "startup-readiness-timeout"),
    )
    for pattern, category, identifier in variable:
        if re.fullmatch(pattern, message):
            categories.add(category)
            known = identifier
            break
    lowered = message.lower()
    signatures = {
        "tls-verification": ("certificate_verify_failed", "certificate verify failed", "unable to get local issuer"),
        "network-refused": ("connection refused",), "network-timeout": ("timed out", "timeout"),
        "dns-resolution": ("name or service not known", "nodename nor servname provided", "temporary failure in name resolution"),
        "download-truncated": ("incompleteread", "unexpected end of data", "unexpected end of file", "compressed file ended before"),
        "signature-verification": ("invalidsignature", "invalid signature", "signature verification failed"),
        "archive-extraction": ("not a gzip file", "invalid header",),
        "dependency-prerequisite": ("missing required prerequisites", "trusted uv executable", "no solution found", "failed to download"),
        "missing-python-module": ("modulenotfounderror",), "permission-denied": ("permission denied",),
        "missing-file-or-executable": ("no such file or directory", "no module named"),
        "health-readiness": ("could not verify that agentsserver is idle before restart:", "server became busy before restart:", "server health response"),
        "hub-continuity": ("managed team hub", "expected team hub", "repaired team hub",),
    }
    categories.update(category for category, needles in signatures.items() if any(needle in lowered for needle in needles))
    result = {"messageState": "present", "categories": [], "knownError": known}
    http = re.search(r"\bHTTP Error ([1-5][0-9]{2}):", message)
    if http:
        result["httpStatus"] = int(http[1])
        categories.add("http-response")
    installer = re.match(r"installer failed \((-?[0-9]{1,5})\):", message)
    if installer and -32768 <= int(installer[1]) <= 32767:
        result["installerExitCode"] = int(installer[1])
        result["knownError"] = "installer-exit-failure"
        categories.add("installer")
    elif re.match(r"installer timed out after [0-9.]+ seconds", message):
        result["knownError"] = "installer-timeout"
        categories.add("installer")
    result["categories"] = sorted(categories) if categories else ["unclassified"]
    return result


def diagnostic_status(value: object, fixture: dict) -> dict:
    if not isinstance(value, dict):
        return {"readable": False}
    phase = value.get("phase")
    return {"readable": True, "phase": phase if isinstance(phase, str) and phase in DIAGNOSTIC_PHASES else "other-or-unknown",
            "target": diagnostic_version(value.get("target_version", value.get("release_version")), fixture),
            "retryable": value.get("retryable") is True,
            "errorPresent": bool(value.get("error") or value.get("error_code")),
            **({"failure": diagnostic_legacy_failure(value.get("message"))} if phase == "failed" else {})}


def diagnostic_service_output(result: subprocess.CompletedProcess, system: str) -> dict:
    """Project only known native fields; never return environment or argv."""
    text = result.stdout.decode("utf-8", errors="replace")
    if result.returncode != 0:
        absent = any(marker in (result.stdout + result.stderr).lower()
                     for marker in (b"could not find service", b"service not found", b"no such process", b"not-found"))
        return {"registered": False if absent else None, "querySucceeded": False}
    if system == "Darwin":
        state = re.search(r"^\s+state = ([a-z ]+)\s*$", text, re.MULTILINE)
        pid = re.search(r"^\s+pid = ([0-9]{1,10})\s*$", text, re.MULTILINE)
        status = re.search(r"^\s+last exit code = (-?[0-9]{1,5})\s*$", text, re.MULTILINE)
        state_value = state[1] if state else None
    else:
        state = re.search(r"^ActiveState=([a-z-]+)$", text, re.MULTILINE)
        pid = re.search(r"^MainPID=([0-9]{1,10})$", text, re.MULTILINE)
        status = re.search(r"^ExecMainStatus=(-?[0-9]{1,5})$", text, re.MULTILINE)
        state_value = state[1] if state else None
    return {"registered": True, "querySucceeded": True,
            "state": state_value if state_value in {"running", "waiting", "spawn scheduled", "active", "inactive", "failed", "activating", "deactivating"} else "other-or-unknown",
            "pid": int(pid[1]) if pid and 0 < int(pid[1]) < 2 ** 31 else None,
            "lastExitCode": int(status[1]) if status and -32768 <= int(status[1]) <= 32767 else None}


def diagnostic_log_categories(path: Path, owner_root: Path) -> dict:
    """Read at most the owned log's last 64 KiB, emitting finite labels only."""
    try:
        contained(path, owner_root)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1,
                 "Diagnostic log ownership is unproven.")
            stream.seek(max(0, info.st_size - 65536))
            data = stream.read(65536).lower()
        patterns = {"tls-verification": (b"certificate_verify_failed", b"certificate verify failed", b"unable to get local issuer"),
                    "port-in-use": (b"address already in use",), "missing-python-module": (b"modulenotfounderror",),
                    "permission-denied": (b"permission denied",), "connection-refused": (b"connection refused",),
                    "dependency-resolution": (b"no solution found", b"failed to download"),
                    "native-health-failure": (b"health check failed", b"did not become healthy", b"rollback is incomplete"),
                    "signature-rejected": (b"invalid signature", b"signature verification failed",)}
        return {"readable": True, "categories": sorted(name for name, needles in patterns.items() if any(needle in data for needle in needles))}
    except (OSError, RuntimeError):
        return {"readable": False, "categories": []}


def diagnostic_tmux_trust(fixture: dict) -> dict:
    """Inspect one daemon variable only; never start/set a tmux server."""
    result = {"daemonAvailable": None, "ownedTrustBundleAvailable": False, "trustBundleMatches": False}
    try:
        work = Path(fixture["workDirectory"])
        bundle = work.parent / "agentsdock-acceptance-network/trust-bundle.pem"
        contained(bundle, work.parent)
        read_regular(bundle, private=True)
        result["ownedTrustBundleAvailable"] = True
        observed = command(["tmux", "show-environment", "-g", "SSL_CERT_FILE"], timeout=5, allowed=(0, 1))
        if observed.returncode == 0:
            result["daemonAvailable"] = True
            result["trustBundleMatches"] = observed.stdout.rstrip(b"\r\n") == f"SSL_CERT_FILE={bundle}".encode()
        elif b"unknown variable" in observed.stderr.lower():
            result["daemonAvailable"] = True
        elif any(marker in observed.stderr.lower() for marker in (b"no server running", b"no such file or directory")):
            result["daemonAvailable"] = False
    except (OSError, RuntimeError, KeyError):
        pass
    return result


def diagnose(fixture: dict) -> dict:
    """Read-only failure observations; not an acceptance test or recovery tool."""
    root, state, home = (Path(fixture[key]) for key in ("installRoot", "stateRoot", "home"))
    current = root / "current"
    target = current.resolve() if current.is_symlink() else None
    version = next((value for value in (fixture["baselineVersion"], fixture["targetVersion"])
                    if target == root / "releases" / value), None)
    result = {"diagnosticOnly": True, "currentRuntime": diagnostic_version(version, fixture), "services": {}, "journals": {}}
    try:
        files = registered_services(fixture)
        result["registrationsVerified"] = True
    except (OSError, RuntimeError, ValueError):
        files = []
        result["registrationsVerified"] = False
    for item in files:
        role = "gateway" if "gateway" in item.name else "worker"
        try:
            system = platform.system()
            if system == "Darwin":
                config = plistlib.loads(read_regular(item))
                environment = config.get("EnvironmentVariables", {})
                if not isinstance(environment, dict):
                    environment = {}
                observed = command(["/bin/launchctl", "print", f"gui/{os.getuid()}/{item.stem}"], timeout=10, allowed=(0, 3, 5, 113))
            else:
                environment = {}
                observed = command(["systemctl", "--user", "show", item.name, "--property=ActiveState,MainPID,ExecMainStatus"], timeout=10, allowed=(0, 1, 3, 4))
            result["services"][role] = diagnostic_service_output(observed, system)
            if system == "Darwin":
                result["services"][role]["configuredPortMatches"] = str(environment.get("AGENTSDOCK_AGENT_PORT", "")) == str(urlsplit(fixture["serverUrl"]).port)
        except (OSError, RuntimeError, ValueError):
            result["services"][role] = {"querySucceeded": False}
    try:
        live = request(fixture, "/api/health")
        result["health"] = {"reachable": True, "ok": live.get("ok") is True,
                            "identityMatches": live.get("server_identity") == fixture["serverIdentity"],
                            "version": diagnostic_version(live.get("server_version"), fixture)}
    except (OSError, RuntimeError, ValueError, http.client.HTTPException):
        result["health"] = {"reachable": False}
    records = [("activation", root / ".activation-transaction/manifest.json", root),
               ("execution", root / ".execution-transaction/manifest.json", root),
               ("update", state / "admin/server-update.json", state)]
    for label, path, owner in records:
        try:
            contained(path, owner)
            result["journals"][label] = diagnostic_status(json.loads(read_regular(path, 256 * 1024, private=True)), fixture)
        except (OSError, RuntimeError, ValueError):
            result["journals"][label] = {"readable": False}
    result["logs"] = {"updater": diagnostic_log_categories(state / "admin/server-update.log", state),
                       "legacyStderr": diagnostic_log_categories(home / "Library/Logs/AgentsServer/server-error.log", home),
                       "workerStderr": diagnostic_log_categories(state / "execution/logs/worker.stderr.log", state),
                       "gatewayStderr": diagnostic_log_categories(state / "execution/logs/gateway.stderr.log", state)}
    result["tmuxTrust"] = diagnostic_tmux_trust(fixture)
    try:
        result["preservation"] = snapshot_differences(fixture["snapshot"], state_snapshot(fixture))
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, http.client.HTTPException):
        result["preservation"] = {"readable": False}
    return result


def safe_extract(archive: Path, destination: Path) -> Path:
    destination.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        need(0 < len(members) <= 500 and sum(member.size for member in members) <= 200 * 1024 * 1024,
             "Legacy archive exceeds the bounded runtime inventory.")
        names: set[str] = set()
        for member in members:
            value = Path(member.name)
            need(bool(value.parts) and not value.is_absolute() and ".." not in value.parts and member.name not in names
                 and (member.isfile() or member.isdir()) and not member.mode & 0o6000,
                 "Unsafe legacy archive member.")
            names.add(member.name)
        roots = {Path(member.name).parts[0] for member in members}
        need(len(roots) == 1, "Legacy archive must contain exactly one release root.")
        package.extractall(destination, members=members, filter="data")
    return destination / roots.pop()


def legacy_source(args: argparse.Namespace, work: Path, candidate: str) -> tuple[Path, str]:
    for value in (args.baseline_archive, args.baseline_manifest, args.baseline_signature):
        need(value is not None, "A real earlier signed legacy release is required; a rewritten VERSION is not accepted.")
    manifest = json.loads(read_regular(args.baseline_manifest, 8192))
    signature = read_regular(args.baseline_signature, 64)
    need(len(signature) == 64, "Legacy signature must be Ed25519.")
    script = """const f=require('node:fs'),c=require('node:crypto');
if(!c.verify(null,f.readFileSync(process.argv[1]),f.readFileSync(process.argv[3]),f.readFileSync(process.argv[2])))process.exit(1);"""
    command(["node", "-e", script, str(args.baseline_manifest), str(args.baseline_signature),
             str(ROOT / "server/release-public-key.pem")])
    version = manifest.get("version", "")
    need(manifest.get("schema") == 1 and VERSION.fullmatch(version) is not None
         and version_order(version) < version_order(candidate), "Legacy baseline must be an earlier signed real version.")
    payload = read_regular(args.baseline_archive, 200 * 1024 * 1024)
    archive = manifest.get("archive", {})
    need(archive.get("name") == args.baseline_archive.name and archive.get("size") == len(payload)
         and archive.get("sha256") == sha(payload), "Legacy baseline archive differs from its signed descriptor.")
    source = safe_extract(args.baseline_archive, work / "legacy-source")
    need(read_regular(source / "VERSION", 200).decode().strip() == version,
         "Legacy baseline runtime version differs from its signed identity.")
    return source, version


def version_order(value: str) -> tuple:
    match = VERSION.fullmatch(value)
    need(match is not None, "Invalid release version.")
    return (*map(int, match.groups()[:3]), match[4] is None, int(match[4] or 0))


def state_snapshot(fixture: dict) -> dict:
    identity = read_regular(Path(fixture["stateRoot"]) / "server-identity", 1024, private=True).decode().strip()
    need(identity == fixture["serverIdentity"] and token_at(Path(fixture["configRoot"])) == fixture["token"],
         "Server identity or access token changed.")
    values = request(fixture, "/api/sessions").get("sessions")
    need(isinstance(values, list) and 0 < len(values) <= 30,
         "Populate one or more disposable real sessions before the preservation snapshot.")
    sessions = {}
    for item in values:
        identifier = item.get("id", "")
        need(re.fullmatch(r"[A-Za-z0-9_-]+", identifier) is not None, "Invalid fixture session ID.")
        detail = request(fixture, f"/api/sessions/{identifier}?limit=1000&tail=false")
        need(detail.get("events_omitted_before", 0) == 0 and detail.get("events_omitted_after", 0) == 0,
             "Preservation fixture exceeds the bounded complete timeline.")
        session = detail.get("session", {})
        events = detail.get("events")
        need(isinstance(events, list), "Session timeline was omitted.")
        sessions[identifier] = {"identity": {key: session.get(key) for key in SESSION_KEYS},
                                "presentFields": [key for key in SESSION_KEYS if key in session],
                                "eventHashes": [sha(canonical(event)) for event in events],
                                "queued": detail.get("queued_turns", [])}
    return {"serverIdentitySha256": sha(identity.encode()), "tokenSha256": sha(fixture["token"].encode()),
            "sessions": sessions}


def snapshot_differences(before: dict, after: dict) -> dict:
    """Expose only fixed field names, booleans and bounded session counts."""
    need(isinstance(before, dict) and isinstance(after, dict), "Invalid preservation snapshot.")
    saved_sessions, actual_sessions = before.get("sessions"), after.get("sessions")
    need(isinstance(saved_sessions, dict) and isinstance(actual_sessions, dict)
         and 0 < len(saved_sessions) <= 30 and len(actual_sessions) <= 30,
         "Preservation diagnostics require bounded session snapshots.")
    result = {"readable": True,
              "serverIdentityChanged": before.get("serverIdentitySha256") != after.get("serverIdentitySha256"),
              "tokenChanged": before.get("tokenSha256") != after.get("tokenSha256"),
              "missingSessionCount": 0, "changedSessionCount": 0,
              "changedSessionFields": [], "unrecognizedSessionFieldChanged": False,
              "historyChanged": False, "queuedMessagesChanged": False}
    changed_fields: set[str] = set()
    for identifier, saved in saved_sessions.items():
        actual = actual_sessions.get(identifier)
        if actual is None:
            result["missingSessionCount"] += 1
            continue
        need(isinstance(saved, dict) and isinstance(actual, dict)
             and isinstance(saved.get("identity"), dict) and isinstance(actual.get("identity"), dict)
             and isinstance(saved.get("eventHashes"), list) and isinstance(actual.get("eventHashes"), list),
             "Invalid session preservation snapshot.")
        old, new = saved["identity"], actual["identity"]
        if old != new:
            result["changedSessionCount"] += 1
            changed_fields.update(key for key in SESSION_KEYS if old.get(key) != new.get(key)
                                  or (key in old) != (key in new))
            result["unrecognizedSessionFieldChanged"] |= any(
                key not in SESSION_KEYS and (old.get(key) != new.get(key) or (key in old) != (key in new))
                for key in old.keys() | new.keys())
        result["historyChanged"] |= actual["eventHashes"][:len(saved["eventHashes"])] != saved["eventHashes"]
        result["queuedMessagesChanged"] |= bool(saved.get("queued")) and actual.get("queued") != saved["queued"]
    result["changedSessionFields"] = sorted(changed_fields)
    return result


def schema_defaults_added(saved: dict, actual: dict, baseline_version: str | None,
                          candidate_version: str | None) -> set[str]:
    """Recognize only proven absent 1.0.3 fields gaining their exact defaults.

    Signed 1.0.3 public_session omitted both fields. The candidate projects the
    implicit Codex provider as 'default' and persists the new OpenCode default
    on every loaded session. Existing fields, including explicit null, are not
    migration defaults. Callers supply versions only after exact receipt-bound
    candidate health; same-version and pre-update checks remain strict.
    """
    if (baseline_version != "1.0.3" or not isinstance(candidate_version, str)
            or VERSION.fullmatch(candidate_version) is None
            or version_order(candidate_version) <= version_order(baseline_version)):
        return set()
    old, new = saved.get("identity", {}), actual.get("identity", {})
    if old.get("backend") not in {"codex", "claude", "cursor"} or old.get("backend") != new.get("backend"):
        return set()
    present_before, present_after = saved.get("presentFields"), actual.get("presentFields")
    if not all(isinstance(value, list) and len(value) <= len(SESSION_KEYS)
               and all(isinstance(key, str) and key in SESSION_KEYS for key in value)
               and len(set(value)) == len(value) for value in (present_before, present_after)):
        return set()
    return {key for key in ("codex_provider", "opencode_permission_mode")
            if key not in present_before and old.get(key) is None
            and key in present_after and new.get(key) == "default"}


def compare_snapshot(before: dict, after: dict, *, baseline_version: str | None = None,
                     candidate_version: str | None = None) -> dict:
    need(before["serverIdentitySha256"] == after["serverIdentitySha256"] and before["tokenSha256"] == after["tokenSha256"],
         "Migration changed server identity or token.")
    defaults_added: set[str] = set()
    for identifier, saved in before["sessions"].items():
        actual = after["sessions"].get(identifier)
        need(actual is not None, "Migration removed a saved chat.")
        defaults = schema_defaults_added(saved, actual, baseline_version, candidate_version)
        expected = {**saved["identity"], **{key: "default" for key in defaults}}
        changes = [key for key in SESSION_KEYS if actual["identity"].get(key) != expected.get(key)
                   or (key in actual["identity"]) != (key in expected)]
        need(actual["identity"] == expected,
             "Migration changed preserved session fields: " + ", ".join(changes or ["unrecognized-field"]) + ".")
        defaults_added.update(defaults)
        need(actual["eventHashes"][:len(saved["eventHashes"])] == saved["eventHashes"],
             "Migration removed or changed previously saved history.")
        if saved.get("queued"):
            need(actual.get("queued") == saved["queued"], "Migration changed the pending queued messages.")
    return {"schemaDefaultsAdded": sorted(defaults_added)}


def rejection_checks(fixture: dict, bundle: Path, version: str) -> dict:
    """Use real authenticated native routes without admitting a valid update."""
    current = health(fixture, version)
    manifest = read_regular(bundle / "npm/agents-server-npm-manifest.json", 8192)
    signature = read_regular(bundle / "npm/agents-server-npm-manifest.sig", 64)
    need(len(signature) == 64, "Prepared server signature length changed.")
    body = {"expected_server_identity": fixture["serverIdentity"],
            "expected_server_instance_id": current["server_instance_id"],
            "manifest_base64": base64.b64encode(manifest).decode(),
            "signature_base64": base64.b64encode(signature).decode()}
    corrupt = bytes([signature[0] ^ 1]) + signature[1:]
    request(fixture, "/api/admin/update/ensure", {
        **body, "signature_base64": base64.b64encode(corrupt).decode()}, expected=(400,))
    request(fixture, "/api/admin/update/ensure", {
        **body, "expected_server_identity": "acceptance-wrong-server-identity"}, expected=(409,))
    request(fixture, "/api/admin/update/ensure", {
        **body, "expected_server_instance_id": "acceptance-stale-server-instance"}, expected=(409,))
    after = health(fixture, version)
    need(after["server_instance_id"] == current["server_instance_id"], "Rejected updates restarted the incumbent.")
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    return {"invalidSignatureRejected": True, "mismatchedServerIdentityRejected": True,
            "staleProcessIdentityRejected": True, "incumbentAndPersistedStateUnchanged": True}


def installed_runtime_mode(member: tarfile.TarInfo, installer: bytes) -> int:
    """Model the one deliberate package-to-install mode change, never relax bytes."""
    mode = member.mode & 0o7777
    need(mode in {0o644, 0o755}, "Signed runtime member has an unsupported mode.")
    if member.name == "package/server/agent_server.py" and mode == 0o644:
        # Both archives intentionally carry this Python module as 0644. The
        # signed installer makes its installed entrypoint executable. Authorize
        # precisely that known transformation only when the sealed installer
        # contains the production rule; do not allow arbitrary mode changes.
        rule = rb'^chmod 755 "\$STAGE_DIR/agent_server\.py"(?: "\$STAGE_DIR/[A-Za-z0-9_.-]+")*$'
        need(sum(re.fullmatch(rule, line) is not None for line in installer.splitlines()) == 1,
             "Signed installer does not establish the expected entrypoint mode.")
        return 0o755
    return mode


def verify_installed_runtime(fixture: dict, bundle: Path, version: str) -> int:
    """Compare sealed bytes and exact installed modes, including installer policy."""
    descriptor = json.loads(read_regular(bundle / "npm/agents-server-npm-manifest.json", 8192))
    need(descriptor.get("version") == version, "Installed runtime pin differs from the prepared package.")
    install = Path(fixture["installRoot"])
    runtime = install / "releases" / version
    owned_directory(runtime)
    need((install / "current").is_symlink() and (install / "current").resolve() == runtime,
         "Activated runtime is not the exact permanent versioned candidate.")
    count = 0
    with tarfile.open(bundle / "npm" / descriptor["archive"]["name"], "r:gz") as package:
        members = package.getmembers()
        need(len(members) <= 500, "Unexpected runtime archive inventory size.")
        installers = [member for member in members if member.name == "package/server/install.sh"]
        need(len(installers) == 1 and installers[0].isfile() and installers[0].size <= 2 * 1024 * 1024,
             "Signed runtime must contain one bounded installer.")
        with package.extractfile(installers[0]) as source:
            installer = source.read()
        for member in members:
            if not member.name.startswith("package/server/") or member.isdir():
                continue
            relative = Path(member.name).relative_to("package/server")
            need(member.isfile() and ".." not in relative.parts and member.size <= 200 * 1024 * 1024,
                 "Unexpected runtime archive member.")
            installed = runtime / relative
            contained(installed, runtime)
            packaged = package.extractfile(member)
            need(packaged is not None, "Runtime archive member is missing.")
            with packaged:
                expected = packaged.read()
            actual = read_regular(installed, 200 * 1024 * 1024)
            need(actual == expected and stat.S_IMODE(installed.stat().st_mode) == installed_runtime_mode(member, installer),
                 "Activated runtime differs from the accepted package bytes or executable modes.")
            count += 1
    need(count > 0, "No signed server runtime files were compared.")
    return count


def wait_update_complete(fixture: dict, version: str, *, timeout: int = 180) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = request(fixture, "/api/admin/update")
        if status.get("phase") == "complete" and status.get("installed_version") == version:
            break
        need(status.get("phase") != "failed", "Retried native update failed after candidate health appeared.")
        time.sleep(1)
    else:
        raise RuntimeError("Candidate health appeared, but the exact update never completed activation.")
    for name in (".activation-transaction", ".execution-transaction"):
        journal = Path(fixture["installRoot"]) / name
        need(not journal.exists() and not journal.is_symlink(), "Candidate still has an unfinished activation journal.")


def worker_pid() -> int:
    raw = command(["systemctl", "--user", "show", "agents-server.service", "--property=MainPID", "--value"], timeout=10).stdout.strip()
    need(raw.isdigit(), "Native service manager did not report one worker PID.")
    return int(raw)


def candidate_process_identity(pid: int, fixture: dict, version: str, incumbent: int,
                               arm_ticks: int, *, proc_root: Path = Path("/proc")) -> tuple[int, int] | None:
    """Read-only proof for one candidate worker; never select by name alone."""
    if pid <= 1 or pid == incumbent:
        return None
    root = Path(fixture["installRoot"])
    candidate = root / "releases" / version
    if (root / "current").resolve() != candidate:
        return None
    try:
        status = read_regular(proc_root / str(pid) / "status", 65536).decode()
        rows = [line.split()[1:] for line in status.splitlines() if line.startswith("Uid:")]
        if len(rows) != 1 or rows[0] != [str(os.getuid())] * 4:
            return None
        process_stat = read_regular(proc_root / str(pid) / "stat", 65536).decode()
        tail = process_stat[process_stat.rfind(")") + 2:].split()
        # tail starts at field 3; field 22 is the non-reusable process start tick.
        if len(tail) < 20 or not tail[19].isdigit():
            return None
        started = int(tail[19])
        if started < arm_ticks:
            return None
        argv = read_regular(proc_root / str(pid) / "cmdline", 65536).decode().split("\0")
        expected = [str(candidate / ".venv/bin/python"), str(candidate / "execution_service.py"), "worker"]
        if argv[:3] != expected or (proc_root / str(pid) / "cwd").resolve(strict=True) != candidate:
            return None
        return pid, started
    except (OSError, ValueError, UnicodeError):
        return None


def require_no_pending_journals(root: Path) -> None:
    for name in (".activation-transaction", ".execution-transaction"):
        path = root / name
        need(not path.exists() and not path.is_symlink(),
             "An existing activation transaction prevents arming a candidate fault.")


def candidate_activation_journal(root: Path, version: str, transaction_id: str | None = None) -> dict:
    directory = root / ".activation-transaction"
    owned_directory(directory)
    value = json.loads(read_regular(directory / "manifest.json", 256 * 1024, private=True))
    need(value.get("format") in {2, 3} and value.get("release_version") == version
         and value.get("release_dir") == str(root / "releases" / version)
         and re.fullmatch(r"activation-[a-f0-9]{24}", str(value.get("transaction_id", ""))) is not None
         and (transaction_id is None or value["transaction_id"] == transaction_id),
         "Activation journal does not bind the exact candidate transaction.")
    return value


def root_normalization_contract(bundle: Path, receipt: dict) -> str:
    """Rebind the reviewed permission policy to the already verified packages.

    main() first verifies both signatures, source provenance and runtime parity.
    Rechecking archive bytes here prevents a later replacement from authorizing
    this one expected difference in before/after native observations.
    """
    version, source = receipt.get("version"), receipt.get("sourceSha")
    need(isinstance(version, str) and VERSION.fullmatch(version)
         and isinstance(source, str) and re.fullmatch(r"[a-f0-9]{40}", source),
         "Root-normalization policy requires the exact accepted source/version.")
    installers = []
    for distribution, manifest, archive_name, member_name in (
        ("npm", "agents-server-npm-manifest.json", f"server-{version}.tgz", "package/server/install.sh"),
        ("legacy", "agents-server-manifest.json", f"agents-server-{version}.tar.gz", f"agents-server-{version}/install.sh"),
    ):
        descriptor_bytes = read_regular(bundle / distribution / manifest, 8192)
        manifest_hash = receipt.get(f"{distribution}ManifestSha256")
        need(isinstance(manifest_hash, str) and re.fullmatch(r"[a-f0-9]{64}", manifest_hash)
             and sha(descriptor_bytes) == manifest_hash,
             "Root-normalization descriptor differs from the accepted receipt.")
        descriptor = json.loads(descriptor_bytes)
        archive = descriptor.get("archive", {})
        need(descriptor.get("version") == version and descriptor.get("commit") == source
             and archive.get("name") == archive_name,
             "Root-normalization package differs from the accepted source/version.")
        payload = read_regular(bundle / distribution / archive_name, 200 * 1024 * 1024)
        need(len(payload) == archive.get("size") and sha(payload) == archive.get("sha256"),
             "Root-normalization package bytes differ from their signed descriptor.")
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as package:
            members = [item for item in package.getmembers() if item.name == member_name]
            need(len(members) == 1 and members[0].isfile() and members[0].size <= 2 * 1024 * 1024,
                 "Root-normalization package must contain one bounded installer.")
            with package.extractfile(members[0]) as stream:
                installers.append(stream.read(2 * 1024 * 1024 + 1))
    need(installers[0] == installers[1] == read_regular(ROOT / "server/install.sh", 2 * 1024 * 1024)
         and sha(installers[0]) == ROOT_NORMALIZING_INSTALLER_SHA256,
         "Signed installer root-normalization behavior is not the reviewed exact implementation.")
    return ROOT_NORMALIZING_INSTALLER_SHA256


def native_root_state(fixture: dict) -> dict:
    info = owned_directory(Path(fixture["installRoot"]))
    need(fixture.get("rootBindings", {}).get("installRoot") == [info.st_dev, info.st_ino],
         "Native install root no longer has its exact fixture inode.")
    return {"rootIdentity": [info.st_dev, info.st_ino, info.st_uid], "rootMode": stat.S_IMODE(info.st_mode)}


def verify_root_normalization(before: dict, after: dict, installer_hash: str) -> dict:
    need(installer_hash == ROOT_NORMALIZING_INSTALLER_SHA256,
         "Root normalization requires the reviewed signed installer contract.")
    identity = before.get("rootIdentity")
    need(isinstance(identity, list) and len(identity) == 3
         and all(type(value) is int for value in identity) and identity[0] > 0 and identity[1] > 0
         and identity[2] == os.getuid() and after.get("rootIdentity") == identity,
         "Native install root identity changed across installer recovery.")
    need(type(before.get("rootMode")) is int and before["rootMode"] in {0o700, 0o750, 0o755}
         and type(after.get("rootMode")) is int and after["rootMode"] == 0o700,
         "Native root permissions did not match exact legacy-to-private normalization.")
    return {"installRootIdentityPreserved": True, "installRootModeBefore": f"{before['rootMode']:04o}",
            "installRootModeAfter": "0700", "signedInstallerRootNormalizationObserved": True}


def require_preserved_native_fields(before: dict, after: dict, fields: tuple[str, ...]) -> None:
    # Fixed field labels only; never expose process argv, tokens, paths or values.
    permitted = {"serverInstanceId", "components", "registrations", "currentLink", "current"}
    need(set(fields) <= permitted, "Unrecognized native preservation fields.")
    changed = [name for name in fields if name not in before or name not in after or before[name] != after[name]]
    need(not changed, "Installer recovery changed preserved native fields: " + ", ".join(changed) + ".")


def rollback_native_state(fixture: dict, version: str) -> dict:
    """Observe exact split runtime, native registrations and released maintenance.

    No Team Hub fixture is manufactured here. This proves component maintenance
    is released and installer journals are gone, not Team Hub fence consumption.
    """
    root = Path(fixture["installRoot"])
    require_no_pending_journals(root)
    current = root / "current"
    need(current.is_symlink() and current.resolve() == root / "releases" / version,
         "Native rollback did not restore the exact current runtime link.")
    value = health(fixture, version)
    components = {}
    for name in ("gateway", "execution_service"):
        item = value.get(name)
        need(isinstance(item, dict) and item.get("protocol") == 1 and item.get("version") == version
             and type(item.get("pid")) is int and item["pid"] > 1 and bool(item.get("instance_id")),
             "Both exact-version native components must be healthy after rollback/retry.")
        components[name] = item
    need(components["gateway"]["pid"] != components["execution_service"]["pid"]
         and components["execution_service"].get("maintenance_held") is False,
         "Execution maintenance must be explicitly released after rollback/retry.")
    registrations = registered_services(fixture)
    need({item.name for item in registrations} == {"agents-server.service", "agents-server-gateway.service"},
         "Both real native Linux registrations are required.")
    for item in registrations:
        role = "gateway" if item.name == "agents-server-gateway.service" else "execution_service"
        raw_pid = command(["systemctl", "--user", "show", item.name, "--property=MainPID", "--value"]).stdout.strip()
        need(raw_pid.isdigit() and int(raw_pid) == components[role]["pid"],
             "Authenticated runtime and real native service manager disagree.")
    return {"registrations": {item.name: sha(read_regular(item)) for item in registrations},
            **native_root_state(fixture), "current": str(current.resolve()),
            "serverInstanceId": value["server_instance_id"]}


def rollback_retry(args: argparse.Namespace, fixture: dict, receipt: dict) -> dict:
    """Force an exact candidate worker unhealthy without modifying artifacts.

    Signals are bound to a kernel pidfd and repeated ownership checks. The
    incumbent, unrelated processes and processes running outside the candidate
    release root are never signaled. The real installer owns all rollback.
    """
    need(sys.platform == "linux" and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"),
         "Rollback fault acceptance requires native Linux kernel pidfd support.")
    need(fixture["baselineVersion"] != receipt["version"] and isinstance(fixture.get("snapshot"), dict),
         "Rollback acceptance requires a populated real earlier baseline.")
    root = Path(fixture["installRoot"])
    require_no_pending_journals(root)
    before = health(fixture, fixture["baselineVersion"])
    native_before = rollback_native_state(fixture, fixture["baselineVersion"])
    installer_hash = root_normalization_contract(args.bundle, receipt)
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    incumbent = worker_pid()
    need(incumbent > 1, "Incumbent worker is not registered with the native service manager.")
    arm_ticks = int(float(read_regular(Path("/proc/uptime"), 1024).split()[0]) * os.sysconf("SC_CLK_TCK"))
    stop = threading.Event()
    observed = {"killed": [], "rollbackPhases": set(), "error": None, "transactionId": None}

    def watch() -> None:
        try:
            while not stop.wait(0.025):
                if observed["transactionId"] is not None:
                    try:
                        phase = candidate_activation_journal(root, receipt["version"], observed["transactionId"]).get("phase")
                        if phase in {"rolling-back", "rolled-back", "rollback-healthy"}:
                            observed["rollbackPhases"].add(phase)
                    except FileNotFoundError:
                        pass
                pid = worker_pid()
                identity = candidate_process_identity(pid, fixture, receipt["version"], incumbent, arm_ticks)
                if identity is None or identity in observed["killed"]:
                    continue
                try:
                    journal = candidate_activation_journal(root, receipt["version"], observed["transactionId"])
                except FileNotFoundError:
                    continue
                # Only arm while the real installer is testing this candidate.
                # Never kill a candidate that has already passed health/commit.
                if journal.get("phase") != "candidate-starting":
                    continue
                observed["transactionId"] = journal["transaction_id"]
                try:
                    fd = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    # Re-read after pidfd_open. A reused PID or rolled-back
                    # current link cannot grant authority over another process.
                    if worker_pid() != pid or candidate_process_identity(
                            pid, fixture, receipt["version"], incumbent, arm_ticks) != identity:
                        continue
                    if candidate_activation_journal(root, receipt["version"], observed["transactionId"]).get("phase") != "candidate-starting":
                        continue
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except ProcessLookupError:
                        continue
                    observed["killed"].append(identity)
                finally:
                    os.close(fd)
        except Exception:
            observed["error"] = "Owned candidate watcher could not maintain exact process/journal proof."
            stop.set()

    watcher = threading.Thread(target=watch, name="owned-candidate-health-fault", daemon=True)
    watcher.start()
    body = {"version": receipt["version"], "track": receipt["track"], "when_idle": True,
            "expected_server_identity": fixture["serverIdentity"],
            "expected_server_instance_id": before["server_instance_id"]}
    try:
        request(fixture, "/api/admin/update/start", body)
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            need(observed["error"] is None, "Owned candidate watcher lost its required safety proof.")
            try:
                status = request(fixture, "/api/admin/update", expected=(200, 502, 503))
                current = request(fixture, "/api/health", expected=(200, 502, 503))
                if status.get("phase") == "failed" and current.get("ok") is True \
                        and current.get("server_version") == fixture["baselineVersion"]:
                    break
                need(not (status.get("phase") == "complete" and current.get("server_version") == receipt["version"]),
                     "Candidate completed before the bounded health fault; rollback was not exercised.")
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("The exact candidate did not complete a real native rollback within its deadline.")
    finally:
        stop.set()
        watcher.join(timeout=15)
        need(not watcher.is_alive(), "Owned candidate watcher failed to stop; no retry was attempted.")
    need(observed["error"] is None and observed["killed"] and observed["rollbackPhases"],
         "A candidate process fault and actual rollback journal phase were not both observed.")
    recovered = health(fixture, fixture["baselineVersion"])
    native_recovered = rollback_native_state(fixture, fixture["baselineVersion"])
    root_observations = verify_root_normalization(native_before, native_recovered, installer_hash)
    require_preserved_native_fields(native_before, native_recovered, ("registrations", "current"))
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    # The watcher is fully stopped before retry. Retained journals and fences
    # are not edited: production recovery owns them.
    request(fixture, "/api/admin/update/start", {
        **body, "expected_server_instance_id": recovered["server_instance_id"]})
    health(fixture, receipt["version"], timeout=1500)
    wait_update_complete(fixture, receipt["version"])
    native_accepted = rollback_native_state(fixture, receipt["version"])
    verify_root_normalization(native_recovered, native_accepted, installer_hash)
    preservation = compare_snapshot(fixture["snapshot"], state_snapshot(fixture),
                                    baseline_version=fixture["baselineVersion"], candidate_version=receipt["version"])
    count = verify_installed_runtime(fixture, args.bundle, receipt["version"])
    return {"fault": "pidfd-exact-candidate-worker-health-failure", "candidateProcessesFaulted": len(observed["killed"]),
            "incumbentNeverSignaled": True, "realRollbackPhases": sorted(observed["rollbackPhases"]),
            "baselineAuthenticatedHealthRestored": True, "serverIdentityTokenAndSnapshotPreserved": True,
            "faultDisabledBeforeRetry": True, "candidateActivationCompletedAfterRetry": True,
            "bothComponentsHealthyAfterRollbackAndRetry": True, "maintenanceReleasedAfterRollbackAndRetry": True,
            "activationJournalsClearedByInstaller": True, "sameAcceptedVersionRetried": True,
            "teamHubFenceCleanupObserved": False, "desktopUpdateObserved": False,
            "exactRuntimeFilesCompared": count, **preservation, **root_observations,
            "nonemptyProviderHistoryObserved": False}


def failure_retry(args: argparse.Namespace, fixture: dict, receipt: dict) -> dict:
    """Interrupt one real signed legacy archive response, then retry normally.

    The replay listener closes the connection after offering part of the actual
    accepted archive. Neither package bytes nor signatures are modified. This
    proves download failure/retry, not activation rollback or process recovery.
    """
    need(fixture["baselineVersion"] != receipt["version"], "Download recovery requires a real older installation.")
    need(isinstance(fixture.get("snapshot"), dict), "A real persisted baseline snapshot is required.")
    need(args.fault_control is not None and args.fault_observed is not None,
         "One-shot replay fault control and observed marker paths are required.")
    for path in (args.fault_control, args.fault_observed, Path(str(args.fault_control) + ".consumed")):
        contained(path, args.work)
        need(not path.exists() and not path.is_symlink(), "The fault control must be unused for this exact run.")
    before = health(fixture, fixture["baselineVersion"])
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    control = {"schema": 1, "kind": "truncate-legacy-once", "sourceSha": receipt["sourceSha"],
               "releaseReceiptSha256": args.receipt_sha256}
    write_private(args.fault_control, control)
    body = {"version": receipt["version"], "track": receipt["track"], "when_idle": True,
            "expected_server_identity": fixture["serverIdentity"],
            "expected_server_instance_id": before["server_instance_id"]}
    request(fixture, "/api/admin/update/start", body)
    deadline = time.monotonic() + 240
    observed = None
    while time.monotonic() < deadline:
        if args.fault_observed.exists():
            observed = json.loads(read_regular(args.fault_observed, private=True))
        status = request(fixture, "/api/admin/update")
        if observed is not None and status.get("phase") == "failed":
            break
        time.sleep(1)
    else:
        raise RuntimeError("The owned real updater did not report failure after the exact download interruption.")
    descriptor = json.loads(read_regular(args.bundle / "legacy/agents-server-manifest.json", 8192))
    need(all(observed.get(key) == value for key, value in control.items())
         and observed.get("archiveSha256") == descriptor["archive"]["sha256"]
         and observed.get("interrupted") is True and observed.get("socketDestroyed") is True
         and type(observed.get("bytesOffered")) is int and type(observed.get("totalBytes")) is int
         and 0 < observed["bytesOffered"] < observed["totalBytes"] == descriptor["archive"]["size"],
         "Observed fault does not identify the exact partially transferred accepted archive.")
    consumed = Path(str(args.fault_control) + ".consumed")
    need(not args.fault_control.exists() and json.loads(read_regular(consumed, private=True)) == control,
         "Replay fault was not consumed exactly once.")
    incumbent = health(fixture, fixture["baselineVersion"])
    need(incumbent["server_instance_id"] == before["server_instance_id"],
         "Failed download interrupted the incumbent server process.")
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    # Submit the same public version and process identity again. Do not edit the
    # update journal, remove a fence or invoke install.sh to force a success.
    request(fixture, "/api/admin/update/start", body)
    accepted = health(fixture, receipt["version"], timeout=1500)
    need(accepted["server_instance_id"] != before["server_instance_id"],
         "Exact update did not replace the baseline runtime process.")
    wait_update_complete(fixture, receipt["version"])
    preservation = compare_snapshot(fixture["snapshot"], state_snapshot(fixture),
                                    baseline_version=fixture["baselineVersion"], candidate_version=receipt["version"])
    count = verify_installed_runtime(fixture, args.bundle, receipt["version"])
    registered_services(fixture)
    return {"fault": "truncated-exact-legacy-download", "failedDownloadObserved": True,
            "incumbentProcessIdentityAndDataPreserved": True, "sameAcceptedVersionRetried": True,
            "candidateAuthenticatedHealthObserved": True, "nativeActivationCompleted": True,
            "exactRuntimeFilesCompared": count, **preservation,
            "activationInterruptionObserved": False, "rollbackObserved": False,
            "nonemptyProviderHistoryObserved": False}


def staging_native_identity(fixture: dict, version: str) -> dict:
    """Read-only proof of both owned launchd components and immutable runtime."""
    need(sys.platform == "darwin", "Staging recovery requires its disposable native macOS fixture.")
    value = health(fixture, version)
    components = {}
    for name in ("gateway", "execution_service"):
        component = value.get(name)
        need(isinstance(component, dict) and component.get("protocol") == 1
             and component.get("version") == version and type(component.get("pid")) is int
             and component["pid"] > 1 and isinstance(component.get("instance_id"), str)
             and len(component["instance_id"]) >= 8 and component.get("maintenance_held") is not True,
             "Both exact-version native components must be healthy and not held.")
        components[name] = {"pid": component["pid"], "instanceId": component["instance_id"]}
    need(components["gateway"]["pid"] != components["execution_service"]["pid"],
         "Native components must be distinct processes.")
    registrations = registered_services(fixture)
    need(len(registrations) == 2
         and {item.stem for item in registrations} == {"com.agentsdock.server", "com.agentsdock.gateway"},
         "Both native registrations are required for the staging recovery fixture.")
    root = Path(fixture["installRoot"])
    release = root / "releases" / version
    need((root / "current").is_symlink() and (root / "current").resolve() == release,
         "Owned native runtime link changed.")
    hashes = {}
    for item in registrations:
        name = "gateway" if item.stem == "com.agentsdock.gateway" else "execution_service"
        raw = read_regular(item)
        result = command(["/bin/launchctl", "print", f"gui/{os.getuid()}/{item.stem}"])
        pids = re.findall(rb"^\s*pid = ([0-9]+)\s*$", result.stdout, re.MULTILINE)
        need(len(pids) == 1 and int(pids[0]) == components[name]["pid"],
             "Native registration and authenticated component identities differ.")
        observed = command(["/bin/ps", "-p", str(components[name]["pid"]), "-o", "uid=", "-o", "command="]).stdout.decode().strip()
        owner, process_command = observed.split(None, 1)
        arguments = plistlib.loads(raw)["ProgramArguments"]
        process_arguments = shlex.split(process_command)
        role = "gateway" if name == "gateway" else "worker"
        need(len(arguments) >= 3 and arguments[2] == role and owner == str(os.getuid())
             and Path(arguments[1]).resolve() == release / "execution_service.py"
             and len(process_arguments) == len(arguments)
             and Path(process_arguments[0]).is_absolute()
             and Path(process_arguments[0]).resolve() == Path(arguments[0]).resolve()
             and process_arguments[1:] == arguments[1:],
             "Native component is not the exact owned installed runtime.")
        hashes[item.stem] = sha(raw)
    return {"serverInstanceId": value["server_instance_id"], "components": components,
            "registrations": hashes, "currentLink": str(release),
            **native_root_state(fixture)}


def staging_failure_retry(args: argparse.Namespace, fixture: dict, receipt: dict) -> dict:
    """Observe installer-owned failed-stage deletion, then use the same API retry.

    This pre-takeover dependency fault is deliberately distinct from truncated
    downloads, post-takeover rollback, busy-drain or maintenance-fence cleanup.
    """
    need(args.candidate and sys.platform == "darwin" and args.kind == "legacy"
         and fixture["baselineVersion"] != receipt["version"] and isinstance(fixture.get("snapshot"), dict),
         "Staging recovery requires a real older candidate macOS legacy fixture.")
    directory = args.work / "dependency-delegate"
    owned_directory(directory)
    config_path = directory / "config.json"
    raw = read_regular(config_path, 8192, private=True)
    need(fixture.get("dependencyFaultFixture", {}).get("configurationSha256") == sha(raw),
         "Fixture does not bind this dependency fault configuration.")
    config = json.loads(raw)
    root = Path(fixture["installRoot"])
    delegate_directory = Path(fixture["home"]) / ".local/libexec" / (
        f"agentsdock-acceptance-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}")
    contained(delegate_directory, Path(fixture["home"]))
    need(config["version"] == receipt["version"] and config["sourceSha"] == receipt["sourceSha"]
         and config["receiptSha256"] == args.receipt_sha256 and config["installRoot"] == str(root)
         and config["rootBinding"] == fixture["rootBindings"]["installRoot"]
         and config["delegate"] == str(delegate_directory / "uv"),
         "Dependency fault does not bind this exact fixture and accepted candidate.")
    before = staging_native_identity(fixture, fixture["baselineVersion"])
    installer_hash = root_normalization_contract(args.bundle, receipt)
    need(installer_hash == config["installerSha256"], "Dependency fault installer differs from its signed permission contract.")
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    require_no_pending_journals(root)
    candidate = root / "releases" / receipt["version"]
    need(not candidate.exists() and not candidate.is_symlink(), "Candidate already exists; no dependency fault was armed.")
    control, consumed, observed_path = (directory / name for name in ("armed.json", "consumed.json", "observed.json"))
    for item in (control, consumed, observed_path):
        need(not item.exists() and not item.is_symlink(), "Dependency fault controls must be unused for this exact run.")
    marker = {"sourceSha": receipt["sourceSha"], "receiptSha256": args.receipt_sha256}
    write_private(control, marker)
    body = {"version": receipt["version"], "track": receipt["track"], "when_idle": True,
            "expected_server_identity": fixture["serverIdentity"],
            "expected_server_instance_id": before["serverInstanceId"]}
    request(fixture, "/api/admin/update/start", body)
    deadline = time.monotonic() + 600
    observed = None
    while time.monotonic() < deadline:
        if observed_path.exists():
            observed = json.loads(read_regular(observed_path, 8192, private=True))
        status = request(fixture, "/api/admin/update")
        if observed is not None and status.get("phase") == "failed":
            break
        need(status.get("phase") != "complete", "Candidate completed without the requested staging fault.")
        time.sleep(1)
    else:
        raise RuntimeError("The owned updater did not fail after the exact candidate dependency stage fault.")
    need(all(observed.get(key) == value for key, value in marker.items())
         and observed.get("version") == receipt["version"]
         and observed.get("installerSha256") == config["installerSha256"]
         and observed.get("dependencyExitCode") == 73
         and type(observed.get("stageDevice")) is int and observed["stageDevice"] > 0
         and type(observed.get("stageInode")) is int and observed["stageInode"] > 0,
         "Observed dependency fault does not identify the exact signed candidate stage.")
    stage = Path(observed.get("stage", ""))
    contained(stage, root)
    need(stage.parent == root / "releases"
         and re.fullmatch(r"\.staging-" + re.escape(receipt["version"]) + r"-[1-9]\d*", stage.name),
         "Observed stage is not the exact candidate staging path.")
    need(not control.exists() and not control.is_symlink()
         and json.loads(read_regular(consumed, 8192, private=True)) == marker,
         "Dependency fault was not consumed exactly once.")
    # Observe native cleanup; never perform it or repair transaction state.
    need(not stage.exists() and not stage.is_symlink(), "The native installer retained its failed stage.")
    need(not candidate.exists() and not candidate.is_symlink(), "Failed preparation activated a candidate runtime.")
    install_lock = root / ".install-lock"
    need(not install_lock.exists() and not install_lock.is_symlink(), "The native installer retained its install lock.")
    require_no_pending_journals(root)
    recovered = staging_native_identity(fixture, fixture["baselineVersion"])
    root_observations = verify_root_normalization(before, recovered, installer_hash)
    require_preserved_native_fields(before, recovered,
        ("serverInstanceId", "components", "registrations", "currentLink"))
    compare_snapshot(fixture["snapshot"], state_snapshot(fixture))
    # Same accepted version and incumbent identity. No install.sh invocation,
    # state deletion, journal rewriting or forced maintenance-fence removal.
    request(fixture, "/api/admin/update/start", body)
    health(fixture, receipt["version"], timeout=1500)
    wait_update_complete(fixture, receipt["version"])
    accepted = staging_native_identity(fixture, receipt["version"])
    verify_root_normalization(recovered, accepted, installer_hash)
    need(accepted["serverInstanceId"] != before["serverInstanceId"], "Retry did not replace the incumbent runtime.")
    preservation = compare_snapshot(fixture["snapshot"], state_snapshot(fixture),
        baseline_version=fixture["baselineVersion"], candidate_version=receipt["version"])
    count = verify_installed_runtime(fixture, args.bundle, receipt["version"])
    return {"fault": "owned-one-shot-candidate-dependency-failure", "ownedDependencyFaultFixture": True,
            "allQaDependenciesIndependent": False, "dependencyExitCode": 73,
            "exactSignedCandidateStageObserved": True, "failedStageRemovedByInstaller": True,
            "installLockReleasedByInstaller": True, "incumbentComponentsIdentityAndDataPreserved": True,
            "sameAcceptedVersionRetried": True, "bothCandidateComponentsHealthy": True,
            "nativeActivationCompleted": True, "exactRuntimeFilesCompared": count, **preservation, **root_observations,
            "fenceCleanupObserved": False, "rollbackObserved": False,
            "activationInterruptionObserved": False, "nonemptyProviderHistoryObserved": False}


def checks_for(operation: str, kind: str, observations: dict, *, migrated: bool = False) -> list[dict]:
    """Never turn package/service observations into unobserved native passes."""
    if operation == "bootstrap" and kind == "fresh":
        return [{"name": "fresh-server-install", "status": "blocked", "observations": {
            **observations,
            "remaining": ["real-provider-chat-through-app", "logout-and-reboot-service-survival",
                          "interactive-pairing-and-optional-dependency-decline"]}},
            {"name": "busy-server-drain", "status": "blocked", "observations": {
                "reason": "No authenticated provider turn and durably queued user message were exercised while an exact update drained.",
                "required": "An isolated real provider login and bounded native turn; a terminal sleep is not an agent run."}}]
    if operation == "verify" and migrated:
        return [{"name": "legacy-server-state-preservation", "status": "passed", "observations": observations}]
    if operation == "failure-retry":
        return [{"name": "interrupted-update-recovery", "status": "passed", "observations": observations}]
    if operation == "staging-failure-retry":
        return [{"name": "failed-candidate-stage-removal-and-retry", "status": "passed", "observations": observations}]
    if operation == "rollback-retry":
        return [{"name": "rollback-data-preservation", "status": "passed", "observations": observations}]
    if operation == "diagnose":
        return [{"name": "server-failure-diagnostics", "status": "blocked", "observations": observations}]
    return [{"name": f"server-{operation}", "status": "passed", "observations": observations}]


def load_fixture(args: argparse.Namespace, receipt: dict, home: Path) -> dict:
    value = json.loads(read_regular(args.fixture, private=True))
    need(value.get("schema") == 1 and value.get("runId") == os.environ["GITHUB_RUN_ID"]
         and value.get("runAttempt") == os.environ["GITHUB_RUN_ATTEMPT"]
         and value.get("candidate", False) == getattr(args, "candidate", False)
         and value.get("candidateServerLinux", False) == getattr(args, "candidate_server_linux", False)
         and value.get("harnessSourceSha", value.get("sourceSha")) == os.environ.get("GITHUB_SHA")
         and value.get("sourceSha") == receipt["sourceSha"] and value.get("releaseReceiptSha256") == args.receipt_sha256
         and value.get("home") == str(home) and value.get("workDirectory") == str(args.work)
         and value.get("targetVersion") == receipt["version"], "Fixture belongs to another account, run or candidate.")
    for key, expected in paths(home).items():
        need(value.get(key) == str(expected), "Fixture points outside the owned default installation.")
        info = owned_directory(expected)
        need(value.get("rootBindings", {}).get(key) == [info.st_dev, info.st_ino], "Fixture root ownership changed.")
    return value


def bootstrap(args: argparse.Namespace, receipt: dict, home: Path) -> tuple[dict, dict]:
    ensure_empty(home)
    args.work.mkdir(mode=0o700)
    env = child_environment(args.work)
    if getattr(args, "staging_failure_fixture", False):
        prepare_stage_fault_delegate(args, receipt, home, env)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    fixture = {"schema": 1, "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
               "sourceSha": receipt["sourceSha"], "harnessSourceSha": os.environ["GITHUB_SHA"],
               "candidate": getattr(args, "candidate", False),
               "candidateServerLinux": getattr(args, "candidate_server_linux", False),
               "releaseReceiptSha256": args.receipt_sha256, "home": str(home), "workDirectory": str(args.work),
               "serverUrl": f"http://127.0.0.1:{port}", "targetVersion": receipt["version"],
               **{key: str(value) for key, value in paths(home).items()}}
    npm_descriptor = json.loads(read_regular(args.bundle / "npm/agents-server-npm-manifest.json", 8192))
    archive = args.bundle / "npm" / npm_descriptor["archive"]["name"]
    prefix = args.work / "npm-prefix"
    command(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
             "--prefix", str(prefix), str(archive)], env=env, timeout=180)
    cli = prefix / "node_modules/@agentsdock/server/npm/cli.cjs"
    need(command(["node", str(cli), "--version"], env=env).stdout.decode().strip() == receipt["version"],
         "Installed exact npm tarball has the wrong CLI version.")
    if args.kind == "fresh":
        baseline = receipt["version"]
        command(["node", str(cli), "install", "--port", str(port), "--bind", "127.0.0.1", "--non-interactive"],
                env=env, timeout=1500)
    else:
        source, baseline = legacy_source(args, args.work, receipt["version"])
        command(["/bin/bash", str(source / "install.sh"), "--release-version", baseline,
                 "--port", str(port), "--bind", "127.0.0.1", "--non-interactive"], env=env, timeout=1500)
        Path(fixture["installRoot"]).chmod(int(args.legacy_root_mode, 8))
    fixture.update(baselineVersion=baseline, token=token_at(Path(fixture["configRoot"])))
    first = health(fixture, baseline)
    fixture.update(serverIdentity=first["server_identity"], serverInstanceId=first["server_instance_id"])
    fixture["rootBindings"] = {key: [info.st_dev, info.st_ino] for key, info in
                               ((key, owned_directory(path)) for key, path in paths(home).items())}
    if getattr(args, "staging_failure_fixture", False):
        bind_stage_fault_delegate(args, fixture)
    registered_services(fixture)
    expected_root = Path(fixture["installRoot"]) / "releases" / baseline
    need((Path(fixture["installRoot"]) / "current").resolve() == expected_root,
         "Service current link is not its permanent versioned installation.")
    # Run the fresh entrypoint a second time. It must refuse without touching
    # server identity, token or the live process, including for legacy installs.
    refused = command(["node", str(cli), "install", "--non-interactive"], env=env, allowed=(1,))
    need(b"existing" in refused.stderr.lower(), "Fresh installation did not explicitly refuse existing state.")
    unchanged = health(fixture, baseline)
    need(unchanged["server_instance_id"] == first["server_instance_id"], "Refused fresh install restarted the incumbent.")
    prefix.rename(args.work / "npm-prefix-retired")
    if (args.work / "npm-cache").exists():
        (args.work / "npm-cache").rename(args.work / "npm-cache-retired")
    if args.kind == "legacy":
        (args.work / "legacy-source").rename(args.work / "legacy-source-retired")
    service(fixture, "restart")
    restarted = health(fixture, baseline)
    need(restarted["server_instance_id"] != first["server_instance_id"], "Native restart did not replace the worker process.")
    fixture["serverInstanceId"] = restarted["server_instance_id"]
    # A genuine persisted session, created through the production HTTP API.
    # It is not a successful provider chat and is never described as one.
    workspace = args.work / "chat-workspace"
    workspace.mkdir(mode=0o700)
    created = request(fixture, "/api/sessions", {
        "title": "Release acceptance preservation fixture", "auto_title_enabled": False,
        "cwd": str(workspace), "backend": "codex", "import_history": False,
        "codex_approval_policy": "on-request", "codex_sandbox_mode": "workspace-write",
    }, expected=(200, 201))
    need(bool(created.get("session", {}).get("id")), "Production API did not persist the disposable session.")
    fixture["snapshot"] = state_snapshot(fixture)
    fixture["baselineStateSha256"] = sha(canonical(fixture["snapshot"]))
    rejections = rejection_checks(fixture, args.bundle, baseline) if args.kind == "fresh" else {}
    if args.kind == "fresh":
        rejections["exactRuntimeFilesCompared"] = verify_installed_runtime(fixture, args.bundle, baseline)
    write_private(args.fixture, fixture)
    return fixture, {"exactNpmPackageInstalled": True, "nativeServiceInstalled": True,
                     "existingInstallRefusedWithoutRestart": True, "permanentVersionedRuntime": True,
                     "stagingAndNpmCacheIndependentAfterNativeRestart": True,
                     "legacyBaseline": args.kind == "legacy", "legacyRootMode": args.legacy_root_mode if args.kind == "legacy" else None,
                     "persistedSessionCreatedThroughAPI": True,
                     "logoutOrRebootObserved": False, "providerChatObserved": False,
                     "nonemptyProviderHistoryObserved": False, "queuedUserMessageObserved": False,
                     "ownedDependencyFaultFixture": bool(fixture.get("dependencyFaultFixture")),
                     **rejections}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("operation", choices=("bootstrap", "snapshot", "verify", "service", "failure-retry", "staging-failure-retry", "rollback-retry", "diagnose"))
    for name in ("receipt", "bundle", "work", "fixture", "evidence"):
        result.add_argument(f"--{name}", type=Path, required=True)
    result.add_argument("--prepare-run", type=Path)
    result.add_argument("--candidate", action="store_true", help="Deliberate test-only macOS candidate CI; never production acceptance.")
    result.add_argument("--candidate-server-linux", action="store_true",
                        help="Exact server-only Linux rollback rehearsal; no desktop or production acceptance.")
    result.add_argument("--receipt-sha256", required=True)
    result.add_argument("--kind", choices=("fresh", "legacy"), default="fresh")
    result.add_argument("--legacy-root-mode", choices=("0755", "0750"), default="0755")
    result.add_argument("--staging-failure-fixture", action="store_true",
                        help="Install a run-owned external dependency delegate for isolated stage-removal/retry observations.")
    for name in ("baseline-archive", "baseline-manifest", "baseline-signature"):
        result.add_argument(f"--{name}", type=Path)
    result.add_argument("--fault-control", type=Path)
    result.add_argument("--fault-observed", type=Path)
    result.add_argument("--expect-version")
    result.add_argument("--action", choices=("stop", "start", "restart"))
    return result


def inspect_receipt(args: argparse.Namespace) -> None:
    if args.candidate or getattr(args, "candidate_server_linux", False):
        command(["node", str(ROOT / "scripts/product-candidate-receipt.mjs"), "inspect", str(args.receipt),
                 args.receipt_sha256, str(args.bundle)], timeout=90)
    else:
        need(args.prepare_run is not None, "Production acceptance requires the successful preparation-run metadata.")
        command(["node", str(ROOT / "scripts/product-release.mjs"), "inspect", str(args.receipt),
                 args.receipt_sha256, str(args.prepare_run), str(args.bundle)], timeout=90)


def validate_candidate_checkout(args: argparse.Namespace, receipt: dict) -> str:
    server_linux = getattr(args, "candidate_server_linux", False)
    operation = "validate-server-runner" if server_linux else "validate-runner"
    result = command(["node", str(ROOT / "scripts/product-candidate-receipt.mjs"), operation,
                      str(args.receipt), args.receipt_sha256], timeout=90)
    value = json.loads(result.stdout)
    need(value.get("sourceSha") == receipt["sourceSha"] and value.get("sourceRef") == receipt["sourceRef"]
         and value.get("harnessSourceSha") == os.environ.get("GITHUB_SHA") and value.get("publicationEligible") is False,
         "Candidate harness validation returned a different source, branch or eligibility.")
    if server_linux:
        need(value.get("executionScope") == "candidate-server-linux" and value.get("desktopAcceptance") is False,
             "Linux server replay cannot claim desktop acceptance.")
    return value["harnessSourceSha"]


def main() -> None:
    args = parser().parse_args()
    raw = read_regular(args.receipt, 32768)
    need(re.fullmatch(r"[a-f0-9]{64}", args.receipt_sha256) is not None and sha(raw) == args.receipt_sha256,
         "Prepared receipt differs from the independently accepted digest.")
    receipt = json.loads(raw)
    server_linux = getattr(args, "candidate_server_linux", False)
    home = guard(receipt, args.work, candidate=args.candidate, candidate_server_linux=server_linux)
    if server_linux:
        need(args.kind == "legacy" and args.operation in {"bootstrap", "snapshot", "rollback-retry", "diagnose", "service"}
             and not getattr(args, "staging_failure_fixture", False),
             "Linux candidate scope is restricted to the signed legacy baseline and real rollback journey.")
    rehearsal = args.candidate or server_linux
    harness_sha = validate_candidate_checkout(args, receipt) if rehearsal else receipt["sourceSha"]
    for path in (args.fixture, args.evidence):
        contained(path, args.work)
    # Reuse production signature, runtime parity and successful preparation-run
    # verification rather than trusting a caller-created success flag.
    inspect_receipt(args)
    head = command(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).stdout.decode().strip()
    need(head == harness_sha, "Acceptance harness checkout differs from its reviewed validation.")
    if args.operation == "bootstrap":
        fixture, observations = bootstrap(args, receipt, home)
        observed_version = fixture["baselineVersion"]
    else:
        owned_directory(args.work)
        fixture = load_fixture(args, receipt, home)
        if args.operation == "snapshot":
            fixture["snapshot"] = state_snapshot(fixture)
            fixture["baselineStateSha256"] = sha(canonical(fixture["snapshot"]))
            write_private(args.fixture, fixture, replace=True)
            observations = {"populatedSessionsSnapshotted": len(fixture["snapshot"]["sessions"]),
                            "snapshotSha256": fixture["baselineStateSha256"]}
            observed_version = request(fixture, "/api/health")["server_version"]
        elif args.operation == "verify":
            need(args.expect_version in {fixture["baselineVersion"], receipt["version"]}, "Expected version must be the exact baseline or candidate.")
            health(fixture, args.expect_version)
            need(isinstance(fixture.get("snapshot"), dict), "A populated pre-upgrade snapshot is required.")
            preservation = compare_snapshot(fixture["snapshot"], state_snapshot(fixture),
                baseline_version=fixture["baselineVersion"],
                candidate_version=receipt["version"] if args.expect_version == receipt["version"] else None)
            registered_services(fixture)
            observations = {"authenticatedExactVersion": True, "serverIdentityAndTokenPreserved": True,
                            "sessionsNativeIdsSettingsAndHistoryPreserved": True,
                            "snapshotSha256": fixture["baselineStateSha256"], **preservation}
            if args.expect_version == receipt["version"]:
                observations["exactRuntimeFilesCompared"] = verify_installed_runtime(fixture, args.bundle, args.expect_version)
            observed_version = args.expect_version
        elif args.operation == "failure-retry":
            observations = failure_retry(args, fixture, receipt)
            observed_version = receipt["version"]
        elif args.operation == "staging-failure-retry":
            observations = staging_failure_retry(args, fixture, receipt)
            observed_version = receipt["version"]
        elif args.operation == "rollback-retry":
            observations = rollback_retry(args, fixture, receipt)
            observed_version = receipt["version"]
        elif args.operation == "diagnose":
            observations = diagnose(fixture)
            observed_version = None
        else:
            need(args.action is not None, "A scoped native service action is required.")
            service(fixture, args.action)
            observations = {"nativeServiceAction": args.action, "scope": "owned-disposable-installation"}
            observed_version = None
    evidence = {"schema": 1, "kind": "candidate-server-observations" if rehearsal else "native-server-observations",
                "operation": args.operation,
                "runId": os.environ["GITHUB_RUN_ID"], "sourceSha": receipt["sourceSha"],
                "harnessSourceSha": harness_sha,
                "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
                "version": receipt["version"], "observedVersion": observed_version,
                "releaseReceiptSha256": args.receipt_sha256, "platform": sys.platform,
                "checks": checks_for(args.operation, args.kind, observations,
                                     migrated=args.operation == "verify" and args.expect_version == receipt["version"]
                                     and fixture["baselineVersion"] != receipt["version"]),
                "releaseAcceptance": False,
                **({"publicationEligible": False} if rehearsal else {}),
                **({"executionScope": "candidate-server-linux", "desktopAcceptance": False} if server_linux else {})}
    write_private(args.evidence, evidence)
    print(json.dumps({"operation": args.operation, "observed": True, "version": observed_version,
                      "evidenceSha256": sha(read_regular(args.evidence))}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # Avoid exception payloads that may include subprocess output or private
        # session/API content. RuntimeError text above is deliberately generic.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"Native server acceptance failed: {message}", file=sys.stderr)
        raise SystemExit(1)
