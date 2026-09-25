# Local Auth + Project Picker + Admin Console — Design

**Date:** 2026-06-25
**Status:** Design approved; ready for implementation plan.
**Predecessor context:** `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md`
(this is the deferred "project-picker UI / multi-project frontend UX" plus an interim local-auth
implementation of the `IdentityProvider` seam — see that spec's §13 open question #1 and the Phase 2
plan's explicit deferral of the project-picker UX).

## 1. Purpose & scope

Today the cloud app cannot let a user log in and choose a model: the frontend is hardwired to
`/api/v1/projects/default` with dev identity headers, and the only roles that exist are the
**per-project** `owner`/`editor`/`viewer`. The backend tenancy layer (`User`/`Project`/`Membership`,
membership-filtered `GET /api/v1/projects`, project/member CRUD) already exists but has no UI and no
real authentication.

This feature delivers four coupled pieces on top of that existing tenancy layer:

1. **A login page** — simple email + password (deliberately minimal; company SSO is a later swap via the
   existing `IdentityProvider` seam).
2. **A project picker page** — lists the projects a user can open (search + open + "New project" wizard).
3. **System-level permissions** — a single global `is_admin` flag governing who manages users, who
   manages project membership, and who can create projects.
4. **An admin console** — admins add/edit users and manage each project's membership.

**Explicitly out of scope (YAGNI for this iteration):** company SSO/OIDC/SAML implementation (the seam
stays), email sending / invite-link onboarding, password self-signup, per-token revocation lists,
multi-org tenancy, fine-grained global roles beyond a single admin flag.

## 2. Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| Global role model | **Single `is_admin` boolean** on `User`. No separate "can create projects" flag — admins create projects; non-admins cannot. |
| User onboarding | **Admin-only provisioning.** No public sign-up. Admin creates each user with email + initial password. |
| Session mechanism | **httpOnly session cookie** carrying a server-issued token. |
| Token strategy | **Stateless JWT** (signed, short-lived). Revocation via an `is_active` flag re-checked per request — no session table. |
| New-project flow | **Create + upload wizard:** name + metamodel (required); model optional (empty model if omitted); view optional. Builds a rev-0 baseline via the existing `importer`. |
| Picker visibility | **Members see their own projects; admins see all.** |
| Membership management | **Centralized in the admin console.** Project owners do not self-manage membership via the UI; membership routes move from `require_owner` to `require_admin`. |

## 3. Architecture

This is the interim local-auth implementation of the `IdentityProvider` seam plus the project-picker and
admin frontend. Company SSO can later replace **one provider** (`CookieIdentityProvider`) and leave the
picker, admin console, and permission model intact.

```
Browser SPA
  ├─ /login                 → POST /auth/login → Set-Cookie: session=<JWT>
  ├─ /projects              → GET /projects (member-filtered, or all for admin)
  ├─ /admin                 → /admin/* (require_admin)
  └─ /p/[projectId]         → existing workspace, project-scoped data routes

FastAPI
  ├─ auth.py                 hashing (Argon2id) + JWT mint/verify + cookie helpers
  ├─ identity.py             + CookieIdentityProvider (default); DevHeaderIdentityProvider retained
  ├─ authz.py               + require_admin; membership/create re-gated to admin
  ├─ routes/auth.py          login / logout / me / change-password
  ├─ routes/admin.py         user CRUD + system-wide membership management
  └─ routes/projects.py      create-project wizard (multipart → importer); list-all for admin
```

### 3.1 Data model changes

Three columns added to the existing `users` table (**Alembic migration `0006`**; current head is `0005`;
SQLite dev/test via `create_all`):

- `password_hash: Mapped[str | None]` — Argon2id hash. **Nullable** so a future SSO-only user can exist
  without a local password.
- `is_admin: Mapped[bool]` — default `False`. The single global role.
- `is_active: Mapped[bool]` — default `True`. Deactivation is the revocation lever (an inactive user is
  rejected `401` on the next request even with a still-valid JWT).

The per-project `Role` enum and `Membership` table are **unchanged**. `is_admin` sits above per-project
roles; it does not replace them.

### 3.2 Auth flow

```
POST /auth/login {email, password}
   → look up user by email; verify Argon2id hash; verify is_active
   → mint JWT { sub: user_id, is_admin, exp }
   → Set-Cookie: session=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/
   → 200 { user_id, email, is_admin }   (401 on any failure, uniform message)

every authenticated request
   → CookieIdentityProvider.identify(conn): read cookie, verify sig+exp
   → load User row → 401 if missing or not is_active
   → Identity(user_id, email)            (NO auto-provision on this path)

POST /auth/logout → clear cookie (204)
```

`get_current_user` stops auto-provisioning when the cookie provider is active: an unknown or inactive
subject is a `401`, not a silent insert. (Auto-provision remains only on the `DevHeaderIdentityProvider`
path, used by gateway deployments and legacy data-route tests.)

## 4. API surface

### 4.1 Auth — `/api/v1/auth` (unauthenticated except `/me`)

| Method & path | Body / result | Notes |
|---|---|---|
| `POST /auth/login` | `{email, password}` → `{user_id, email, is_admin}` + cookie | Uniform `401 invalid credentials` (no user enumeration). |
| `POST /auth/logout` | → `204`, clears cookie | |
| `GET /auth/me` | → `{user_id, email, is_admin}` | Drives the frontend guard; `401` if unauthenticated. |
| `POST /auth/change-password` | `{old_password, new_password}` → `204` | Self-service. Verifies `old`; length floor on `new`. |

### 4.2 Admin — `/api/v1/admin` (all `require_admin`)

| Method & path | Purpose |
|---|---|
| `GET /admin/users?q=` | List users (`id, email, is_admin, is_active`); optional search over email. |
| `POST /admin/users` | Create `{email, password, is_admin}` → `201`; `409` on duplicate email. |
| `PATCH /admin/users/{id}` | Edit any of `is_admin` / `is_active` / `password` (reset). |
| `DELETE /admin/users/{id}` | Delete user (memberships cascade; commit `author_id`→NULL preserves history). |
| `GET /admin/projects/{id}/members` | List a project's members + roles. |
| `POST /admin/projects/{id}/members` | Add/update member `{user_id, role}`. |
| `DELETE /admin/projects/{id}/members/{user_id}` | Remove member (last-owner guard ⇒ `422`). |

Membership management is **moved** to the admin namespace (gated `require_admin`). The existing
`/projects/{id}/members` routes are either removed or re-gated to `require_admin`; the implementation
plan picks one (preference: re-gate in place to minimize route churn, and have the admin console call
them — functionally identical to a dedicated `/admin/projects/...` path. The table above is the logical
contract regardless of final URL).

### 4.3 Projects — `/api/v1/projects` (re-gated)

- `GET /projects` — admin sees **all** projects; non-admin sees member-filtered (existing behaviour).
  Each row carries the caller's role (admins get a synthesized role label for non-member projects, e.g.
  `owner`/an explicit `admin` marker — implementation detail).
