def test_no_token_returns_403(client):
    """Protected endpoints require Authorization header."""
    resp = client.post("/capture/page", json={"url": "https://example.com"})
    assert resp.status_code in (401, 403)


def test_invalid_token_returns_401(client):
    resp = client.post(
        "/capture/page",
        json={"url": "https://example.com"},
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert resp.status_code == 401


def test_valid_token_accepted(client, auth_headers, sample_page_data):
    resp = client.post(
        "/capture/page",
        json=sample_page_data,
        headers=auth_headers,
    )
    assert resp.status_code == 201
