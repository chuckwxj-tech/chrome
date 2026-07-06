#!/usr/bin/env python3
"""
Browser Capture Ingest — daily cron job.

Scans /srv/cloud-vault/inbox/browser-capture/ for new captures,
routes them into /srv/cloud-vault/markdown/content-collection/ by rules,
and updates the master index.

Routing is driven by browser-capture-rules.json (same directory as this
script, override with --rules). Each enabled route creates hardlinks:
  by-tag/{tag}/, by-domain/{domain}/, by-type/{capture_type}/, by-date/YYYY/MM/
plus per-priority extra_routes (relative to the vault root). Priorities with
notify=true append an entry to logs/content-capture/notifications.jsonl.

Files are hardlinked (not copied) to save disk space.
Processed captures are tracked via .ingest_state.json so they're never re-processed.

Usage:
  python ingest_browser_captures.py                  # normal run
  python ingest_browser_captures.py --dry-run        # preview only
  python ingest_browser_captures.py --verbose        # detailed log
  python ingest_browser_captures.py --rules my.json  # alternate rules file
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────
DEFAULT_VAULT_ROOT = Path(os.getenv("CLOUD_VAULT_ROOT", "/srv/cloud-vault"))
DEFAULT_RULES_FILE = Path(__file__).resolve().parent / "browser-capture-rules.json"

# Fallback when the rules file is missing/unreadable — mirrors the
# shipped browser-capture-rules.json routing section.
DEFAULT_RULES = {
    "routes": {
        "by-tag": {"enabled": True},
        "by-domain": {"enabled": True},
        "by-type": {"enabled": True},
        "by-date": {"enabled": True},
    },
    "priority_rules": {},
}


class VaultPaths:
    """All filesystem locations derived from the vault root."""

    def __init__(self, root: Path):
        self.root = root
        self.inbox = root / "inbox" / "browser-capture"
        self.collection = root / "markdown" / "content-collection"
        self.index_file = root / "index" / "browser-captures-index.jsonl"
        self.log_dir = root / "logs" / "content-capture"
        self.state_file = self.log_dir / ".ingest_state.json"
        self.notifications_file = self.log_dir / "notifications.jsonl"


def load_rules(rules_path: Path) -> dict:
    """Load routing rules JSON; fall back to built-in defaults."""
    try:
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        if not isinstance(rules.get("routes"), dict):
            raise ValueError("rules file has no 'routes' object")
        rules.setdefault("priority_rules", {})
        return rules
    except FileNotFoundError:
        log(f"WARN: rules file not found at {rules_path}, using built-in defaults")
        return DEFAULT_RULES
    except Exception as e:
        log(f"WARN: failed to load rules {rules_path} ({e}), using built-in defaults")
        return DEFAULT_RULES


def _route_enabled(rules: dict, key: str) -> bool:
    return bool(rules.get("routes", {}).get(key, {}).get("enabled"))

# ── Helpers ─────────────────────────────────────────────────────────


def log(msg: str, verbose: bool = False) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] {msg}"
    print(line)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_state(state_file: Path) -> set[str]:
    """Return set of already-ingested capture IDs."""
    if not state_file.exists():
        return set()
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
        return set(data.get("ingested_ids", []))
    except Exception:
        return set()


def save_state(state_file: Path, ingested_ids: set[str]) -> None:
    ensure_dir(state_file.parent)
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "ingested_ids": sorted(ingested_ids),
        "count": len(ingested_ids),
    }
    state_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def find_capture_json_files(inbox: Path) -> list[Path]:
    """Return sorted list of *.json files in inbox (not _processed)."""
    results = []
    if not inbox.exists():
        return results
    for json_file in inbox.rglob("*.json"):
        if "_processed" in json_file.parts:
            continue
        results.append(json_file)
    return sorted(results)


def read_capture(json_path: Path) -> dict | None:
    """Parse a capture JSON file."""
    try:
        return json.loads(json_path.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"ERROR reading {json_path}: {e}")
        return None


def build_routes(rec: dict, rules: dict, paths: VaultPaths) -> tuple[list[Path], list[str]]:
    """Return (absolute target dirs, route labels for the index) per rules.

    Standard by-* routes live under content-collection; per-priority
    extra_routes are relative to the vault root (e.g. research/threads/inbox).
    """
    targets: list[Path] = []
    labels: list[str] = []

    def add(base: Path, rel: Path, label: str) -> None:
        targets.append(base / rel)
        labels.append(label)

    if _route_enabled(rules, "by-tag"):
        for tag in rec.get("tags", []) or []:
            rel = Path("by-tag") / _slug(tag)
            add(paths.collection, rel, str(rel))

    if _route_enabled(rules, "by-domain"):
        domain = rec.get("source_domain", "")
        if domain:
            rel = Path("by-domain") / _slug(domain)
            add(paths.collection, rel, str(rel))

    if _route_enabled(rules, "by-type"):
        rel = Path("by-type") / _slug(rec.get("capture_type", "unknown"))
        add(paths.collection, rel, str(rel))

    if _route_enabled(rules, "by-date"):
        storage_date = rec.get("storage_date", "")
        if storage_date and len(storage_date) >= 7:
            parts = storage_date.split("-")
            rel = Path("by-date") / parts[0] / parts[1]  # YYYY/MM
            add(paths.collection, rel, str(rel))

    # Priority extra routes (vault-root-relative)
    prio_cfg = rules.get("priority_rules", {}).get(rec.get("priority") or "", {})
    for extra in prio_cfg.get("extra_routes", []) or []:
        add(paths.root, Path(extra), extra)

    return targets, labels


def write_notification(paths: VaultPaths, rec: dict, route_labels: list[str]) -> None:
    """Append a notification entry for priorities configured with notify=true.

    Downstream tooling (or a shell one-liner) can tail this JSONL to alert on
    urgent captures.
    """
    ensure_dir(paths.notifications_file.parent)
    entry = {
        "notified_at": datetime.now(timezone.utc).isoformat(),
        "capture_id": rec.get("id"),
        "title": rec.get("title"),
        "url": rec.get("url"),
        "priority": rec.get("priority"),
        "tags": rec.get("tags", []),
        "routes": route_labels,
    }
    with open(paths.notifications_file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _slug(text: str) -> str:
    """Safe directory name from arbitrary string."""
    import re
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff_-]", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    return text.strip("-") or "unknown"


def build_index_entry(rec: dict, routes: list[str]) -> dict:
    """Create a JSONL index entry for this capture."""
    return {
        "id": rec.get("id"),
        "title": rec.get("title"),
        "url": rec.get("url"),
        "capture_type": rec.get("capture_type"),
        "source_domain": rec.get("source_domain"),
        "tags": rec.get("tags", []),
        "priority": rec.get("priority"),
        "captured_at": rec.get("captured_at"),
        "storage_date": rec.get("storage_date"),
        "content_hash": rec.get("content_hash"),
        "routes": routes,
        "ingested_at": datetime.now(timezone.utc).isoformat(),
    }


def append_index(index_file: Path, entry: dict) -> None:
    """Append one line to the JSONL index file."""
    ensure_dir(index_file.parent)
    with open(index_file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ── Main Ingest Logic ───────────────────────────────────────────────


def ingest(
    dry_run: bool = False,
    verbose: bool = False,
    vault_root: Path | None = None,
    rules_file: Path | None = None,
) -> dict:
    """
    Scan inbox, route new captures per the rules file, update index.
    Returns stats dict.
    """
    paths = VaultPaths(vault_root or DEFAULT_VAULT_ROOT)
    rules = load_rules(rules_file or DEFAULT_RULES_FILE)
    ingested_ids = load_state(paths.state_file)
    json_files = find_capture_json_files(paths.inbox)

    stats = {"scanned": 0, "ingested": 0, "skipped": 0, "failed": 0}

    for json_path in json_files:
        stats["scanned"] += 1
        rec = read_capture(json_path)
        if not rec:
            stats["failed"] += 1
            continue

        capture_id = rec.get("id", "")
        if not capture_id:
            log(f"WARN: no id in {json_path}, skipping")
            stats["failed"] += 1
            continue

        if capture_id in ingested_ids:
            stats["skipped"] += 1
            continue

        # Find associated files
        base_name = json_path.stem  # e.g. cap_20260609_042653_slug_7467ed0e
        sibling_dir = json_path.parent
        md_file = sibling_dir / f"{base_name}.md"
        analysis_file = sibling_dir / f"{base_name}.analysis_prompt.md"
        raw_html_file = sibling_dir / f"{base_name}.raw.html"

        # Build routes from rules (includes per-priority extra_routes)
        target_dirs, route_labels = build_routes(rec, rules, paths)
        prio_cfg = rules.get("priority_rules", {}).get(rec.get("priority") or "", {})

        if verbose:
            log(f"  {rec.get('title', 'untitled')[:60]}")
            for r in route_labels:
                log(f"    → {r}")
            if prio_cfg.get("notify"):
                log("    → notify")

        if dry_run:
            ingested_ids.add(capture_id)
            stats["ingested"] += 1
            continue

        # Create hardlinks in each route directory
        try:
            for target_dir in target_dirs:
                ensure_dir(target_dir)

                if md_file.exists():
                    _link(md_file, target_dir / md_file.name)
                if analysis_file.exists():
                    _link(analysis_file, target_dir / analysis_file.name)
                if raw_html_file.exists():
                    _link(raw_html_file, target_dir / raw_html_file.name)
                # Link the JSON too for full metadata access
                _link(json_path, target_dir / json_path.name)

            # Append to index
            entry = build_index_entry(rec, route_labels)
            append_index(paths.index_file, entry)

            # Notify per priority rules
            if prio_cfg.get("notify"):
                write_notification(paths, rec, route_labels)

            # Mark ingested
            ingested_ids.add(capture_id)
            stats["ingested"] += 1
            log(f"  ingested: {rec.get('title', 'untitled')[:60]}")

        except Exception as e:
            log(f"ERROR ingesting {capture_id}: {e}")
            stats["failed"] += 1

    if not dry_run and stats["ingested"] > 0:
        save_state(paths.state_file, ingested_ids)

    return stats


def _link(src: Path, dst: Path) -> None:
    """Create a hardlink if possible, else copy."""
    if dst.exists():
        return  # already linked
    try:
        os.link(src, dst)
    except OSError:
        # Hardlink failed (e.g. cross-filesystem), fall back to symlink
        try:
            dst.symlink_to(src)
        except OSError:
            # Symlink failed too, copy
            import shutil
            shutil.copy2(src, dst)


# ── CLI ─────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Browser Capture Ingest")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, don't write files")
    parser.add_argument("--verbose", "-v", action="store_true", help="Detailed output")
    parser.add_argument("--vault-root", type=Path, default=None,
                        help=f"Vault root directory (default: $CLOUD_VAULT_ROOT or {DEFAULT_VAULT_ROOT})")
    parser.add_argument("--rules", type=Path, default=None,
                        help=f"Routing rules JSON (default: {DEFAULT_RULES_FILE})")
    args = parser.parse_args()

    log(f"Ingest started — {'DRY RUN' if args.dry_run else 'LIVE'}")
    stats = ingest(
        dry_run=args.dry_run,
        verbose=args.verbose,
        vault_root=args.vault_root,
        rules_file=args.rules,
    )

    log(f"Done: scanned={stats['scanned']} ingested={stats['ingested']} "
        f"skipped={stats['skipped']} failed={stats['failed']}")

    if stats["failed"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