- `POST /projects` — **admin-only** (`require_admin`). **Create-project wizard**: accepts multipart
  `{name, metamodel (required), model? , view?}` and builds the rev-0 baseline through the existing
  `importer` (empty model conforming to the metamodel if `model` omitted). Validates the metamodel parses
  **before** creating any DB rows (no orphan project on bad upload). The creating admin becomes the
  project `owner`.
- `DELETE /projects/{id}` — admin-only.

## 5. Frontend

### 5.1 Routes & guard

```
/login                  LoginForm; on success → /projects
/projects               picker: search box, project cards (name + role),
                        "New project" button (admins only) → NewProjectWizard
/admin                  admin console (admins only): Users tab + Members tab
/p/[projectId]          the workspace (today's "/" +page.svelte, moved + parameterized)
/p/[projectId]/compare  today's /compare
```

- Root `+layout.ts` (or `hooks`) load guard calls `GET /auth/me`: unauthenticated → redirect `/login`.
  `/admin` additionally requires `is_admin` (else redirect `/projects`).
- The SvelteKit app is an SPA (client routing); the guard runs client-side and gates rendering.

### 5.2 API client changes (`frontend/src/lib/api/client.ts` + `identity.ts`)

- Remove `DEV_IDENTITY_HEADERS` injection; add `credentials: 'include'` so the cookie is sent.
- Send the CSRF custom header (`X-Requested-With: data-rover`) on every write.
- Make the base URL **dynamic**: derive `/api/v1/projects/{activeProjectId}` from the `[projectId]`
  route param (an active-project store) instead of the hardcoded `default`.

### 5.3 New components

- `LoginForm` — email + password, error display.
- `ProjectPicker` — searchable list of project cards; opens `/p/{id}`. "New project" (admins) launches:
- `NewProjectWizard` — name → metamodel (required) → model (optional) → view (optional) →
  `POST /projects` multipart → redirect `/p/{newId}`. Reuses file-parsing bits from
  `LoadFilesDialog`/`SwapMetamodelDrawer`.
