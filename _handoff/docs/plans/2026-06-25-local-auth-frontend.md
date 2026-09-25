# Local Auth + Project Picker + Admin — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SvelteKit UI for the auth feature: a `/login` page, a `/projects` picker (search + open + admin-only New-Project wizard), an `/admin` console (user CRUD + per-project membership), move the workspace to a project-scoped route, switch the API client from dev identity headers to cookie auth (`credentials:'include'` + CSRF header) with a dynamic per-project base URL, and a route guard that redirects unauthenticated users to `/login`.

**Architecture:** The API client gains a module-global "active base URL" (set from the `[projectId]` route param) plus always-on `credentials:'include'` and a CSRF header on unsafe methods; the dev identity-header injection is removed. A `state/auth.svelte.ts` store holds the current user (from `GET /auth/me`) and a root `+layout.ts` load guard enforces auth + admin gating. New `lib/api/{auth,projects,admin}.ts` modules wrap the non-project-scoped endpoints. New routes `/login`, `/projects`, `/admin`, and the relocated `/p/[projectId]` workspace. The realtime feed authenticates via the same-origin cookie (dev query params dropped).

**Tech Stack:** SvelteKit (static-adapter SPA, `ssr=false`), Svelte 5 runes, TypeScript, Tailwind + shadcn-svelte UI primitives, TanStack Query (already used), Zod. Tests: vitest + happy-dom + MSW; Playwright e2e.

**This is Plan 2 of 2.** Plan 1 (`docs/superpowers/plans/2026-06-25-local-auth-backend.md`) MUST be merged first — this plan consumes its endpoints. Spec: `docs/superpowers/specs/2026-06-25-local-auth-project-picker-admin-design.md`. Read `frontend/README.md` before touching `frontend/src/lib/state/`.

## Global Constraints

- Run everything through **pixi** in the `frontend` env. Commands:
  - All unit tests: `pixi run -e frontend npm test` (alias for `vitest run`).
  - A single test file: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/auth.test.ts'`.
  - Type-check: `pixi run -e frontend npm run check` (svelte-check). Lint/format: `pixi run -e frontend npm run lint` / `npm run format`.
  - e2e: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`.
- **Store convention** (enforced — see `frontend/README.md`): state lives in `lib/state/*.svelte.ts` exposed as **accessor functions** (`getX()`/`setX()`), never exported `$state` bindings. Re-export new accessors from `lib/state/index.ts`.
- **API module convention:** typed REST wrappers in `lib/api/<name>.ts` calling `apiFetch`/`apiFetchRaw`; non-project-scoped endpoints pass `{ baseUrl: '/api/v1' }` as the third arg.
- **UI primitives:** import from `$lib/components/ui/{button,input,dialog,tabs}`; dark theme Tailwind classes (`bg-zinc-950`/`bg-zinc-900`/`border-zinc-800`/`text-zinc-100`/`text-zinc-400`). Match `TopBar.svelte`/`LoadFilesDialog.svelte` style.
- **CSRF contract (from backend):** every unsafe (non-GET/HEAD/OPTIONS) request sent with the session cookie MUST carry header `X-Requested-With: data-rover`, or the backend returns 403.
- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); components mount/unmount in tests via `import { mount, unmount, flushSync } from 'svelte'`.
- Prettier + eslint clean before each commit (`npm run lint`).

---

## File Structure

**Create (api):**
- `src/lib/api/auth.ts` — `login`, `logout`, `me`, `changePassword`.
- `src/lib/api/projects.ts` — `listProjects`, `createProject` (multipart).
- `src/lib/api/admin.ts` — user CRUD + membership management.

**Create (state):**
- `src/lib/state/auth.svelte.ts` — current-user store + `fetchMe`/`signIn`/`signOut`.
- `src/lib/state/active-project.svelte.ts` — active project id + base-URL wiring.

**Create (routes):**
- `src/routes/+page.ts` — redirect `/` → `/projects`.
- `src/routes/login/+page.svelte` — login form.
- `src/routes/projects/+page.svelte` — picker.
- `src/routes/admin/+page.svelte` — admin console.
- `src/routes/p/[projectId]/+page.svelte` — relocated workspace (moved from `src/routes/+page.svelte`).
- `src/routes/p/[projectId]/+page.ts` — set active project from the route param.
- `src/routes/p/[projectId]/compare/+page.svelte` — relocated from `src/routes/compare/+page.svelte`.

**Create (components):**
- `src/lib/components/auth/LoginForm.svelte`
- `src/lib/components/projects/ProjectCard.svelte`
- `src/lib/components/projects/NewProjectWizard.svelte`
- `src/lib/components/admin/UsersTab.svelte`
- `src/lib/components/admin/ProjectMembersTab.svelte`
- `src/lib/components/AppHeader.svelte` — minimal chrome (user email, logout, links) shown on picker/admin.

**Modify:**
- `src/lib/api/client.ts` — `credentials:'include'`, CSRF header, `setActiveBaseUrl`, drop dev-header injection.
- `src/lib/api/identity.ts` — replace dev resolution with `setCurrentUserId`/`getCurrentUserId`.
- `src/lib/api/feed.ts` — project-scoped feed URL, drop dev query params.
- `src/lib/state/realtime.svelte.ts` — pass active project id to the feed.
- `src/lib/state/index.ts` — re-export new accessors.
- `src/routes/+layout.ts` — auth guard load.
- `src/routes/+layout.svelte` — adopt guard data into the auth store; render `AppHeader` off the workspace.
- `playwright.config.ts` — cookie-auth backend env.
- `e2e/helpers/*` + existing specs — log in before workspace actions.

**Delete (after move):** `src/routes/+page.svelte`, `src/routes/compare/+page.svelte`.

---
---

# PHASE A — Client + auth foundation

## Task 1: API client — credentials, CSRF, dynamic base URL; real current-user id

**Files:**
- Modify: `src/lib/api/client.ts`
- Modify: `src/lib/api/identity.ts`
- Test: `src/lib/api/__tests__/client.test.ts` (existing — extend)

**Interfaces:**
- Produces: `setActiveBaseUrl(url: string | null): void` (client.ts); `setCurrentUserId(id: string): void`, `getCurrentUserId(): string` (identity.ts, real-auth versions). `apiFetchRaw` now always sends `credentials:'include'` and adds `X-Requested-With: data-rover` on unsafe methods.

- [ ] **Step 1: Write failing tests for credentials + CSRF + base-URL override**

Append to `src/lib/api/__tests__/client.test.ts` (follow the existing MSW pattern in that file):

```typescript
import { setActiveBaseUrl } from '../client';

describe('cookie-auth client behavior', () => {
  it('adds the CSRF header on unsafe methods and omits it on GET', async () => {
    let postHadCsrf: string | null = null;
    let getHadCsrf: string | null = null;
    server.use(
      http.post('http://t/api/v1/x', ({ request }) => {
        postHadCsrf = request.headers.get('x-requested-with');
        return HttpResponse.json({ ok: true });
      }),
      http.get('http://t/api/v1/x', ({ request }) => {
        getHadCsrf = request.headers.get('x-requested-with');
        return HttpResponse.json({ ok: true });
      })
    );
    await apiFetch('/x', { method: 'POST', body: {} }, { baseUrl: 'http://t/api/v1' });
    await apiFetch('/x', { method: 'GET' }, { baseUrl: 'http://t/api/v1' });
    expect(postHadCsrf).toBe('data-rover');
    expect(getHadCsrf).toBeNull();
  });

  it('uses the active base URL when no per-call baseUrl is given', async () => {
    setActiveBaseUrl('http://active/api/v1/projects/p1');
    let hit = false;
    server.use(
      http.get('http://active/api/v1/projects/p1/y', () => {
        hit = true;
        return HttpResponse.json({ ok: true });
      })
    );
    await apiFetch('/y', { method: 'GET' });
    expect(hit).toBe(true);
    setActiveBaseUrl(null);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/client.test.ts'`
Expected: FAIL — `setActiveBaseUrl` not exported / CSRF header absent.

- [ ] **Step 3: Rewrite the relevant parts of `client.ts`**

Replace the identity import and `DEFAULT_BASE_URL` block (lines 1-24) with:

```typescript
import type { z } from 'zod';
import { errorForStatus, messageFromBody } from './errors';
import { getCurrentUserId } from './identity';

// Re-exported so existing `import { getCurrentUserId } from '$lib/api/client'`
// call sites keep working; the value now comes from the authenticated user
// (set by the auth store after GET /auth/me — see api/identity.ts).
export { getCurrentUserId };

export interface ClientConfig {
	baseUrl?: string;
	fetch?: typeof fetch;
}

export interface ApiFetchInit extends Omit<RequestInit, 'body'> {
	body?: unknown;
	schema?: z.ZodType<unknown>;
	query?: Record<string, string | number | boolean | undefined | null>;
}

// Project-scoped default base URL, set once per workspace from the [projectId]
// route param (see state/active-project.svelte.ts). Non-project-scoped calls
// (auth/admin/projects-list) pass an explicit { baseUrl: '/api/v1' }. The
// hardcoded fallback only matters before any project is active (e.g. the very
// first boot before routing resolves).
const FALLBACK_BASE_URL = '/api/v1/projects/default';
let _activeBaseUrl: string | null = null;

/** Set the project-scoped base URL used by calls that pass no per-call baseUrl. */
export function setActiveBaseUrl(url: string | null): void {
	_activeBaseUrl = url;
}

