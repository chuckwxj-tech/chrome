"""Tests for POST /capture/batch (bulk bookmark export)."""


def _items(n=3, prefix="tw"):
    return [
        {
            "url": f"https://x.com/user/status/{prefix}{i}",
            "title": f"@analyst: tweet {i}",
            "content": f"CPO 交换机放量观察，第 {i} 条",
            "author": "@analyst",
            "published_at": "2026-07-01T08:00:00Z",
            "tags": ["X书签"],
        }
        for i in range(n)
    ]


def test_batch_ingests_all(client, auth_headers):
    resp = client.post(
        "/capture/batch",
        json={"items": _items(3), "source": "x_bookmarks"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["total"] == 3
    assert data["unique"] == 3
    assert data["duplicate"] == 0
    assert data["failed"] == 0
    assert all(r["success"] for r in data["results"])
    assert all(r["id"] for r in data["results"])


def test_batch_reexport_is_incremental(client, auth_headers):
    client.post(
        "/capture/batch", json={"items": _items(3)}, headers=auth_headers
    )
    # Re-export: same 3 plus 2 new
    resp = client.post(
        "/capture/batch",
        json={"items": _items(3) + _items(2, prefix="new")},
        headers=auth_headers,
    )
    data = resp.json()
    assert data["duplicate"] == 3
    assert data["unique"] == 2


def test_batch_same_text_different_posts_not_deduped(client, auth_headers):
    # Two different tweets with identical short text must both be stored
    items = [
        {"url": "https://x.com/a/status/1", "content": "gm"},
        {"url": "https://x.com/b/status/2", "content": "gm"},
    ]
    resp = client.post(
        "/capture/batch", json={"items": items}, headers=auth_headers
    )
    assert resp.json()["unique"] == 2


def test_batch_stores_content_and_type(client, auth_headers):
    client.post(
        "/capture/batch",
        json={"items": _items(1), "source": "x_bookmarks"},
        headers=auth_headers,
    )
    recent = client.get("/captures/recent?limit=1", headers=auth_headers).json()
    item = recent["captures"][0]
    assert item["capture_type"] == "post"
    assert item["source_domain"] == "x.com"
    assert "X书签" in item["tags"]


def test_batch_rejects_bad_url(client, auth_headers):
    resp = client.post(
        "/capture/batch",
        json={"items": [{"url": "javascript:alert(1)"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 422


def test_batch_requires_auth(client):
    resp = client.post("/capture/batch", json={"items": _items(1)})
    assert resp.status_code in (401, 403)


def test_batch_size_limit(client, auth_headers):
    resp = client.post(
        "/capture/batch", json={"items": _items(201)}, headers=auth_headers
    )
    assert resp.status_code == 422
