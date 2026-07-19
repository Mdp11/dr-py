# Quickstart

## Prerequisites

- [pixi](https://pixi.sh) — `curl -fsSL https://pixi.sh/install.sh | bash`
- Docker (Postgres + GCS emulator)
- git

## Local dev (from scratch)

```sh
git clone git@github.com:Mdp11/dr-py.git data-rover-py
cd data-rover-py
pixi install -e api
pixi install -e frontend

cp .env.example .env        # defaults match docker-compose + set the dev admin

pixi run services-start        # Postgres + fake-gcs (waits until ready)
pixi run db-upgrade         # apply Postgres schema (Alembic)
pixi run backend-start      # http://127.0.0.1:8000
pixi run frontend-start     # http://localhost:5173  (separate terminal)
```

### One-shot workflow (shortcut)

The steps above are bundled into three commands (docker + backend + frontend, via
a detached `process-compose` daemon — see `process-compose.yaml`):

```sh
pixi run dr-start    # start dockers, migrate, then backend + frontend (non-blocking)
pixi run dr-logs     # attach live per-process logs (Ctrl-b q to detach; leaves it running)
pixi run dr-stop     # stop backend + frontend + dockers (keeps data volumes)
pixi run dr-reset    # stop everything + wipe the Postgres/fake-gcs volumes (clean slate;
                     # next dr-start rebuilds fully fresh — does NOT restart)
```

Open <http://localhost:5173> and log in:

```
admin@example.com / admin12345
```

Create a project via **New Project** (header). Upload a metamodel — the bundled
`examples/smart-city.*` give you sample content (metamodel + model + view).

Teardown: `pixi run services-stop` (stop, **keep** data) or `pixi run services-reset`
(stop + **wipe** the Postgres and fake-gcs volumes).

### Reset to a clean slate

`services-reset` (`docker compose down -v`) drops both data volumes — the
Postgres database and the fake-gcs snapshot store — so everything (users,
projects, models, snapshots) is gone. To rebuild from empty:

```sh
pixi run services-reset     # wipe Postgres + fake-gcs volumes
pixi run services-start        # recreate them (waits until ready)
pixi run db-upgrade         # re-apply the Alembic schema
pixi run backend-start      # re-creates the bootstrap admin on boot
```

You're back to a fresh DB with only the `DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL`
admin — log in and recreate projects via **New Project**.

## Production (from scratch)

Set real values in the environment (no `.env` defaults):

```sh
DATA_ROVER_DEV_SEED=false                        # Postgres schema is Alembic-owned
DATA_ROVER_DATABASE_URL=postgresql+psycopg://USER:PASS@HOST:5432/DB
DATA_ROVER_JWT_SECRET=<long-random-secret>       # boot refuses the dev default
DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=you@example.com # the only seeded user
DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=<strong-pw>  # boot refuses "admin12345"
DATA_ROVER_SNAPSHOT_STORE=gcs
DATA_ROVER_GCS_BUCKET=<your-bucket>              # real GCS + default credentials
# do NOT set DATA_ROVER_STORAGE_EMULATOR_HOST in prod
# DATA_ROVER_AUTH_COOKIE_SECURE=true (default; requires HTTPS)
```

```sh
pixi run db-upgrade         # apply schema to the prod Postgres
pixi run backend-start      # serve the API (behind your TLS proxy)
pixi run frontend-build     # static build in frontend/build — serve it
```

Log in as the bootstrap admin. There is no self-signup: create all other users
in the in-app **Admin console**, and projects via **New Project** (or the
importer CLI below).

Seed a project non-interactively (shares the app's DB + snapshot store):

```sh
PYTHONPATH=src pixi run -e api python -m data_rover.api.importer \
  --project-id smart-city --name "Smart City" --owner-id <admin-user-id> \
  --metamodel examples/smart-city.metamodel.yaml \
  --model examples/smart-city.model.json \
  --view examples/smart-city.view.json
```
