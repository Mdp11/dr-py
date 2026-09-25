# Local-dev workflow: `dr-start` / `dr-stop` / `dr-reset`

**Date:** 2026-07-19
**Status:** implemented

## Goal

Collapse the multi-step local dev inner loop (docker services + Alembic migration
+ backend + frontend, spread across the `api` and `frontend` pixi environments)
into three pixi commands:

- `pixi run dr-start` — start dockers, backend, and frontend
- `pixi run dr-stop` — stop backend, frontend, and dockers
- `pixi run dr-reset` — reset the full local environment to a clean slate

## Constraints / context

- The building blocks already exist as pixi tasks: `services-start` /
  `services-stop` / `services-reset` (docker compose), `db-upgrade`
  (`alembic upgrade head`), `backend-start` (uvicorn, `api` env), `frontend-start`
  (vite, `frontend` env).
- `.env` targets the docker stack (Postgres + fake-gcs); the sqlite `dev.db` is
  unused with this config.
- Backend and frontend are long-running foreground servers in **different pixi
  environments**. pixi cannot run two long-running foreground tasks
  concurrently, so an orchestrator is required.
- `dr-stop` existing as a separate command implies the servers run **detached**
  (backgrounded), so a later command can stop them.

## Decision: orchestrator

Use **process-compose** (on conda-forge → declared pixi dependency, not a global
install). Chosen over hand-rolled PID files (fragile lifecycle) and over
supervisord because process-compose natively provides:

- a **detached daemon** mode + clean `down` + `attach` (matches the
  start/stop/attach shape),
- **health-gated `depends_on`** (backend starts only after the migration
  succeeds) and first-class **one-shot** processes (the migration),
- a YAML config that mirrors the repo's existing `docker-compose.yml` idiom.

supervisord was considered but has no readiness concept (only start `priority`)
and treats run-and-exit tasks as `FATAL` — the migration ordering would have to
be scripted outside it, eroding the elegance.

## Division of labor

Each tool does what it is best at:

- **docker compose** owns the container lifecycle. `services-start`'s `--wait`
  already guarantees Postgres-healthy + snapshot-bucket-created — the first
  ordering gate, for free. docker is brought up/down by the existing pixi tasks
  (symmetric), never from inside process-compose.
- **process-compose** owns the host processes (backend, frontend) and the second
  ordering gate: backend starts only after `db-upgrade` completes successfully.

## New file: `process-compose.yaml` (repo root)

```yaml
version: "0.5"
processes:
  db-upgrade:                        # one-shot: alembic upgrade head
    command: "pixi run db-upgrade"
    availability: { restart: "no" }
  backend:                           # waits for the migration to succeed
    command: "pixi run backend-start"
    depends_on:
      db-upgrade: { condition: process_completed_successfully }
  frontend:                          # independent; vite tolerates a not-yet-up backend
    command: "pixi run frontend-start"
```

Reuses the existing pixi tasks — no duplicated uvicorn/npm/alembic command lines.
Postgres-health ordering for the migration is handled upstream by `services-start`
(`docker compose up -d --wait`), so `db-upgrade` needs no docker dependency here.

## `pixi.toml` changes

- Add `process-compose` to `[feature.api.dependencies]`.
- Add tasks under `[feature.api.tasks]`, all `default-environment = "api"`:

| Task       | Behavior |
|------------|----------|
| `dr-start` | `--wait` the long-running docker services (postgres, fake-gcs) → start + `docker compose wait` `gcs-init` (bucket ready) → `process-compose up --detached` (runs db-upgrade → backend, frontend concurrently, as a background daemon). Non-blocking — returns to the shell. |
| `dr-stop`  | `process-compose down` (SIGTERM backend + frontend) → `pixi run services-stop` (docker down, **keep** volumes). |
| `dr-reset` | `process-compose down \|\| true` (stop servers if running) → `pixi run services-reset` (`docker compose down -v` — remove containers + **wipe** both volumes). End state: **nothing running, volumes gone**. |
| `dr-logs`  | `process-compose attach` — live TUI (per-process logs, scrollback, restart keys). Free bonus. |

## Behavior notes

- `dr-start` is **non-blocking**; view live logs with `pixi run dr-logs`
  (`process-compose attach`).
- `dr-reset` does **not** restart the stack — it leaves a clean slate (no
  containers, no volumes). The next `pixi run dr-start` rebuilds everything fully
  fresh: new containers, empty DB reseeded with only the bootstrap admin
  (`DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL`), servers up.
- Scope of `dr-reset` is **docker volumes + reseed only** — it leaves
  `frontend/node_modules` and the `.pixi` environments intact.

## Resolved during implementation

- Detached flag is `--detached` (alias `-D`); `version: "0.5"` accepted by
  process-compose v1.120.0. `down` / `attach` confirmed.
- **Nested `pixi run` needs an explicit `-e`.** The daemon is spawned from the
  `api` env, and a bare nested `pixi run <task>` only resolves tasks in that
  already-activated env — so `frontend-start` (a `frontend`-env task) was "command
  not found" (exit 127). Each command in `process-compose.yaml` now pins its env:
  `pixi run -e api …` / `pixi run -e frontend …`.
- **`docker compose up --wait` over all services is cold-volume-unsafe.** It
  aborts (non-zero) the instant the one-shot `gcs-init` exits, which on a fresh
  volume is *before* Postgres finishes its slow first `initdb` — so `db-upgrade`
  raced a not-ready DB (`the database system is starting up`). Fixed by `--wait`ing
  only the long-running services (postgres, fake-gcs) — which never exit, so
  `--wait` truly blocks on Postgres health — then starting `gcs-init` and
  `docker compose wait`ing for it. `dr-start` therefore does NOT reuse
  `services-start` (which keeps its all-services `--wait` for manual use).
- Verified end-to-end: cold-volume `dr-start` → `db-upgrade` migrates the empty
  DB, backend + frontend Running, bootstrap-admin login returns HTTP 200; vite
  proxy reaches the API; `dr-stop` keeps volumes; `dr-reset` (from both stopped
  and running states) wipes them.

## Out of scope

- Any frontend/`.pixi` reinstall in `dr-reset` (explicitly declined).
- Production orchestration — this is the local dev inner loop only.
