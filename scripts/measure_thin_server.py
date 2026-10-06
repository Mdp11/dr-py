"""Measure the thin server on Postgres over model M.

Medians of three for: the import of M, a 1,000-op commit, the delete of a
10,000-element subtree, and a snapshot written from the head rows. A script, not
a test: run it on a quiet machine, with the compose Postgres up.

    docker compose up -d postgres
    pixi run engine-bench-data        # only if benchmarks/large.model.json is missing
    pixi run -e api python scripts/measure_thin_server.py

The database (``data_rover_measure`` by default) is created when missing and its
schema is dropped and rebuilt on every run, so its name must end in ``_test`` or
``_measure``; any other needs ``--i-know-this-drops``. Requests go through the app in-process (the
commit's route, its lock check and its transaction); the snapshot goes to the
in-memory store, so the numbers carry the database and the encoding, not a blob
store's network.
"""

from __future__ import annotations

import argparse
import io
import os
import platform
import statistics
import sys
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

DEFAULT_URL = (
    "postgresql+psycopg://data_rover:data_rover@127.0.0.1:5432/data_rover_measure"
)
REPS = 3
COMMIT_OPS = 1_000
SUBTREE = 10_000
USER = "measure"
HEADERS = {"x-user-id": USER, "x-user-email": "measure@example.com"}


SAFE_SUFFIXES = ("_test", "_measure")


def refuse_unless_droppable(url: str, *, allowed: bool) -> None:
    """Exit unless the schema of ``url`` may be dropped: its database is named
    for tests or measures, or the caller said so."""
    from sqlalchemy.engine import make_url

    name = make_url(url).database or ""
    if not allowed and not name.endswith(SAFE_SUFFIXES):
        raise SystemExit(
            f"refusing to drop the public schema of {name!r}: the name must end in "
            f"{' or '.join(SAFE_SUFFIXES)}, or pass --i-know-this-drops"
        )


