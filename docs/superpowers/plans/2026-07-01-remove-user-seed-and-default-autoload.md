# Remove User Seeding + Default-Model Autoload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit startup seeding to a single bootstrap admin and stop autoloading any default metamodel/model/view, removing the code, env entries, and sample files that supported the old dev-seed.

**Architecture:** `_ensure_dev_seed` collapses to "create the SQLite schema for local dev" only; the single admin comes from the already-present `_ensure_bootstrap_admin`; projects are created via the wizard API (`POST /api/v1/projects`) or the importer CLI. `examples/smart-city.*` are kept as reference/import fodder. The Playwright e2e suite, which relied on the autoloaded "Smart City" project, gets its data from a new Playwright *setup project* that creates it through the running backend's wizard API.

**Tech Stack:** Python 3.14 / FastAPI / pydantic-settings, pytest, SvelteKit + Playwright, pixi toolchain.

## Global Constraints

- Toolchain is **pixi** — no global `python`/`node`. Run Python via `pixi run -e core-dev ...`, frontend via `pixi run -e frontend bash -c 'cd frontend && ...'`.
- Python check floor is **3.10** (pyright) though runtime is 3.14 — no >3.10 stdlib.
- All three of ruff, mypy, pyright must pass: `pixi run tidy` (or `pixi run lint-core`).
- API tests need no DB service — `tests/api/conftest.py` uses in-memory SQLite and **pins `DATA_ROVER_IDENTITY_PROVIDER=header`**.
- Commit messages end with the Co-Authored-By trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Keep the codebase's dense "why" docstrings.

---

### Task 1: Reduce dev-seed to schema-only + drop dead settings

**Files:**
- Modify: `src/data_rover/api/main.py` (lines 3, 13, 16, 43–123, and the `create_app` body ~228–236)
- Modify: `src/data_rover/api/settings.py` (lines 61–74)
- Rewrite: `tests/api/test_dev_seed.py`
- Delete: `tests/api/test_dev_seed_example.py`

**Interfaces:**
- Consumes: `data_rover.api.db.create_all`, `db.init_engine`, `db.get_db`; `data_rover.api.storage.MemorySnapshotStore`, `set_snapshot_store`; `data_rover.api.db_models.Project`; `data_rover.api.main.create_app`.
- Produces: `_ensure_dev_seed(settings)` now only calls `create_all()` on SQLite. `Settings` no longer has `seed_metamodel`/`seed_model`/`seed_view`/`dev_users_file`. `_ensure_bootstrap_admin` and `_guard_prod_secret` are unchanged and remain the admin-seed + prod-guard path.

- [ ] **Step 1: Replace the dev-seed test with a schema-only assertion**

Overwrite `tests/api/test_dev_seed.py` with:

```python
from __future__ import annotations

from data_rover.api import db
from data_rover.api.db_models import Project
from data_rover.api.main import create_app
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store


def test_dev_seed_creates_schema_without_seeding_a_project(monkeypatch) -> None:
    """dev_seed on SQLite creates the tenancy+content schema but seeds NO
    default project and NO users. The single admin is provisioned only by
    _ensure_bootstrap_admin; projects are created via the wizard / importer."""
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_STORE", "memory")
    monkeypatch.setenv("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
    db.init_engine("sqlite://", force=True)
    set_snapshot_store(MemorySnapshotStore())
    try:
        create_app()  # builds the app + runs dev-seed
        gen = db.get_db()
        s = next(gen)
        try:
            # schema exists (the query does not raise) and no default project
            assert s.get(Project, "default") is None
        finally:
            gen.close()
    finally:
        set_snapshot_store(None)
```

- [ ] **Step 2: Delete the now-obsolete example/user-provision test file**

Run: `git rm tests/api/test_dev_seed_example.py`
Expected: file removed (all 3 tests exercise removed behavior).

- [ ] **Step 3: Run the new test to verify it FAILS against current code**

Run: `pixi run -e core-dev pytest tests/api/test_dev_seed.py -v`
Expected: FAIL — `assert s.get(Project, "default") is None` is False because current `_ensure_dev_seed` still imports the smart-city project.

- [ ] **Step 4: Reduce `_ensure_dev_seed` and prune `main.py` imports/constants**

In `src/data_rover/api/main.py`:

Change the import on line 13 from:

```python
from . import importer, tenancy
```
to:
```python
from . import tenancy
```

