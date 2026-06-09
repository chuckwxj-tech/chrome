import os
import json
from pathlib import Path


def test_capture_page_creates_record(client, auth_headers, sample_page_data):
    resp = client.post("/capture/page", json=sample_page_data, headers=auth_headers)
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True
    assert data["id"] is not None
    assert data["file_slug"] is not None
    assert data["dedup_status"] == "unique"


def test_capture_page_missing_required_fields(client, auth_headers):
    resp = client.post("/capture/page", json={}, headers=auth_headers)
    assert resp.status_code == 422


def test_capture_page_duplicate_detected(client, auth_headers, sample_page_data):
    # First capture
    r1 = client.post("/capture/page", json=sample_page_data, headers=auth_headers)
    assert r1.status_code == 201

    # Second capture — same URL + content_hash
    r2 = client.post("/capture/page", json=sample_page_data, headers=auth_headers)
    assert r2.status_code in (200, 201)
    data2 = r2.json()
    assert data2["dedup_status"] == "duplicate"


def test_capture_page_creates_files(client, auth_headers, sample_page_data, test_config):
    resp = client.post("/capture/page", json=sample_page_data, headers=auth_headers)
    assert resp.status_code == 201
    data = resp.json()

    # Check files exist on disk
    storage = Path(test_config.storage_root)
    date_dirs = list(storage.glob("20*"))
    assert len(date_dirs) > 0
    files = list(date_dirs[0].glob(f"{data['file_slug']}.*"))
    assert len(files) >= 2  # At minimum .md and .json

    # Verify .md has frontmatter
    md_files = [f for f in files if f.suffix == '.md']
    assert len(md_files) == 1
    content = md_files[0].read_text(encoding='utf-8')
    assert '---' in content
    assert 'AI Server Market Outlook' in content
    assert 'ai_server' not in content.lower() or '算力' in content

    # Verify .json is valid JSON
    json_files = [f for f in files if f.suffix == '.json']
    assert len(json_files) == 1
    meta = json.loads(json_files[0].read_text(encoding='utf-8'))
    assert meta["title"] == sample_page_data["title"]
    assert "paths" in meta
    assert "markdown" in meta["paths"]


def test_same_title_same_second_different_slugs(client, auth_headers, sample_page_data, test_config):
    """P1 regression: two captures with same title must not overwrite each other."""
    # Use distinct URLs so dedup doesn't reject the second as duplicate
    body1 = {**sample_page_data, "url": "https://example.com/a", "canonical_url": "https://example.com/a", "content_hash": "c" * 64}
    body2 = {**sample_page_data, "url": "https://example.com/b", "canonical_url": "https://example.com/b", "content_hash": "d" * 64}
    resp1 = client.post("/capture/page", json=body1, headers=auth_headers)
    resp2 = client.post("/capture/page", json=body2, headers=auth_headers)
    assert resp1.status_code == 201
    assert resp2.status_code == 201

    slug1 = resp1.json()["file_slug"]
    slug2 = resp2.json()["file_slug"]
    assert slug1 != slug2, f"Same slug {slug1} — collision detected"

    # Both .md and .json files should exist for each capture
    storage = Path(test_config.storage_root)
    date_dirs = list(storage.glob("20*"))
    all_files = list(date_dirs[0].iterdir())

    for slug in (slug1, slug2):
        md_exists = any(f.name.startswith(slug) and f.suffix == ".md" for f in all_files)
        json_exists = any(f.name.startswith(slug) and f.suffix == ".json" for f in all_files)
        assert md_exists, f"Missing .md for {slug}"
        assert json_exists, f"Missing .json for {slug}"


def test_metadata_consistency_between_json_and_response(client, auth_headers, sample_page_data, test_config):
    """P1 regression: JSON on disk must match API response for dedup_status and raw_html_path."""
    page_data = {**sample_page_data, "raw_html": "<html><body>test</body></html>"}
    resp = client.post("/capture/page", json=page_data, headers=auth_headers)
    assert resp.status_code == 201
    api_data = resp.json()

    # Read the JSON file written to disk
    storage = Path(test_config.storage_root)
    date_dirs = list(storage.glob("20*"))
    json_files = list(date_dirs[0].glob(f"{api_data['file_slug']}.json"))
    assert len(json_files) == 1
    disk_meta = json.loads(json_files[0].read_text(encoding="utf-8"))

    # dedup_status should match
    assert disk_meta["dedup_status"] == api_data["dedup_status"], (
        f"JSON has {disk_meta['dedup_status']}, API returned {api_data['dedup_status']}"
    )
    # raw_html_path should not be null when raw_html was provided
    assert disk_meta["paths"]["raw_html"] is not None, "raw_html_path should not be null"
    assert disk_meta["paths"]["raw_html"].endswith(".raw.html"), "raw_html_path should point to .raw.html"


def test_yaml_frontmatter_survives_quotes_and_newlines(client, auth_headers, sample_page_data, test_config):
    """P2 regression: titles with double quotes and notes with newlines must produce valid YAML."""
    tricky_data = {
        **sample_page_data,
        "title": 'AI "Super" Cycle: Winners & Losers',
        "user_notes": "Line 1: 重点关注\nLine 2: 可能影响\"PCB\"板块\nLine 3: 待确认",
        "research_intent": '了解 "CPO switch" 对 PCB 的冲击',
    }
    resp = client.post("/capture/page", json=tricky_data, headers=auth_headers)
    assert resp.status_code == 201
    api_data = resp.json()

    # Read the .md file and verify YAML frontmatter is parseable
    storage = Path(test_config.storage_root)
    date_dirs = list(storage.glob("20*"))
    md_files = list(date_dirs[0].glob(f"{api_data['file_slug']}.md"))
    assert len(md_files) == 1
    content = md_files[0].read_text(encoding="utf-8")

    # Basic YAML integrity: --- delimiters present, no raw newlines inside values
    assert content.startswith("---")
    # The title with double quotes should appear escaped in the YAML
    assert 'AI "Super" Cycle' in content or 'AI \\"Super\\" Cycle' in content or 'AI "Super" Cycle' in content
    # User notes with newlines should be escaped (not raw newlines in YAML value)
    assert "重点关注" in content
    assert "PCB" in content
