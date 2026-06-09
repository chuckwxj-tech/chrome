def test_capture_link_works(client, auth_headers):
    body = {
        "url": "https://example.com/report.pdf",
        "title": "Q2 Earnings Report",
        "link_text": "Earnings Report",
        "context_page_url": "https://example.com/ir",
    }
    resp = client.post("/capture/link", json=body, headers=auth_headers)
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True


def test_capture_link_duplicate(client, auth_headers):
    body = {
        "url": "https://unique.example.com/link1",
        "title": "Unique Link",
        "link_text": "Link",
    }
    r1 = client.post("/capture/link", json=body, headers=auth_headers)
    assert r1.status_code == 201

    r2 = client.post("/capture/link", json=body, headers=auth_headers)
    assert r2.json()["dedup_status"] == "duplicate"
