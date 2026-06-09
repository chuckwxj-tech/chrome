import hashlib
from services.dedup import check_dedup


def test_unique_returns_unique(db):
    status, dup_id, _ = check_dedup(
        db, "https://new.example.com", "https://new.example.com",
        "hash-new", "New Title", "example.com", "2026-06-09"
    )
    assert status == "unique"
    assert dup_id is None


def test_canonical_url_match(db):
    # Insert a record
    db.insert_capture({
        "capture_type": "page",
        "url": "https://example.com",
        "canonical_url": "https://example.com/canonical",
        "title": "Test",
        "content": "test",
        "content_hash": "hash-1",
        "source_domain": "example.com",
        "captured_at": "2026-06-09T12:00:00Z",
        "file_slug": "cap_20260609_120000_test",
        "storage_date": "2026-06-09",
    })

    status, dup_id, _ = check_dedup(
        db, "https://example.com/other", "https://example.com/canonical",
        "hash-other", "Other Title", "example.com", "2026-06-09"
    )
    assert status == "duplicate"
    assert dup_id is not None


def test_content_hash_match(db):
    db.insert_capture({
        "capture_type": "page",
        "url": "https://example.com/page1",
        "canonical_url": None,
        "title": "Original",
        "content": "original content",
        "content_hash": "hash-same",
        "source_domain": "example.com",
        "captured_at": "2026-06-09T12:00:00Z",
        "file_slug": "cap_20260609_120000_original",
        "storage_date": "2026-06-09",
    })

    status, dup_id, _ = check_dedup(
        db, "https://example.com/page2", None,
        "hash-same", "Different Title", "other.com", "2026-06-09"
    )
    assert status == "duplicate"
    assert dup_id is not None


def test_fuzzy_match(db):
    # Insert a record with title
    db.insert_capture({
        "capture_type": "page",
        "url": "https://example.com/ai-report",
        "canonical_url": None,
        "title": "AI Server Market Analysis 2026",
        "content": "market analysis content",
        "content_hash": "hash-fuzzy-1",
        "source_domain": "example.com",
        "captured_at": "2026-06-09T12:00:00Z",
        "file_slug": "cap_20260609_120000_ai-server",
        "storage_date": "2026-06-09",
    })

    # Similar title, same domain, same date
    status, dup_id, _ = check_dedup(
        db, "https://example.com/ai-report-v2", None,
        "hash-fuzzy-2", "AI Server Market", "example.com", "2026-06-09"
    )
    assert status == "fuzzy_warn"
    assert dup_id is not None