const _SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'data-rover';
```

In `apiFetchRaw`, replace the base-URL line and the dev-header loop (lines 73-81) with:

```typescript
	const baseUrl = config?.baseUrl ?? _activeBaseUrl ?? FALLBACK_BASE_URL;
	const doFetch = config?.fetch ?? fetch;
	const url = buildUrl(baseUrl, path, init.query);
	const { body, headers } = prepareBody(init);
	const method = (init.method ?? 'GET').toUpperCase();
	if (!_SAFE_METHODS.has(method) && !headers.has(CSRF_HEADER)) {
		headers.set(CSRF_HEADER, CSRF_VALUE);
	}

	const response = await doFetch(url, { ...init, body, headers, credentials: 'include' });
```

- [ ] **Step 4: Replace the dev identity with real current-user state in `identity.ts`**

Replace the whole body of `src/lib/api/identity.ts` with:

```typescript
/**
 * Current-user identity for the authenticated client.
 *
 * The user id is no longer a dev seam — it is the subject of the logged-in
 * user, set by the auth store after GET /api/v1/auth/me succeeds. The checkout
 * store reads getCurrentUserId() to recognize its OWN lock events on the feed.
 * Requests carry identity via the httpOnly session cookie (see api/client.ts),
 * not headers, so there is nothing to inject here.
 */
let _userId = '';

/** Set the authenticated user's id (called by state/auth.svelte.ts after /me). */
export function setCurrentUserId(id: string): void {
	_userId = id;
}

/** The current user's id as seen by the backend. Empty until login resolves. */
export function getCurrentUserId(): string {
	return _userId;
}
```

(This removes `DEV_IDENTITY_HEADERS`, `DEV_USER_ID`, `DEV_USER_EMAIL`, `resolveDevUserId`. Task 6/feed Task 12 update the remaining importers — `feed.ts` is the only other importer; the client import is already fixed above.)

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/client.test.ts'`
Expected: PASS (existing tests + the two new ones). If a pre-existing test asserted the dev headers were sent, update it to assert no `x-user-id` header is sent.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/client.ts frontend/src/lib/api/identity.ts frontend/src/lib/api/__tests__/client.test.ts
git commit -m "feat(frontend): cookie-auth client (credentials + CSRF), dynamic base URL, real user id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Auth API module + auth store

**Files:**
- Create: `src/lib/api/auth.ts`
- Create: `src/lib/state/auth.svelte.ts`
- Modify: `src/lib/state/index.ts`
- Test: `src/lib/api/__tests__/auth.test.ts`, `src/lib/state/__tests__/auth-store.test.ts`

**Interfaces:**
- Produces (api/auth.ts): `interface Me { user_id: string; email: string; is_admin: boolean }`; `login(email, password): Promise<Me>`; `logout(): Promise<void>`; `me(): Promise<Me>`; `changePassword(oldPw, newPw): Promise<void>`. All target `{ baseUrl: '/api/v1' }`.
- Produces (state/auth.svelte.ts): `getCurrentUser(): Me | null`; `fetchMe(): Promise<Me | null>` (null on 401); `signIn(email, password): Promise<void>`; `signOut(): Promise<void>`; `isAdmin(): boolean`.

- [ ] **Step 1: Write failing API-module test**

Create `src/lib/api/__tests__/auth.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import * as auth from '../auth';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('auth api', () => {
  it('login posts credentials to /api/v1/auth/login', async () => {
    let body: unknown;
    server.use(
      http.post('/api/v1/auth/login', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ user_id: 'u1', email: 'a@x', is_admin: true });
      })
    );
    const me = await auth.login('a@x', 'pw');
    expect(body).toEqual({ email: 'a@x', password: 'pw' });
    expect(me.is_admin).toBe(true);
  });

  it('me returns the current user', async () => {
    server.use(
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({ user_id: 'u1', email: 'a@x', is_admin: false })
      )
    );
    expect((await auth.me()).user_id).toBe('u1');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/auth.test.ts'`
Expected: FAIL — module `../auth` not found.

- [ ] **Step 3: Implement `src/lib/api/auth.ts`**

```typescript
import { z } from 'zod';
import { apiFetch } from './client';

const API = { baseUrl: '/api/v1' };

export const MeSchema = z.object({
	user_id: z.string(),
	email: z.string(),
	is_admin: z.boolean()
});
export type Me = z.infer<typeof MeSchema>;

export function login(email: string, password: string): Promise<Me> {
	return apiFetch('/auth/login', { method: 'POST', body: { email, password }, schema: MeSchema }, API);
}

export function logout(): Promise<void> {
	return apiFetch('/auth/logout', { method: 'POST' }, API);
}

export function me(): Promise<Me> {
	return apiFetch('/auth/me', { method: 'GET', schema: MeSchema }, API);
}

export function changePassword(oldPassword: string, newPassword: string): Promise<void> {
	return apiFetch(
		'/auth/change-password',
		{ method: 'POST', body: { old_password: oldPassword, new_password: newPassword } },
		API
	);
}
```

- [ ] **Step 4: Run to verify the api test passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/auth.test.ts'`
Expected: PASS.

- [ ] **Step 5: Write failing store test**

Create `src/lib/state/__tests__/auth-store.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { fetchMe, getCurrentUser, isAdmin } from '../auth.svelte';
import { getCurrentUserId } from '../../api/identity';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('auth store', () => {
  it('fetchMe populates the current user and the api identity', async () => {
    server.use(
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({ user_id: 'u9', email: 'z@x', is_admin: true })
      )
    );
    const me = await fetchMe();
    expect(me?.user_id).toBe('u9');
    expect(getCurrentUser()?.email).toBe('z@x');
    expect(isAdmin()).toBe(true);
    expect(getCurrentUserId()).toBe('u9'); // wired into the api identity seam
  });

  it('fetchMe returns null on 401 and leaves no current user', async () => {
    server.use(http.get('/api/v1/auth/me', () => new HttpResponse(null, { status: 401 })));
    expect(await fetchMe()).toBeNull();
    expect(getCurrentUser()).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/auth-store.test.ts'`
Expected: FAIL — `../auth.svelte` not found.

- [ ] **Step 7: Implement `src/lib/state/auth.svelte.ts`**

```typescript
import * as authApi from '$lib/api/auth';
import type { Me } from '$lib/api/auth';
import { setCurrentUserId } from '$lib/api/identity';
import { isUnauthorized } from '$lib/api/errors';

let current = $state<Me | null>(null);

/** The authenticated user, or null when not logged in. */
export function getCurrentUser(): Me | null {
	return current;
}

export function isAdmin(): boolean {
	return current?.is_admin === true;
}

function adopt(me: Me | null): void {
	current = me;
	setCurrentUserId(me?.user_id ?? '');
}

/** Fetch /auth/me; returns the user or null on 401. Populates the store + the
 * api identity seam so the checkout store can recognize its own lock events. */
export async function fetchMe(): Promise<Me | null> {
	try {
		const me = await authApi.me();
		adopt(me);
		return me;
	} catch (err) {
		if (isUnauthorized(err)) {
			adopt(null);
			return null;
		}
		throw err;
	}
}

export async function signIn(email: string, password: string): Promise<void> {
	adopt(await authApi.login(email, password));
}

export async function signOut(): Promise<void> {
	try {
		await authApi.logout();
	} finally {
		adopt(null);
	}
}
```

