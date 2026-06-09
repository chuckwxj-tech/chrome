def test_recent_empty(client, auth_headers):
    resp = client.get("/captures/recent", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["captures"] == []
    assert data["total"] == 0


def test_recent_returns_items(client, auth_headers, sample_page_data):
    # Insert a capture
    client.post("/capture/page", json=sample_page_data, headers=auth_headers)

    resp = client.get("/captures/recent?limit=5", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["captures"]) >= 1
    assert data["total"] >= 1
    item = data["captures"][0]
    assert item["title"] == sample_page_data["title"]
    assert item["capture_type"] == "page"


def test_recent_respects_limit(client, auth_headers, sample_page_data):
    # Insert 3 captures with distinct canonical URLs to avoid dedup
    for i in range(3):
        body = {
            **sample_page_data,
            "url": f"https://example.com/{i}",
            "canonical_url": f"https://example.com/{i}",
            "content_hash": f"{i:064d}",
        }
        client.post("/capture/page", json=body, headers=auth_headers)

    resp = client.get("/captures/recent?limit=2", headers=auth_headers)
    assert len(resp.json()["captures"]) == 2
