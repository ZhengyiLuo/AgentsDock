#!/usr/bin/env python3
"""Validate a fast-forward server subtree export; never push or publish."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise ValueError(result.stderr.strip() or f"git {arguments[0]} failed")
    return result.stdout.strip()


def prepare(root: Path, commit: str, previous: str) -> dict[str, str]:
    if not re.fullmatch(r"[0-9a-f]{40}", previous):
        raise ValueError("previous must be the full reviewed standalone commit")
    if git(root, "rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("server export requires complete Git history")
    canonical = git(root, "rev-parse", "--verify", "--end-of-options", f"{commit}^{{commit}}")
    git(root, "cat-file", "-e", f"{previous}^{{commit}}")
    server_tree = git(root, "rev-parse", f"{canonical}:server")
    if git(root, "cat-file", "-t", server_tree) != "tree":
        raise ValueError("the accepted commit has no server directory")
    exported = git(root, "subtree", "split", "--prefix=server", canonical)
    exported_tree = git(root, "rev-parse", f"{exported}^{{tree}}")
    if exported_tree != server_tree:
        raise ValueError("exported contents differ from the accepted server subtree")
    ancestor = subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", previous, exported],
        capture_output=True, check=False,
    )
    if ancestor.returncode:
        raise ValueError("standalone history diverged; refusing a non-fast-forward export")
    return {
        "canonical_commit": canonical,
        "previous_standalone_commit": previous,
        "exported_commit": exported,
        "server_tree": server_tree,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", default="HEAD")
    parser.add_argument("--previous", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        result = prepare(root, args.commit, args.previous)
    except ValueError as error:
        parser.exit(1, f"Server export rejected: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