`errors.ts` has `ApiError` (with `.status`) plus `NotFoundError`/`ConflictError`/`ValidationError` subclasses, but **no** `isUnauthorized` helper and no 401 subclass — add the helper next to `errorForStatus`:

```typescript
export function isUnauthorized(err: unknown): boolean {
	return err instanceof ApiError && err.status === 401;
}
```

- [ ] **Step 8: Re-export accessors from `state/index.ts`**

Add to `src/lib/state/index.ts`:

```typescript
export { getCurrentUser, isAdmin, fetchMe, signIn, signOut } from './auth.svelte';
```

- [ ] **Step 9: Run both tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/auth-store.test.ts src/lib/api/__tests__/auth.test.ts'`
Expected: PASS. Then `pixi run -e frontend npm run check` — clean.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/api/auth.ts frontend/src/lib/state/auth.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/api/errors.ts frontend/src/lib/api/__tests__/auth.test.ts frontend/src/lib/state/__tests__/auth-store.test.ts
git commit -m "feat(frontend): auth api module + current-user store (fetchMe/signIn/signOut)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Active-project store + base-URL wiring

**Files:**
- Create: `src/lib/state/active-project.svelte.ts`
- Modify: `src/lib/state/index.ts`
- Test: `src/lib/state/__tests__/active-project.test.ts`

**Interfaces:**
- Produces: `getActiveProjectId(): string | null`; `setActiveProject(id: string): void` (sets the id AND `setActiveBaseUrl('/api/v1/projects/'+id)`); `clearActiveProject(): void`.

- [ ] **Step 1: Write failing test**

Create `src/lib/state/__tests__/active-project.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { getActiveProjectId, setActiveProject, clearActiveProject } from '../active-project.svelte';

describe('active project store', () => {
  it('tracks the active id', () => {
    expect(getActiveProjectId()).toBeNull();
    setActiveProject('proj-1');
    expect(getActiveProjectId()).toBe('proj-1');
    clearActiveProject();
    expect(getActiveProjectId()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/active-project.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/state/active-project.svelte.ts`**

```typescript
import { setActiveBaseUrl } from '$lib/api/client';

let activeId = $state<string | null>(null);

export function getActiveProjectId(): string | null {
	return activeId;
}

/** Select the active project: tracks the id and points the project-scoped API
 * base URL at it, so every project-scoped apiFetch (which passes no per-call
 * baseUrl) targets /api/v1/projects/{id}. */
export function setActiveProject(id: string): void {
	activeId = id;
	setActiveBaseUrl(`/api/v1/projects/${id}`);
}

export function clearActiveProject(): void {
	activeId = null;
	setActiveBaseUrl(null);
}
```

- [ ] **Step 4: Run + re-export + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/active-project.test.ts'` → PASS.

Add to `src/lib/state/index.ts`:

```typescript
export { getActiveProjectId, setActiveProject, clearActiveProject } from './active-project.svelte';
```

```bash
git add frontend/src/lib/state/active-project.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/active-project.test.ts
git commit -m "feat(frontend): active-project store wiring the dynamic API base URL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
---

# PHASE B — Routing + guard

## Task 4: Root layout guard + app chrome + `/` redirect

**Files:**
- Modify: `src/routes/+layout.ts`
- Modify: `src/routes/+layout.svelte`
- Create: `src/routes/+page.ts`
- Create: `src/lib/components/AppHeader.svelte`
- Test: `src/routes/__tests__/layout-guard.test.ts`

**Interfaces:**
- Consumes: `fetchMe` (auth store), `isAdmin`, `signOut`.
- Produces: a `load` that redirects unauthenticated users to `/login` and non-admins away from `/admin`; `AppHeader` with the user email + logout.

- [ ] **Step 1: Write failing guard test**

The guard logic is a pure function of `(pathname, me)`. Extract it so it is unit-testable. Create `src/routes/guard.ts`:

```typescript
import type { Me } from '$lib/api/auth';

export interface GuardDecision {
	redirectTo: string | null;
}

/** Pure guard: where (if anywhere) to redirect given the path and current user.
 * - unauthenticated (me=null) anywhere except /login → /login
 * - authenticated on /login → /projects
 * - non-admin on /admin* → /projects
 */
export function guardDecision(pathname: string, me: Me | null): GuardDecision {
	const onLogin = pathname === '/login';
	if (!me) return { redirectTo: onLogin ? null : '/login' };
	if (onLogin) return { redirectTo: '/projects' };
	if (pathname.startsWith('/admin') && !me.is_admin) return { redirectTo: '/projects' };
	return { redirectTo: null };
}
```

Create `src/routes/__tests__/layout-guard.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { guardDecision } from '../guard';

const admin = { user_id: 'a', email: 'a@x', is_admin: true };
const user = { user_id: 'u', email: 'u@x', is_admin: false };

