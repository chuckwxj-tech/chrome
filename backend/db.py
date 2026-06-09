"""SQLite database adapter with WAL mode and migrations."""

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from config import get_config


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    capture_type TEXT NOT NULL,
    url TEXT NOT NULL,
    canonical_url TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_domain TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    priority TEXT NOT NULL DEFAULT 'normal',
    research_intent TEXT NOT NULL DEFAULT '',
    user_notes TEXT NOT NULL DEFAULT '',
    author TEXT,
    published_at TEXT,
    raw_html_path TEXT,
    captured_at TEXT NOT NULL,
    file_slug TEXT NOT NULL,
    storage_date TEXT NOT NULL,
    dedup_status TEXT NOT NULL DEFAULT 'unique',
    duplicate_of TEXT,
    markdown_path TEXT,
    json_path TEXT,
    analysis_prompt_path TEXT,
    status TEXT NOT NULL DEFAULT 'raw_captured'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_file_slug ON captures(file_slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_url ON captures(canonical_url) WHERE canonical_url IS NOT NULL AND canonical_url != '';
CREATE INDEX IF NOT EXISTS idx_captures_url ON captures(url);
CREATE INDEX IF NOT EXISTS idx_captures_hash ON captures(content_hash);
CREATE INDEX IF NOT EXISTS idx_captures_date ON captures(storage_date);
CREATE INDEX IF NOT EXISTS idx_captures_domain ON captures(source_domain);

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    entity_type TEXT,
    market TEXT,
    ticker TEXT,
    canonical_name TEXT
);

CREATE TABLE IF NOT EXISTS capture_entities (
    capture_id TEXT NOT NULL REFERENCES captures(id),
    entity_id INTEGER NOT NULL REFERENCES entities(id),
    role TEXT,
    confidence REAL,
    evidence TEXT,
    PRIMARY KEY (capture_id, entity_id)
);
"""


class Database:
    def __init__(self, db_path: str | None = None):
        path = db_path or get_config().db_path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.row_factory = sqlite3.Row

    def init_schema(self):
        self._conn.executescript(SCHEMA_SQL)
        self._conn.commit()

    # ── Capture CRUD ──────────────────────────────────────────────

    def insert_capture(self, record: dict) -> str:
        if not record.get("id"):
            record["id"] = str(uuid.uuid4())
        if not record.get("captured_at"):
            record["captured_at"] = datetime.now(timezone.utc).isoformat()

        tags_json = json.dumps(record.get("tags", []), ensure_ascii=False)

        try:
            self._conn.execute(
                """INSERT INTO captures (
                    id, capture_type, url, canonical_url, title, content,
                    content_hash, source_domain, tags, priority,
                    research_intent, user_notes, author, published_at,
                    raw_html_path, captured_at, file_slug, storage_date,
                    dedup_status, duplicate_of, markdown_path, json_path,
                    analysis_prompt_path, status
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    record["id"], record["capture_type"], record["url"],
                    record.get("canonical_url"), record["title"], record["content"],
                    record["content_hash"], record["source_domain"], tags_json,
                    record.get("priority", "normal"),
                    record.get("research_intent", ""), record.get("user_notes", ""),
                    record.get("author"), record.get("published_at"),
                    record.get("raw_html_path"), record["captured_at"],
                    record["file_slug"], record["storage_date"],
                    record.get("dedup_status", "unique"), record.get("duplicate_of"),
                    record.get("markdown_path"), record.get("json_path"),
                    record.get("analysis_prompt_path"), record.get("status", "raw_captured"),
                ),
            )
            self._conn.commit()
            return record["id"]
        except sqlite3.IntegrityError:
            self._conn.rollback()
            raise

    def find_by_canonical_url(self, canonical_url: str) -> dict | None:
        if not canonical_url:
            return None
        row = self._conn.execute(
            "SELECT * FROM captures WHERE canonical_url = ? ORDER BY captured_at DESC LIMIT 1",
            (canonical_url,),
        ).fetchone()
        return dict(row) if row else None

    def find_by_content_hash(self, content_hash: str) -> dict | None:
        if not content_hash:
            return None
        row = self._conn.execute(
            "SELECT * FROM captures WHERE content_hash = ? LIMIT 1",
            (content_hash,),
        ).fetchone()
        return dict(row) if row else None

    def fuzzy_match(self, title: str, source_domain: str, storage_date: str) -> dict | None:
        """Level 3 dedup: approximate title + domain + date match."""
        row = self._conn.execute(
            """SELECT * FROM captures
               WHERE source_domain = ? AND storage_date = ? AND title LIKE ?
               LIMIT 1""",
            (source_domain, storage_date, f"%{title[:50]}%"),
        ).fetchone()
        return dict(row) if row else None

    def get_by_id(self, capture_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM captures WHERE id = ?", (capture_id,)
        ).fetchone()
        return dict(row) if row else None

    def find_recent(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM captures ORDER BY captured_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def update_analysis_prompt_path(self, capture_id: str, path: str):
        self._conn.execute(
            "UPDATE captures SET analysis_prompt_path = ? WHERE id = ?",
            (path, capture_id),
        )
        self._conn.commit()

    def count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM captures").fetchone()[0]

    def close(self):
        self._conn.close()
