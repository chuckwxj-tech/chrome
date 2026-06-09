"""Captures endpoints: GET /captures/recent, POST /captures/{id}/build-analysis-prompt."""

import json
from fastapi import APIRouter, Depends, Request, Query, HTTPException, status
from middleware import verify_token
from schemas import RecentCapturesResponse, RecentCaptureItem, AnalysisPromptResponse
from services.analysis_prompt import write_analysis_prompt

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