describe('guardDecision', () => {
  it('redirects anonymous to /login', () => {
    expect(guardDecision('/projects', null).redirectTo).toBe('/login');
    expect(guardDecision('/login', null).redirectTo).toBeNull();
  });
  it('bounces a logged-in user off /login', () => {
    expect(guardDecision('/login', user).redirectTo).toBe('/projects');
  });
  it('blocks non-admins from /admin', () => {
    expect(guardDecision('/admin', user).redirectTo).toBe('/projects');
    expect(guardDecision('/admin', admin).redirectTo).toBeNull();
  });
  it('allows a normal page', () => {
    expect(guardDecision('/p/x', user).redirectTo).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/routes/__tests__/layout-guard.test.ts'`
Expected: FAIL — `../guard` not found.

- [ ] **Step 3: Implement the guard module (Step 1 already wrote it) and verify pass**

Run the same command. Expected: PASS.

- [ ] **Step 4: Wire the guard into `+layout.ts`**

Replace `src/routes/+layout.ts` with:

```typescript
import { redirect } from '@sveltejs/kit';
import { fetchMe } from '$lib/state/auth.svelte';
import { guardDecision } from './guard';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = async ({ url }) => {
	const me = await fetchMe();
	const { redirectTo } = guardDecision(url.pathname, me);
	if (redirectTo && redirectTo !== url.pathname) throw redirect(307, redirectTo);
	return { me };
};
```

(`fetchMe` runs client-side because `ssr=false`. It populates the auth store as a side effect; the returned `me` is also handed to the layout via `data`.)

- [ ] **Step 5: Implement `AppHeader.svelte`**

Create `src/lib/components/AppHeader.svelte`:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { getCurrentUser, isAdmin, signOut } from '$lib/state';

	const user = $derived(getCurrentUser());

	async function onLogout(): Promise<void> {
		await signOut();
		await goto('/login');
	}
</script>

<header
	class="flex h-10 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-sm"
>
	<div class="flex items-center gap-3">
		<button class="font-semibold tracking-tight text-zinc-100" onclick={() => goto('/projects')}>
			Data Rover
		</button>
		{#if isAdmin()}
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => goto('/admin')}>
				Admin
			</Button>
		{/if}
	</div>
	<div class="flex items-center gap-2">
		<span class="text-xs text-zinc-400">{user?.email}</span>
		<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={onLogout}>Sign out</Button>
	</div>
</header>
```

- [ ] **Step 6: Render `AppHeader` in `+layout.svelte` for non-workspace routes**

In `src/routes/+layout.svelte`, keep the existing `QueryClientProvider` and keyboard-shortcut setup. Wrap the slot so the header shows on `/projects` and `/admin` but NOT on the workspace (`/p/...`, which has its own `TopBar`) or `/login`. Use `$app/stores` `page`:

```svelte
<script lang="ts">
	import { page } from '$app/stores';
	import AppHeader from '$lib/components/AppHeader.svelte';
	// ...existing imports (QueryClientProvider, installKeyboardShortcuts, etc.)
	let { children } = $props();
	const showHeader = $derived(
		!$page.url.pathname.startsWith('/p/') && $page.url.pathname !== '/login'
	);
</script>

<QueryClientProvider client={queryClient}>
	{#if showHeader}
		<AppHeader />
	{/if}
	{@render children()}
</QueryClientProvider>
```

(Adapt to the file's actual existing markup — only ADD the `showHeader` gate + `<AppHeader />`; don't remove existing providers/effects.)

- [ ] **Step 7: Implement `/` redirect**

Create `src/routes/+page.ts`:

```typescript
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
	throw redirect(307, '/projects');
};
```

(Note: `src/routes/+page.svelte` — the old workspace — is moved out in Task 5; once moved, this `+page.ts` owns `/`.)

- [ ] **Step 8: Type-check + commit**

Run: `pixi run -e frontend npm run check` — clean (the workspace move in Task 5 may briefly leave `/` without a `+page.svelte`; that's fine, `+page.ts` redirect covers it).

```bash
git add frontend/src/routes/+layout.ts frontend/src/routes/+layout.svelte frontend/src/routes/+page.ts frontend/src/routes/guard.ts frontend/src/lib/components/AppHeader.svelte frontend/src/routes/__tests__/layout-guard.test.ts
git commit -m "feat(frontend): auth route guard + app header + / redirect to picker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Relocate the workspace to `/p/[projectId]`

**Files:**
- Move: `src/routes/+page.svelte` → `src/routes/p/[projectId]/+page.svelte`
- Create: `src/routes/p/[projectId]/+page.ts`
- Move: `src/routes/compare/+page.svelte` → `src/routes/p/[projectId]/compare/+page.svelte`
- Modify: any in-app links to `/compare`

**Interfaces:**
- Consumes: `setActiveProject` (active-project store), route param `projectId`.

- [ ] **Step 1: Move the workspace file**

```bash
mkdir -p frontend/src/routes/p/\[projectId\]
git mv frontend/src/routes/+page.svelte frontend/src/routes/p/\[projectId\]/+page.svelte
mkdir -p frontend/src/routes/p/\[projectId\]/compare
git mv frontend/src/routes/compare/+page.svelte frontend/src/routes/p/\[projectId\]/compare/+page.svelte
```

- [ ] **Step 2: Add the project-param load**

Create `src/routes/p/[projectId]/+page.ts`:

```typescript
import { setActiveProject } from '$lib/state/active-project.svelte';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
	// Point the project-scoped API base URL at this project BEFORE the page's
	// onMount boot() runs its first project-scoped fetch.
	setActiveProject(params.projectId);
	return { projectId: params.projectId };
};
```

- [ ] **Step 3: Confirm boot uses the active project**

The workspace `boot()` (now in `p/[projectId]/+page.svelte`) calls `metamodelApi.getMetamodel()` etc. with no per-call baseUrl, so they resolve against the active base URL set in Step 2. No change to `boot()` is required. Verify the file has no remaining hardcoded `/projects/default` references:

Run: `grep -rn "projects/default" frontend/src/routes/p` — Expected: no matches.

- [ ] **Step 4: Fix internal links to the old routes**

Search for navigations to `/compare` or assumptions of `/` being the workspace:

Run: `grep -rn "'/compare'\|\"/compare\"\|goto('/')" frontend/src/lib frontend/src/routes`
For each hit, rewrite to the project-scoped path using the active project id, e.g.:

```typescript
import { getActiveProjectId } from '$lib/state';
// ...
goto(`/p/${getActiveProjectId()}/compare`);
```

- [ ] **Step 5: Type-check**

Run: `pixi run -e frontend npm run check`
Expected: clean. Fix any `$types` import path errors from the move.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/routes
git commit -m "refactor(frontend): relocate workspace + compare under /p/[projectId]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
---

# PHASE C — Login page

## Task 6: Login page + form

**Files:**
- Create: `src/routes/login/+page.svelte`
- Create: `src/lib/components/auth/LoginForm.svelte`
- Test: `src/lib/components/__tests__/LoginForm.test.ts`

**Interfaces:**
- Consumes: `signIn` (auth store), `goto`.

- [ ] **Step 1: Write failing component test**

Create `src/lib/components/__tests__/LoginForm.test.ts` (follow the `mount`/`flushSync` pattern from `SwapMetamodelDrawer.test.ts`):

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import LoginForm from '../auth/LoginForm.svelte';

const signIn = vi.fn();
const goto = vi.fn();
vi.mock('$lib/state', () => ({ signIn: (...a: unknown[]) => signIn(...a) }));
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('LoginForm', () => {
  it('signs in and navigates on success', async () => {
    signIn.mockResolvedValue(undefined);
    const c = mount(LoginForm, { target: document.body });
    flushSync();
    (document.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@x';
    (document.querySelector('input[type="email"]') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true })
    );
    (document.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    (document.querySelector('input[type="password"]') as HTMLInputElement).dispatchEvent(
      new Event('input', { bubbles: true })
    );
    flushSync();
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(signIn).toHaveBeenCalledWith('a@x', 'pw');
    expect(goto).toHaveBeenCalledWith('/projects');
    unmount(c);
  });

  it('shows an error message when sign-in fails', async () => {
    signIn.mockRejectedValue(new Error('invalid credentials'));
    const c = mount(LoginForm, { target: document.body });
    flushSync();
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(document.body.textContent).toContain('Invalid');
    expect(goto).not.toHaveBeenCalled();
    unmount(c);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/LoginForm.test.ts'`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `LoginForm.svelte`**

Create `src/lib/components/auth/LoginForm.svelte`:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { signIn } from '$lib/state';

	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let pending = $state(false);

	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = null;
		pending = true;
		try {
			await signIn(email, password);
			await goto('/projects');
		} catch {
			error = 'Invalid email or password.';
		} finally {
			pending = false;
		}
	}
</script>

<form onsubmit={onSubmit} class="flex w-72 flex-col gap-3">
	<h1 class="text-base font-semibold text-zinc-100">Sign in</h1>
	<Input type="email" placeholder="Email" autocomplete="username" bind:value={email} required />
	<Input
		type="password"
		placeholder="Password"
		autocomplete="current-password"
		bind:value={password}
		required
	/>
	{#if error}
		<p class="text-xs text-red-400">{error}</p>
	{/if}
	<Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
</form>
```

- [ ] **Step 4: Implement the page**

Create `src/routes/login/+page.svelte`:

```svelte
<script lang="ts">
	import LoginForm from '$lib/components/auth/LoginForm.svelte';
</script>

<div class="flex min-h-screen items-center justify-center bg-zinc-950">
	<LoginForm />
</div>
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/LoginForm.test.ts'`
Expected: PASS. (If the `Input` component does not forward `type`/`bind:value`, check `src/lib/components/ui/input/input.svelte` and use a plain `<input>` with the same Tailwind classes instead.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/login frontend/src/lib/components/auth frontend/src/lib/components/__tests__/LoginForm.test.ts
git commit -m "feat(frontend): /login page with email+password form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
---

# PHASE D — Project picker

## Task 7: Projects API module

**Files:**
- Create: `src/lib/api/projects.ts`
- Test: `src/lib/api/__tests__/projects.test.ts`

**Interfaces:**
- Produces: `interface ProjectSummary { id: string; name: string; role: 'owner'|'editor'|'viewer' }`; `listProjects(): Promise<ProjectSummary[]>`; `createProject(input: { name: string; metamodel: File; model?: File | null; view?: File | null }): Promise<ProjectSummary>` (multipart). Both target `{ baseUrl: '/api/v1' }`.

- [ ] **Step 1: Write failing test**

Create `src/lib/api/__tests__/projects.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import * as projects from '../projects';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('projects api', () => {
  it('lists projects', async () => {
    server.use(
      http.get('/api/v1/projects', () =>
        HttpResponse.json([{ id: 'p1', name: 'One', role: 'owner' }])
      )
    );
    const ps = await projects.listProjects();
    expect(ps[0]).toEqual({ id: 'p1', name: 'One', role: 'owner' });
  });

  it('creates a project via multipart with name + metamodel', async () => {
    let form: FormData | null = null;
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        form = await request.formData();
        return HttpResponse.json({ id: 'p2', name: 'Fresh', role: 'owner' }, { status: 201 });
      })
    );
    const mm = new File(['types: []'], 'mm.yaml', { type: 'application/yaml' });
    const res = await projects.createProject({ name: 'Fresh', metamodel: mm });
    expect(res.id).toBe('p2');
    expect(form!.get('name')).toBe('Fresh');
    expect((form!.get('metamodel') as File).name).toBe('mm.yaml');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/projects.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/api/projects.ts`**

```typescript
import { z } from 'zod';
import { apiFetch } from './client';

const API = { baseUrl: '/api/v1' };

export const ProjectSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	role: z.enum(['owner', 'editor', 'viewer'])
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export function listProjects(): Promise<ProjectSummary[]> {
	return apiFetch('/projects', { method: 'GET', schema: z.array(ProjectSummarySchema) }, API);
}

export interface CreateProjectInput {
	name: string;
	metamodel: File;
	model?: File | null;
	view?: File | null;
}

export function createProject(input: CreateProjectInput): Promise<ProjectSummary> {
	const form = new FormData();
	form.set('name', input.name);
	form.set('metamodel', input.metamodel);
	if (input.model) form.set('model', input.model);
	if (input.view) form.set('view', input.view);
	// FormData body: apiFetch leaves it as-is (not JSON-stringified) and the
	// browser sets the multipart Content-Type + boundary itself.
	return apiFetch('/projects', { method: 'POST', body: form, schema: ProjectSummarySchema }, API);
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/projects.test.ts'` → PASS.

```bash
git add frontend/src/lib/api/projects.ts frontend/src/lib/api/__tests__/projects.test.ts
git commit -m "feat(frontend): projects api module (list + multipart create)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Project picker page

**Files:**
- Create: `src/routes/projects/+page.svelte`
- Create: `src/lib/components/projects/ProjectCard.svelte`
- Test: `src/lib/components/__tests__/ProjectsPage.test.ts`

**Interfaces:**
- Consumes: `listProjects` (projects api), `isAdmin` (auth store), `goto`, `NewProjectWizard` (Task 9 — gate its mount behind a flag so this task tests independently; wire it in Task 9).

- [ ] **Step 1: Write failing test (list + search + open)**

Create `src/lib/components/__tests__/ProjectsPage.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import Page from '../../../routes/projects/+page.svelte';

const goto = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));
vi.mock('$lib/state', async (orig) => ({ ...(await orig()), isAdmin: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => { server.resetHandlers(); document.body.innerHTML = ''; vi.clearAllMocks(); });
afterAll(() => server.close());

function seed() {
  server.use(
    http.get('/api/v1/projects', () =>
      HttpResponse.json([
        { id: 'p1', name: 'Alpha', role: 'owner' },
        { id: 'p2', name: 'Beta', role: 'viewer' }
      ])
    )
  );
}

describe('projects page', () => {
  it('lists projects and opens one on click', async () => {
    seed();
    const c = mount(Page, { target: document.body });
    // allow the onMount fetch microtasks to settle
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(document.body.textContent).toContain('Alpha');
    expect(document.body.textContent).toContain('Beta');
    const alpha = [...document.querySelectorAll('button,a')].find((el) =>
      el.textContent?.includes('Alpha')
    ) as HTMLElement;
    alpha.click();
    expect(goto).toHaveBeenCalledWith('/p/p1');
    unmount(c);
  });

  it('filters by the search box', async () => {
    seed();
    const c = mount(Page, { target: document.body });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    const search = document.querySelector('input[type="search"]') as HTMLInputElement;
    search.value = 'bet';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(document.body.textContent).toContain('Beta');
    expect(document.body.textContent).not.toContain('Alpha');
    unmount(c);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProjectsPage.test.ts'`
Expected: FAIL — page not found.

- [ ] **Step 3: Implement `ProjectCard.svelte`**

```svelte
<script lang="ts">
	import type { ProjectSummary } from '$lib/api/projects';
	let { project, onOpen }: { project: ProjectSummary; onOpen: (id: string) => void } = $props();
</script>

<button
	class="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-left hover:border-zinc-700"
	onclick={() => onOpen(project.id)}
>
	<span class="text-sm text-zinc-100">{project.name}</span>
	<span class="text-xs text-zinc-400">{project.role}</span>
</button>
```

- [ ] **Step 4: Implement the picker page**

Create `src/routes/projects/+page.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { isAdmin } from '$lib/state';
	import { listProjects, type ProjectSummary } from '$lib/api/projects';
	import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
	import NewProjectWizard from '$lib/components/projects/NewProjectWizard.svelte';

	let projects = $state<ProjectSummary[]>([]);
	let query = $state('');
	let wizardOpen = $state(false);

	const filtered = $derived(
		projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
	);

	async function refresh(): Promise<void> {
		projects = await listProjects();
	}
	onMount(refresh);

	function open(id: string): void {
		void goto(`/p/${id}`);
	}
	async function onCreated(id: string): Promise<void> {
		wizardOpen = false;
		await refresh();
		open(id);
	}
</script>

<div class="mx-auto flex max-w-2xl flex-col gap-4 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-lg font-semibold text-zinc-100">Projects</h1>
		{#if isAdmin()}
			<Button size="sm" onclick={() => (wizardOpen = true)}>New project</Button>
		{/if}
	</div>
	<Input type="search" placeholder="Search projects…" bind:value={query} />
	<div class="flex flex-col gap-2">
		{#each filtered as p (p.id)}
			<ProjectCard project={p} onOpen={open} />
		{:else}
			<p class="text-sm text-zinc-500">No projects.</p>
		{/each}
	</div>
</div>

{#if isAdmin()}
	<NewProjectWizard bind:open={wizardOpen} {onCreated} />
{/if}
```

(Note: `NewProjectWizard` is built in Task 9. Since the test mocks `isAdmin: () => false`, the wizard is not mounted during this task's test. Create a minimal placeholder `NewProjectWizard.svelte` with `let { open = $bindable(false), onCreated }: { open?: boolean; onCreated: (id: string) => void } = $props();` and an empty `{#if open}{/if}` so the import resolves; Task 9 fills it in.)

- [ ] **Step 5: Run to verify pass + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProjectsPage.test.ts'` → PASS.

```bash
git add frontend/src/routes/projects frontend/src/lib/components/projects frontend/src/lib/components/__tests__/ProjectsPage.test.ts
git commit -m "feat(frontend): project picker page (list + search + open)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: New-project wizard

**Files:**
- Modify (replace placeholder): `src/lib/components/projects/NewProjectWizard.svelte`
- Test: `src/lib/components/__tests__/NewProjectWizard.test.ts`

**Interfaces:**
- Consumes: `createProject` (projects api). Props: `open: boolean` (`$bindable`), `onCreated: (id: string) => void`.

- [ ] **Step 1: Write failing test**

Create `src/lib/components/__tests__/NewProjectWizard.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import NewProjectWizard from '../projects/NewProjectWizard.svelte';

const createProject = vi.fn();
vi.mock('$lib/api/projects', () => ({ createProject: (...a: unknown[]) => createProject(...a) }));

afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

function setFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('NewProjectWizard', () => {
  it('creates a project with name + metamodel only (model optional)', async () => {
    createProject.mockResolvedValue({ id: 'pX', name: 'W', role: 'owner' });
    const onCreated = vi.fn();
    const c = mount(NewProjectWizard, { target: document.body, props: { open: true, onCreated } });
    flushSync();
    const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
    name.value = 'W';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    setFile(
      document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
      new File(['types: []'], 'mm.yaml')
    );
    flushSync();
    document.querySelector('form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'W', metamodel: expect.any(File) })
    );
    expect(onCreated).toHaveBeenCalledWith('pX');
    unmount(c);
  });

  it('disables submit until a name and a metamodel are provided', async () => {
    const c = mount(NewProjectWizard, {
      target: document.body,
      props: { open: true, onCreated: vi.fn() }
    });
    flushSync();
    const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    unmount(c);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/NewProjectWizard.test.ts'`
Expected: FAIL — placeholder has no form.

- [ ] **Step 3: Implement the wizard** (reuses the `file.text()`/file-input pattern from `LoadFilesDialog.svelte`, but passes the raw `File`s to the multipart `createProject`)

Replace `src/lib/components/projects/NewProjectWizard.svelte`:

```svelte
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { createProject } from '$lib/api/projects';

	let {
		open = $bindable(false),
		onCreated
	}: { open?: boolean; onCreated: (id: string) => void } = $props();

	let name = $state('');
	let metamodel = $state<File | null>(null);
	let model = $state<File | null>(null);
	let view = $state<File | null>(null);
	let error = $state<string | null>(null);
	let pending = $state(false);

	const canSubmit = $derived(name.trim().length > 0 && metamodel !== null);

	function pick(setter: (f: File | null) => void) {
		return (e: Event) => setter((e.target as HTMLInputElement).files?.[0] ?? null);
	}

	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!canSubmit || !metamodel) return;
		error = null;
		pending = true;
		try {
			const created = await createProject({ name, metamodel, model, view });
			onCreated(created.id);
		} catch {
			error = 'Could not create the project. Check the metamodel file.';
		} finally {
			pending = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>New project</Dialog.Title>
			<Dialog.Description>
				Name the project and upload a metamodel. The model and view are optional —
				an empty model is created if you skip it.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col gap-3">
			<Input name="project-name" placeholder="Project name" bind:value={name} required />
			<label class="text-xs text-zinc-400">
				Metamodel (.yaml, required)
				<input
					data-testid="mm-input"
					type="file"
					accept=".yaml,.yml"
					class="mt-1 block text-xs"
					onchange={pick((f) => (metamodel = f))}
				/>
			</label>
			<label class="text-xs text-zinc-400">
				Model (.json, optional)
				<input
					data-testid="model-input"
					type="file"
					accept=".json"
					class="mt-1 block text-xs"
					onchange={pick((f) => (model = f))}
				/>
			</label>
			<label class="text-xs text-zinc-400">
				View (.json, optional)
				<input
					type="file"
					accept=".json"
					class="mt-1 block text-xs"
					onchange={pick((f) => (view = f))}
				/>
			</label>
			{#if error}
				<p class="text-xs text-red-400">{error}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<Button type="submit" disabled={!canSubmit || pending}>
					{pending ? 'Creating…' : 'Create'}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/NewProjectWizard.test.ts'` → PASS. (If `Dialog` portals its content out of `document.body` in happy-dom and the queries miss it, render the form inside an `{#if open}` block directly rather than relying on the portal — keep the same inputs/testids.)

```bash
git add frontend/src/lib/components/projects/NewProjectWizard.svelte frontend/src/lib/components/__tests__/NewProjectWizard.test.ts
git commit -m "feat(frontend): new-project wizard (multipart create, model optional)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
---

# PHASE E — Admin console

## Task 10: Admin API module

**Files:**
- Create: `src/lib/api/admin.ts`
- Test: `src/lib/api/__tests__/admin.test.ts`

**Interfaces:**
- Produces (all `{ baseUrl: '/api/v1' }`):
  - `interface AdminUser { id: string; email: string; is_admin: boolean; is_active: boolean }`
  - `listUsers(q?: string): Promise<AdminUser[]>`
  - `createUser(input: { email: string; password: string; is_admin: boolean }): Promise<AdminUser>`
  - `patchUser(id: string, patch: { is_admin?: boolean; is_active?: boolean; password?: string }): Promise<AdminUser>`
  - `deleteUser(id: string): Promise<void>`
  - `interface Member { user_id: string; email: string; role: 'owner'|'editor'|'viewer' }`
  - `listMembers(projectId): Promise<Member[]>`; `addMember(projectId, user_id, role): Promise<Member>`; `removeMember(projectId, user_id): Promise<void>`

- [ ] **Step 1: Write failing test**

Create `src/lib/api/__tests__/admin.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import * as admin from '../admin';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('admin api', () => {
  it('lists users with a query', async () => {
    let url = '';
    server.use(
      http.get('/api/v1/admin/users', ({ request }) => {
        url = request.url;
        return HttpResponse.json([{ id: 'u1', email: 'a@x', is_admin: false, is_active: true }]);
      })
    );
    const us = await admin.listUsers('a');
    expect(us[0].email).toBe('a@x');
    expect(url).toContain('q=a');
  });

  it('creates and patches a user', async () => {
    server.use(
      http.post('/api/v1/admin/users', () =>
        HttpResponse.json({ id: 'u2', email: 'b@x', is_admin: true, is_active: true }, { status: 201 })
      ),
      http.patch('/api/v1/admin/users/u2', () =>
        HttpResponse.json({ id: 'u2', email: 'b@x', is_admin: false, is_active: true })
      )
    );
    expect((await admin.createUser({ email: 'b@x', password: 'secret12', is_admin: true })).id).toBe('u2');
    expect((await admin.patchUser('u2', { is_admin: false })).is_admin).toBe(false);
  });

  it('adds a member', async () => {
    server.use(
      http.post('/api/v1/admin/projects/p1/members', () =>
        HttpResponse.json({ user_id: 'u1', email: 'a@x', role: 'editor' }, { status: 201 })
      )
    );
    expect((await admin.addMember('p1', 'u1', 'editor')).role).toBe('editor');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/admin.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/api/admin.ts`**

```typescript
import { z } from 'zod';
import { apiFetch } from './client';

const API = { baseUrl: '/api/v1' };

export const AdminUserSchema = z.object({
	id: z.string(),
	email: z.string(),
	is_admin: z.boolean(),
	is_active: z.boolean()
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const MemberSchema = z.object({
	user_id: z.string(),
	email: z.string(),
	role: z.enum(['owner', 'editor', 'viewer'])
});
export type Member = z.infer<typeof MemberSchema>;

export function listUsers(q = ''): Promise<AdminUser[]> {
	return apiFetch('/admin/users', { method: 'GET', query: { q: q || undefined }, schema: z.array(AdminUserSchema) }, API);
}

export function createUser(input: { email: string; password: string; is_admin: boolean }): Promise<AdminUser> {
	return apiFetch('/admin/users', { method: 'POST', body: input, schema: AdminUserSchema }, API);
}

export function patchUser(
	id: string,
	patch: { is_admin?: boolean; is_active?: boolean; password?: string }
): Promise<AdminUser> {
	return apiFetch(`/admin/users/${id}`, { method: 'PATCH', body: patch, schema: AdminUserSchema }, API);
}

export function deleteUser(id: string): Promise<void> {
	return apiFetch(`/admin/users/${id}`, { method: 'DELETE' }, API);
}

export function listMembers(projectId: string): Promise<Member[]> {
	return apiFetch(`/admin/projects/${projectId}/members`, { method: 'GET', schema: z.array(MemberSchema) }, API);
}

export function addMember(projectId: string, userId: string, role: Member['role']): Promise<Member> {
	return apiFetch(
		`/admin/projects/${projectId}/members`,
		{ method: 'POST', body: { user_id: userId, role }, schema: MemberSchema },
		API
	);
}

export function removeMember(projectId: string, userId: string): Promise<void> {
	return apiFetch(`/admin/projects/${projectId}/members/${userId}`, { method: 'DELETE' }, API);
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/admin.test.ts'` → PASS.

```bash
git add frontend/src/lib/api/admin.ts frontend/src/lib/api/__tests__/admin.test.ts
git commit -m "feat(frontend): admin api module (user CRUD + membership)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Admin console page (Users + Members tabs)

**Files:**
- Create: `src/routes/admin/+page.svelte`
- Create: `src/lib/components/admin/UsersTab.svelte`
- Create: `src/lib/components/admin/ProjectMembersTab.svelte`
- Test: `src/lib/components/__tests__/UsersTab.test.ts`

**Interfaces:**
- Consumes: admin api (`listUsers`/`createUser`/`patchUser`/`deleteUser`/`listProjects`/`listMembers`/`addMember`/`removeMember`), `Tabs` UI primitive.

- [ ] **Step 1: Write failing UsersTab test**

Create `src/lib/components/__tests__/UsersTab.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import UsersTab from '../admin/UsersTab.svelte';

const listUsers = vi.fn();
const createUser = vi.fn();
const patchUser = vi.fn();
vi.mock('$lib/api/admin', () => ({
  listUsers: (...a: unknown[]) => listUsers(...a),
  createUser: (...a: unknown[]) => createUser(...a),
  patchUser: (...a: unknown[]) => patchUser(...a),
  deleteUser: vi.fn()
}));

afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('UsersTab', () => {
  it('lists users on mount', async () => {
    listUsers.mockResolvedValue([{ id: 'u1', email: 'a@x', is_admin: true, is_active: true }]);
    const c = mount(UsersTab, { target: document.body });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(document.body.textContent).toContain('a@x');
    unmount(c);
  });

  it('creates a user from the form', async () => {
    listUsers.mockResolvedValue([]);
    createUser.mockResolvedValue({ id: 'u9', email: 'new@x', is_admin: false, is_active: true });
    const c = mount(UsersTab, { target: document.body });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    const email = document.querySelector('input[name="new-email"]') as HTMLInputElement;
    email.value = 'new@x'; email.dispatchEvent(new Event('input', { bubbles: true }));
    const pw = document.querySelector('input[name="new-password"]') as HTMLInputElement;
    pw.value = 'secret12'; pw.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    document.querySelector('form[data-testid="new-user-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(createUser).toHaveBeenCalledWith({ email: 'new@x', password: 'secret12', is_admin: false });
    unmount(c);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/UsersTab.test.ts'`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `UsersTab.svelte`**

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { listUsers, createUser, patchUser, deleteUser, type AdminUser } from '$lib/api/admin';

	let users = $state<AdminUser[]>([]);
	let query = $state('');
	let email = $state('');
	let password = $state('');
	let makeAdmin = $state(false);
	let error = $state<string | null>(null);

	async function refresh(): Promise<void> {
		users = await listUsers(query);
	}
	onMount(refresh);

	async function onCreate(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = null;
		try {
			await createUser({ email, password, is_admin: makeAdmin });
			email = '';
			password = '';
			makeAdmin = false;
			await refresh();
		} catch {
			error = 'Could not create user (email may already exist).';
		}
	}

	async function toggleAdmin(u: AdminUser): Promise<void> {
		await patchUser(u.id, { is_admin: !u.is_admin });
		await refresh();
	}
	async function toggleActive(u: AdminUser): Promise<void> {
		await patchUser(u.id, { is_active: !u.is_active });
		await refresh();
	}
	async function remove(u: AdminUser): Promise<void> {
		await deleteUser(u.id);
		await refresh();
	}
</script>

<div class="flex flex-col gap-4">
	<form data-testid="new-user-form" onsubmit={onCreate} class="flex items-end gap-2">
		<Input name="new-email" type="email" placeholder="Email" bind:value={email} required />
		<Input name="new-password" type="password" placeholder="Initial password" bind:value={password} required />
		<label class="flex items-center gap-1 text-xs text-zinc-400">
			<input type="checkbox" bind:checked={makeAdmin} /> admin
		</label>
		<Button type="submit" size="sm">Add user</Button>
	</form>
	{#if error}<p class="text-xs text-red-400">{error}</p>{/if}

	<Input type="search" placeholder="Search users…" bind:value={query} oninput={refresh} />

	<table class="w-full text-sm">
		<tbody>
			{#each users as u (u.id)}
				<tr class="border-b border-zinc-800">
					<td class="py-1 text-zinc-100">{u.email}</td>
					<td class="py-1">
						<button class="text-xs text-zinc-400" onclick={() => toggleAdmin(u)}>
							{u.is_admin ? 'admin' : 'user'}
						</button>
					</td>
					<td class="py-1">
						<button class="text-xs text-zinc-400" onclick={() => toggleActive(u)}>
							{u.is_active ? 'active' : 'disabled'}
						</button>
					</td>
					<td class="py-1 text-right">
						<button class="text-xs text-red-400" onclick={() => remove(u)}>delete</button>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
```

- [ ] **Step 4: Implement `ProjectMembersTab.svelte`**

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { listProjects, type ProjectSummary } from '$lib/api/projects';
	import { listMembers, addMember, removeMember, type Member } from '$lib/api/admin';

	let projects = $state<ProjectSummary[]>([]);
	let selected = $state<string>('');
	let members = $state<Member[]>([]);
	let newUserId = $state('');
	let newRole = $state<Member['role']>('editor');

	onMount(async () => {
		projects = await listProjects();
		if (projects.length) await select(projects[0].id);
	});

	async function select(id: string): Promise<void> {
		selected = id;
		members = await listMembers(id);
	}
	async function add(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		await addMember(selected, newUserId, newRole);
		newUserId = '';
		members = await listMembers(selected);
	}
	async function remove(userId: string): Promise<void> {
		await removeMember(selected, userId);
		members = await listMembers(selected);
	}
</script>

<div class="flex flex-col gap-3">
	<select
		class="rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
		bind:value={selected}
		onchange={() => select(selected)}
	>
		{#each projects as p (p.id)}
			<option value={p.id}>{p.name}</option>
		{/each}
	</select>

	<form onsubmit={add} class="flex items-end gap-2">
		<Input placeholder="User id" bind:value={newUserId} required />
		<select class="rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-100" bind:value={newRole}>
			<option value="owner">owner</option>
			<option value="editor">editor</option>
			<option value="viewer">viewer</option>
		</select>
		<Button type="submit" size="sm">Add member</Button>
	</form>

	<ul class="flex flex-col gap-1">
		{#each members as m (m.user_id)}
			<li class="flex items-center justify-between text-sm">
				<span class="text-zinc-100">{m.email} <span class="text-zinc-500">({m.role})</span></span>
				<button class="text-xs text-red-400" onclick={() => remove(m.user_id)}>remove</button>
			</li>
		{/each}
	</ul>
</div>
```

- [ ] **Step 5: Implement the admin page with tabs**

Create `src/routes/admin/+page.svelte`:

```svelte
<script lang="ts">
	import * as Tabs from '$lib/components/ui/tabs';
	import UsersTab from '$lib/components/admin/UsersTab.svelte';
	import ProjectMembersTab from '$lib/components/admin/ProjectMembersTab.svelte';
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-4 p-6">
	<h1 class="text-lg font-semibold text-zinc-100">Administration</h1>
	<Tabs.Root value="users">
		<Tabs.List>
			<Tabs.Trigger value="users">Users</Tabs.Trigger>
			<Tabs.Trigger value="members">Project members</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="users"><UsersTab /></Tabs.Content>
		<Tabs.Content value="members"><ProjectMembersTab /></Tabs.Content>
	</Tabs.Root>
</div>
```

(Verify the `Tabs` primitive exists at `src/lib/components/ui/tabs/index.ts` with `Root/List/Trigger/Content`. If the export shape differs, match the actual API; if there is no tabs primitive, use two `<section>`s with a simple `$state` toggle instead — the page is not under test, only `UsersTab` is.)

- [ ] **Step 6: Run UsersTab test + type-check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/UsersTab.test.ts'` → PASS.
Run: `pixi run -e frontend npm run check` → clean.

```bash
git add frontend/src/routes/admin frontend/src/lib/components/admin frontend/src/lib/components/__tests__/UsersTab.test.ts
git commit -m "feat(frontend): admin console (users + project-members tabs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
---

# PHASE F — Realtime cookie auth + end-to-end

## Task 12: Project-scoped feed URL over cookie auth

**Files:**
- Modify: `src/lib/api/feed.ts`
- Modify: `src/lib/state/realtime.svelte.ts`
- Test: `src/lib/api/__tests__/feed.test.ts` (existing — adapt) or add a focused URL test.

**Interfaces:**
- Produces: `defaultFeedUrl(projectId: string): string` (project-scoped, no dev query params). The realtime store's `startRealtime(config?: Partial<FeedConfig>)` (line 125) passes `url: defaultFeedUrl(activeProjectId)` into its `connectFeed({...})` call (line 127).

- [ ] **Step 1: Inspect the current URL builder + its callers**

`feed.ts` currently exports `defaultFeedUrl(): string` (no args, lines ~61-64) which builds:

```typescript
const q = `x-user-id=${encodeURIComponent(DEV_USER_ID)}&x-user-email=${encodeURIComponent(DEV_USER_EMAIL)}`;
return `${proto}//${location.host}/api/v1/projects/default/feed?${q}`;
```

importing `DEV_USER_ID, DEV_USER_EMAIL` from `./identity` (which Task 1 removed). `connectFeed(config: FeedConfig)` (line 67) derives its socket URL from `config.url ?? defaultFeedUrl()`. The realtime store calls `connectFeed({...})` from `startRealtime` (line 127). This must change: the browser sends the httpOnly session cookie on the same-origin WS upgrade, so no identity query param is needed, and the project id must be the active one.

- [ ] **Step 2: Write a failing URL test**

Add to `src/lib/api/__tests__/feed.test.ts` (or create it):

```typescript
import { describe, expect, it } from 'vitest';
import { defaultFeedUrl } from '../feed';

describe('defaultFeedUrl', () => {
  it('is project-scoped and carries no identity query params', () => {
    const url = defaultFeedUrl('proj-7');
    expect(url).toContain('/api/v1/projects/proj-7/feed');
    expect(url).not.toContain('x-user-id');
  });
});
```

- [ ] **Step 3: Update `feed.ts`**

Remove the `import { DEV_USER_ID, DEV_USER_EMAIL } from './identity';` line. Replace the URL builder with a function that takes the project id and emits no identity query params:

```typescript
/** Same-origin WebSocket feed URL for a project. Identity travels on the
 * httpOnly session cookie (browsers send it on the same-origin upgrade), so no
 * query params are needed. */
export function defaultFeedUrl(projectId: string): string {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${location.host}/api/v1/projects/${projectId}/feed`;
}
```

Then change `connectFeed`'s URL derivation: since `defaultFeedUrl` now requires a project id that `connectFeed` does not have, require the caller to pass `config.url`. Replace the `config.url ?? defaultFeedUrl()` fallback (line ~68) with `config.url` and, if it is missing, throw a clear error (`throw new Error('connectFeed requires config.url')`). The realtime store always supplies it (Step 4), and feed unit tests that drive `connectFeed` with a `socketFactory` already pass an explicit `url` (or add one).

- [ ] **Step 4: Update `realtime.svelte.ts` to pass the active project's URL**

In `src/lib/state/realtime.svelte.ts` `startRealtime` (line 125), build the URL from the active project and pass it into the existing `connectFeed({...})` call (line 127):

```typescript
import { defaultFeedUrl } from '$lib/api/feed';           // already imports connectFeed/FeedConfig
import { getActiveProjectId } from '$lib/state/active-project.svelte';
// ...inside startRealtime, before connectFeed:
const pid = getActiveProjectId();
if (!pid) return; // no active project ⇒ no feed
_conn = connectFeed({
	url: defaultFeedUrl(pid),
	...config,            // keep the existing onEvent/onStatus/reconnect wiring
	// ensure onEvent/onStatus from the existing body remain set
});
```

(Adapt to the exact existing `connectFeed({...})` argument object — only ADD `url: defaultFeedUrl(pid)` and the `pid` guard; keep the existing `onEvent`/`onStatus` handlers the store already passes.)

- [ ] **Step 5: Run feed tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/feed.test.ts'` → PASS. Adjust any existing feed test that asserted the old `default`-project URL or the dev query params.
Run: `pixi run -e frontend npm run check` → clean (confirms no remaining importers of the removed identity exports).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/feed.ts frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/api/__tests__/feed.test.ts
git commit -m "feat(frontend): project-scoped realtime feed over cookie auth (drop dev query params)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: End-to-end — login + picker + workspace + admin

**Files:**
- Modify: `playwright.config.ts`
- Create: `e2e/helpers/auth.ts`
- Modify: existing specs under `e2e/` (log in + navigate to a project before workspace actions)
- Create: `e2e/auth.spec.ts`

**Interfaces:**
- Consumes: the dev-seeded admin (`admin@example.com` / `admin12345`, from backend Plan Task 10) and the dev-seeded `default` project.

- [ ] **Step 1: Point the e2e backend at cookie auth**

In `playwright.config.ts`, the backend `webServer.command` currently sets `DATA_ROVER_DEV_SEED=true`. Add the cookie-auth env so the dev admin is seeded and the cookie works over plain HTTP:

```
rm -f /tmp/data-rover-e2e.db && DATA_ROVER_DATABASE_URL=sqlite:////tmp/data-rover-e2e.db DATA_ROVER_DEV_SEED=true DATA_ROVER_SNAPSHOT_STORE=memory DATA_ROVER_IDENTITY_PROVIDER=cookie DATA_ROVER_AUTH_COOKIE_SECURE=false pixi run -e api start-backend
```

(`DATA_ROVER_IDENTITY_PROVIDER=cookie` is the default, but set it explicitly; `AUTH_COOKIE_SECURE=false` lets the cookie flow over `http://127.0.0.1`. The dev seed creates `admin@example.com`/`admin12345` per backend Plan Task 10.)

- [ ] **Step 2: Add an auth helper**

Create `e2e/helpers/auth.ts`:

```typescript
import type { Page } from '@playwright/test';

export async function login(page: Page, email = 'admin@example.com', password = 'admin12345'): Promise<void> {
	await page.goto('/login');
	await page.getByPlaceholder('Email').fill(email);
	await page.getByPlaceholder('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL('**/projects');
}

export async function openDefaultProject(page: Page): Promise<void> {
	await login(page);
	await page.getByText('Smart City').click(); // the dev-seeded default project
	await page.waitForURL('**/p/**');
}
```

- [ ] **Step 3: Add the auth smoke spec**

Create `e2e/auth.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test('login lands on the picker and lists the seeded project', async ({ page }) => {
	await login(page);
	await expect(page.getByText('Smart City')).toBeVisible();
});

test('admin console is reachable for the dev admin', async ({ page }) => {
	await login(page);
	await page.getByRole('button', { name: 'Admin' }).click();
	await page.waitForURL('**/admin');
	await expect(page.getByText('Administration')).toBeVisible();
});

test('unauthenticated visit redirects to /login', async ({ page }) => {
	await page.goto('/projects');
	await page.waitForURL('**/login');
});
```

- [ ] **Step 4: Update existing specs to authenticate first**

Existing specs (e.g. `e2e/smoke.spec.ts`) `page.goto('/')` and expect the workspace. They now must log in and open a project first. For each spec, replace the initial `await page.goto('/')` with `await openDefaultProject(page)` (import from `./helpers/auth`), since `/` now redirects to `/projects` and the workspace lives at `/p/[projectId]`.

Run: `grep -rln "page.goto('/')" frontend/e2e` and update each.

- [ ] **Step 5: Run e2e**

Run: `pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'`
Expected: PASS — auth specs plus the updated existing specs. (First run installs chromium.) If a spec races the picker fetch, add `await expect(page.getByText('Smart City')).toBeVisible()` before clicking.

- [ ] **Step 6: Commit**

```bash
git add frontend/playwright.config.ts frontend/e2e
git commit -m "test(frontend): e2e login + picker + admin; authenticate before workspace specs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
---

## Deferred (intentionally not in this plan)

- **Change-password UI.** The `changePassword` API wrapper is built in Task 2 (so the backend endpoint isn't dead), but no UI consumes it yet. Wire it into a future profile/settings menu — out of scope for the picker/admin slice. Admins can already reset any user's password via the admin console (`patchUser({ password })`).

## Final verification

- [ ] All unit tests: `pixi run -e frontend npm test` — green.
- [ ] Type-check: `pixi run -e frontend npm run check` — clean (no remaining importers of the removed `DEV_IDENTITY_HEADERS`/`DEV_USER_ID`).
- [ ] Lint/format: `pixi run -e frontend npm run lint` — clean.
- [ ] e2e: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'` — green.
- [ ] Manual smoke (with backend Plan 1 merged): `DATA_ROVER_DEV_SEED=true DATA_ROVER_AUTH_COOKIE_SECURE=false pixi run start-backend` + `pixi run start-frontend`, open `http://127.0.0.1:5173/` → redirected to `/login` → sign in as `admin@example.com` / `admin12345` → land on `/projects` → open Smart City → workspace loads → header "Admin" link opens the console.
- [ ] Grep sweep: `grep -rn "projects/default\|DEV_IDENTITY_HEADERS\|x-user-id" frontend/src` returns nothing (all dev-identity coupling removed).

## Cross-plan dependency note

This plan assumes Plan 1 (backend) shipped exactly these contracts:
- `POST /api/v1/auth/login {email,password}` → `{user_id,email,is_admin}` + httpOnly cookie; `GET /auth/me`; `POST /auth/logout` (204).
- `GET /api/v1/projects` → `[{id,name,role}]` (all for admins); `POST /api/v1/projects` multipart `{name, metamodel, model?, view?}` → `{id,name,role}`.
- `/api/v1/admin/users` GET/POST, `/admin/users/{id}` PATCH/DELETE, `/admin/projects/{id}/members` GET/POST + `/{user_id}` DELETE — all admin-gated.
- Unsafe cookie-authed requests require `X-Requested-With: data-rover`.
- Dev seed provisions `admin@example.com` / `admin12345` and the `default` ("Smart City") project.
If any contract differs, reconcile here before implementing the consuming task.
```
