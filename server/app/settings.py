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
    llm_model: str = _env("LLM_MODEL", "privacy-qwen3.6-35b-a3b")
    llm_daily_limit: int = field(default_factory=lambda: int(os.environ.get("LLM_DAILY_LIMIT", "200")))
    # Generous, so a self-hosted model that has to wake up still works.
    llm_timeout: int = field(default_factory=lambda: int(os.environ.get("LLM_TIMEOUT", "75")))
    payment_url: str = _env("PAYMENT_URL")
    # Sign-in is single sign-on only.
    oidc_issuer: str = _env("OIDC_ISSUER", "https://auth.osmosis.page/application/o/freight/")
    oidc_client_id: str = _env("OIDC_CLIENT_ID")
    # Comma separated. A user must be in at least one of these; empty means nobody gets in.
    oidc_allowed_groups: str = _env("OIDC_ALLOWED_GROUPS", "freight,authentik Admins")

    @property
    def secure_cookies(self) -> bool:
        return self.base_url.startswith("https://")