- `AdminConsole` — `UsersTab` (list/search/create/edit `is_admin`+`is_active`/reset password/delete) and
  `ProjectMembersTab` (pick a project → manage its member list + roles).

## 6. Security

- **Cookie:** `HttpOnly; Secure; SameSite=Strict; Path=/`. `Secure` is settings-controlled (off for
  localhost dev). Same-origin in prod (frontend behind the same gateway); dev uses the Vite proxy so the
  cookie flows.
- **CSRF:** `SameSite=Strict` plus a required custom header (`X-Requested-With: data-rover`) on writes.
  Browsers cannot attach custom headers to cross-site requests, so a forged cross-origin POST is
  rejected. The API client always sends it.
- **Passwords:** Argon2id via `argon2-cffi`'s `PasswordHasher` (added to the `api` pixi env; no passlib). Minimum-length
  floor on create/change. Uniform `401` on login failure (no distinction between unknown email and wrong
  password).
- **JWT:** short TTL (default 8h); `is_active` re-check per request is the revocation lever. Secret from
  settings; required (no insecure default) in production.

## 7. Settings (added to `settings.py`, `DATA_ROVER_` prefix)

| Setting | Purpose |
|---|---|
| `jwt_secret` | HMAC signing secret. Dev default; **must be set** in prod (startup error if missing when `identity_provider=cookie` and not dev). |
| `jwt_ttl_seconds` | Token lifetime (default 28800 = 8h). |
| `auth_cookie_name` | Cookie name (default `session`). |
| `auth_cookie_secure` | Set `Secure` flag (default true; false for local dev). |
| `bootstrap_admin_email` / `bootstrap_admin_password` | Idempotently ensure one admin exists on startup (works independent of `dev_seed`, so prod can seed its first admin). |
| `identity_provider` | `cookie` (default) or `header` (gateway/test). Selects the provider built by `get_identity_provider()`. |

## 8. Bootstrapping & dev-seed reconciliation

- **First admin:** only admins create users, so the first admin is seeded from
  `bootstrap_admin_email`/`_password` on startup — idempotent (upsert; sets `is_admin=True`,
  hashes the password if the user is new or has no hash). Runs in prod too.
- **Dev seed:** `main._ensure_dev_seed` additionally provisions the bootstrap admin and keeps the
  `default` project, so local dev logs in with real credentials instead of header injection.
  `DATA_ROVER_DEV_SEED=false` in production; the bootstrap-admin vars are independent of it.
- **Provider default:** `get_identity_provider()` builds `CookieIdentityProvider` by default;
  `DevHeaderIdentityProvider` is retained behind the `identity_provider=header` setting for gateway
  deployments and the legacy data-route tests.

## 9. Error handling

| Condition | Status |
|---|---|
| Unauthenticated / invalid login / inactive user | `401` |
| Non-admin hits admin route; non-member hits a project; viewer write | `403` |
| Unknown project | `404` |
| Duplicate email on user create | `409` |
| Last-owner removal; invalid op batch | `422` |
| Wizard: metamodel fails to parse | `422` (validated before any DB write) |

## 10. Testing

**Backend (`tests/api/`):**
- `test_auth.py` — login success/failure, logout, `/me`, inactive-user rejection, JWT expiry, CSRF-header
  rejection, change-password.
- `test_admin.py` — user CRUD, admin-gating (non-admin ⇒ 403), duplicate-email 409, deactivate-as-
  revocation, membership matrix, last-owner guard.
- `test_projects_wizard.py` — wizard creates rev-0 baseline; model-optional ⇒ empty model; bad metamodel
  ⇒ 422 with no orphan project; admin-only gating; admin sees all projects in `GET /projects`.
- `conftest.py` — the `client` fixture authenticates via cookie (login helper) **or** keeps the header
  provider via the seam for existing data-route tests (minimize churn; chosen in the plan).

**Frontend:**
- vitest (happy-dom + MSW) for the auth store / route guard, `ProjectPicker` (search, role display),
  `NewProjectWizard` (optional model), `AdminConsole` tabs.
- Playwright e2e: login → pick project → open workspace → admin console add-user → assign membership.

## 11. Open items for the implementation plan

- Final URL choice for membership routes (re-gate `/projects/{id}/members` in place vs. new
  `/admin/projects/...`). Logical contract is fixed; only the path is open.
- The `GET /projects` role label for an admin viewing a non-member project (synthesized `owner` vs an
  explicit `admin` marker in `ProjectOut`).
- Whether to remove the now-unused `require_owner` or keep it for a future owner-self-serve mode
  (lean: keep the function, stop using it on membership routes).
