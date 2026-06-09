"""Frozen configuration from environment variables. Read once at startup."""

from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv
import os

load_dotenv()


@dataclass(frozen=True)
class Config:
    capture_token: str = field(
        default_factory=lambda: os.getenv("LOCAL_CAPTURE_TOKEN", "")
    )
    db_path: str = field(
        default_factory=lambda: os.getenv("DB_PATH", "data/captures.db")
    )
    storage_root: str = field(
        default_factory=lambda: os.getenv(
            "STORAGE_ROOT", "/srv/cloud-vault/inbox/browser-capture"
        )
    )
    host: str = field(
        default_factory=lambda: os.getenv("HOST", "0.0.0.0")
    )
    port: int = field(
        default_factory=lambda: int(os.getenv("PORT", "8000"))
    )
    log_level: str = field(
        default_factory=lambda: os.getenv("LOG_LEVEL", "INFO")
    )
    max_content_bytes: int = 1_000_000  # 1MB limit for raw HTML


_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config
