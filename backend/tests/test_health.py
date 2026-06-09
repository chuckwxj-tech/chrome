def test_health_returns_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "timestamp" in data
    assert "version" in data


def test_health_no_auth_required(client):
    """Health endpoint should be accessible without token."""
    resp = client.get("/health")
    assert resp.status_code == 200
