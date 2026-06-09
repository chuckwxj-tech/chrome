def test_capture_selection_works(client, auth_headers, sample_selection_data):
    resp = client.post(
        "/capture/selection", json=sample_selection_data, headers=auth_headers
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True
    assert data["dedup_status"] == "unique"


def test_capture_selection_empty_rejected(client, auth_headers):
    """Empty content should get 422."""
    resp = client.post(
        "/capture/selection",
        json={
            "url": "https://example.com",
            "title": "test",
            "content": "",
            "content_hash": "a" * 64,
        },
        headers=auth_headers,
    )
    assert resp.status_code == 422


def test_selection_special_characters_survive(client, auth_headers):
    special = "CPU价格 ↑ 30%, 订单 → NVIDIA (台积电 & 三星)"
    body = {
        "url": "https://example.com",
        "title": "Test",
        "content": special,
        "content_hash": "e" * 64,
        "tags": ["半导体"],
        "priority": "urgent",
    }
    resp = client.post("/capture/selection", json=body, headers=auth_headers)
    assert resp.status_code == 201
