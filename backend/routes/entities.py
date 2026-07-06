"""Entities endpoints: GET /entities/stats — mention counts across captures."""

from fastapi import APIRouter, Depends, Request, Query
from middleware import verify_token
from schemas import EntityStatsResponse, EntityStatsItem

router = APIRouter(tags=["entities"])


def _get_db(request: Request):
    return request.app.state.db


@router.get("/stats", response_model=EntityStatsResponse)
async def entity_stats(
    limit: int = Query(50, ge=1, le=200),
    since: str | None = Query(
        None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Only count captures with storage_date >= this date",
    ),
    request: Request = None,
    token: str = Depends(verify_token),
):
    db = _get_db(request)
    rows = db.entity_mention_stats(limit=limit, since=since)
    return EntityStatsResponse(entities=[EntityStatsItem(**r) for r in rows])
