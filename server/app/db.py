"""SQLite storage. Message text is never stored."""

import hashlib
import hmac
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .models import Flow, default_flow

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, flow TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  llm_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
"""
SESSION_SECONDS = 14 * 24 * 3600


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt = bytes.fromhex(stored.split("$")[0])
    return hmac.compare_digest(hash_password(password, salt), stored)


class Database:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        try:
            with c:
                yield c
        finally:
            c.close()

    def one(self, sql: str, *args):
        with self.connect() as c:
            return c.execute(sql, args).fetchone()

    def run(self, sql: str, *args) -> int:
        with self.connect() as c:
            return c.execute(sql, args).rowcount

    def create_user(self, email: str, password: str) -> None:
        self.run(
            "INSERT INTO users (email, password, flow, created) VALUES (?, ?, ?, ?)",
            email.strip().lower(),
            hash_password(password),
            default_flow().model_dump_json(),
            int(time.time()),
        )

    def user_by_email(self, email: str):
        return self.one("SELECT * FROM users WHERE email = ?", email.strip().lower())

    def flow(self, user_id: int) -> Flow:
        return Flow.model_validate_json(self.one("SELECT flow FROM users WHERE id = ?", user_id)["flow"])

    def save_flow(self, user_id: int, flow: Flow) -> None:
        self.run("UPDATE users SET flow = ? WHERE id = ?", flow.model_dump_json(), user_id)

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        self.run("DELETE FROM sessions WHERE expires < ?", int(time.time()))
        self.run(
            "INSERT INTO sessions (hash, user_id, csrf, expires) VALUES (?, ?, ?, ?)",
            sha256(token),
            user_id,
            secrets.token_urlsafe(24),
            int(time.time()) + SESSION_SECONDS,
        )
        return token

    def session(self, token: str):
        return self.one(
            "SELECT users.*, sessions.csrf, sessions.hash AS session_hash FROM sessions "
            "JOIN users ON users.id = sessions.user_id WHERE sessions.hash = ? AND expires > ?",
            sha256(token),
            int(time.time()),
        )

    def create_api_key(self, user_id: int) -> str:
        """One key per user: creating a new one revokes the old one."""
        key = f"far_{secrets.token_urlsafe(32)}"
        self.run("DELETE FROM api_keys WHERE user_id = ?", user_id)
        self.run(
            "INSERT INTO api_keys (user_id, hash, prefix, created) VALUES (?, ?, ?, ?)",
            user_id,
            sha256(key),
            key[:10],
            int(time.time()),
        )
        return key

    def api_key(self, user_id: int):
        return self.one("SELECT prefix, last_used FROM api_keys WHERE user_id = ?", user_id)

    def user_by_api_key(self, key: str):
        user = self.one(
            "SELECT users.* FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE hash = ?",
            sha256(key),
        )
        if user:
            self.run("UPDATE api_keys SET last_used = ? WHERE user_id = ?", int(time.time()), user["id"])
        return user

    def take_llm_call(self, user_id: int, limit: int) -> bool:
        """Atomically count one AI call against today's cap."""
        if limit <= 0:
            return False
        return (
            self.run(
                "INSERT INTO usage (user_id, day, llm_calls) VALUES (?, ?, 1) "
                "ON CONFLICT (user_id, day) DO UPDATE SET llm_calls = llm_calls + 1 WHERE llm_calls < ?",
                user_id,
                datetime.now(UTC).date().isoformat(),
                limit,
            )
            == 1
        )

    def llm_calls_today(self, user_id: int) -> int:
        row = self.one(
            "SELECT llm_calls FROM usage WHERE user_id = ? AND day = ?",
            user_id,
            datetime.now(UTC).date().isoformat(),
        )
        return row["llm_calls"] if row else 0
