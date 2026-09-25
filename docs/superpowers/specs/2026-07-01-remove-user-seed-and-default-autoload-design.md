# Remove user seeding + default-model autoload

**Date:** 2026-07-01
**Status:** Approved

## Goal

Clean up the repository so that:

1. **User seeding** is limited to a *single* bootstrap admin created on startup
   (`_ensure_bootstrap_admin`). All other users are created manually via the
   admin API. Remove the `dev-users.json` provisioning path and the fallback
   dev admin (`admin@example.com` / `admin12345` made owner of `default`).
2. **No default view/model/metamodel is autoloaded.** The backend no longer
   imports `examples/smart-city.*` into a `default` project on startup.
   Projects are created via the New Project wizard; example artifacts are
   imported manually (wizard or importer CLI).

The removal spans **code, env files, and sample files**.

## Decisions (confirmed with user)

- **`examples/smart-city.*`** — *kept* as the canonical data-format reference /
  importer-CLI / wizard fodder. Only the *autoload* is removed.
- **`dev_seed` setting** — *kept but reduced* to "create the SQLite schema for
  local dev". This preserves the `_guard_prod_secret` production signal
  (`dev_seed=false` ⇒ prod).
- **Local login** — the dev admin creds move into `.env` as
  `DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD` (`admin@example.com` /
  `admin12345`), so local dev keeps a one-admin login through the single
  bootstrap path.
- **e2e** — the Playwright suite depends on the autoloaded "Smart City" project.
  Because the e2e snapshot store is in-process `memory` (the importer CLI can't
  seed it cross-process), a Playwright **globalSetup** creates the project via
  the running backend's wizard API (`POST /api/v1/projects` with
  `examples/smart-city.*`). Existing e2e helpers stay unchanged.

## Changes

### 1. `src/data_rover/api/main.py`
- Delete `_seed_artifact`, `_provision_dev_users`, the `importer.import_project`
  autoload call, and the fallback dev-admin block.
- `_ensure_dev_seed` becomes: `if settings.database_url.startswith("sqlite"): create_all()`.
- Remove now-unused constants (`DEV_USER_ID`, `DEV_PROJECT_ID`, `_EXAMPLES`) and
  imports (`importer`, `Role`, `json` if unused). Keep the `if settings.dev_seed`
  gate in `create_app` and `_ensure_bootstrap_admin` unchanged.

### 2. `src/data_rover/api/settings.py`
- Remove `seed_metamodel`, `seed_model`, `seed_view`, `dev_users_file`.
- Keep `dev_seed` (rewrite docstring: schema creation only). `bootstrap_admin_*`
  unchanged.

### 3. Env files — `.env`, `.env.example`
- Remove `DATA_ROVER_SEED_*` and `DATA_ROVER_DEV_USERS_FILE` lines.
- Rewrite the `DEV_SEED` comment (schema-only).
- `.env`: set `DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com` /
  `_PASSWORD=admin12345`. `.env.example`: document these (kept commented) as the
  local-dev login.

### 4. Sample files
- Delete `dev-users.json`, `dev-users.example.json`.
- Keep `examples/smart-city.*`.

### 5. Tests
- Delete `tests/api/test_dev_seed_example.py` and `tests/api/test_dev_seed.py`.
- Optionally add a small test that `dev_seed` on sqlite creates the schema.
- `test_auth.py` (bootstrap/guard), `test_importer.py`, `test_projects_wizard.py`
  unaffected.

### 6. e2e (`frontend/`)
- `playwright.config.ts` webServer: add
  `DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com`
  `DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=admin12345`.
- Add a `globalSetup` that logs in as that admin and `POST`s
  `examples/smart-city.*` to create the "Smart City" project once.
- `e2e/helpers/auth.ts` unchanged.

### 7. Docs — `README.md`, `CLAUDE.md`, `frontend/README.md`
- Rewrite dev-seed / seeding / dev-members / seeded-model sections: one bootstrap
  admin, no autoloaded project, wizard-created projects, manual example import.

## Verification
- `pixi run test-core` and API tests green.
- `pixi run tidy` (ruff + mypy + pyright) clean.
- e2e: `cd frontend && npm run test:e2e` green (globalSetup creates the project).
- Manual: fresh sqlite dev boot → login as bootstrap admin → empty picker →
  wizard creates a project.
