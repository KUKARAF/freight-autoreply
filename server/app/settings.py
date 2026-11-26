"""All configuration comes from the environment, read once per app instance."""

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = ""):
    return field(default_factory=lambda: os.environ.get(name, default))


@dataclass
class Settings:
    database_path: str = _env("DATABASE_PATH", "data/app.db")
    base_url: str = _env("BASE_URL", "http://localhost:8000")
    llm_base_url: str = _env("LLM_BASE_URL", "https://litellm.osmosis.page/v1")
    llm_api_key: str = _env("LLM_API_KEY")
    llm_model: str = _env("LLM_MODEL", "qwen3.6-27b")
    llm_daily_limit: int = field(default_factory=lambda: int(os.environ.get("LLM_DAILY_LIMIT", "200")))
    # The default model runs on a machine that may need about 40 s to wake up.
    llm_timeout: int = field(default_factory=lambda: int(os.environ.get("LLM_TIMEOUT", "75")))
    payment_url: str = _env("PAYMENT_URL")

    @property
    def secure_cookies(self) -> bool:
        return self.base_url.startswith("https://")
