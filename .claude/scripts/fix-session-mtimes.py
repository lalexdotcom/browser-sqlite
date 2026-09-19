#!/usr/bin/env python3
"""Restore each session file's mtime from the last timestamp it contains.

Claude Code rewrites session .jsonl files in bulk at every version upgrade,
stamping a whole generation of conversations with one identical mtime. That
flattens the chronology the session picker sorts on. Each file still carries
the true timestamps of its own messages, so the real date can be read back
out and put where it belongs.

Only mtime is ever written. File contents are opened read-only.
"""

import os
import re
import sys
from datetime import datetime, timezone

# CLAUDE_CONFIG_DIR is authoritative when set: ~/.claude does not necessarily
# exist (devcontainers routinely mount the config elsewhere), and walking a
# missing directory fails silently with nothing to show for it.
CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
PROJECTS = os.environ.get("CLAUDE_PROJECTS_DIR") or os.path.join(CONFIG_DIR, "projects")
TS = re.compile(rb'"timestamp":"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"')

# A session written to within this window is probably still live; leave it be.
LIVE_WINDOW_S = 300


def last_timestamp(path, size):
    """Newest timestamp in the file, scanning from the tail outward."""
    window = 1 << 20
    with open(path, "rb") as fh:
        while True:
            fh.seek(max(0, size - window))
            found = TS.findall(fh.read())
            if found:
                return max(found).decode()
            if window >= size:
                return None
            window *= 2


def main():
    dry = "--dry-run" in sys.argv

    # Say so rather than reporting a serene "fixed 0": a wrong path and a clean
    # run are otherwise indistinguishable, and this runs unattended from a hook.
    if not os.path.isdir(PROJECTS):
        print(f"projects directory not found: {PROJECTS}", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc).timestamp()
    changed = skipped = live = 0

    for root, _, files in os.walk(PROJECTS):
        for name in sorted(files):
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(root, name)
            st = os.stat(path)
            if not st.st_size:
                skipped += 1
                continue
            if now - st.st_mtime < LIVE_WINDOW_S:
                live += 1
                continue

            iso = last_timestamp(path, st.st_size)
            if iso is None:
                skipped += 1
                continue

            want = datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
            if abs(want - st.st_mtime) < 1:
                continue

            was = datetime.fromtimestamp(st.st_mtime, timezone.utc)
            print(f"  {name[:8]}  {was:%Y-%m-%d %H:%M}  ->  {iso[:16].replace('T', ' ')}")
            if not dry:
                os.utime(path, (st.st_atime, want))
            changed += 1

    verb = "would fix" if dry else "fixed"
    print(f"{verb} {changed} · skipped {skipped} (empty/no timestamp) · live {live}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
