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
frontend. Auth is the same **cookie-based local login** as production (local
email + password, no external SSO); the dev-only seams are the GCS emulator and
the dev seed (creates the SQLite/dev schema; the single admin comes from
DATA_ROVER_BOOTSTRAP_ADMIN_*).

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
cp .env.example .env                       # backend config (Postgres + GCS + admin)
```

`.env` is gitignored — it is your local config. The defaults already match
`docker-compose.yml`, so you can run as-is.

### 2. Start everything

```sh
pixi run services-start      # Postgres + fake-gcs + snapshot bucket (waits until ready)
pixi run db-upgrade       # apply the Postgres schema (Alembic)
pixi run backend-start    # http://127.0.0.1:8000  (reads .env)
pixi run frontend-start   # http://localhost:5173  (separate terminal)
```

Open <http://localhost:5173>. On first boot the backend creates the schema and
ensures the bootstrap admin exists — it does **not** seed any project. The
frontend opens the **login** page — sign in, then create a project with the
**New Project** wizard.

### Logging in & the first admin

Auth is **cookie-based email + password** (`DATA_ROVER_IDENTITY_PROVIDER=cookie`,
the default). There is **no self-signup**: admins create every other user from
the in-app **Admin console**, so a deployment needs a *first* admin. The backend
ensures exactly one on **every** startup from `.env` (create-or-promote,
independent of `DATA_ROVER_DEV_SEED`):

```sh
DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com   # dev default in .env.example
DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=admin12345
```

Log in with these on first boot. For production set a real pair and a strong
`DATA_ROVER_JWT_SECRET` (the backend **refuses to boot** with the insecure
default when `identity_provider=cookie` and `dev_seed=false`). Password rotation
is via `POST /api/v1/auth/change-password` (no UI yet).

Once logged in as an admin, open **Admin** in the header to create more users
(each with a password) and manage project membership.

### Creating a project

There is no autoloaded project. Log in as an admin and use the **New Project**
wizard (header → New Project) to create one, uploading a metamodel (and
optionally a model + view). The bundled `examples/smart-city.*` are a ready-made
set to upload.

To import a project straight into the database instead (e.g. seeding a shared
Postgres deployment), use the importer CLI:

```sh
PYTHONPATH=src pixi run -e api python -m data_rover.api.importer \
  --project-id smart-city --name "Smart City" --owner-id <admin-user-id> \
  --metamodel examples/smart-city.metamodel.yaml \
  --model examples/smart-city.model.json \
  --view examples/smart-city.view.json
```

To convert a legacy metamodel+model into the new format first, use the migration
CLI and upload / import its output:

```sh
PYTHONPATH=src pixi run -e core python -m data_rover.migration \
  --old-metamodel old.metamodel.json --old-model old.model.json \
  --out-metamodel my.metamodel.yaml  --out-model my.model.json \
  --remove-inconsistencies
```

### Testing multiple users in the browser

Cookie login is per-browser-session, so use **separate browser profiles** (or
one normal + one Incognito — not two tabs in one profile, which share cookies):

1. Log in as the admin and, in the **Admin console**, create the test users
   (each with a password) and add them to a project with the role you want to
   test (editor / viewer).
2. Profile A → log in as user A; Profile B → log in as user B.

You'll see live presence, locking (A checks out an element → B sees it locked),
commits broadcasting, and viewer write-blocks.

> **Legacy header mode (API/automation only).** Setting
> `DATA_ROVER_IDENTITY_PROVIDER=header` trusts an `X-User-Id` header (and the
> `?user=` query param) with no password — handy for `curl`/scripted multi-user
> testing against the API. The browser SPA no longer sends identity headers, so
> it always uses cookie login regardless of this setting.

### Reference

| `.env` variable | Default | Purpose |
|---|---|---|
| `DATA_ROVER_DATABASE_URL` | compose Postgres DSN | Tenancy + content DB |
| `DATA_ROVER_SNAPSHOT_STORE` | `gcs` | Blob store (`gcs` / `memory`) |
| `DATA_ROVER_GCS_BUCKET` | `data-rover-snapshots` | Snapshot bucket |
| `DATA_ROVER_STORAGE_EMULATOR_HOST` | `http://localhost:4443` | fake-gcs endpoint (drop in real prod) |
| `DATA_ROVER_DEV_SEED` | `true` | Create the SQLite schema on startup (`false` in prod) |
| `DATA_ROVER_IDENTITY_PROVIDER` | `cookie` | Auth mode: `cookie` (login) or `header` (API/legacy) |
| `DATA_ROVER_JWT_SECRET` | insecure dev default | Session-cookie signing key; **must set in prod** |
| `DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL` | _(empty)_ | First-admin email; create-or-promote each startup |
| `DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD` | _(empty)_ | Password for the bootstrap admin |

| pixi command | Action |
|---|---|
| `pixi run services-start` | Start Postgres + fake-gcs (+ bucket), wait until ready |
| `pixi run services-stop` | Stop containers, keep data |
| `pixi run services-reset` | Stop + wipe data volumes |
| `pixi run services-logs` | Tail infra logs |
| `pixi run db-upgrade` | Apply Postgres schema (Alembic) |
| `pixi run backend-start` | Run the API (reads `.env`) |
| `pixi run frontend-start` | Run the SvelteKit dev server |

### Teardown

```sh
# Ctrl-C backend + frontend
pixi run services-stop     # or: pixi run services-reset  (also wipes data)
```

### Applying changes — mental model

| Change | What to do |
|---|---|
| Add a user / change role | Create + manage in the in-app **Admin console** (no restart) |
| Change the first admin | Set `DATA_ROVER_BOOTSTRAP_ADMIN_*` in `.env` → restart (create-or-promote) |
| Add a project | **New Project** wizard (or the importer CLI) — no restart |
| Change ports / DB / storage config | Edit `.env` → restart backend (some need `services-reset`) |
