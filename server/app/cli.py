"""Account management (there is no public sign-up).

python -m app.cli create-user EMAIL     prints a generated password
python -m app.cli reset-password EMAIL  prints a new password and ends sessions
python -m app.cli activate EMAIL | deactivate EMAIL   (deactivated -> the extension gets HTTP 402)
"""

import secrets
import sqlite3
import sys

from .db import Database, hash_password
from .settings import Settings


def main(argv: list[str]) -> int:
    commands = ("create-user", "reset-password", "activate", "deactivate")
    if len(argv) != 2 or argv[0] not in commands:
        print(__doc__)
        return 2
    command, email = argv[0], argv[1].strip().lower()
    db = Database(Settings().database_path)
    password = secrets.token_urlsafe(15)
    if command == "create-user":
        try:
            db.create_user(email, password)
        except sqlite3.IntegrityError:
            print("user already exists")
            return 1
        print(f"created {email}\npassword: {password}")
        return 0
    user = db.user_by_email(email)
    if not user:
        print("no such user")
        return 1
    if command == "reset-password":
        db.run("UPDATE users SET password = ? WHERE id = ?", hash_password(password), user["id"])
        db.run("DELETE FROM sessions WHERE user_id = ?", user["id"])
        print(f"password: {password}")
    else:
        db.run("UPDATE users SET active = ? WHERE id = ?", int(command == "activate"), user["id"])
        print(f"{command}d {email}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
