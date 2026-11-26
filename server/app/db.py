"""SQLite storage. Message text is never stored. Accounts come from single sign-on."""

import hashlib
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .models import Flow, default_flow

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, flow TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_logins (
  state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
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
# Short, so that access removed in the sign-in provider ends here too within a working day.
SESSION_SECONDS = 12 * 3600
LOGIN_SECONDS = 10 * 60


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Database:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            self._drop_password_schema(c)
            c.executescript(SCHEMA)

    @staticmethod
    def _drop_password_schema(c):
        """The first release had password accounts. Replace those tables only while they are empty."""
        if "password" not in {row["name"] for row in c.execute("PRAGMA table_info(users)")}:
            return
        if c.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            raise RuntimeError("password accounts exist: migrate them to single sign-on by hand")
        for table in ("api_keys", "sessions", "usage", "users"):
            c.execute(f"DROP TABLE IF EXISTS {table}")

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

    def sign_in_user(self, subject: str, email: str) -> int:
        """Create the account on first sign-in; the provider's subject id is its identity."""
        self.run(
            "INSERT INTO users (sub, email, flow, created) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (sub) DO UPDATE SET email = excluded.email",
            subject,
            email.strip().lower(),
            default_flow().model_dump_json(),
            int(time.time()),
        )
        return self.one("SELECT id FROM users WHERE sub = ?", subject)["id"]

    def users_by_email(self, email: str) -> list:
        with self.connect() as c:
            return c.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchall()

    def all_users(self) -> list:
        with self.connect() as c:
            return c.execute("SELECT email, active FROM users ORDER BY email").fetchall()

    def start_login(self, state: str, verifier: str, nonce: str) -> None:
        self.run("DELETE FROM pending_logins WHERE expires < ?", int(time.time()))
        self.run(
            "INSERT INTO pending_logins (state_hash, verifier, nonce, expires) VALUES (?, ?, ?, ?)",
            sha256(state),
            verifier,
            nonce,
            int(time.time()) + LOGIN_SECONDS,
        )

    def take_login(self, state: str):
        """Single use: the row is removed as it is read."""
        with self.connect() as c:
            return c.execute(
                "DELETE FROM pending_logins WHERE state_hash = ? AND expires > ? RETURNING verifier, nonce",
                (sha256(state), int(time.time())),
            ).fetchone()

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
