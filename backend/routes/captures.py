"""Captures endpoints: GET /captures/recent, POST /captures/{id}/build-analysis-prompt."""

import json
from fastapi import APIRouter, Depends, Request, Query, HTTPException, status
from middleware import verify_token
from schemas import (
    RecentCapturesResponse,
    RecentCaptureItem,
    AnalysisPromptResponse,
    AttachEntitiesRequest,
    CaptureEntitiesResponse,
    CaptureEntityItem,
    AnalysisResultRequest,
    AnalysisResultResponse,
)
from services.analysis_prompt import write_analysis_prompt
from services.analysis_result import parse_entities_from_analysis

router = APIRouter(tags=["captures"])


def _get_db(request: Request):
    return request.app.state.db


@router.get("/recent", response_model=RecentCapturesResponse)
async def get_recent(
    limit: int = Query(20, ge=1, le=100),
    request: Request = None,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    rows = db.find_recent(limit)
    captures = [
        RecentCaptureItem(
            id=r["id"],
            capture_type=r["capture_type"],
            title=r["title"],
            url=r["url"],
            source_domain=r["source_domain"],
            tags=json.loads(r["tags"]) if isinstance(r["tags"], str) else r["tags"],
            priority=r["priority"],
            captured_at=r["captured_at"],
            file_slug=r["file_slug"],
            dedup_status=r["dedup_status"],
        )
        for r in rows
    ]
    return RecentCapturesResponse(captures=captures, total=db.count())


@router.post("/{capture_id}/build-analysis-prompt", response_model=AnalysisPromptResponse)
async def build_analysis_prompt(
    capture_id: str,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    capture = db.get_by_id(capture_id)
    if not capture:
        raise HTTPException(status_code=404, detail="Capture not found")

    # Parse tags from JSON string
    if isinstance(capture.get("tags"), str):
        capture["tags"] = json.loads(capture["tags"])

    file_path = write_analysis_prompt(capture)
    db.update_analysis_prompt_path(capture_id, file_path)

    return AnalysisPromptResponse(
        success=True,
        id=capture_id,
        file_path=file_path,
        message="Analysis prompt generated",
    )


@router.post("/{capture_id}/entities", response_model=CaptureEntitiesResponse)
async def attach_entities(
    capture_id: str,
    body: AttachEntitiesRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    """Attach structured entity mappings (公司/ticker/市场) to a capture.

    Designed as the write-back target for the analysis step: after the LLM
    fills in the 相关公司映射 section, post the structured result here so
    mentions become queryable instead of living only in a markdown file.
    """
    db = _get_db(request)
    if not db.get_by_id(capture_id):
        raise HTTPException(status_code=404, detail="Capture not found")

    for ent in body.entities:
        entity_id = db.upsert_entity(
            name=ent.name,
            entity_type=ent.entity_type,
            market=ent.market,
            ticker=ent.ticker,
            canonical_name=ent.canonical_name,
        )
        db.link_capture_entity(
            capture_id,
            entity_id,
            role=ent.role,
            confidence=ent.confidence,
            evidence=ent.evidence,
        )

    return CaptureEntitiesResponse(
        capture_id=capture_id,
        entities=[
            CaptureEntityItem(**row)
            for row in db.get_entities_for_capture(capture_id)
        ],
    )


@router.post("/{capture_id}/analysis-result", response_model=AnalysisResultResponse)
async def submit_analysis_result(
    capture_id: str,
    body: AnalysisResultRequest,
    request: Request,
    token: str = Depends(verify_token),
):
    """Ingest a full LLM analysis: archive it, extract the entities JSON
    block into the entities tables, and advance status to 'analyzed'.

    This closes the loop started by build-analysis-prompt — paste the LLM's
    whole markdown answer here and the 相关公司映射 becomes queryable.
    """
    db = _get_db(request)
    capture = db.get_by_id(capture_id)
    if not capture:
        raise HTTPException(status_code=404, detail="Capture not found")

    try:
        entities = parse_entities_from_analysis(body.analysis_markdown)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Could not parse entities from analysis: {e}",
        )

    # Archive the analysis next to the capture's other files
    from pathlib import Path
    from config import get_config

    date_dir = Path(get_config().storage_root) / capture["storage_date"]
    date_dir.mkdir(parents=True, exist_ok=True)
    analysis_path = date_dir / f"{capture['file_slug']}.analysis.md"
    analysis_path.write_text(body.analysis_markdown, encoding="utf-8")

    for ent in entities:
        entity_id = db.upsert_entity(
            name=ent["name"],
            entity_type=ent["entity_type"],
            market=ent["market"],
            ticker=ent["ticker"],
            canonical_name=ent["canonical_name"],
        )
        db.link_capture_entity(
            capture_id,
            entity_id,
            role=ent["role"],
            confidence=ent["confidence"],
            evidence=ent["evidence"],
        )

    db.update_status(capture_id, "analyzed")

    return AnalysisResultResponse(
        capture_id=capture_id,
        entities_extracted=len(entities),
        analysis_path=str(analysis_path),
        entities=[
            CaptureEntityItem(**row)
            for row in db.get_entities_for_capture(capture_id)
        ],
    )


@router.get("/{capture_id}/entities", response_model=CaptureEntitiesResponse)
async def get_capture_entities(
    capture_id: str,
    request: Request,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    if not db.get_by_id(capture_id):
        raise HTTPException(status_code=404, detail="Capture not found")

    return CaptureEntitiesResponse(
        capture_id=capture_id,
        entities=[
            CaptureEntityItem(**row)
            for row in db.get_entities_for_capture(capture_id)
        ],
    )
