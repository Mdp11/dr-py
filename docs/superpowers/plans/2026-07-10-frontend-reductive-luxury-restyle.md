# Frontend Reductive-Luxury Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole SvelteKit frontend to a reductive modern-luxury design language (graphite/platinum neutrals, sage accent, display typography, brand logos, calm motion, decluttered TopBar) with zero routing/data-flow/ops changes.

**Architecture:** One authoritative token layer in `app.css` (new palette + status/motion/display-font tokens), then a mechanical class-mapping sweep across ~61 components in three batches, plus hand-built redesigns of the marquee surfaces (login, AppHeader, TopBar with overflow menu, ProgressOverlay) and a small motion utility for `svelte/transition` durations.

**Tech Stack:** Svelte 5 + SvelteKit 2, Tailwind CSS v4 (CSS-config), shadcn-svelte/bits-ui, `@fontsource-variable/inter` + `@fontsource-variable/outfit`, vitest (happy-dom + MSW), Playwright, Pillow via `pixi exec` for one-off asset derivation.

**Spec:** `docs/superpowers/specs/2026-07-10-frontend-reductive-luxury-restyle-design.md`

## Global Constraints

- **Never name the inspiring automotive brand** anywhere: code, comments, commit messages, test names, docs. The direction is called "reductive luxury".
- No routing, store/data-flow, ops/commit/locking-protocol, or API changes. Event handlers keep their logic; only *where* a trigger lives may change (TopBar overflow menu).
- No new runtime dependencies except `@fontsource-variable/outfit`. Motion uses built-in `svelte/transition` + CSS only.
- All frontend commands run through pixi from the repo root, e.g. `pixi run -e frontend bash -c 'cd frontend && npm test'`. The bare `pixi run -e frontend npm test` fails (wrong cwd).
- The app stays dark-locked. Don't add a theme toggle. `:root` (light) token block stays structurally valid but is not a design target.
- Preserve every `aria-*`, `role`, `data-testid`, and form field name/id. Tests may only be edited to follow a moved trigger or changed literal class, nothing else.
- Prettier runs with the repo config: tabs, single quotes. Run `pixi run -e frontend bash -c 'cd frontend && npm run format'` before each commit.

## Design tokens reference (used by every task)

New dark palette (`.dark` block), OKLCH:

| Token | Value | Role |
|---|---|---|
| `--background` | `oklch(0.155 0.004 150)` | app background (deep warm charcoal) |
| `--foreground` | `oklch(0.96 0.005 150)` | platinum text |
| `--card` | `oklch(0.19 0.005 150)` | raised surface |
| `--popover` | `oklch(0.215 0.006 150)` | menus/tooltips |
| `--primary` | `oklch(0.78 0.05 155)` | sage accent (logo "R") |
| `--primary-foreground` | `oklch(0.17 0.01 150)` | text on sage |
| `--secondary` / `--muted` / `--accent` | `oklch(0.245 0.006 150)` | chips, hovers |
| `--muted-foreground` | `oklch(0.72 0.008 150)` | secondary text |
| `--destructive` | `oklch(0.66 0.14 25)` | calm red |
| `--success` | `oklch(0.74 0.09 155)` | NEW status token |
| `--warning` | `oklch(0.79 0.1 85)` | NEW status token |
| `--info` | `oklch(0.74 0.06 240)` | NEW status token |
| `--border` | `oklch(1 0 0 / 8%)` | hairline |
| `--input` | `oklch(1 0 0 / 12%)` | field borders |
| `--ring` | `oklch(0.74 0.06 155)` | sage focus ring |
| `--radius` | `0.5rem` | tightened from 0.625rem |

Class-mapping table for the sweep (apply mechanically; judgment cases noted):

| Old (hardcoded) | New (semantic) |
|---|---|
| `bg-zinc-950` | `bg-background` |
| `bg-zinc-900` | `bg-card` (panel/tooltip surfaces) or `bg-muted` (badges/chips/hovers) |
| `bg-zinc-800`, `hover:bg-zinc-800` | `bg-muted`, `hover:bg-muted` |
| `border-zinc-800` | `border-border` |
| `border-zinc-700` | `border-input` |
| `text-zinc-100`, `text-white`, `hover:text-white` | `text-foreground`, `hover:text-foreground` |
| `text-zinc-200` | `text-foreground/90` |
| `text-zinc-300` | `text-foreground/80` (labels) or `text-muted-foreground` (secondary) |
| `text-zinc-400` | `text-muted-foreground` |
| `text-zinc-500` | `text-muted-foreground/70` |
| `ring-indigo-500`, `focus-visible:ring-indigo-500` | `ring-ring`, `focus-visible:ring-ring` |
| `border-indigo-*` / `text-indigo-*` / `bg-indigo-*` | `border-primary` / `text-primary` / `bg-primary/15` |
| `text-emerald-300/400`, `bg-emerald-500/15` | `text-success`, `bg-success/15` |
| `text-amber-300/400`, `bg-amber-500/15`, `yellow-*` | `text-warning`, `bg-warning/15` |
| `text-sky-*`, `blue-*` | `text-info`, `bg-info/15` |
| `text-red-300/400` | `text-destructive` |
| `bg-red-950/60`, `bg-red-500/15` | `bg-destructive/15` |
| `border-red-*` | `border-destructive/40` |
| `shadow-lg` on tooltips/menus | `shadow-lg` → keep, but no new shadows/glows |

