"""Pydantic request/response schemas for API validation."""

import re
from typing import Literal
from pydantic import BaseModel, Field, field_validator


# ── Shared validators ──────────────────────────────────────────────

def _validate_http_url(v: str) -> str:
    if not re.match(r"^https?://", v):
        raise ValueError("URL must start with http:// or https://")
    return v


def _validate_content_hash(v: str) -> str:
    """Accept empty or 64-char hex; reject obviously malformed hashes."""
    if v and not re.fullmatch(r"[a-f0-9]{64}", v):
        raise ValueError("content_hash must be 64-char hex (sha-256)")
    return v


# ── Request schemas ───────────────────────────────────────────────

class PageCaptureRequest(BaseModel):
    url: str
    title: str
    content: str = Field(min_length=1)
    content_hash: str
    canonical_url: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)
    priority: Literal["normal", "high", "urgent"] = "normal"
    research_intent: str = ""
    user_notes: str = ""
    raw_html: str | None = None
    author: str | None = None
    published_at: str | None = None

    @field_validator("url")
    @classmethod
    def url_must_be_http(cls, v: str) -> str:
        return _validate_http_url(v)

    @field_validator("content_hash")
    @classmethod
    def hash_must_be_valid(cls, v: str) -> str:
        return _validate_content_hash(v)


class SelectionCaptureRequest(BaseModel):
    url: str
    title: str
    content: str = Field(min_length=1)
    content_hash: str
    context_page_url: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)
    priority: Literal["normal", "high", "urgent"] = "normal"
    research_intent: str = ""
    user_notes: str = ""
    selection_html: str | None = None

    @field_validator("url")
    @classmethod
    def url_must_be_http(cls, v: str) -> str:
        return _validate_http_url(v)

    @field_validator("content_hash")
    @classmethod
    def hash_must_be_valid(cls, v: str) -> str:
        return _validate_content_hash(v)


class LinkCaptureRequest(BaseModel):
    url: str
    title: str = ""
    link_text: str = ""
    context_page_url: str | None = None
    context_page_title: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)
    priority: Literal["normal", "high", "urgent"] = "normal"
    research_intent: str = ""
    user_notes: str = ""

    @field_validator("url")
    @classmethod
    def url_must_be_http(cls, v: str) -> str:
        return _validate_http_url(v)


class ImageCaptureRequest(BaseModel):
    url: str
    title: str = ""
    alt_text: str = ""
    page_url: str | None = None
    content_hash: str = ""
    tags: list[str] = Field(default_factory=list, max_length=10)
    priority: Literal["normal", "high", "urgent"] = "normal"
    research_intent: str = ""
    user_notes: str = ""

    @field_validator("url")
    @classmethod
    def url_must_be_http(cls, v: str) -> str:
        return _validate_http_url(v)

    @field_validator("content_hash")
    @classmethod
    def hash_must_be_valid(cls, v: str) -> str:
        return _validate_content_hash(v)


class PdfCaptureRequest(BaseModel):
    url: str
    title: str = ""
    filename: str | None = None
    content_hash: str = ""
    tags: list[str] = Field(default_factory=list, max_length=10)
    priority: Literal["normal", "high", "urgent"] = "normal"
    research_intent: str = ""
    user_notes: str = ""

    @field_validator("url")
    @classmethod
    def url_must_be_http(cls, v: str) -> str:
        return _validate_http_url(v)

    @field_validator("content_hash")
    @classmethod
    def hash_must_be_valid(cls, v: str) -> str:
        return _validate_content_hash(v)


# ── Response schemas ──────────────────────────────────────────────

class CaptureResponse(BaseModel):
    success: bool
    id: str | None = None
    file_slug: str | None = None
    dedup_status: Literal["unique", "duplicate", "fuzzy_warn"] = "unique"
    message: str = ""
    duplicate_of: str | None = None
    existing_paths: dict[str, str] | None = None


class RecentCaptureItem(BaseModel):
    id: str
    capture_type: str
    title: str
    url: str
    source_domain: str
    tags: list[str]
    priority: str
    captured_at: str
    file_slug: str
    dedup_status: str


class RecentCapturesResponse(BaseModel):
    captures: list[RecentCaptureItem]
    total: int


class AnalysisPromptResponse(BaseModel):
    success: bool
    id: str
    file_path: str
    message: str = ""


class ErrorResponse(BaseModel):
    success: bool = False
    error: str
    detail: str | None = None