Delete the unused imports: line 3 `import json` and line 16 `from .db_models import Role`. Delete the `from pathlib import Path` import (line 7) — it is only used by removed code.

Delete the constants/helpers on lines 43–123 (`DEV_USER_ID`, `DEV_PROJECT_ID`, `_EXAMPLES`, `_seed_artifact`, `_provision_dev_users`, and the whole body of `_ensure_dev_seed`) and replace with just:

```python
def _ensure_dev_seed(settings: Settings) -> None:
    """Dev/SQLite convenience: create the tenancy + content schema so local
    dev works without Alembic (Postgres schema is Alembic-owned). Gated by
    ``settings.dev_seed`` — MUST be false in production. No user or model
    seeding happens here: the single admin comes from
    ``_ensure_bootstrap_admin`` and projects are created via the New Project
    wizard (``POST /api/v1/projects``) or the importer CLI."""
    if settings.database_url.startswith("sqlite"):
        create_all()
```

Leave `_ensure_bootstrap_admin`, `_guard_prod_secret`, and the `create_app` body (`if settings.dev_seed: _ensure_dev_seed(settings)` then `_ensure_bootstrap_admin(settings)`) unchanged.

- [ ] **Step 5: Remove dead settings fields**

In `src/data_rover/api/settings.py`, delete lines 61–74 (the `seed_metamodel`/`seed_model`/`seed_view` block and the `dev_users_file` block). Rewrite the `dev_seed` docstring (lines 56–59) to:

```python
    #: Dev/SQLite convenience: when true, ``create_app`` creates the schema
    #: (so local dev needs no Alembic). It seeds NO users or model — the single
    #: admin comes from ``bootstrap_admin_*`` and projects are made via the
    #: wizard. MUST be false in production (Postgres schema is Alembic-owned):
    #: set ``DATA_ROVER_DEV_SEED=false``. Also the prod signal for
    #: ``_guard_prod_secret``.
    dev_seed: bool = True
```

- [ ] **Step 6: Run the dev-seed test — now PASSES**

Run: `pixi run -e core-dev pytest tests/api/test_dev_seed.py -v`
Expected: PASS.

- [ ] **Step 7: Run the full API + auth suite (bootstrap/guard must stay green)**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS (notably `tests/api/test_auth.py::test_bootstrap_admin_created_idempotently` and `::test_guard_refuses_insecure_secret_in_prod`, and `tests/api/test_projects_wizard.py`).

- [ ] **Step 8: Lint/typecheck — confirm no unused imports remain**

Run: `pixi run lint-core`
Expected: ruff + mypy + pyright clean. (If ruff flags a still-unused `Path`/`json`/`Role`, remove it.)

- [ ] **Step 9: Commit**

```bash
git add src/data_rover/api/main.py src/data_rover/api/settings.py tests/api/test_dev_seed.py tests/api/test_dev_seed_example.py
git commit -m "$(cat <<'EOF'
refactor(api): reduce dev-seed to SQLite schema creation only

Drop the default-project autoload and dev-users provisioning from
_ensure_dev_seed; the single admin now comes solely from
_ensure_bootstrap_admin and projects are created via the wizard/importer.
Remove the dead seed_* / dev_users_file settings.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove seed/user env entries + sample files; wire local admin via bootstrap

**Files:**
- Modify: `.env`
- Modify: `.env.example`
- Delete: `dev-users.json`, `dev-users.example.json`

**Interfaces:**
- Consumes: nothing (config/data only).
- Produces: local dev boots with exactly one admin (`admin@example.com`/`admin12345`) via `DATA_ROVER_BOOTSTRAP_ADMIN_*`; no `SEED_*`/`DEV_USERS_FILE` vars exist.

- [ ] **Step 1: Delete the sample dev-users files**

`dev-users.example.json` is tracked; `dev-users.json` is gitignored (local-only,
untracked). Remove both from disk, staging only the tracked one:

Run: `git rm dev-users.example.json && rm -f dev-users.json`
Expected: `dev-users.example.json` staged for deletion; local `dev-users.json` gone.

- [ ] **Step 2: Rewrite the `.env` dev section** (local-only; `.env` is gitignored)

`.env` is gitignored, so this edit is local convenience and is NOT committed.
Note: Task 1's implementer already removed the `DATA_ROVER_SEED_*` /
`DATA_ROVER_DEV_USERS_FILE` lines from the local `.env` (pydantic-settings
rejects unknown fields). Ensure the `--- Dev convenience ---` block through the
end reads as below (add the bootstrap-admin block if not already present):

```sh
# --- Dev convenience ---
# Create the SQLite schema on startup (local dev without Alembic). It seeds NO
# users or model. MUST be false in real production (Postgres schema is
# Alembic-owned).
DATA_ROVER_DEV_SEED=true

