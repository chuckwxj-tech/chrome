"""Pytest fixtures for Cloud Vault Capture tests."""

import os
import sys
import tempfile
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from db import Database


@pytest.fixture
def test_db_path():
    # ignore_cleanup_errors handles Windows SQLite WAL file cleanup
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        yield str(Path(tmp) / "test.db")


@pytest.fixture
def test_storage_root():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        yield tmp


@pytest.fixture
def test_config(test_db_path, test_storage_root, monkeypatch):
    monkeypatch.setenv("LOCAL_CAPTURE_TOKEN", "test-token-123")
    monkeypatch.setenv("DB_PATH", test_db_path)
    monkeypatch.setenv("STORAGE_ROOT", test_storage_root)
    monkeypatch.setenv("CORS_ORIGINS", "*")

    import config
    config._config = None
    return config.get_config()


@pytest.fixture
def db(test_config):
    database = Database(test_config.db_path)
    database.init_schema()
    yield database
    database.close()


@pytest.fixture
def client(test_config):
    from main import app

    # Override lifespan with direct DB initialization for testing
    db_inst = Database(test_config.db_path)
    db_inst.init_schema()
    app.state.db = db_inst

    from fastapi.testclient import TestClient
    tc = TestClient(app)
    yield tc
    db_inst.close()


@pytest.fixture
def auth_headers():
    return {"Authorization": "Bearer test-token-123"}


@pytest.fixture
def sample_page_data():
    return {
        "url": "https://example.com/article",
        "title": "AI Server Market Outlook 2026",
        "content": "The global AI server market is expected to grow significantly in 2026.",
        "content_hash": "a" * 64,
        "canonical_url": "https://example.com/article",
        "tags": ["AI服务器", "算力"],
        "priority": "high",
        "research_intent": "了解AI服务器市场趋势",
        "user_notes": "重要数据在第3段",
        "author": "Jane Researcher",
        "published_at": "2026-06-05T10:00:00Z",
    }


@pytest.fixture
def sample_selection_data():
    return {
        "url": "https://example.com/article",
        "title": "Selection from: AI Server Market Outlook",
        "content": "NVIDIA is launching CPO switches in 2026.",
        "content_hash": "b" * 64,
        "context_page_url": "https://example.com/article",
        "tags": ["CPO"],
        "priority": "normal",
    }
