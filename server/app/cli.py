"""Account management. Accounts are created by signing in through single sign-on.

python -m app.cli list
python -m app.cli activate EMAIL | deactivate EMAIL   (deactivated -> the extension gets HTTP 402)
"""

import sys

from .db import Database
from .settings import Settings


def main(argv: list[str]) -> int:
    db = Database(Settings().database_path)
    if argv == ["list"]:
        for user in db.all_users():
            print(user["email"], "active" if user["active"] else "paused")
        return 0
    if len(argv) != 2 or argv[0] not in ("activate", "deactivate"):
        print(__doc__)
        return 2
    command, email = argv
    users = db.users_by_email(email)
    if not users:
        print("no such user (they must sign in once first)")
        return 1
    for user in users:
        db.run("UPDATE users SET active = ? WHERE id = ?", int(command == "activate"), user["id"])
    print(f"{command}d {email.strip().lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