# --- Auth / first admin user ---
# The ONLY seeded user. On every startup the backend ensures this user exists
# and is an admin (create-or-promote) — there is no self-signup, so admins
# create all other users in the in-app Admin console. For local dev these are
# the login you use. Change them (and set a strong JWT secret) for production.
DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=admin12345
```

- [ ] **Step 3: Rewrite the `.env.example` dev + auth sections**

In `.env.example`, replace lines 25–63 (from `--- Dev convenience ---` to the end of the bootstrap-admin block) with:

```sh
# --- Dev convenience ---
# Create the SQLite schema on startup (local dev without Alembic). Seeds NO
# users or model. MUST be false in real production (Postgres schema is
# Alembic-owned).
DATA_ROVER_DEV_SEED=true

# --- Auth / first admin user ---
# Identity provider: "cookie" (real email+password login — the default) or
# "header" (trusts X-User-Id / ?user= — dev/gateway/API automation only).
# DATA_ROVER_IDENTITY_PROVIDER=cookie

# JWT signing secret for cookie sessions. The code default below is INSECURE and
# the backend REFUSES to boot with it when identity_provider=cookie and
# dev_seed=false (production). Set a long random value in production.
# DATA_ROVER_JWT_SECRET=dev-insecure-secret-change-me

# First (and only) seeded admin. On every startup the backend ensures this user
# exists and is an admin (create-or-promote) — independent of dev_seed. There is
# no self-signup; admins create all other users in the Admin console. For local
# dev use admin@example.com / admin12345; set a real pair in production.
DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=admin12345
```

- [ ] **Step 4: Verify no stray seed/user-file references remain in env**

Run: `grep -nE 'SEED_METAMODEL|SEED_MODEL|SEED_VIEW|DEV_USERS_FILE' .env .env.example`
Expected: no output.

- [ ] **Step 5: Commit** (only tracked files — `.env` and `dev-users.json` are gitignored)

```bash
git add .env.example dev-users.example.json
git commit -m "$(cat <<'EOF'
chore(env): drop seed/dev-users config; seed local admin via bootstrap

Remove DATA_ROVER_SEED_* and DATA_ROVER_DEV_USERS_FILE and the sample
dev-users files. Point local dev at the single bootstrap admin
(admin@example.com / admin12345).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Seed the e2e "Smart City" project via a Playwright setup project

**Files:**
- Create: `frontend/e2e/seed.setup.ts`
- Modify: `frontend/playwright.config.ts`

**Interfaces:**
- Consumes: the running backend at `http://127.0.0.1:8000` with the bootstrap admin `admin@example.com`/`admin12345`; wizard route `POST /api/v1/projects` (multipart: `name`, `metamodel`, optional `model`, `view`); `examples/smart-city.*`.
- Produces: a "Smart City" project exists before the `chromium` project's tests run, so `e2e/helpers/auth.ts` (`login`, `openDefaultProject`) works unchanged.

- [ ] **Step 1: Create the setup spec**

Create `frontend/e2e/seed.setup.ts`:

```typescript
import { test as setup, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Playwright runs with cwd = the config dir (frontend/), so examples/ is one up.
const EXAMPLES = resolve(process.cwd(), '..', 'examples');
const API = 'http://127.0.0.1:8000/api/v1';

/**
 * The backend no longer autoloads a default model, so the e2e suite creates
 * its "Smart City" project itself via the wizard API. Runs as a Playwright
 * setup project (webServer guaranteed up); the shared `request` context keeps
 * the session cookie from login across calls. Idempotent so `reuseExistingServer`
 * reruns are safe.
 */
setup('seed the Smart City project', async ({ request }) => {
	const login = await request.post(`${API}/auth/login`, {
		data: { email: 'admin@example.com', password: 'admin12345' }
	});
	expect(login.ok(), await login.text()).toBeTruthy();

	const existing = await request.get(`${API}/projects`);
	const names = (await existing.json()).map((p: { name: string }) => p.name);
	if (names.includes('Smart City')) return; // already seeded (reused server)

	const res = await request.post(`${API}/projects`, {
		headers: { 'x-requested-with': 'data-rover' }, // CSRF: cookie is present
		multipart: {
			name: 'Smart City',
			metamodel: {
				name: 'smart-city.metamodel.yaml',
				mimeType: 'application/yaml',
				buffer: readFileSync(resolve(EXAMPLES, 'smart-city.metamodel.yaml'))
			},
			model: {
				name: 'smart-city.model.json',
				mimeType: 'application/json',
				buffer: readFileSync(resolve(EXAMPLES, 'smart-city.model.json'))
			},
			view: {
				name: 'smart-city.view.json',
				mimeType: 'application/json',
				buffer: readFileSync(resolve(EXAMPLES, 'smart-city.view.json'))
			}
		}
	});
	expect(res.status(), await res.text()).toBe(201);
});
```

