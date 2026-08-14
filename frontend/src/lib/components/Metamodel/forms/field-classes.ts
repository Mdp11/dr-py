/**
 * The form panel's control styling, in one place so the five form components
 * cannot drift apart visually. Same shapes the Inspector's `PropertyField`
 * uses (`h-7`, hairline border, card ground, ring on focus) — the panel is a
 * sibling of that inspector, not a new visual language.
 *
 * `disabled:` states are baked in rather than left to each call site: every
 * control in this panel renders DISABLED on a read-only surface instead of
 * disappearing, so a viewer still sees what the type says.
 */

const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-60';

export const inputCls = `h-7 w-full rounded border border-border bg-card px-2 py-0.5 text-xs text-foreground outline-none focus:border-ring ${DISABLED}`;

export const selectCls = `h-7 w-full rounded border border-border bg-card px-1 text-xs text-foreground outline-none focus:border-ring ${DISABLED}`;

/** Section heading inside the panel (“Properties”, “Key”, “Mappings”). */
export const headingCls =
	'text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70';

/** Field label above a control. */
export const labelCls = 'text-[11px] font-medium text-foreground/90';

/** The panel's small secondary action (“+ Property”, “+ Mapping”). */
export const addBtnCls =
	'inline-flex w-fit items-center gap-1 rounded border border-border bg-card px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-muted';

/** The per-row destructive icon button (remove a property, a mapping, a key
 * entry). Muted until hovered — a list of rows should not read as a list of
 * delete buttons. */
export const rowRemoveCls = 'text-muted-foreground transition-colors hover:text-destructive';

/** A destructive TEXT action (“Delete Zone”, “No key”). Distinct from
 * {@link addBtnCls} on purpose: a clear-all sitting next to two `+` buttons in
 * the add-button's own styling reads as a third way to add something. */
export const dangerBtnCls =
	'inline-flex w-fit items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 text-[11px] text-destructive transition-colors hover:bg-destructive/15';

/** A full-width action inside a narrow overlay (the connection popover's three
 * choices), where the button IS the row rather than sitting at the end of one. */
export const blockBtnCls =
	'w-full rounded border border-border bg-card px-2 py-1 text-[11px] text-foreground/90 transition-colors hover:bg-muted';
