#!/usr/bin/env python3
"""
Browser Capture Ingest — daily cron job.

Scans /srv/cloud-vault/inbox/browser-capture/ for new captures,
routes them into /srv/cloud-vault/markdown/content-collection/ by rules,
and updates the master index.

Routing rules (in priority order):
  1. Tag → /by-tag/{tag}/
  2. Domain → /by-domain/{domain}/
  3. Type → /by-type/{capture_type}/
  4. Date → /by-date/YYYY/MM/

Files are hardlinked (not copied) to save disk space.
Processed captures are tracked via .ingest_state.json so they're never re-processed.

Usage:
  python ingest_browser_captures.py                  # normal run
  python ingest_browser_captures.py --dry-run        # preview only
  python ingest_browser_captures.py --verbose        # detailed log
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────
VAULT_ROOT = Path("/srv/cloud-vault")
INBOX_DIR = VAULT_ROOT / "inbox" / "browser-capture"
COLLECTION_DIR = VAULT_ROOT / "markdown" / "content-collection"
INDEX_DIR = VAULT_ROOT / "index"
INDEX_FILE = INDEX_DIR / "browser-captures-index.jsonl"
STATE_FILE = VAULT_ROOT / "logs" / "content-capture" / ".ingest_state.json"
LOG_DIR = VAULT_ROOT / "logs" / "content-capture"

# Subdirs under content-collection:
SUBDIRS = {
    "by-tag": "tags",
    "by-domain": "source_domain",
    "by-type": "capture_type",
    "by-date": "storage_date",
}

# ── Helpers ─────────────────────────────────────────────────────────


def log(msg: str, verbose: bool = False) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] {msg}"
    print(line)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_state() -> set[str]:
    """Return set of already-ingested capture IDs."""
    if not STATE_FILE.exists():
        return set()
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return set(data.get("ingested_ids", []))
    except Exception:
        return set()


def save_state(ingested_ids: set[str]) -> None:
    ensure_dir(STATE_FILE.parent)
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "ingested_ids": sorted(ingested_ids),
        "count": len(ingested_ids),
    }
    STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


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


def build_routes(rec: dict) -> list[Path]:
    """Return list of relative paths under content-collection for this capture."""
    routes = []

    # By tag
    for tag in rec.get("tags", []) or []:
        tag_slug = _slug(tag)
        routes.append(Path("by-tag") / tag_slug)

    # By domain
    domain = rec.get("source_domain", "")
    if domain:
        routes.append(Path("by-domain") / _slug(domain))

    # By type
    ctype = rec.get("capture_type", "unknown")
    routes.append(Path("by-type") / _slug(ctype))

    # By date
    storage_date = rec.get("storage_date", "")
    if storage_date and len(storage_date) >= 7:
        parts = storage_date.split("-")
        routes.append(Path("by-date") / parts[0] / parts[1])  # YYYY/MM

    return routes


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


def append_index(entry: dict) -> None:
    """Append one line to the JSONL index file."""
    ensure_dir(INDEX_FILE.parent)
    with open(INDEX_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ── Main Ingest Logic ───────────────────────────────────────────────


def ingest(dry_run: bool = False, verbose: bool = False) -> dict:
    """
    Scan inbox, route new captures into content-collection, update index.
    Returns stats dict.
    """
    ingested_ids = load_state()
    json_files = find_capture_json_files(INBOX_DIR)

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

        # Build routes
        routes = build_routes(rec)
        route_strs = [str(r) for r in routes]

        if verbose:
            log(f"  {rec.get('title', 'untitled')[:60]}")
            for r in route_strs:
                log(f"    → {r}")

        if dry_run:
            ingested_ids.add(capture_id)
            stats["ingested"] += 1
            continue

        # Create hardlinks in each route directory
        try:
            for route_dir in routes:
                target_dir = COLLECTION_DIR / route_dir
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
            entry = build_index_entry(rec, route_strs)
            append_index(entry)

            # Mark ingested
            ingested_ids.add(capture_id)
            stats["ingested"] += 1
            log(f"  ingested: {rec.get('title', 'untitled')[:60]}")

        except Exception as e:
            log(f"ERROR ingesting {capture_id}: {e}")
            stats["failed"] += 1

    if not dry_run and stats["ingested"] > 0:
        save_state(ingested_ids)

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
    args = parser.parse_args()

    log(f"Ingest started — {'DRY RUN' if args.dry_run else 'LIVE'}")
    stats = ingest(dry_run=args.dry_run, verbose=args.verbose)

    log(f"Done: scanned={stats['scanned']} ingested={stats['ingested']} "
        f"skipped={stats['skipped']} failed={stats['failed']}")

    if stats["failed"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