- [ ] **Step 2: Wire the setup project + bootstrap admin env into the config**

In `frontend/playwright.config.ts`:

Replace the `projects` array (lines 24–29) with:

```typescript
	projects: [
		{ name: 'setup', testMatch: /seed\.setup\.ts/ },
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
			dependencies: ['setup']
		}
	],
```

Replace the backend `command` string (line 45–46) with (adds the bootstrap admin; keeps dev-seed for the SQLite schema):

```typescript
			command:
				'rm -f /tmp/data-rover-e2e.db && DATA_ROVER_DATABASE_URL=sqlite:////tmp/data-rover-e2e.db DATA_ROVER_DEV_SEED=true DATA_ROVER_SNAPSHOT_STORE=memory DATA_ROVER_IDENTITY_PROVIDER=cookie DATA_ROVER_AUTH_COOKIE_SECURE=false DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD=admin12345 pixi run -e api start-backend',
```

Update the config's top JSDoc (lines 6–10) to reflect the new reality — replace the sentence about "dev-seed enabled so the default user+project exist" with:

```typescript
 *   1. The FastAPI backend (`pixi run -e api start-backend`) on :8000. Uses a
 *      throwaway SQLite file at /tmp/data-rover-e2e.db; dev-seed creates the
 *      schema and the bootstrap admin (admin@example.com/admin12345). The
 *      "Smart City" project is created by the `setup` project (seed.setup.ts),
 *      not autoloaded.
```

- [ ] **Step 3: Run the e2e suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: the `setup` project runs first and creates "Smart City"; `chromium` specs (which call `openDefaultProject` / click "Smart City") pass.

> If a backend is already running locally from `.env` (`reuseExistingServer: true`), the setup step is idempotent (it skips when "Smart City" exists) but that server must have the bootstrap admin. When in doubt, stop the local backend so Playwright starts its own with the env above.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/seed.setup.ts frontend/playwright.config.ts
git commit -m "$(cat <<'EOF'
test(e2e): seed Smart City project via a Playwright setup project

The backend no longer autoloads a default model, so create the e2e
project through the wizard API in a setup project and provision the admin
via DATA_ROVER_BOOTSTRAP_ADMIN_*.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Align documentation

**Files:**
- Modify: `README.md` (lines 22–25, 40–48, 59–159, 195–239)
- Modify: `CLAUDE.md` (lines 42, 75, 115)
- Modify: `frontend/README.md` (lines 30–34)

**Interfaces:**
- Consumes: the behavior established in Tasks 1–3.
- Produces: docs that describe one bootstrap admin, no autoloaded project, wizard-created projects, and manual example import.

- [ ] **Step 1: README — intro + configure steps**

In `README.md`:

Replace the parenthetical in the "Running locally" intro (lines 24–25) `... the dev seed (auto-provisioned admin + `default` project).` with:
`... the dev seed (creates the SQLite/dev schema; the single admin comes from DATA_ROVER_BOOTSTRAP_ADMIN_*).`

In the "1. Configure (once)" block (lines 42–48) remove the `cp dev-users.example.json dev-users.json` line and its mention, leaving:

```sh
cp .env.example .env                       # backend config (Postgres + GCS + admin)
```
and change the following paragraph to: ``.env`` is gitignored — it is your local config. The defaults already match `docker-compose.yml`, so you can run as-is.

- [ ] **Step 2: README — first-boot + login sections**

Replace lines 59–102 (from "On first boot..." through the end of "Logging in & seeding the first admin") with:

```markdown
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
```

- [ ] **Step 3: README — replace dev-members + seeded-model sections with a "creating a project" section**

