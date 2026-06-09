"""Capture endpoints: POST /capture/page, /selection, /link, /pdf, /image."""

import hashlib
import sqlite3
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Request
from middleware import verify_token
from schemas import (
    PageCaptureRequest,
    SelectionCaptureRequest,
    LinkCaptureRequest,
    PdfCaptureRequest,
    ImageCaptureRequest,
    CaptureResponse,
)
from services.dedup import check_dedup
from services.file_writer import write_all_files

router = APIRouter(tags=["capture"])


def _get_db(request: Request):
    return request.app.state.db


def _extract_domain(url: str) -> str:
    from urllib.parse import urlparse

    try:
        return urlparse(url).netloc or "unknown"
    except Exception:
        return "unknown"


# ── Shared capture save flow ────────────────────────────────────────


def _save_capture(
    db,
    record: dict,
    canonical_url: str | None,
    raw_html: str | None = None,
    duplicate_message: str = "Content already captured",
) -> CaptureResponse:
    """Dedup → write files → insert DB. Returns CaptureResponse."""
    domain = record.get("source_domain", "")
    title = record.get("title", "")
    url = record.get("url", "")
    content_hash = record.get("content_hash", "")

    storage_date_approx = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    dedup_status, dup_id, dup_record = check_dedup(
        db, url, canonical_url, content_hash, title, domain, storage_date_approx,
    )

    if dedup_status == "duplicate" and dup_record:
        return CaptureResponse(
            success=True,
            id=dup_record["id"],
            file_slug=dup_record.get("file_slug"),
            dedup_status="duplicate",
            message=duplicate_message,
            duplicate_of=dup_id,
            existing_paths={
                "markdown": dup_record.get("markdown_path", ""),
                "json": dup_record.get("json_path", ""),
            },
        )

    capture_id = str(uuid.uuid4())
    record["id"] = capture_id
    record["dedup_status"] = dedup_status
    record["duplicate_of"] = dup_id

    record = write_all_files(record, raw_html=raw_html)

    try:
        db.insert_capture(record)
    except sqlite3.IntegrityError:
        # Race condition: another request inserted between check and insert.
        # Re-read the duplicate and return it.
        if canonical_url:
            dup = db.find_by_canonical_url(canonical_url)
        else:
            dup = db.find_by_content_hash(content_hash)
        if dup:
            return CaptureResponse(
                success=True,
                id=dup["id"],
                file_slug=dup.get("file_slug"),
                dedup_status="duplicate",
                message=duplicate_message,
                duplicate_of=dup["id"],
            )
        raise

    return CaptureResponse(
        success=True,
        id=capture_id,
        file_slug=record["file_slug"],
        dedup_status=dedup_status,
        message="Capture saved"
        if dedup_status != "fuzzy_warn"
        else "Capture saved (possible duplicate)",
    )


# ── POST /capture/page ──────────────────────────────────────────────


@router.post("/page", response_model=CaptureResponse, status_code=201)
async def capture_page(
    body: PageCaptureRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    domain = _extract_domain(body.url)

    record = {
        "capture_type": "page",
        "url": body.url,
        "canonical_url": body.canonical_url,
        "title": body.title,
        "content": body.content,
        "content_hash": body.content_hash,
        "source_domain": domain,
        "tags": body.tags,
        "priority": body.priority,
        "research_intent": body.research_intent,
        "user_notes": body.user_notes,
        "author": body.author,
        "published_at": body.published_at,
    }

    return _save_capture(db, record, body.canonical_url, raw_html=body.raw_html)


# ── POST /capture/selection ─────────────────────────────────────────


@router.post("/selection", response_model=CaptureResponse, status_code=201)
async def capture_selection(
    body: SelectionCaptureRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    domain = _extract_domain(body.url)
    title = body.title or f"Selection from: {body.url}"

    record = {
        "capture_type": "selection",
        "url": body.context_page_url or body.url,
        "canonical_url": None,
        "title": title,
        "content": body.content,
        "content_hash": body.content_hash,
        "source_domain": domain,
        "tags": body.tags,
        "priority": body.priority,
        "research_intent": body.research_intent,
        "user_notes": body.user_notes,
        "author": None,
        "published_at": None,
    }

    return _save_capture(
        db, record, None, raw_html=body.selection_html,
        duplicate_message="Selection already captured",
    )


# ── POST /capture/link ──────────────────────────────────────────────


@router.post("/link", response_model=CaptureResponse, status_code=201)
async def capture_link(
    body: LinkCaptureRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    domain = _extract_domain(body.url)
    title = body.title or body.link_text or f"Link: {body.url}"
    content_hash = hashlib.sha256(body.url.encode()).hexdigest()

    record = {
        "capture_type": "link",
        "url": body.url,
        "canonical_url": body.url,
        "title": title,
        "content": (
            f"Link: {body.url}\n"
            f"Link Text: {body.link_text or '_none_'}\n"
            f"Context Page: {body.context_page_url or '_none_'}\n"
            f"Context Title: {body.context_page_title or '_none_'}"
        ),
        "content_hash": content_hash,
        "source_domain": domain,
        "tags": body.tags,
        "priority": body.priority,
        "research_intent": body.research_intent,
        "user_notes": body.user_notes,
    }

    return _save_capture(
        db, record, body.url, duplicate_message="Link already captured",
    )


# ── POST /capture/pdf ───────────────────────────────────────────────


@router.post("/pdf", response_model=CaptureResponse, status_code=201)
async def capture_pdf(
    body: PdfCaptureRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    domain = _extract_domain(body.url)
    title = body.title or body.filename or f"PDF: {body.url}"
    content_hash = body.content_hash or hashlib.sha256(body.url.encode()).hexdigest()

    record = {
        "capture_type": "pdf",
        "url": body.url,
        "canonical_url": body.url,
        "title": title,
        "content": f"PDF URL: {body.url}\nFilename: {body.filename or '_unknown_'}",
        "content_hash": content_hash,
        "source_domain": domain,
        "tags": body.tags,
        "priority": body.priority,
        "research_intent": body.research_intent,
        "user_notes": body.user_notes,
    }

    return _save_capture(
        db, record, body.url, duplicate_message="PDF already captured",
    )


# ── POST /capture/image ─────────────────────────────────────────────


@router.post("/image", response_model=CaptureResponse, status_code=201)
async def capture_image(
    body: ImageCaptureRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    domain = _extract_domain(body.url)
    title = body.title or body.alt_text or f"Image: {body.url}"
    content_hash = body.content_hash or hashlib.sha256(body.url.encode()).hexdigest()

    record = {
        "capture_type": "image",
        "url": body.url,
        "canonical_url": body.url,
        "title": title,
        "content": (
            f"Image URL: {body.url}\n"
            f"Alt Text: {body.alt_text or '_none_'}\n"
            f"Page URL: {body.page_url or '_none_'}"
        ),
        "content_hash": content_hash,
        "source_domain": domain,
        "tags": body.tags,
        "priority": body.priority,
        "research_intent": body.research_intent,
        "user_notes": body.user_notes,
    }

    return _save_capture(
        db, record, body.url, duplicate_message="Image already captured",
    )