Section-header idiom: replace ad-hoc small-bold headers on panels with `class="microlabel"` (defined in Task 2). Display headings (dialog/drawer titles, page titles, empty states): `font-display text-lg font-light tracking-wide` (scale up/down per surface).

GraphView / script-side hex equivalents (canvas/SVG constants can't read CSS vars):

| Role | Hex |
|---|---|
| background | `#101311` |
| surface | `#191d1a` |
| border hairline | `rgba(255,255,255,0.08)` |
| text | `#f2f4f2` |
| muted text | `#a8b0aa` |
| sage accent | `#a9c4ae` |
| red | `#d98d84` |
| amber | `#dcb878` |

---

### Task 1: Brand asset derivation + `app.html` head

**Files:**
- Create: `frontend/static/dr-mark.png`, `frontend/static/dr-lockup.png`, `frontend/static/favicon.png`, `frontend/static/apple-touch-icon.png` (generated)
- Create (scratchpad only, NOT committed): `<scratchpad>/derive_brand_assets.py`
- Modify: `frontend/src/app.html`
- Delete: `frontend/static/dr_full.png:Zone.Identifier`, `frontend/static/dr_small.png:Zone.Identifier`

**Interfaces:**
- Produces: static assets referenced by later tasks as `{assets}/dr-mark.png` (header icon, ~24px display height) and `{assets}/dr-lockup.png` (login logo, ~340px display width). `import { assets } from '$app/paths'`.

- [ ] **Step 1: Write the derivation script** to the scratchpad directory:

```python
"""One-off: derive web brand assets from the provided master PNGs.

The masters have opaque black backgrounds and large padding. We convert
near-black to transparent via a luminance ramp (the letterforms are
brushed metal, far lighter than the uniform black bg), trim, and resize.
"""

from pathlib import Path

from PIL import Image

STATIC = Path("/home/mdp/workspace/data-rover-py/frontend/static")
LO, HI = 10, 36  # luminance ramp: <=LO transparent, >=HI opaque


def key_black(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            if lum <= LO:
                alpha = 0
            elif lum >= HI:
                alpha = 255
            else:
                alpha = int(255 * (lum - LO) / (HI - LO))
            px[x, y] = (r, g, b, min(a, alpha))
    return img


def trim(img: Image.Image, pad: int = 12) -> Image.Image:
    bbox = img.getbbox()
    assert bbox is not None
    left, top, right, bottom = bbox
    left, top = max(0, left - pad), max(0, top - pad)
    right, bottom = min(img.width, right + pad), min(img.height, bottom + pad)
    return img.crop((left, top, right, bottom))


def resize_h(img: Image.Image, h: int) -> Image.Image:
    return img.resize((round(img.width * h / img.height), h), Image.LANCZOS)


def resize_w(img: Image.Image, w: int) -> Image.Image:
    return img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)


small = trim(key_black(Image.open(STATIC / "dr_small.png")))
full = trim(key_black(Image.open(STATIC / "dr_full.png")))

# Header mark: displayed ~24px tall; ship 3x for crisp rendering.
resize_h(small, 72).save(STATIC / "dr-mark.png")
# Login lockup: displayed ~340px wide; ship 2x.
resize_w(full, 680).save(STATIC / "dr-lockup.png")

# Favicon: square canvas, transparent bg.
fav_src = resize_h(small, 56)
fav = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
fav.paste(fav_src, ((64 - fav_src.width) // 2, (64 - fav_src.height) // 2), fav_src)
fav.save(STATIC / "favicon.png")

# Apple touch icon: 180px on solid black (iOS dislikes transparency).
at_src = resize_h(small, 96)
at = Image.new("RGBA", (180, 180), (5, 6, 5, 255))
at.paste(at_src, ((180 - at_src.width) // 2, (180 - at_src.height) // 2), at_src)
at.convert("RGB").save(STATIC / "apple-touch-icon.png")

print("done:", [p.name for p in STATIC.glob("dr-*.png")], "favicon.png apple-touch-icon.png")
```

- [ ] **Step 2: Run it** with an ephemeral Pillow env:

Run: `pixi exec -s python=3.12 -s pillow python <scratchpad>/derive_brand_assets.py`
Expected: `done: [...]` and four new PNGs in `frontend/static/`.
Fallback if `pixi exec` is unavailable/offline: `pixi run -e frontend bash -c 'cd frontend && npx --yes sharp-cli ...'` or ask the user; do NOT commit half-derived assets.

- [ ] **Step 3: Visually verify the keying** — Read each generated PNG (they render as images). The letterforms must be intact with no halo/holes; the D-interior network motif must survive. If keying artifacts appear, fall back per spec: keep opaque originals, plan the "plinth" (pure-black container) treatment, and note it for Tasks 4/5/9.

- [ ] **Step 4: Replace `frontend/src/app.html`** with:

```html
<!doctype html>
<html lang="en" class="dark">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="text-scale" content="scale" />
		<meta name="theme-color" content="#101211" />
		<title>Data Rover</title>
		<link rel="icon" type="image/png" href="%sveltekit.assets%/favicon.png" />
		<link rel="apple-touch-icon" href="%sveltekit.assets%/apple-touch-icon.png" />
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">%sveltekit.body%</div>
	</body>
</html>
```

- [ ] **Step 5: Delete the WSL litter files**

Run: `rm 'frontend/static/dr_full.png:Zone.Identifier' 'frontend/static/dr_small.png:Zone.Identifier'`

- [ ] **Step 6: Verify build health**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors (same as baseline).

- [ ] **Step 7: Commit**

```bash
git add frontend/static/dr_full.png frontend/static/dr_small.png frontend/static/dr-mark.png frontend/static/dr-lockup.png frontend/static/favicon.png frontend/static/apple-touch-icon.png frontend/src/app.html
git commit -m "feat(frontend): brand assets, favicon, and page title"
```

---

### Task 2: Design tokens, typography, motion foundation

**Files:**
- Modify: `frontend/src/app.css` (rewrite), `frontend/package.json` (+`@fontsource-variable/outfit`)
- Create: `frontend/src/lib/util/motion.ts`
- Test: existing suite (`npm test`, `npm run check`)

**Interfaces:**
- Produces: Tailwind color utilities `success`/`warning`/`info` (e.g. `text-success`, `bg-warning/15`); `font-display` utility; `.microlabel` component class; motion constants `MICRO`/`PANEL` and `dur(ms: number): number` from `$lib/util/motion` (returns 0 under reduced motion / SSR). All later tasks consume these.

- [ ] **Step 1: Install the display font**

Run: `pixi run -e frontend bash -c 'cd frontend && npm install --save-dev @fontsource-variable/outfit'`
Expected: package.json devDependencies gains `@fontsource-variable/outfit`.

- [ ] **Step 2: Rewrite `frontend/src/app.css`.** Keep the file's structure (imports → custom-variant → `:root` → base html/body → `.dark` → `@theme inline` → `@layer base`); change these things and only these things:

1. Add `@import '@fontsource-variable/outfit';` after the inter import.
2. In `:root`: change `--radius` to `0.5rem`; append the three status tokens (light values, dead but valid): `--success: oklch(0.55 0.12 155); --warning: oklch(0.65 0.13 85); --info: oklch(0.55 0.09 240);` and motion tokens `--motion-micro: 120ms; --motion-panel: 200ms; --ease-standard: cubic-bezier(0.2, 0, 0, 1);`
3. Replace the `html, body` rule (drop the zinc literals — the base layer applies tokens):

```css
html,
body {
	height: 100%;
	margin: 0;
	font-size: 14px;
}
```

4. Replace the whole `.dark` block values with the palette from the tokens reference table above (keep `--card-foreground`/`--popover-foreground`/`--secondary-foreground`/`--accent-foreground` = `var(--foreground)`-equivalent value `oklch(0.96 0.005 150)`; keep the `--sidebar-*` family pointing at the same values as their non-sidebar counterparts, i.e. `--sidebar: oklch(0.19 0.005 150)`, `--sidebar-primary: oklch(0.78 0.05 155)`, `--sidebar-ring: oklch(0.74 0.06 155)`, `--sidebar-border: oklch(1 0 0 / 8%)`; keep `--chart-1..5` as the existing grayscale ramp), and append:

```css
	--success: oklch(0.74 0.09 155);
	--warning: oklch(0.79 0.1 85);
	--info: oklch(0.74 0.06 240);
```

5. In `@theme inline`, add:

```css
	--font-display: 'Outfit Variable', 'Inter Variable', sans-serif;
	--color-success: var(--success);
	--color-warning: var(--warning);
	--color-info: var(--info);
```

6. After the `@layer base` block, append:

```css
@layer components {
	/* Wide-tracked uppercase micro-label — the section-header idiom. */
	.microlabel {
		@apply text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase;
	}
}

/* Calm-motion guard: neutralize CSS animations/transitions when the user
   opts out. JS-driven svelte/transition durations go through
   $lib/util/motion's dur() for the same reason. */
@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
		transition-duration: 0.01ms !important;
	}
}
```

- [ ] **Step 3: Create `frontend/src/lib/util/motion.ts`:**

```ts
/**
 * Central motion constants for svelte/transition calls.
 *
 * CSS animations are neutralized under prefers-reduced-motion by a global
 * media query in app.css; JS-driven transitions must opt in through dur().
 */
export const MICRO = 120;
export const PANEL = 200;

export function dur(ms: number): number {
	if (typeof window === 'undefined') return 0;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}
```

- [ ] **Step 4: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: check 0 errors; all vitest suites pass (token values don't participate in assertions).

- [ ] **Step 5: Visual smoke** — start the dev stack briefly (backend: `DATA_ROVER_DEV_SEED=true DATA_ROVER_DATABASE_URL='sqlite://' pixi run start-backend` if not already running; frontend: `pixi run start-frontend`) and confirm the app renders with the new base palette (most surfaces still zinc-hardcoded — that's expected until Tasks 4–8).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app.css frontend/src/lib/util/motion.ts frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): reductive-luxury design tokens, display font, motion foundation"
```

---

### Task 3: Login page — the brand showcase

**Files:**
- Modify: `frontend/src/routes/login/+page.svelte`, `frontend/src/lib/components/auth/LoginForm.svelte`
- Test: `frontend/src/lib/components/__tests__/LoginForm.test.ts` (must keep passing unmodified — aria-labels/roles/copy unchanged)

**Interfaces:**
- Consumes: `{assets}/dr-lockup.png` (Task 1), `.microlabel`, `font-display` (Task 2).
- Produces: nothing downstream.

- [ ] **Step 1: Replace `frontend/src/routes/login/+page.svelte`:**

```svelte
<script lang="ts">
	import { assets } from '$app/paths';
	import { fade } from 'svelte/transition';
	import { dur, PANEL } from '$lib/util/motion';
	import LoginForm from '$lib/components/auth/LoginForm.svelte';
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-10 bg-background px-6">
	<div in:fade={{ duration: dur(PANEL) }} class="flex flex-col items-center gap-10">
		<img src={`${assets}/dr-lockup.png`} alt="Data Rover — Model. Connect. Drive." class="w-80 max-w-full" />
		<LoginForm />
	</div>
</div>
```

- [ ] **Step 2: Replace the form markup in `LoginForm.svelte`** (script block unchanged — same handlers, fields, copy):

```svelte
<form
	onsubmit={onSubmit}
	class="flex w-80 flex-col gap-4 rounded-lg border border-border bg-card/70 p-8"
>
	<h1 class="font-display text-lg font-light tracking-wide text-foreground">Sign in</h1>
	<Input
		type="email"
		placeholder="Email"
		autocomplete="username"
		aria-label="Email"
		bind:value={email}
		required
	/>
	<Input
		type="password"
		placeholder="Password"
		autocomplete="current-password"
		aria-label="Password"
		bind:value={password}
		required
	/>
	{#if error}
		<p class="text-xs text-destructive">{error}</p>
	{/if}
	<Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
</form>
```

- [ ] **Step 3: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npx vitest run src/lib/components/__tests__/LoginForm.test.ts'`
Expected: PASS without touching the test file.

- [ ] **Step 4: Look at it** — dev server, `/login`: lockup centered above a hairline card on charcoal. If the keyed lockup shows halo artifacts, swap to the plinth fallback (pure-black rounded container behind the image: wrap in `<div class="rounded-xl bg-black p-8">`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/login/+page.svelte frontend/src/lib/components/auth/LoginForm.svelte
git commit -m "feat(frontend): login page brand showcase"
```

---

### Task 4: AppHeader — icon mark + tokens

**Files:**
- Modify: `frontend/src/lib/components/AppHeader.svelte`

**Interfaces:**
- Consumes: `{assets}/dr-mark.png` (Task 1).
- Produces: the header brand-mark idiom Task 5 repeats: `<img src={`${assets}/dr-mark.png`} alt="" class="h-6 w-auto" />` inside the existing nav button, `aria-label="Data Rover"` on the button.

- [ ] **Step 1: Update the markup** (script unchanged):

```svelte
<header
	class="flex h-11 items-center justify-between border-b border-border bg-background px-4 text-sm"
>
	<div class="flex items-center gap-4">
		<button
			class="flex items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label="Data Rover"
			onclick={() => goto(resolve('/projects'))}
		>
			<img src={`${assets}/dr-mark.png`} alt="" class="h-6 w-auto" />
		</button>
		{#if isAdmin()}
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => goto(resolve('/admin'))}>
				Admin
			</Button>
		{/if}
	</div>
	<div class="flex items-center gap-3">
		<kbd
			class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70"
			title="Command palette">⌘K</kbd
		>
		<span class="text-xs text-muted-foreground">{user?.email}</span>
		<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={onLogout}>Sign out</Button>
	</div>
</header>
```

Add `import { assets } from '$app/paths';` to the script block (alongside the existing `resolve` import).

- [ ] **Step 2: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green (no test targets the "Data Rover" text; `layout-guard.test.ts` and `ProjectsPage.test.ts` may — if one asserted on the brand text, update it to query `[aria-label="Data Rover"]`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/AppHeader.svelte
git commit -m "feat(frontend): icon mark in global header"
```

---

### Task 5: TopBar — icon mark, declutter into overflow menu, tokens

**Files:**
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Test: `frontend/src/lib/components/__tests__/TopBar.test.ts`, `TopBar.strict.test.ts`, and e2e specs `frontend/e2e/smoke.spec.ts:91`, `frontend/e2e/strict-mode.spec.ts:60,109`, `frontend/e2e/history.spec.ts:103`

**Interfaces:**
- Consumes: brand-mark idiom (Task 4), tokens/microlabel (Task 2).
- Produces: overflow menu with `aria-label="More actions"` trigger and menu items named exactly `Compare`, `Apply CR`, `Swap Metamodel`, `Export`, `History`, `Settings` — e2e and component tests target these via `getByRole('menuitem', { name: ... })`.

Visible actions stay: Undo, Validate, validation status, Commit, change counter, Strict badge. Everything else folds into a `…` dropdown. All handlers, `$derived` disables, dialogs, and the file-info tooltip keep their exact logic.

- [ ] **Step 1: Rewrite the template.** Script block: add imports

```ts
import { assets } from '$app/paths';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import { Ellipsis, AlertCircle, AlertTriangle, Info, RefreshCw, Undo2 } from '@lucide/svelte';
```

(everything else in the script stays byte-identical). Template:

```svelte
<header
	class="sticky top-0 z-20 col-span-5 flex h-11 items-center justify-between border-b border-border bg-background px-4 text-sm"
>
	<div class="flex items-center gap-3">
		<button
			type="button"
			class="flex items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label="Data Rover"
			onclick={goHome}
		>
			<img src={`${assets}/dr-mark.png`} alt="" class="h-6 w-auto" />
		</button>

		<div class="group relative flex items-center">
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="Loaded files"
			>
				<Info class="h-4 w-4" />
			</button>
			<div
				role="tooltip"
				class="pointer-events-none absolute top-full left-0 z-30 hidden w-max rounded border border-border bg-popover p-2 shadow-lg group-focus-within:block group-hover:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-muted-foreground/70">Metamodel</dt>
					<dd class="font-mono text-foreground/90">
						{metamodelFilename ?? (metamodel ? 'loaded' : '—')}
					</dd>
					<dt class="text-muted-foreground/70">Model</dt>
					<dd class="font-mono text-foreground/90">{modelFilename ?? (summary ? 'loaded' : '—')}</dd>
					<dt class="text-muted-foreground/70">View</dt>
					<dd class="font-mono text-foreground/90">{view ? (viewFilename ?? view.name) : '—'}</dd>
				</dl>
			</div>
		</div>
	</div>

	<div class="flex items-center gap-2">
		<span class="contents" aria-live="polite">
			{#if validating}
				<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
					Running validation…
				</span>
			{:else if lastValidateError !== null}
				<span class="rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
					Validation failed
				</span>
			{:else if lastRunAt !== null}
				{#if issues.length === 0}
					<span class="rounded bg-success/15 px-1.5 py-0.5 font-mono text-[10px] text-success">
						✓ no issues
					</span>
				{:else}
					<span class="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
						{#if errorCount > 0}
							<AlertCircle class="h-3 w-3 text-destructive" />
							<span class="text-destructive">{errorCount} {errorCount === 1 ? 'error' : 'errors'}</span>
						{/if}
						{#if warningCount > 0}
							<AlertTriangle class="h-3 w-3 text-warning" />
							<span class="text-warning">
								{warningCount}
								{warningCount === 1 ? 'warning' : 'warnings'}
							</span>
						{/if}
					</span>
				{/if}
			{/if}
		</span>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs"
			disabled={undoDisabled}
			onclick={onUndo}
		>
			<Undo2 class="h-3 w-3" />
			Undo
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs"
			disabled={validateDisabled}
			aria-busy={validating}
			onclick={() => void runValidation()}
		>
			<RefreshCw class="h-3 w-3 {validating ? 'animate-spin' : ''}" />
			Validate
		</Button>
		<Button
			variant="outline"
			size="sm"
			class="h-7 text-xs"
			disabled={saveDisabled}
			onclick={() => setDiffDrawerOpen(true)}
		>
			Commit
		</Button>
		{#if strictOn}
			<span
				class="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning"
				title="Strict mode on: commits with validation errors are blocked."
			>
				Strict
			</span>
		{/if}
		<div class="group relative flex items-center">
			<span
				class="font-mono text-xs {combinedChanges > 0 ? 'text-destructive' : 'text-muted-foreground/70'}"
			>
				● {combinedChanges}
				{combinedChanges === 1 ? 'change' : 'changes'}
			</span>
			<div
				role="tooltip"
				class="absolute top-full right-0 z-30 hidden w-max rounded border border-border bg-popover p-2 shadow-lg group-focus-within:block group-hover:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-muted-foreground/70">Uncommitted (model)</dt>
					<dd class="text-right font-mono text-foreground/90">{totalChanges}</dd>
					<dt class="text-muted-foreground/70">Unsaved (view)</dt>
					<dd class="text-right font-mono text-foreground/90">{viewChanges}</dd>
				</dl>
			</div>
		</div>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="More actions"
			>
				<Ellipsis class="h-4 w-4" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item onclick={() => void goto(resolve(`/p/${getActiveProjectId()}/compare`))}>
					Compare
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => (applyCrOpen = true)}>Apply CR</DropdownMenu.Item>
				<DropdownMenu.Item disabled={metamodel === null} onclick={() => (swapOpen = true)}>
					Swap Metamodel
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item disabled={summary === null} onclick={() => void onExport()}>
					Export
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => setHistoryDrawerOpen(true)}>History</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onclick={() => (settingsOpen = true)}>Settings</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</header>

<ApplyCrDialog bind:open={applyCrOpen} />
<SwapMetamodelDrawer bind:open={swapOpen} />
<SettingsDialog bind:open={settingsOpen} />
```

Note: `goHome`'s discard-confirm guard already runs inside `goHome()`; the Compare item's `goto` matches the old `<a>` navigation (client-side either way).

- [ ] **Step 2: Run the TopBar component tests to see what breaks**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/TopBar.test.ts src/lib/components/__tests__/TopBar.strict.test.ts'`
Expected: failures ONLY on the moved actions (Export/History/Settings/Swap/Apply CR lookups via the `findButton(RegExp)` helper).

- [ ] **Step 3: Update those tests minimally** — for a moved action, first `await` a click on the trigger `document.querySelector('[aria-label="More actions"]')`, then locate the item via `[role="menuitem"]` text match (bits-ui portals content to `document.body`, so query `document`, not the component container). Assert disabled state via `aria-disabled` on the menuitem instead of the button `disabled` attribute. Do not change what behaviour each test verifies.

- [ ] **Step 4: Update the three e2e specs** the same way — replace direct button clicks for moved actions:

```ts
await page.getByRole('button', { name: 'More actions' }).click();
await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
```

(`smoke.spec.ts` Export; `strict-mode.spec.ts` Settings ×2; `history.spec.ts` History.)

- [ ] **Step 5: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green.
Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'` (boots its own backend)
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/TopBar.svelte frontend/src/lib/components/__tests__/TopBar.test.ts frontend/src/lib/components/__tests__/TopBar.strict.test.ts frontend/e2e/smoke.spec.ts frontend/e2e/strict-mode.spec.ts frontend/e2e/history.spec.ts
git commit -m "feat(frontend): decluttered editor topbar with overflow menu and brand mark"
```

---

### Task 6: Sweep batch A — editor chrome

**Files (modify all; apply the class-mapping table + idioms):**
- `frontend/src/routes/p/[projectId]/+page.svelte` (grid shell: `bg-zinc-950 text-zinc-100` → `bg-background text-foreground`; banners → `bg-destructive/15 text-destructive` etc.)
- `frontend/src/lib/components/Sidebar.svelte` + `frontend/src/lib/components/Sidebar/` (all: `ContainmentTree.svelte`, `TreeRow.svelte`, `Search.svelte`, `AdvancedSearchDialog.svelte`, `ViewSelector.svelte`, `ArtifactsSection.svelte`, `StereotypePicker.svelte`, `PropertyPicker.svelte`, `CriterionRow.svelte`, `VerticalSplit.svelte`)
- `frontend/src/lib/components/Inspector.svelte` + `frontend/src/lib/components/Inspector/` (all: `PropertyForm.svelte`, `PropertyField.svelte`, `RelationshipsList.svelte`, `NewRelationshipPicker.svelte`, `ElementRefPicker.svelte`, `LockControl.svelte`)
- `frontend/src/lib/components/StatusBar.svelte`, `ResultsPanel.svelte`, `ResizeHandle.svelte`
- `frontend/src/lib/components/Workspace.svelte`, `Workspace/DetailView.svelte`, `Workspace/IssuesPanel.svelte`
- Test: full vitest suite + `npm run check`

**Interfaces:** consumes Task 2 tokens only; produces nothing downstream.

- [ ] **Step 1: Mechanical mapping sweep** over every listed file using the class-mapping table. Zero markup/logic changes in this step. Where zinc appears inside ternaries/string interpolation (e.g. `TreeRow.svelte` selection states), map each branch: selected rows → `bg-primary/15 text-foreground` (was indigo/zinc selection), hover rows → `hover:bg-muted`.

- [ ] **Step 2: Idiom pass** (visual-only): panel section headers → `class="microlabel"` (replacing ad-hoc `text-xs font-semibold text-zinc-400`-style headers); empty states (e.g. "no element selected" in Inspector/DetailView, empty tree/results) → centered `font-display text-base font-light text-muted-foreground` heading + one-line `text-xs text-muted-foreground/70` hint; panel paddings may step up one notch (`p-2`→`p-3`) where cramped, nothing structural.

- [ ] **Step 3: Grep gate** — no hardcoded palette classes left in batch-A files:

Run: `grep -rEn 'zinc-|indigo-|emerald-|amber-|sky-[0-9]|red-[0-9]|yellow-|blue-[0-9]' frontend/src/lib/components/Sidebar* frontend/src/lib/components/Inspector* frontend/src/lib/components/StatusBar.svelte frontend/src/lib/components/ResultsPanel.svelte frontend/src/lib/components/ResizeHandle.svelte frontend/src/lib/components/Workspace.svelte frontend/src/lib/components/Workspace/DetailView.svelte frontend/src/lib/components/Workspace/IssuesPanel.svelte 'frontend/src/routes/p/[projectId]/+page.svelte'`
Expected: no matches.

- [ ] **Step 4: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green; if a test asserted an old literal class (e.g. `TreeRow.artifact.test.ts`, `IssuesPanel.origin.test.ts`, `lock-control.test.ts`), update the class-string assertion to the new token class — same element, same behaviour.

- [ ] **Step 5: Visual pass** on the editor (dev stack): tree selection, inspector forms, status bar, results panel — check contrast and affordances.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "restyle(frontend): editor chrome on semantic tokens"
```

---

### Task 7: Sweep batch B — dialogs, drawers, overlays, compare

**Files (modify all; mapping table + idioms as in Task 6):**
- `frontend/src/lib/components/DiffDrawer.svelte`, `HistoryDrawer.svelte`, `SwapMetamodelDrawer.svelte`, `ApplyCrDialog.svelte`, `SettingsDialog.svelte`, `LoadFilesDialog.svelte`, `CommandPalette.svelte`
- `frontend/src/lib/components/ProgressOverlay.svelte` (redesign below)
- `frontend/src/lib/components/CompareDiff.svelte`, `CompareEntityCard.svelte`, `DiffRow.svelte`, `frontend/src/routes/p/[projectId]/compare/+page.svelte`
- Test: full vitest suite; `ProgressOverlay.test.ts`, `DiffDrawer.strict.test.ts`, `HistoryDrawer.test.ts`, `SettingsDialog.test.ts`, `SwapMetamodelDrawer.test.ts` must keep passing (update only literal-class assertions).

**Interfaces:** consumes tokens + `{assets}/dr-mark.png` + `dur`/`PANEL`.

- [ ] **Step 1: Mechanical mapping sweep** over all listed files (table from the header). Dialog/drawer titles additionally get `font-display font-light tracking-wide`.

- [ ] **Step 2: ProgressOverlay redesign** — keep the component's props, test ids, and conditional logic identical; replace the visual shell with: full-screen `bg-background/90 backdrop-blur-sm` scrim, centered column with the brand mark (`<img src={`${assets}/dr-mark.png`} alt="" class="h-8 w-auto opacity-90" />`), the existing status/progress text as `microlabel`, and a 2px-high progress track (`h-0.5 w-56 overflow-hidden rounded-full bg-muted` with an inner `h-full bg-primary transition-[width]` bar bound to the existing progress value). Wrap the root in `transition:fade={{ duration: dur(PANEL) }}`.

- [ ] **Step 3: Diff semantics** in CompareDiff/DiffRow/DiffDrawer: added → `text-success`, modified → `text-warning`, deleted → `text-destructive` (replacing green/amber/red literals), backgrounds at `/10`–`/15` alpha.

- [ ] **Step 4: Grep gate**

Run: `grep -rEn 'zinc-|indigo-|emerald-|amber-|sky-[0-9]|red-[0-9]|yellow-|blue-[0-9]' frontend/src/lib/components/{DiffDrawer,HistoryDrawer,SwapMetamodelDrawer,ApplyCrDialog,SettingsDialog,LoadFilesDialog,CommandPalette,ProgressOverlay,CompareDiff,CompareEntityCard,DiffRow}.svelte 'frontend/src/routes/p/[projectId]/compare/+page.svelte'`
Expected: no matches.

- [ ] **Step 5: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green (class-assertion-only test updates allowed).

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "restyle(frontend): overlays, drawers, and compare on semantic tokens"
```

---

### Task 8: Sweep batch C — navigation builder, projects, admin, root layout

**Files (modify all; mapping table + idioms as in Task 6):**
- `frontend/src/lib/components/Navigation/` (all 14: `NavigationBuilder.svelte`, `NavigationNode.svelte`, `PathCard.svelte`, `RefCard.svelte`, `CombineFrame.svelte`, `ResultsDock.svelte`, `ScopeEditor.svelte`, `ChainBadge.svelte`, `StatusChip.svelte`, `FeedsChip.svelte`, `ElementStartPicker.svelte`, `FilterStepRow.svelte`, `RelationshipStepRow.svelte`, `OperandToolbar.svelte`)
- `frontend/src/routes/projects/+page.svelte`, `frontend/src/lib/components/projects/ProjectCard.svelte`, `projects/NewProjectWizard.svelte`
- `frontend/src/routes/admin/+page.svelte`, `frontend/src/lib/components/admin/UsersTab.svelte`, `admin/ProjectMembersTab.svelte`
- `frontend/src/routes/+layout.svelte`, `frontend/src/routes/+page.svelte`
- Any `frontend/src/lib/components/ui/` primitive still carrying a zinc/indigo literal
- Test: full vitest suite (`ProjectCard.test.ts`, `ProjectsPage.test.ts`, `NewProjectWizard.test.ts`, `UsersTab.test.ts`, `ProjectMembersTab.test.ts` affected-by-class-assertions only)

**Interfaces:** consumes tokens; produces nothing downstream.

- [ ] **Step 1: Mechanical mapping sweep** over all listed files.

- [ ] **Step 2: Idiom pass** — ProjectCard: hairline `border-border bg-card` card, `hover:border-input` lift (border-step, no shadow/scale), project name in `font-display font-light text-base`, metadata as `text-xs text-muted-foreground`; page titles ("Projects", "Administration") → `font-display text-xl font-light tracking-wide`; tab/section labels → `microlabel`; nav-builder chips/badges → `bg-muted`/`bg-primary/15` with hairline borders.

- [ ] **Step 3: Grep gate — whole `src/` this time:**

Run: `grep -rEn 'zinc-|indigo-|emerald-|amber-|sky-[0-9]|red-[0-9]|yellow-|blue-[0-9]' frontend/src --include='*.svelte' | grep -v GraphView`
Expected: no matches (GraphView is Task 9).

- [ ] **Step 4: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "restyle(frontend): navigation builder, projects, and admin on semantic tokens"
```

---

### Task 9: GraphView palette

**Files:**
- Modify: `frontend/src/lib/components/Workspace/GraphView.svelte` (and any sibling helper it imports colors from)

**Interfaces:** consumes the script-side hex table (plan header).

- [ ] **Step 1: Read the file**; locate all color literals (xyflow node/edge styles, minimap, background, inline `style=` attributes, class strings).

- [ ] **Step 2: Replace them** with the hex table values (background `#101311`, surfaces `#191d1a`, hairlines `rgba(255,255,255,0.08)`, text `#f2f4f2`/`#a8b0aa`, selection/highlight `#a9c4ae`, error `#d98d84`, warning `#dcb878`). Add one comment at the constants site: `// Palette mirrors the app tokens in app.css (canvas/SVG can't read CSS vars).` Map any zinc/indigo utility classes per the standard table.

- [ ] **Step 3: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green.
Then visual: open an element's graph view in the dev stack; nodes/edges/minimap must match the new palette with readable labels.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Workspace/GraphView.svelte
git commit -m "restyle(frontend): graph view palette aligned with design tokens"
```

---

### Task 10: Motion layer

**Files:**
- Modify: `frontend/src/lib/components/DiffDrawer.svelte`, `HistoryDrawer.svelte`, `SwapMetamodelDrawer.svelte` (if custom-panel-based: `transition:fly={{ x: 24, duration: dur(PANEL) }}` on the panel, `transition:fade={{ duration: dur(PANEL) }}` on the scrim; if shadcn-Dialog-based they already animate — only normalize durations to ~200ms via their `duration-*`/animate classes)
- Modify: `frontend/src/lib/components/ResultsPanel.svelte` (`transition:slide={{ duration: dur(PANEL) }}` on show/hide), `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` or `TreeRow.svelte` (children container `transition:slide={{ duration: dur(MICRO) }}` — ONLY if expansion renders a wrapper element; do not restructure row rendering or drag/drop markup to force it), inline banners in `frontend/src/routes/p/[projectId]/+page.svelte` (`transition:slide`)
- Modify: `frontend/src/lib/components/ui/button/button.svelte` (root classes gain `transition-colors duration-[120ms]` if absent) and interactive rows/chips from Tasks 6–8 that lack a `transition-colors`
- Test: full vitest suite + e2e

**Interfaces:** consumes `dur`/`MICRO`/`PANEL` from `$lib/util/motion` (Task 2).

- [ ] **Step 1: Apply transitions** per the file list. Rules: color/opacity/position only — no scale/bounce; every `svelte/transition` call goes through `dur()`; never attach a transition to an element whose add/remove is asserted synchronously in a test without awaiting — check the affected suites (`HistoryDrawer.test.ts`, `DiffDrawer.strict.test.ts`, `ProgressOverlay.test.ts`) and if one flakes on outro timing, use `in:` only (no outro) for that element.

- [ ] **Step 2: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test'`
Expected: green.
Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: green (transitions must not break e2e waits; Playwright auto-waits cover 200ms fades).

- [ ] **Step 3: Reduced-motion spot check** — in the dev stack with DevTools emulating `prefers-reduced-motion: reduce`, drawers/dialogs must appear instantly.

- [ ] **Step 4: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): calm motion layer with reduced-motion support"
```

---

### Task 11: Full verification + visual sign-off

**Files:** none new (fixes only).

- [ ] **Step 1: Full gates**

Run, all expected green:
```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'
pixi run tidy
git diff --stat  # tidy should produce no new changes; if it reformats, commit those
```

- [ ] **Step 2: Residual-literal gate (whole frontend, including GraphView classes)**

Run: `grep -rEn 'zinc-|indigo-' frontend/src --include='*.svelte' --include='*.ts' | grep -v node_modules`
Expected: no matches.

- [ ] **Step 3: Visual sign-off sweep** — dev stack up; screenshot to the scratchpad (Playwright script or the `run` skill) and inspect: `/login`, `/projects` (+ New Project wizard open), `/admin` (both tabs), editor (tree populated, element selected, inspector open, results panel open, issues panel), each drawer/dialog (Commit/Diff, History, Settings, Swap Metamodel, Apply CR, Advanced Search, Command Palette), compare page, graph view, ProgressOverlay (visible during project open). Check: contrast (no sub-`muted-foreground/70` body text), focus rings visible on keyboard Tab, favicon + title in the browser tab.

- [ ] **Step 4: Fix anything found, re-run the affected gate, commit**

```bash
git add -A frontend
git commit -m "polish(frontend): visual sign-off fixes for the reductive-luxury restyle"
```

---

## Self-review notes

- Spec coverage: tokens/typography (T2), brand assets + favicon/title (T1), login (T3), header marks (T4/T5), TopBar declutter + ⌘K hint (T5, hint in T4), component migration (T6–T8), GraphView (T9), motion + reduced-motion + ProgressOverlay/empty states (T10, T7, T6), verification incl. e2e (T5, T11). Out-of-scope items respected (no toggle, no routing/state changes).
- Type consistency: `dur`/`MICRO`/`PANEL` defined in T2, consumed T3/T7/T10; asset filenames fixed in T1 and referenced verbatim in T3/T4/T5/T7; menu item names fixed in T5 and used in its test updates.
- Placeholders: sweep tasks intentionally specify a deterministic mapping table instead of 61 file diffs; every non-mechanical surface has exact code.
