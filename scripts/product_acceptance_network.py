#!/usr/bin/env python3
"""Ephemeral HTTPS origin replay routing, ONLY on disposable hosted CI runners.

This helper is not a signature verifier or acceptance result. The caller must
verify the sealed product before setup and must run teardown in an always step.
Never run this on a developer machine. Only the three exact replay hosts are
mapped; TLS verification stays enabled. No release credential is used here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import ssl
import stat
import subprocess
import sys

HOSTS = ("github.com", "api.github.com", "registry.npmjs.org")
MARKER = "AGENTSDOCK-DISPOSABLE-PRODUCT-REPLAY"
LOCK = Path("/tmp/agentsdock-product-network.lock")
HOSTS_FILE = Path("/etc/hosts")
SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain"


def need(condition, message):
    if not condition:
        raise ValueError(message)


def command(*args, data=None, timeout=120):
    # Never echo commands with private data, and never inherit release tokens
    # into OpenSSL/sudo children. Authenticated provider traffic is unrelated.
    env = {k: v for k, v in os.environ.items()
           if k in {"PATH", "LANG", "LC_ALL", "TMPDIR"}}
    try:
        return subprocess.run(args, input=data, capture_output=True, check=True,
                              timeout=timeout, env=env).stdout
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Replay command failed ({Path(args[0]).name}, exit {error.returncode}); private output was withheld") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Replay command timed out ({Path(args[0]).name}); private output was withheld") from None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit=1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_size <= limit,
             "Expected a bounded regular input file")
        data = stream.read(limit + 1)
        need(len(data) <= limit, "Input exceeded its size limit")
        return data


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def guard(work, env=None, candidate=False):
    env = os.environ if env is None else env
    need(env.get("CI") == "true" and env.get("GITHUB_ACTIONS") == "true"
         and env.get("RUNNER_ENVIRONMENT") == "github-hosted",
         "Network replay is restricted to disposable GitHub-hosted CI")
    need(env.get("GITHUB_REPOSITORY") == "ZhengyiLuo/AgentsDock",
         "Unexpected acceptance repository")
    expected_workflow = (r"ZhengyiLuo/AgentsDock/\.github/workflows/ci\.yml@refs/heads/release/[A-Za-z0-9][A-Za-z0-9._/-]*" if candidate else
                         r"ZhengyiLuo/AgentsDock/\.github/workflows/product-release-acceptance\.yml@refs/heads/(?:main|release/[A-Za-z0-9][A-Za-z0-9._/-]*)")
    need(re.fullmatch(expected_workflow,
                      env.get("GITHUB_WORKFLOW_REF", "")), "Unexpected acceptance workflow")
    need(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Acceptance must be explicitly dispatched")
    for field in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        need(re.fullmatch(r"[1-9][0-9]*", env.get(field, "")), "Missing CI run identity")
    need(env.get("RUNNER_OS") in {"macOS", "Linux"}, "Unsupported native replay platform")
    need((env["RUNNER_OS"] == "macOS") == (sys.platform == "darwin"), "Runner platform mismatch")
    root = Path(env.get("RUNNER_TEMP", "")).resolve()
    path = Path(work).absolute()
    need(root.is_dir() and path == path.resolve() and path.is_relative_to(root)
         and path != root, "Replay work directory must be a non-symlink child of RUNNER_TEMP")
    if candidate:
        need(sys.platform == "darwin" and env["RUNNER_OS"] == "macOS", "Candidate replay is scoped to disposable macOS")
        need(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Candidate harness commit is missing")
    return path, {**({"scope": "candidate", "publicationEligible": False, "harnessSourceSha": env["GITHUB_SHA"]} if candidate else {}),
                  "runId": env["GITHUB_RUN_ID"], "runAttempt": env["GITHUB_RUN_ATTEMPT"],
                  "platform": env["RUNNER_OS"]}


def hosts_overlay(baseline, marker):
    text = baseline.decode("utf-8")
    need(MARKER not in text, "A replay hosts block already exists")
    for line in text.splitlines():
        fields = line.split("#", 1)[0].lower().split()
        need(not set(HOSTS).intersection(x.rstrip(".") for x in fields[1:]),
             "A replay hostname already has a hosts override")
    prefix = b"" if not baseline or baseline.endswith(b"\n") else b"\n"
    return baseline + prefix + (f"# BEGIN {marker}\n127.0.0.1 {' '.join(HOSTS)}\n# END {marker}\n").encode()


def restore_hosts(current, baseline, active, marker):
    # Exact comparison prevents erasing unrelated modifications. If another
    # tool changed hosts, fail and leave the saved baseline for manual review.
    need(current in (baseline, active), "Hosts changed outside this replay; refusing to overwrite unrelated changes")
    need(marker.encode() in active, "Replay hosts ownership is missing")
    return baseline


def trust_commands(platform, work, fingerprint, install):
    if platform == "macOS":
        return [["sudo", "-n", "/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot",
                 "-k", SYSTEM_KEYCHAIN, str(work / "ca.pem")]] if install else [
                     ["sudo", "-n", "/usr/bin/security", "delete-certificate", "-Z", fingerprint, SYSTEM_KEYCHAIN]]
    target = "/usr/local/share/ca-certificates/agentsdock-product-replay.crt"
    return [["sudo", "-n", "/usr/bin/install", "-m", "0644", str(work / "ca.pem"), target],
            ["sudo", "-n", "/usr/sbin/update-ca-certificates"]] if install else [
                ["sudo", "-n", "/bin/rm", "--", target], ["sudo", "-n", "/usr/sbin/update-ca-certificates"]]


def flush_dns(platform):
    if platform == "macOS":
        command("sudo", "-n", "/usr/bin/dscacheutil", "-flushcache")
        command("sudo", "-n", "/usr/bin/killall", "-HUP", "mDNSResponder")


def generate_certificates(work, name, *, openssl="openssl"):
    """Create only disposable fixture certificates, without host trust changes."""
    # Never inherit a binary's default req.x509_extensions. Some LibreSSL
    # versions append -addext to that section instead of replacing an existing
    # extension, producing duplicate Basic Constraints and an invalid CA.
    write_private(work / "ca.cnf", b"[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n"
                  b"[dn]\nCN=AgentsDock disposable replay\n[ca]\n"
                  b"basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n"
                  b"subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n")
    write_private(work / "leaf.cnf", b"[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=github.com\n")
    write_private(work / "leaf.ext", ("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                  "extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n"
                  "subjectAltName=" + ",".join("DNS:" + host for host in HOSTS) + "\n").encode())
    # Keys remain private even when OpenSSL itself creates their output files.
    old_umask = os.umask(0o077)
    try:
        command(openssl, "req", "-config", str(work / "ca.cnf"), "-x509", "-newkey", "rsa:2048",
                "-nodes", "-sha256", "-days", "1", "-subj", f"/CN={name}",
                "-keyout", str(work / "ca.key"), "-out", str(work / "ca.pem"))
        command(openssl, "req", "-config", str(work / "leaf.cnf"), "-new", "-newkey", "rsa:2048",
                "-nodes", "-sha256", "-subj", "/CN=github.com",
                "-keyout", str(work / "leaf.key"), "-out", str(work / "leaf.csr"))
        command(openssl, "x509", "-req", "-sha256", "-days", "1", "-in", str(work / "leaf.csr"),
                "-CA", str(work / "ca.pem"), "-CAkey", str(work / "ca.key"), "-CAcreateserial",
                "-extfile", str(work / "leaf.ext"), "-out", str(work / "leaf.pem"))
    finally:
        os.umask(old_umask)


def setup(receipt, receipt_hash, work, candidate=False):
    work, identity = guard(work, candidate=candidate)
    need(re.fullmatch(r"[a-f0-9]{64}", receipt_hash), "Invalid receipt hash")
    content = regular(receipt)
    need(digest(content) == receipt_hash, "Receipt bytes differ from the accepted seal")
    parsed_receipt = json.loads(content)
    if candidate:
        need(parsed_receipt.get("kind") == "agentsdock-macos-candidate" and parsed_receipt.get("schema") == 1
             and parsed_receipt.get("scope") == "darwin-app-server" and parsed_receipt.get("publicationEligible") is False,
             "Candidate network setup requires an explicitly non-publishing scoped receipt")
    source = parsed_receipt.get("sourceSha", "")
    need(re.fullmatch(r"[a-f0-9]{40}", source), "Receipt source pin is missing")
    if candidate:
        # Preserve real runner metadata for the shared git/provenance guard,
        # but do not inherit publishing/provider credentials into this child.
        env = {key: value for key, value in os.environ.items() if key in {
            "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "GITHUB_ACTIONS", "GITHUB_REPOSITORY",
            "GITHUB_EVENT_NAME", "GITHUB_WORKFLOW_REF", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
            "RUNNER_ENVIRONMENT", "RUNNER_OS", "RUNNER_TEMP"}}
        validated = subprocess.run(["node", str(Path(__file__).with_name("product-candidate-receipt.mjs")),
            "validate-runner", str(receipt), receipt_hash], capture_output=True, env=env, timeout=60)
        need(validated.returncode == 0 and len(validated.stdout) <= 32768,
             "Candidate harness ancestry, checkout or allowed-path verification failed")
        harness = json.loads(validated.stdout)
        need(harness.get("sourceSha") == source and harness.get("harnessSourceSha") == identity["harnessSourceSha"]
             and harness.get("publicationEligible") is False, "Candidate harness identity differs")
    else:
        need(command("git", "rev-parse", "HEAD").decode().strip() == source,
             "Checkout differs from the exact candidate source")
    need(not work.exists(), "Replay work directory already exists")
    need(not Path("/usr/local/share/ca-certificates/agentsdock-product-replay.crt").exists(),
         "Replay trust anchor already exists")
    baseline = regular(HOSTS_FILE)
    marker = f"{MARKER} {identity['runId']}/{identity['runAttempt']}"
    active = hosts_overlay(baseline, marker)
    # Fixed exclusive lock prevents a second setup in a different work folder.
    LOCK.mkdir(mode=0o700)
    work.mkdir(mode=0o700)
    identity.update({"schema": 1, "sourceSha": source, "receiptSha256": receipt_hash,
                     "work": str(work), "marker": marker})
    write_private(LOCK / "owner.json", json.dumps(identity).encode())
    write_private(work / "hosts.baseline", baseline)
    write_private(work / "hosts.active", active)
    write_private(work / "owner.json", json.dumps(identity).encode())
    # Private CA/key bytes are never uploaded; teardown deletes exact files.
    generate_certificates(work, f"AgentsDock disposable replay {identity['runId']}-{identity['runAttempt']}")
    # Prove the generated leaf chains to this ephemeral CA and is valid for
    # every exact TLS origin before adding trust or changing host routing.
    # A malformed certificate remains owned by this setup and cleanable, but
    # never reaches a privileged mutation or a disabled-verification fallback.
    for host in HOSTS:
        command("openssl", "verify", "-CAfile", str(work / "ca.pem"),
                "-purpose", "sslserver", "-verify_hostname", host,
                str(work / "leaf.pem"), timeout=30)
    ca = regular(work / "ca.pem")
    fingerprint = command("openssl", "x509", "-in", str(work / "ca.pem"), "-noout", "-fingerprint", "-sha1").decode().strip().split("=")[-1].replace(":", "")
    need(re.fullmatch(r"[A-Fa-f0-9]{40}", fingerprint), "Invalid ephemeral CA fingerprint")
    write_private(work / "ca.fingerprint", fingerprint.encode())
    # Keep public-root access for dependencies/providers. SSL_CERT_FILE reaches
    # Python urllib, including uv Python, if the fixture propagates it into the
    # native service environment. macOS keychain trust alone is insufficient.
    roots = ssl.create_default_context().get_ca_certs(binary_form=True)
    need(roots, "Runner Python has no default public trust roots; prepare its certificate store before replay")
    bundle = "".join(ssl.DER_cert_to_PEM_cert(cert) for cert in roots).encode() + ca
    write_private(work / "trust-bundle.pem", bundle)
    hints = {"NODE_EXTRA_CA_CERTS": str(work / "ca.pem"), "SSL_CERT_FILE": str(work / "trust-bundle.pem"),
             "REQUESTS_CA_BUNDLE": str(work / "trust-bundle.pem"), "CURL_CA_BUNDLE": str(work / "trust-bundle.pem"),
             "NO_PROXY": ",".join((*HOSTS, "localhost", "127.0.0.1", "::1"))}
    write_private(work / "trust.env", "".join(f"export {key}={shlex.quote(value)}\n" for key, value in hints.items()).encode())
    public = {**identity, "hosts": list(HOSTS), "listen": "127.0.0.1", "port": 443,
              "caCertificate": str(work / "ca.pem"), "certificate": str(work / "leaf.pem"),
              "privateKey": str(work / "leaf.key"), "environment": hints, "caFingerprint": fingerprint}
    write_private(work / "network.json", json.dumps(public, indent=2).encode())
    # Journal intent before each privileged mutation so teardown can recover
    # even if the following operation or a later acceptance step fails.
    write_private(work / "trust.attempted", b"1")
    for args in trust_commands(identity["platform"], work, fingerprint, True):
        command(*args)
    need(regular(HOSTS_FILE) == baseline, "Hosts changed before replay activation")
    write_private(work / "hosts.attempted", b"1")
    command("sudo", "-n", "/usr/bin/tee", str(HOSTS_FILE), data=active)
    flush_dns(identity["platform"])
    return public


def teardown(work, candidate=False):
    work, run = guard(work, candidate=candidate)
    if not work.exists():
        need(not LOCK.exists(), "Replay lock exists without the requested work directory")
        return {"restored": True, "setupStarted": False}
    identity = json.loads(regular(work / "owner.json"))
    need(all(identity.get(key) == value for key, value in run.items())
         and identity.get("work") == str(work), "Replay cleanup ownership mismatch")
    if (work / "restored.json").exists():
        previous = json.loads(regular(work / "restored.json"))
        need(previous == {"restored": True, **run}, "Replay cleanup receipt mismatch")
        return {"restored": True}
    need(json.loads(regular(LOCK / "owner.json")) == identity, "Replay lock ownership mismatch")
    if (work / "hosts.attempted").exists():
        baseline, active = regular(work / "hosts.baseline"), regular(work / "hosts.active")
        restored = restore_hosts(regular(HOSTS_FILE), baseline, active, identity["marker"])
        command("sudo", "-n", "/usr/bin/tee", str(HOSTS_FILE), data=restored)
        flush_dns(identity["platform"])
        (work / "hosts.attempted").unlink()
    if (work / "trust.attempted").exists():
        fingerprint = regular(work / "ca.fingerprint").decode()
        need(re.fullmatch(r"[A-Fa-f0-9]{40}", fingerprint), "Invalid CA cleanup fingerprint")
        if identity["platform"] == "macOS":
            # A failed add-trusted-cert may never have installed the CA. Query
            # public certificate metadata so cleanup remains safe on that path.
            certificates = command("/usr/bin/security", "find-certificate", "-a", "-Z", SYSTEM_KEYCHAIN)
            if fingerprint.upper().encode() in certificates.upper():
                for args in trust_commands(identity["platform"], work, fingerprint, False):
                    command(*args)
        else:
            anchor = Path("/usr/local/share/ca-certificates/agentsdock-product-replay.crt")
            if anchor.exists():
                need(regular(anchor) == regular(work / "ca.pem"),
                     "Replay trust anchor changed; refusing to remove an unrelated certificate")
                for args in trust_commands(identity["platform"], work, fingerprint, False):
                    command(*args)
            else:
                command("sudo", "-n", "/usr/sbin/update-ca-certificates")
        (work / "trust.attempted").unlink()
    for name in ("ca.key", "leaf.key", "leaf.csr", "ca.srl"):
        path = work / name
        if path.exists():
            need(path.is_file() and not path.is_symlink(), "Unexpected private-key cleanup target")
            path.unlink()
    (LOCK / "owner.json").unlink()
    LOCK.rmdir()
    write_private(work / "restored.json", json.dumps({"restored": True, **run}).encode())
    return {"restored": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    start = sub.add_parser("setup")
    start.add_argument("--receipt", type=Path, required=True)
    start.add_argument("--receipt-sha256", required=True)
    start.add_argument("--work", type=Path, required=True)
    start.add_argument("--candidate", action="store_true")
    stop = sub.add_parser("teardown")
    stop.add_argument("--work", type=Path, required=True)
    stop.add_argument("--candidate", action="store_true")
    args = parser.parse_args()
    result = setup(args.receipt, args.receipt_sha256, args.work, args.candidate) if args.operation == "setup" else teardown(args.work, args.candidate)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
