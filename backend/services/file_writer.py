"""File writer: generates .md, .json, .raw.html files on disk."""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from config import get_config


def _yaml_str(value: str) -> str:
    """Return a YAML-safe double-quoted string."""
    if not value:
        return '""'
    return json.dumps(value, ensure_ascii=False)


def _sanitize_slug(text: str, max_len: int = 50) -> str:
    """Generate a file-safe slug from a title string."""
    slug = text.lower().strip()
    slug = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", slug)
    slug = slug.strip("-")
    return slug[:max_len] if len(slug) > max_len else slug


def _build_file_slug(storage_date: str, title: str, uuid_suffix: str = "") -> str:
    now = datetime.now(timezone.utc)
    time_part = now.strftime("%H%M%S")
    date_part = storage_date.replace("-", "")
    slug = _sanitize_slug(title) if title else "untitled"
    base = f"cap_{date_part}_{time_part}_{slug}"
    if uuid_suffix:
        base = f"{base}_{uuid_suffix}"
    return base


def _ensure_date_dir(storage_date: str) -> Path:
    root = Path(get_config().storage_root)
    date_dir = root / storage_date
    date_dir.mkdir(parents=True, exist_ok=True)
    return date_dir


def write_markdown(
    file_slug: str,
    storage_date: str,
    record: dict,
) -> str:
    """Write .md file with YAML frontmatter. Returns the file path."""
    date_dir = _ensure_date_dir(storage_date)
    file_path = date_dir / f"{file_slug}.md"

    tags_yml = "\n".join(f"  - {t}" for t in record.get("tags", []))

    frontmatter = f"""---
id: {record['id']}
capture_type: {record.get('capture_type', 'page')}
url: {_yaml_str(record.get('url', ''))}
canonical_url: {_yaml_str(record.get('canonical_url', '') or '')}
title: {_yaml_str(record.get('title', 'Untitled'))}
source_domain: {record.get('source_domain', '')}
author: {_yaml_str(record.get('author') or '')}
published_at: {_yaml_str(record.get('published_at') or '')}
captured_at: {record['captured_at']}
storage_date: {storage_date}
content_hash: {record.get('content_hash', '')}
tags:
{tags_yml if tags_yml else '  - none'}
priority: {record.get('priority', 'normal')}
research_intent: {_yaml_str(record.get('research_intent', '') or '')}
user_notes: {_yaml_str(record.get('user_notes', '') or '')}
dedup_status: {record.get('dedup_status', 'unique')}
status: {record.get('status', 'raw_captured')}
---

# {record.get('title', 'Untitled')}

## 用户备注

{record.get('user_notes', '') or '_无备注_'}

## 原文

{record.get('content', '') or '_无内容_'}

## 待分析问题

- 这条信息对应哪个产业链环节？
- 是否影响 A股/港股/美股/台股 映射？
- 是否有新增催化剂？
- 是否需要加入日报/周报？
"""

    file_path.write_text(frontmatter, encoding="utf-8")
    return str(file_path)


def write_json(
    file_slug: str,
    storage_date: str,
    record: dict,
) -> str:
    """Write .json metadata file. Returns the file path."""
    date_dir = _ensure_date_dir(storage_date)
    file_path = date_dir / f"{file_slug}.json"

    meta = {
        "id": record["id"],
        "capture_type": record.get("capture_type", "page"),
        "url": record.get("url", ""),
        "canonical_url": record.get("canonical_url"),
        "title": record.get("title", "Untitled"),
        "source_domain": record.get("source_domain", ""),
        "author": record.get("author"),
        "published_at": record.get("published_at"),
        "captured_at": record["captured_at"],
        "storage_date": storage_date,
        "content_hash": record.get("content_hash", ""),
        "tags": record.get("tags", []),
        "priority": record.get("priority", "normal"),
        "research_intent": record.get("research_intent", ""),
        "user_notes": record.get("user_notes", ""),
        "dedup_status": record.get("dedup_status", "unique"),
        "duplicate_of": record.get("duplicate_of"),
        "status": record.get("status", "raw_captured"),
        "paths": {
            "markdown": str(date_dir / f"{file_slug}.md"),
            "json": str(date_dir / f"{file_slug}.json"),
            "raw_html": str(date_dir / f"{file_slug}.raw.html")
            if record.get("raw_html_path")
            else None,
            "analysis_prompt": str(date_dir / f"{file_slug}.analysis_prompt.md"),
        },
    }

    file_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return str(file_path)


def write_raw_html(
    file_slug: str,
    storage_date: str,
    raw_html: str,
) -> str | None:
    """Write raw .html file. Returns path or None if no HTML."""
    if not raw_html:
        return None
    date_dir = _ensure_date_dir(storage_date)
    file_path = date_dir / f"{file_slug}.raw.html"
    # Truncate if exceeds max
    max_bytes = get_config().max_content_bytes
    html_bytes = raw_html.encode("utf-8")
    if len(html_bytes) > max_bytes:
        raw_html = html_bytes[:max_bytes].decode("utf-8", errors="replace")
        raw_html += "\n<!-- [Content truncated at 1MB] -->"
    file_path.write_text(raw_html, encoding="utf-8")
    return str(file_path)


def write_all_files(record: dict, raw_html: str | None = None) -> dict:
    """
    Generate file_slug, write .md + .json + optional .raw.html.
    Returns dict with paths for DB storage.
    """
    now = datetime.now(timezone.utc)
    storage_date = now.strftime("%Y-%m-%d")
    captured_at = now.isoformat()
    file_slug = _build_file_slug(
        storage_date, record.get("title", ""), record["id"][:8]
    )

    record["storage_date"] = storage_date
    record["captured_at"] = captured_at
    record["file_slug"] = file_slug

    # Write raw HTML first so its path is available for JSON metadata
    html_path = write_raw_html(file_slug, storage_date, raw_html) if raw_html else None
    record["raw_html_path"] = html_path

    md_path = write_markdown(file_slug, storage_date, record)
    json_path = write_json(file_slug, storage_date, record)

    record["markdown_path"] = md_path
    record["json_path"] = json_path
    record["analysis_prompt_path"] = str(
        _ensure_date_dir(storage_date) / f"{file_slug}.analysis_prompt.md"
    )

    return record
