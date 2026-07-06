"""Tests for entity write-back and stats endpoints."""


def _create_capture(client, auth_headers, sample_page_data, suffix=""):
    body = dict(sample_page_data)
    if suffix:
        body["url"] = f"https://example.com/article-{suffix}"
        body["canonical_url"] = body["url"]
        body["content_hash"] = ("c" * 64 + suffix)[-64:]
    resp = client.post("/capture/page", json=body, headers=auth_headers)
    assert resp.status_code == 201
    return resp.json()["id"]


ENTITIES_PAYLOAD = {
    "entities": [
        {
            "name": "NVIDIA",
            "entity_type": "company",
            "market": "美股",
            "ticker": "NVDA",
            "role": "subject",
            "confidence": 0.95,
            "evidence": "正文直接讨论 NVIDIA CPO 交换机",
        },
        {
            "name": "中际旭创",
            "entity_type": "company",
            "market": "A股",
            "ticker": "300308",
            "role": "supplier",
            "confidence": 0.6,
        },
    ]
}


def test_attach_entities_and_read_back(client, auth_headers, sample_page_data):
    capture_id = _create_capture(client, auth_headers, sample_page_data)

    resp = client.post(
        f"/captures/{capture_id}/entities",
        json=ENTITIES_PAYLOAD,
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["capture_id"] == capture_id
    names = {e["name"] for e in data["entities"]}
    assert names == {"NVIDIA", "中际旭创"}
    nvda = next(e for e in data["entities"] if e["name"] == "NVIDIA")
    assert nvda["ticker"] == "NVDA"
    assert nvda["confidence"] == 0.95

    # GET returns the same set
    resp = client.get(f"/captures/{capture_id}/entities", headers=auth_headers)
    assert resp.status_code == 200
    assert len(resp.json()["entities"]) == 2


def test_attach_entities_404_for_unknown_capture(client, auth_headers):
    resp = client.post(
        "/captures/no-such-id/entities",
        json=ENTITIES_PAYLOAD,
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_attach_entities_requires_auth(client, sample_page_data, auth_headers):
    capture_id = _create_capture(client, auth_headers, sample_page_data)
    resp = client.post(f"/captures/{capture_id}/entities", json=ENTITIES_PAYLOAD)
    assert resp.status_code in (401, 403)


def test_reattach_updates_link_not_duplicates(client, auth_headers, sample_page_data):
    capture_id = _create_capture(client, auth_headers, sample_page_data)
    client.post(
        f"/captures/{capture_id}/entities", json=ENTITIES_PAYLOAD, headers=auth_headers
    )

    # Re-post the same entity with a revised confidence
    revised = {
        "entities": [
            {"name": "NVIDIA", "role": "subject", "confidence": 0.5}
        ]
    }
    resp = client.post(
        f"/captures/{capture_id}/entities", json=revised, headers=auth_headers
    )
    assert resp.status_code == 200
    entities = resp.json()["entities"]
    nvda_rows = [e for e in entities if e["name"] == "NVIDIA"]
    assert len(nvda_rows) == 1
    assert nvda_rows[0]["confidence"] == 0.5
    # Fields not resent must survive the upsert (None never overwrites)
    assert nvda_rows[0]["ticker"] == "NVDA"


def test_entity_stats_counts_mentions(client, auth_headers, sample_page_data):
    id_a = _create_capture(client, auth_headers, sample_page_data)
    id_b = _create_capture(client, auth_headers, sample_page_data, suffix="2")

    for cid in (id_a, id_b):
        client.post(
            f"/captures/{cid}/entities",
            json={"entities": [{"name": "NVIDIA", "ticker": "NVDA"}]},
            headers=auth_headers,
        )
    client.post(
        f"/captures/{id_a}/entities",
        json={"entities": [{"name": "中际旭创", "market": "A股"}]},
        headers=auth_headers,
    )

    resp = client.get("/entities/stats", headers=auth_headers)
    assert resp.status_code == 200
    entities = resp.json()["entities"]
    assert entities[0]["name"] == "NVIDIA"
    assert entities[0]["mention_count"] == 2
    assert entities[1]["name"] == "中际旭创"
    assert entities[1]["mention_count"] == 1
    assert entities[0]["last_mentioned_at"]

    # since filter in the future excludes everything
    resp = client.get("/entities/stats?since=2099-01-01", headers=auth_headers)
    assert resp.json()["entities"] == []
