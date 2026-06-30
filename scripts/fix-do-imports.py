#!/usr/bin/env python3
"""One-shot import path fixes after src/do module reorg."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DO = ROOT / "src" / "do"

MODULES = [
    "chat-channel",
    "user-connection",
    "user-directory",
    "bot-registry",
    "bot-connection",
    "bot-stream-connection",
    "channel-directory",
    "channel-fanout",
    "dm-directory",
    "invite-directory",
    "scheduler-probe",
]

MIGRATION_OLD = {
    "chat-channel": "chat-channel",
    "user-connection": "user-connection",
    "user-directory": "user-directory",
    "bot-registry": "bot-registry",
    "bot-connection": "bot-connection",
    "bot-stream-connection": "bot-stream-connection",
    "channel-directory": "channel-directory",
    "channel-fanout": "channel-fanout",
    "dm-directory": "dm-directory",
    "invite-directory": "invite-directory",
}


def patch_file(path: Path, replacements: list[tuple[str, str]]) -> bool:
    text = path.read_text()
    original = text
    for old, new in replacements:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text)
        return True
    return False


def fix_shared() -> None:
    for path in (DO / "shared").rglob("*.ts"):
        patch_file(
            path,
            [
                ('from "../contract/', 'from "../../contract/'),
                ('from "../errors"', 'from "../../errors"'),
                ('from "../ids/', 'from "../../ids/'),
            ],
        )


def fix_module_object(module: str) -> None:
    obj = DO / module / "object.ts"
    if not obj.exists():
        return
    reps: list[tuple[str, str]] = [
        ('from "../env"', 'from "../../env"'),
        ('from "../chat/', 'from "../../chat/'),
        ('from "../contract/', 'from "../../contract/'),
        ('from "../errors"', 'from "../../errors"'),
        ('from "../ids/', 'from "../../ids/'),
        ('from "../archive/', 'from "../../archive/'),
        ('from "../profile/', 'from "../../profile/'),
        ('from "../auth/', 'from "../../auth/'),
        ('from "../ws/', 'from "../../ws/'),
        ('from "./retry-backoff"', 'from "../shared/retry-backoff"'),
        ('from "./do-errors"', 'from "../shared/do-errors"'),
        ('from "./scheduler"', 'from "../shared/scheduler"'),
        ('from "./rpc-errors"', 'from "../shared/rpc-errors"'),
        ('from "./do-rpc"', 'from "../shared/do-rpc"'),
        ('from "./sql-migrations"', 'from "../shared/sql-migrations"'),
        ('from "./sql"', 'from "../shared/sql"'),
        ('from "./fanout-scheduler"', 'from "./fanout-scheduler"'),
    ]
    if module in MIGRATION_OLD:
        reps.append((f'from "./migrations/{MIGRATION_OLD[module]}"', 'from "./migrations"'))
    if module == "chat-channel":
        reps.extend(
            [
                ('from "./chat-channel/', 'from "./'),
                ('from "./bot-stream-connection"', 'from "../bot-stream-connection"'),
            ]
        )
    if module == "user-connection":
        reps.append(('from "./chat-channel"', 'from "../chat-channel"'))
    if module == "bot-connection":
        reps.append(('from "./bot-connection-stateful"', 'from "./stateful"'))
    patch_file(obj, reps)


def fix_migrations(module: str) -> None:
    mig = DO / module / "migrations.ts"
    if not mig.exists():
        return
    patch_file(
        mig,
        [
            ('from "../sql-migrations"', 'from "../shared/sql-migrations"'),
            ('from "../../archive/', 'from "../../../archive/'),
        ],
    )


def fix_chat_channel_children() -> None:
    for path in (DO / "chat-channel").rglob("*.ts"):
        if path.name in ("object.ts", "migrations.ts", "index.ts"):
            continue
        patch_file(
            path,
            [
                ('from "../do-rpc"', 'from "../shared/do-rpc"'),
                ('from "../../do-rpc"', 'from "../../shared/do-rpc"'),
            ],
        )


def fix_channel_fanout() -> None:
    patch_file(
        DO / "channel-fanout" / "fanout-scheduler.ts",
        [
            ('from "./retry-backoff"', 'from "../shared/retry-backoff"'),
            ('from "./scheduler"', 'from "../shared/scheduler"'),
        ],
    )


def fix_scheduler_probe() -> None:
    obj = DO / "scheduler-probe" / "object.ts"
    patch_file(
        obj,
        [
            ('from "../env"', 'from "../../env"'),
            ('from "./sql"', 'from "../shared/sql"'),
            ('from "./scheduler"', 'from "../shared/scheduler"'),
        ],
    )


def fix_outside_do() -> None:
    patterns = [
        ("src/do/migrations/chat-channel", "src/do/chat-channel/migrations"),
        ("src/do/migrations/user-connection", "src/do/user-connection/migrations"),
        ("src/do/migrations/user-directory", "src/do/user-directory/migrations"),
        ("src/do/migrations/bot-registry", "src/do/bot-registry/migrations"),
        ("src/do/migrations/bot-connection", "src/do/bot-connection/migrations"),
        ("src/do/migrations/bot-stream-connection", "src/do/bot-stream-connection/migrations"),
        ("src/do/migrations/channel-directory", "src/do/channel-directory/migrations"),
        ("src/do/migrations/channel-fanout", "src/do/channel-fanout/migrations"),
        ("src/do/migrations/dm-directory", "src/do/dm-directory/migrations"),
        ("src/do/migrations/invite-directory", "src/do/invite-directory/migrations"),
        ("../do/sql-migrations", "../do/shared/sql-migrations"),
        ("../../src/do/sql-migrations", "../../src/do/shared/sql-migrations"),
        ("../do/scheduler", "../do/shared/scheduler"),
        ("../do/retry-backoff", "../do/shared/retry-backoff"),
        ("../do/fanout-scheduler", "../do/channel-fanout/fanout-scheduler"),
        ("../../src/do/fanout-scheduler", "../../src/do/channel-fanout/fanout-scheduler"),
        ("../../src/do/scheduler.test", "../../src/do/scheduler-probe/scheduler.test"),
        ("../do/bot-connection-stateful", "../do/bot-connection/stateful"),
        ("../../src/do/chat-channel.read.test", "../../src/do/chat-channel/read.test"),
        ("../do/user-directory.projection.test", "../do/user-directory/projection.test"),
        ("../../src/do/rpc-errors", "../../src/do/shared/rpc-errors"),
        ("../do/rpc-errors", "../do/shared/rpc-errors"),
        ("../do/do-rpc", "../do/shared/do-rpc"),
    ]
    for base in [ROOT / "src", ROOT / "test"]:
        for path in base.rglob("*.ts"):
            if "src/do/" in str(path) and "/shared/" not in str(path):
                continue
            text = path.read_text()
            original = text
            for old, new in patterns:
                text = text.replace(old, new)
            if text != original:
                path.write_text(text)


def main() -> None:
    fix_shared()
    for module in MODULES:
        fix_module_object(module)
        fix_migrations(module)
    fix_chat_channel_children()
    fix_channel_fanout()
    fix_scheduler_probe()
    fix_outside_do()
    print("import fixes applied")


if __name__ == "__main__":
    main()
