"""Three-level deduplication logic — pure functions, no I/O."""

from db import Database


def check_dedup(
    db: Database,
    url: str,
    canonical_url: str | None,
    content_hash: str,
    title: str,
    source_domain: str,
    storage_date: str,
) -> tuple[str, str | None, dict | None]:
    """
    Returns (dedup_status, duplicate_of_id, existing_record_or_None).
    Level 1: canonical_url match -> "duplicate"
    Level 2: content_hash match -> "duplicate"
    Level 3: title + domain + date fuzzy -> "fuzzy_warn"
    Otherwise: "unique"
    """

    # Level 1: canonical URL
    if canonical_url:
        existing = db.find_by_canonical_url(canonical_url)
        if existing:
            return ("duplicate", existing["id"], existing)

    # Level 2: content hash
    if content_hash:
        existing = db.find_by_content_hash(content_hash)
        if existing:
            return ("duplicate", existing["id"], existing)

    # Level 3: fuzzy match (title + domain + date)
    if title and source_domain and storage_date:
        existing = db.fuzzy_match(title, source_domain, storage_date)
        if existing:
            return ("fuzzy_warn", existing["id"], existing)

    return ("unique", None, None)