Replace lines 103–173 (the "Pre-provisioning dev **members**" and "Editing the seeded **model**" sections, up to but not including "### Testing multiple users in the browser") with:

```markdown
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
```

- [ ] **Step 4: README — testing-multiple-users note + reference tables**

In the "Testing multiple users" section, change the legacy-header note (lines 188–193) to drop the `dev-users.json members work directly` clause — end the sentence at "against the API." and keep the SPA sentence.

In the Reference table (lines 197–209) delete the `DATA_ROVER_SEED_*` and `DATA_ROVER_DEV_USERS_FILE` rows, and change the `DATA_ROVER_DEV_SEED` row to:
`| `DATA_ROVER_DEV_SEED` | `true` | Create the SQLite schema on startup (`false` in prod) |`

In the pixi-commands table, change the `services-reset` description to drop "(needed to re-seed the model)" → just "Stop + wipe data volumes".

Replace the "Applying changes — mental model" table (lines 229–239) with:

```markdown
### Applying changes — mental model

| Change | What to do |
|---|---|
| Add a user / change role | Create + manage in the in-app **Admin console** (no restart) |
| Change the first admin | Set `DATA_ROVER_BOOTSTRAP_ADMIN_*` in `.env` → restart (create-or-promote) |
| Add a project | **New Project** wizard (or the importer CLI) — no restart |
| Change ports / DB / storage config | Edit `.env` → restart backend (some need `services-reset`) |
```

- [ ] **Step 5: CLAUDE.md — three touch-ups**

In `CLAUDE.md`:
- Line 42: change "the seeded `default` project (dev-seed) or a project created via the New Project wizard" to "a project created via the New Project wizard (or imported via the importer CLI)".
- Line 75 (the dev-seed bullet): replace its `_ensure_dev_seed` description so it reads that `_ensure_dev_seed` (gated by `settings.dev_seed`, SQLite-only) **only creates the schema** — no model/user seeding — and that `_ensure_bootstrap_admin` is the sole user-seed path. Keep the `_guard_prod_secret` sentence.
- Line 115: change "the dev-seed reuses it to load `examples/smart-city.*` into `default`" to "the importer CLI / New Project wizard load `examples/smart-city.*` on demand (no autoload)".

- [ ] **Step 6: frontend/README.md**

Replace lines 32–34's clause "on first boot the dev seed provisions an admin (`admin@example.com` / `admin12345`) and the `default` project; the app opens the **login** page." with:
"on first boot the backend ensures the bootstrap admin (`admin@example.com` / `admin12345`) exists — no project is autoloaded; the app opens the **login** page and projects are created via the New Project wizard."

- [ ] **Step 7: Verify no stale references remain**

Run: `grep -rnE 'dev-users|DEV_USERS_FILE|SEED_METAMODEL|SEED_MODEL|SEED_VIEW|autoload' README.md CLAUDE.md frontend/README.md`
Expected: no output (or only intentional "no autoload" phrasing).

- [ ] **Step 8: Commit**

```bash
git add README.md CLAUDE.md frontend/README.md
git commit -m "$(cat <<'EOF'
docs: describe single bootstrap admin + wizard-created projects

Drop dev-users.json and SEED_* docs; document that dev-seed only creates
the SQLite schema, the single admin comes from BOOTSTRAP_ADMIN_*, and
projects/examples are created via the wizard or importer CLI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (main.py gut) → Task 1 Steps 4. ✓
- Spec §2 (settings) → Task 1 Step 5. ✓
- Spec §3 (env files) → Task 2 Steps 2–3. ✓
- Spec §4 (sample files delete / examples kept) → Task 2 Step 1; examples untouched. ✓
- Spec §5 (tests) → Task 1 Steps 1–2, 6–7. ✓
- Spec §6 (e2e) → Task 3. ✓
- Spec §7 (docs) → Task 4. ✓

**Placeholder scan:** No TBD/TODO; all code and commands are concrete. ✓

**Type/name consistency:** `_ensure_dev_seed(settings)` signature preserved; `create_all`, `db.get_db`, `Project`, `set_snapshot_store`, wizard field names (`name`/`metamodel`/`model`/`view`), CSRF header `x-requested-with: data-rover`, and admin creds `admin@example.com`/`admin12345` are used consistently across tasks. ✓

**Note for executor:** line numbers are from the pre-change snapshot; if a prior task shifts them, match on the quoted text instead.
