"""Immutable dataclass models for capture records."""

from dataclasses import dataclass, field
from typing import Literal


CaptureType = Literal["page", "selection", "link", "pdf", "image"]
Priority = Literal["normal", "high", "urgent"]
DedupStatus = Literal["unique", "duplicate", "fuzzy_warn"]


@dataclass(frozen=True)
class CaptureRecord:
    id: str | None = None
    capture_type: CaptureType = "page"
    url: str = ""
    canonical_url: str | None = None
    title: str = ""
    content: str = ""
    content_hash: str = ""
    source_domain: str = ""
    tags: tuple[str, ...] = ()
    priority: Priority = "normal"
    research_intent: str = ""
    user_notes: str = ""
    author: str | None = None
    published_at: str | None = None
    raw_html_path: str | None = None
    captured_at: str = ""
    file_slug: str = ""
    storage_date: str = ""
    dedup_status: DedupStatus = "unique"
    duplicate_of: str | None = None
    markdown_path: str | None = None
    json_path: str | None = None
    analysis_prompt_path: str | None = None
    status: str = "raw_captured"


@dataclass(frozen=True)
class Entity:
    id: int | None = None
    name: str = ""
    entity_type: str = ""
    market: str = ""
    ticker: str = ""
    canonical_name: str = ""


@dataclass(frozen=True)
class CaptureEntity:
    capture_id: str = ""
    entity_id: int = 0
    role: str = ""
    confidence: float = 0.0
    evidence: str = ""
