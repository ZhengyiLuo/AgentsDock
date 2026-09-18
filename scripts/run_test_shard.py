"""Run a deterministic portion of the suite in an isolated CI checkout.

Keep the whole checkout available: test modules share fixture helpers. Use
--list to inspect assignments without importing tests or production code.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=int, required=True)
    parser.add_argument('--count', type=int, required=True)
    parser.add_argument('--list', action='store_true')
    args = parser.parse_args()
    if args.count < 1 or not 0 <= args.index < args.count:
        parser.error('require count > 0 and 0 <= index < count')
    root = Path(__file__).resolve().parents[1]
    # The existing suite is flat. Fail visibly if package-based discovery grows
    # nested tests, instead of silently leaving them out of all eight workers.
    for package in root.iterdir():
        if package.is_dir() and (package / '__init__.py').is_file():
            if any(package.rglob('test_*.py')):
                parser.error('nested test modules require updating shard discovery')
    paths = sorted(root.glob('test_*.py'))
    selected = paths[args.index::args.count]
    if not selected:
        parser.error('empty test shard')
    if args.list:
        print('\n'.join(path.stem for path in selected))
        return 0
    print(f'Shard {args.index + 1}/{args.count}: {len(selected)}/{len(paths)} modules', flush=True)
    for path in selected:
        compile(path.read_bytes(), str(path), 'exec')
    # Import only after assignment; --list stays safe in a live development tree.
    import unittest

    sys.path.insert(0, str(root))
    suite = unittest.defaultTestLoader.loadTestsFromNames([path.stem for path in selected])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