def fresh_database(url: str) -> None:
    """Create the database when missing and rebuild its schema."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    parsed = make_url(url)
    admin = create_engine(parsed.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        if not conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": parsed.database}
        ).scalar():
            conn.execute(text(f'CREATE DATABASE "{parsed.database}"'))
    admin.dispose()
    engine = create_engine(parsed)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    command.upgrade(cfg, "head")


def timed(fn: Callable[[], Any]) -> tuple[float, Any]:
    start = time.perf_counter()
    value = fn()
    return time.perf_counter() - start, value


def committed(
    client: Any, pid: str, ops: list[dict[str, Any]], *, timed_run: bool
) -> tuple[float, dict[str, Any]]:
    """Post ``ops`` at the head. The server names the leases it lacks; they are
    taken and the commit is posted again, and that post is the one timed."""
    from data_rover.api.content import get_model_row
    from data_rover.api.db import db_session

    base = f"/api/v1/projects/{pid}"
    with db_session() as s:
        row = get_model_row(s, pid)
        assert row is not None
        rev = row.model_rev
    payload: dict[str, Any] = {"base_rev": rev, "ops": ops}
    r = client.post(f"{base}/commits", json=payload, headers=HEADERS)
    token = None
    if r.status_code == 409 and r.json().get("detail") == "required lock not held":
        lock = client.post(
            f"{base}/locks",
            json={"targets": r.json()["missing"], "intent": "edit"},
            headers=HEADERS,
        )
        assert lock.status_code == 200, lock.text[:300]
        token = lock.json()["token"]
        payload["lock_tokens"] = [token]
        start = time.perf_counter()
        r = client.post(f"{base}/commits", json=payload, headers=HEADERS)
        elapsed = time.perf_counter() - start
    else:
        # nothing to lock: that post was the commit
        elapsed = float("nan")
    assert r.status_code == 200, f"{r.status_code} {r.text[:300]}"
    if token is not None:
        client.post(f"{base}/locks/release", json={"token": token}, headers=HEADERS)
    return elapsed, r.json()


def load_by_baseline(pid: str, metamodel_yaml: str, model_bytes: bytes) -> None:
    """Put M in as ``head.write_baseline`` writes a model, without the import's
    streaming and row checks."""
    from data_rover.api import importer
    from data_rover.api.db import db_session
    from data_rover.api.head import write_baseline
    from data_rover.api.routes._snapshot import build_model_from_dicts
    from data_rover.api.serialize import parse_model_json
    from data_rover.core.metamodel.loader import load_metamodel_str

    importer.import_project(
        project_id=pid,
        name=pid,
        owner_id=USER,
        metamodel_yaml=metamodel_yaml,
        model_json='{"elements": [], "relationships": []}',
    )
    metamodel = load_metamodel_str(metamodel_yaml)
    model = build_model_from_dicts(metamodel, parse_model_json(model_bytes))
    with db_session() as s:
        write_baseline(s, pid, metamodel, model)


def main() -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATA_ROVER_MEASURE_DATABASE_URL", DEFAULT_URL),
    )
    parser.add_argument(
        "--model", type=Path, default=REPO_ROOT / "benchmarks" / "large.model.json"
    )
    parser.add_argument(
        "--metamodel",
        type=Path,
        default=REPO_ROOT / "examples" / "smart-city.metamodel.yaml",
    )
    parser.add_argument(
        "--load",
        choices=("import", "baseline"),
        default="import",
        help="how M gets into the database: the import route's code (timed, three "
        "runs) or the baseline writer (not timed, for the phases after the import)",
    )
    parser.add_argument(
        "--i-know-this-drops",
        action="store_true",
        help="drop the public schema of a database not named *_test or *_measure",
    )
    args = parser.parse_args()
    refuse_unless_droppable(args.database_url, allowed=args.i_know_this_drops)
    if not args.model.exists():
        raise SystemExit(f"{args.model} is missing: run `pixi run engine-bench-data`")

    os.environ.update(
        DATA_ROVER_DATABASE_URL=args.database_url,
        DATA_ROVER_DEV_SEED="false",
        DATA_ROVER_SNAPSHOT_STORE="memory",
        DATA_ROVER_IDENTITY_PROVIDER="header",
        DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL="",
        DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD="",
        DATA_ROVER_IDLE_EVICT_SECONDS="0",
        DATA_ROVER_LOCK_SWEEP_SECONDS="0",
    )
    fresh_database(args.database_url)

    from fastapi.testclient import TestClient
    from sqlalchemy import text

    from data_rover.api import db, importer
    from data_rover.api.db_models import User
    from data_rover.api.main import create_app
    from data_rover.api.snapshot_rows import write_snapshot_from_rows

    app = create_app()
    # the rev-0 snapshot job is not part of the import
    importer.schedule_periodic_snapshot = lambda *a, **k: None  # type: ignore[assignment]
    with db.db_session() as s:
        s.add(User(id=USER, email="measure@example.com"))
    metamodel = args.metamodel.read_text(encoding="utf-8")
    model_bytes = args.model.read_bytes()

    # -- import of M -------------------------------------------------------------
    imports: list[float] = []
    pid = ""
    if args.load == "baseline":
        pid = "m0"
        load_by_baseline(pid, metamodel, model_bytes)
    for i in range(REPS if args.load == "import" else 0):
        pid = f"m{i}"
        seconds, _ = timed(
            lambda: importer.import_project(
                project_id=pid,
                name=pid,
                owner_id=USER,
                metamodel_yaml=metamodel,
                model_json=io.BytesIO(model_bytes),
            )
        )
        imports.append(seconds)
        print(f"import {i + 1}: {seconds:.2f} s", flush=True)
        if i < REPS - 1:  # only the last stays, for the rest of the run
            with db.db_session() as s:
                s.execute(text("DELETE FROM projects WHERE id = :p"), {"p": pid})
    with db.db_session() as s:
        counts = s.execute(
            text(
                "SELECT element_count, relationship_count FROM models WHERE project_id = :p"
            ),
            {"p": pid},
        ).one()

    if args.load == "baseline":
        # a baseline write is no import: its rows have no statistics until
        # autovacuum analyzes them, which an import does itself
        with (
            db.get_engine()
            .connect()
            .execution_options(isolation_level="AUTOCOMMIT") as conn
        ):
            conn.execute(text("ANALYZE"))

    client = TestClient(app)

    # -- a 1,000-op commit ---------------------------------------------------------
    with db.db_session() as s:
        teams = list(
            s.execute(
                text(
                    "SELECT id FROM elements WHERE project_id = :p AND type_name = 'Team' ORDER BY seq LIMIT :n"
                ),
                {"p": pid, "n": COMMIT_OPS},
            ).scalars()
        )
    assert len(teams) == COMMIT_OPS
    commits: list[float] = []
    for i in range(REPS):
        ops = [
            {"kind": "update_element", "id": tid, "properties_patch": {"size": 10 + i}}
            for tid in teams
        ]
        seconds, _ = committed(client, pid, ops, timed_run=True)
        commits.append(seconds)
        print(f"commit of {COMMIT_OPS} ops {i + 1}: {seconds:.2f} s", flush=True)

    # -- a delete of a 10,000-element subtree ---------------------------------------
    deletes: list[float] = []
    for i in range(REPS):
        grow = [
            {
                "kind": "create_element",
                "temp_id": "tmp_root",
                "type_name": "Organization",
                "properties": {"name": f"Measured-{i}", "country": "DE"},
            }
        ]
        for j in range(SUBTREE - 1):
            grow.append(
                {
                    "kind": "create_element",
                    "temp_id": f"tmp_t{j}",
                    "type_name": "Team",
                    "properties": {"name": f"Measured-{i}-{j}"},
                }
            )
            grow.append(
                {
                    "kind": "create_relationship",
                    "temp_id": f"tmp_o{j}",
                    "type_name": "Owns",
                    "source_id": "tmp_root",
                    "target_id": f"tmp_t{j}",
                    "properties": {},
                }
            )
        _, made = committed(client, pid, grow, timed_run=False)
        root = made["id_map"]["tmp_root"]
        seconds, body = committed(
            client, pid, [{"kind": "delete_element", "id": root}], timed_run=True
        )
        assert len(body["deleted_element_ids"]) == SUBTREE, len(
            body["deleted_element_ids"]
        )
        deletes.append(seconds)
        print(f"delete of {SUBTREE} elements {i + 1}: {seconds:.2f} s", flush=True)

    # -- a snapshot from rows ---------------------------------------------------------
    snapshots: list[float] = []
    for i in range(REPS):
        seconds, rev = timed(lambda: write_snapshot_from_rows(pid))
        snapshots.append(seconds)
        print(f"snapshot {i + 1} (rev {rev}): {seconds:.2f} s", flush=True)

    with db.db_session() as s:
        server = s.execute(text("SHOW server_version")).scalar()
    import psycopg
    import sqlalchemy

    print()
    print(
        f"host: {platform.node()} ({platform.system()} {platform.release()}, {os.cpu_count()} cpus)"
    )
    print(
        f"python {platform.python_version()}, postgres {server}, "
        f"sqlalchemy {sqlalchemy.__version__}, psycopg {psycopg.__version__}"
    )
    print(f"date: {date.today().isoformat()}")
    print(f"model M: {counts[0]:,} elements, {counts[1]:,} relationships")
    print("medians of 3 (seconds):")
    for name, values in (
        ("import of M", imports),
        (f"{COMMIT_OPS:,}-op commit", commits),
        (f"delete of a {SUBTREE:,}-element subtree", deletes),
        ("snapshot from rows", snapshots),
    ):
        if not values:
            print(f"  {name}: not measured")
            continue
        print(
            f"  {name}: {statistics.median(values):.2f}  (runs: {', '.join(f'{v:.2f}' for v in values)})"
        )


if __name__ == "__main__":
    main()
