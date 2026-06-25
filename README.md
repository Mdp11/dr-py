# data-rover

A reflective MBSE (Model-Based Systems Engineering) metamodel engine. Three data
layers stack on each other:

- **Metamodel** (`*.metamodel.yaml`) — the schema: element/relationship types,
  inheritance, properties, allowed endpoint mappings, and uniqueness keys.
- **Model** (`*.model.json`) — instance data: elements and relationships
  conforming to one metamodel.
- **View** (`*.view.json`) — an optional user-defined folder overlay that
  *references* model elements by id.

It ships as a Python core + FastAPI backend and a SvelteKit single-page
frontend. Everything runs through **[pixi](https://pixi.sh)** — there is no
global `python` or `node`. Example artifacts live in `examples/`
(`smart-city.*`). See `CLAUDE.md` for the architecture in depth, and
`frontend/README.md` / `migration/README.md` for those subsystems.

## Running locally (production-faithful stack)

This brings up the real production code paths — **Postgres** (schema via
Alembic) + **GCS-protocol snapshots** (a `fake-gcs-server` emulator) + backend +
frontend. The only dev-only seam is identity (header-based instead of SSO).

### 0. Prerequisites (once)

- **[pixi](https://pixi.sh)** — the toolchain entry point: `curl -fsSL https://pixi.sh/install.sh | bash`
- **Docker** — for Postgres + the GCS emulator (on WSL2, enable WSL integration in Docker Desktop)
- **git**

```sh
git clone git@github.com:Mdp11/dr-py.git data-rover-py
cd data-rover-py
pixi install -e api
pixi install -e frontend
```

### 1. Configure (once)

```sh
cp .env.example .env                       # backend config (Postgres + GCS + seed)
cp dev-users.example.json dev-users.json   # extra local users
```

`.env` and `dev-users.json` are gitignored — they are your local config. The
defaults already match `docker-compose.yml`, so you can run as-is.

### 2. Start everything

```sh
pixi run services-up      # Postgres + fake-gcs + snapshot bucket (waits until ready)
pixi run db-upgrade       # apply the Postgres schema (Alembic)
pixi run start-backend    # http://127.0.0.1:8000  (reads .env)
pixi run start-frontend   # http://localhost:5173  (separate terminal)
```

Open <http://localhost:5173>. On first boot the backend seeds project `default`
from the configured model and provisions your users.

### Editing the default **users**

Edit `dev-users.json`:

```json
{
  "users": [
    { "id": "alice", "email": "alice@example.com", "role": "editor" },
    { "id": "bob",   "role": "viewer" }
  ]
}
```

- `role` is one of `owner` / `editor` / `viewer` (`editor` if omitted);
  `email` defaults to `<id>@example.com`.
- The owner `default-user` is always seeded regardless of this file.

**Apply:** restart the backend (`Ctrl-C`, then `pixi run start-backend`). User
provisioning is idempotent and runs **even on an existing project**, so added
users and role changes are picked up — no DB reset needed.

> Removing a user from the file does not delete them. To remove a member:
> `curl -s -H 'x-user-id: default-user' -X DELETE http://127.0.0.1:8000/api/v1/projects/default/members/<id>`

The file path is set in `.env` via `DATA_ROVER_DEV_USERS_FILE`.

### Editing the seeded **model**

The seed artifacts are set in `.env`:

```sh
DATA_ROVER_SEED_METAMODEL=examples/smart-city.metamodel.yaml
DATA_ROVER_SEED_MODEL=examples/smart-city.model.json
DATA_ROVER_SEED_VIEW=examples/smart-city.view.json
```

Point these at your own files (paths relative to the repo root; leave
`SEED_VIEW` empty to seed no view).

**Apply — important:** unlike users, the model import is idempotent and
**no-ops if project `default` already exists**, so changing the model requires a
fresh DB:

```sh
# Ctrl-C the backend first
pixi run services-reset   # wipe Postgres + snapshot volumes
pixi run services-up
pixi run db-upgrade
pixi run start-backend    # re-seeds from the new SEED_* paths + re-provisions users
```

> Editing the example files in place counts as changing the model too — same
> reset required, because the existing `default` project still holds the old
> content.

To convert a legacy metamodel+model into the new format, use the migration CLI
and point `SEED_*` at its output:

```sh
PYTHONPATH=src pixi run -e core python -m data_rover.migration \
  --old-metamodel old.metamodel.json --old-model old.model.json \
  --out-metamodel my.metamodel.yaml  --out-model my.model.json \
  --remove-inconsistencies
```

### Testing multiple users in the browser

The frontend picks its identity from a `?user=` query param (persisted to
localStorage, default `default-user`). Use **separate browser profiles** (or one
normal + one Incognito — not two tabs in one profile, which share localStorage):

- Profile A → <http://localhost:5173/?user=alice>
- Profile B → <http://localhost:5173/?user=bob>

You'll see live presence, locking (alice checks out an element → bob sees it
locked), commits broadcasting, and viewer write-blocks. Each user must be in
`dev-users.json` (or be `default-user`).

### Reference

| `.env` variable | Default | Purpose |
|---|---|---|
| `DATA_ROVER_DATABASE_URL` | compose Postgres DSN | Tenancy + content DB |
| `DATA_ROVER_SNAPSHOT_STORE` | `gcs` | Blob store (`gcs` / `memory`) |
| `DATA_ROVER_GCS_BUCKET` | `data-rover-snapshots` | Snapshot bucket |
| `DATA_ROVER_STORAGE_EMULATOR_HOST` | `http://localhost:4443` | fake-gcs endpoint (drop in real prod) |
| `DATA_ROVER_DEV_SEED` | `true` | Auto-seed on startup (`false` in prod) |
| `DATA_ROVER_SEED_METAMODEL` / `_MODEL` / `_VIEW` | smart-city example | Seed artifacts |
| `DATA_ROVER_DEV_USERS_FILE` | `dev-users.json` | Extra users to provision |

| pixi command | Action |
|---|---|
| `pixi run services-up` | Start Postgres + fake-gcs (+ bucket), wait until ready |
| `pixi run services-down` | Stop containers, keep data |
| `pixi run services-reset` | Stop + wipe data volumes (needed to re-seed the model) |
| `pixi run services-logs` | Tail infra logs |
| `pixi run db-upgrade` | Apply Postgres schema (Alembic) |
| `pixi run start-backend` | Run the API (reads `.env`) |
| `pixi run start-frontend` | Run the SvelteKit dev server |

### Teardown

```sh
# Ctrl-C backend + frontend
pixi run services-down     # or: pixi run services-reset  (also wipes data)
```

### Applying changes — mental model

| Change | What to do |
|---|---|
| Add user / change role | Edit `dev-users.json` → restart backend |
| Change seeded model | Edit `.env` `SEED_*` (or the files) → `services-reset` + up + `db-upgrade` + start-backend |
| Change ports / DB / storage config | Edit `.env` → restart backend (some need `services-reset`) |

The asymmetry is the one thing to remember: **users re-provision on restart; the
model only re-seeds on a fresh DB.**
