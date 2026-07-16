import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDefaultProject } from './helpers/auth';
import { loadFiles } from './helpers/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.metamodel.yaml');
const MODEL_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.model.json');
const VIEW_PATH = join(__dirname, '..', '..', 'examples', 'smart-city.view.json');

/**
 * E2E smoke for the Table system (Stage 2, Task 11): build a navigation,
 * open it "as table", add a property column, edit a value cell through the
 * exact commit-flow.spec.ts path (checkout -> stage -> DiffDrawer -> commit),
 * then Save as… a real table artifact and reopen it from the sidebar Tables
 * section.
 *
 * Fixture facts relied on below (examples/smart-city.model.json,
 * smart-city.metamodel.yaml — see navigation.spec.ts for the fuller writeup):
 *  - 12 SoftwareSystem elements, each with a string `name` property (NamedElement
 *    base type), so picking SoftwareSystem as the nav's start type alone is
 *    both runnable (isRunnable requires only a non-pristine start or a
 *    complete step) and guaranteed to produce non-empty rows.
 *  - SystemContainsComponent hops from every SoftwareSystem reach a Component
 *    subtype, so adding it as a relationship step (mirroring navigation.spec's
 *    exact steps) stays non-empty without needing a filter step.
 *
 * UI facts (source-verified, NOT the placeholder selectors in the task brief):
 *  - "Open as table" lives in NavigationBuilder's toolbar (no data-testid;
 *    `getByRole('button', { name: 'Open as table' })`), disabled until
 *    `isRunnable(draft.definition)`. Clicking it opens a brand-new `tbl:draft:N`
 *    tab, makes it the active tab, and immediately loads a table definition
 *    derived from the nav (one `element` column per chain hop) — see
 *    NavigationBuilder.svelte's `openAsTable` and table/columns.ts's
 *    `navigationAsTableDefinition`.
 *  - ColumnManager's "+ Property column" button (data-testid="add-property-column")
 *    creates the column EMPTY (row source defaulted to `chain_index: 0`, the
 *    Start column; no name yet) and opens its per-column PropertyColumnEditor
 *    — the property name is picked/typed there via a free-text input
 *    (`aria-label="Property name"`), not at creation time. This is the
 *    add-then-edit flow (Stage 2 Task 6): property columns stay editable at
 *    any time, not just immediately after adding. Typing "name" lands
 *    editable ValueCells sourced from the SoftwareSystem elements.
 *  - ValueCell (Table/Cell/ValueCell.svelte) renders a plain
 *    `<input type="text">` for string properties, committing via `onchange`
 *    (not `oninput`) through the SAME `editLock` -> `emit` checkout path the
 *    Inspector uses — so `.fill()` + `.blur()` (not just `.fill()`) is needed
 *    to fire the native `change` event, exactly like commit-flow.spec.ts's
 *    Inspector edit.
 *  - Table/TableView.svelte's "Save as…" button calls `window.prompt('Save as', …)`
 *    (a NATIVE dialog, not a DOM textbox) then `saveAsTableDraft`, which —
 *    unlike navigation's `saveAsDraft` — REBINDS the current tab in place
 *    (`moveTabState`) rather than opening a second tab, and retitles it via
 *    `retitleTab`, so the tab's close button becomes `aria-label="Close My Table"`.
 *  - Sidebar table rows: `frontend/src/lib/components/Sidebar/ArtifactsSection.svelte`
 *    renders `<li data-artifact-id={item.id}>` under a "Tables" section, with
 *    `ondblclick` -> `openArtifactTab('table', …)` — identical shape to the
 *    `[data-artifact-id]` / `span.flex-1` pattern navigation.spec.ts already
 *    uses for the Navigations section.
 *
 * Like commit-flow.spec.ts (and unlike navigation.spec.ts, which happens to
 * run early alphabetically), this spec explicitly reloads the smart-city
 * files via the load dialog: the suite shares one backend project across
 * spec files (`workers: 1`), and a spec that runs later (e.g. strict-mode.spec.ts,
 * alphabetically before "table") can leave the model in a different — even
 * empty — state. Without this, the SoftwareSystem type picker below can come
 * up with "No matches." against a stale/empty model.
 */
test('open navigation as table, add a column, edit a cell, commit, save, and reopen', async ({
	page
}) => {
	test.setTimeout(120_000);

	// One dialog handler for the whole test: accepts the load dialog's "discard
	// unsaved changes" confirm generically, and answers the Save as… `prompt()`
	// with a fixed name (see checkpoint 4 below).
	page.on('dialog', (dialog) => {
		if (dialog.type() === 'prompt') void dialog.accept('My Table');
		else void dialog.accept();
	});

	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// --- 1. Build a minimal navigation, then "Open as table" -----------------
	await page.getByRole('button', { name: 'New navigation' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');
	await expect(dock).toContainText('Pick what to start from');

	// Start types: SoftwareSystem (StereotypePicker in filter mode).
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();

	// A relationship hop (mirrors navigation.spec.ts's exact steps).
	await tabpanel.getByRole('button', { name: '+ Follow a relationship', exact: true }).click();
	const relStep = tabpanel.getByTestId('relationship-step');
	await expect(relStep).toHaveCount(1);
	await relStep.getByText('pick a relationship…', { exact: true }).click();
	await page.getByPlaceholder('Relationship type…').fill('SystemContainsComponent');
	await page.getByRole('button', { name: 'SystemContainsComponent', exact: true }).click();
	await expect(relStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();

	// The dock auto-runs the path; wait for a non-empty result before opening
	// as a table (guards against a race where "Open as table" is clicked while
	// still technically disabled/pristine).
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });

	const openAsTableButton = tabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();

	// The new table tab becomes the active (only) tabpanel; `tabpanel` is a
	// lazy locator so it now resolves to the table tab.
	const grid = tabpanel.getByTestId('table-grid');
	await expect(grid).toBeVisible({ timeout: 15_000 });
	const header = tabpanel.getByTestId('table-header');
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });

	// --- 2. Add a property column via the ColumnManager, now behind the
	// ⚙ Settings popup (add-then-edit: the column is created empty and the
	// property is picked/typed in the per-column editor). The popup is portaled
	// to the body, so its controls are scoped to the dialog, not the tabpanel;
	// the grid keeps rendering live underneath. -----------------------------
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	const columnCountBefore = await header.locator('> div').count();
	await settings.getByTestId('add-property-column').click();
	await expect(header.locator('> div')).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	await settings.getByLabel('Property name').fill('name');
	// The grid re-evaluates with the edited definition; the new column now
	// carries values (any non-empty cell text will do — seeded elements all
	// have a `name`).
	await expect(tabpanel.getByTestId('table-row').first()).toContainText(/\w/, {
		timeout: 10_000
	});
	// Close the popup so its overlay stops intercepting clicks on the grid for
	// the value-cell edit in section 3.
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();

	// --- 3. Edit a value cell, then stage -> commit through the DiffDrawer ---
	// (this reuses the Inspector's exact checkout/commit path — see
	// commit-flow.spec.ts — NOT a naive "commit" button/toast.)
	const uncommittedBadge = page.locator('footer').getByText(/\d+ uncommitted/);
	await expect(uncommittedBadge).toBeVisible({ timeout: 15_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted');

	const firstRow = tabpanel.getByTestId('table-row').first();

	// Select the row's Start-column element first (clicking its ElementCell
	// button, as a real user would to see it in the Inspector). This isn't
	// cosmetic: the staged-diff badge is computed from the shared `_elements`
	// cache (model.svelte.ts's `getStagedDiff`), which a table page's rows
	// never populate on their own (evaluate() results are table-page-local).
	// Inspector.svelte is mounted persistently (routes/p/[projectId]/+page.svelte)
	// regardless of the active workspace tab, and its `$effect` calls
	// `ensureElement(selection.id)` whenever the selection changes — so
	// selecting the element here is what makes the subsequent edit visible to
	// `getStagedDiff()` / the footer badge / the DiffDrawer's Commit button
	// (all disabled/zero otherwise, since `applyOptimistic`'s `update_element`
	// case no-ops for an uncached element).
	await firstRow.locator('button').first().click();
	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });

	const cell = firstRow.locator('input[type="text"]').first();
	await expect(cell).toBeVisible({ timeout: 10_000 });
	const editedValue = `e2e-table-edit-${Date.now()}`;
	await cell.fill(editedValue);
	// ValueCell commits on native `change`, which fires on blur (not on fill's
	// `input` event alone) — see the file-header note above.
	await cell.blur();

	await expect(uncommittedBadge).not.toContainText('0 uncommitted', { timeout: 15_000 });

	await page.keyboard.press('Control+s');
	const drawer = page.getByRole('dialog', { name: /commit changes/i });
	await expect(drawer).toBeVisible({ timeout: 10_000 });
	const commitButton = drawer.getByRole('button', { name: /^Commit/ });
	await expect(commitButton).toBeEnabled({ timeout: 20_000 });
	await commitButton.click();

	await expect(drawer).toBeHidden({ timeout: 20_000 });
	await expect(uncommittedBadge).toContainText('0 uncommitted', { timeout: 15_000 });

	// --- 4. Save as… a real artifact, then reopen from the sidebar -----------
	// (the `dialog` handler registered at the top of the test answers the
	// native `window.prompt('Save as', …)` with 'My Table'.)
	await tabpanel.getByRole('button', { name: /Save as/ }).click();

	const tableItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^My Table$/ }) });
	await expect(tableItem).toBeVisible({ timeout: 10_000 });

	// saveAsTableDraft rebinds the CURRENT tab in place (unlike navigation's
	// saveAsDraft, which opens a second tab) — confirm the tab title followed.
	await expect(page.getByRole('button', { name: 'Close My Table' })).toBeVisible();

	// Close the tab, then reopen the artifact via a sidebar double-click —
	// exercises the actual "open from library" path, not just presence.
	await page.getByRole('button', { name: 'Close My Table' }).click();
	await tableItem.dblclick();

	const reopened = page.getByRole('tabpanel');
	await expect(reopened.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(reopened.getByTestId('table-name')).toHaveValue('My Table');
});

/**
 * E2E for lazy row loading: a NEW table defaults to a scope row source with
 * no type filter, so every element in the model (1000+ in smart-city) is a
 * row — far more than the first fetched chunk (100). The grid must (a) size
 * its scrollbar for the FULL row set immediately and (b) fill a deep scroll
 * position with lazily fetched rows, rendering placeholders only while the
 * chunk is in flight.
 */
test('lazy loads rows while scrolling a large scope table', async ({ page }) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	await page.getByRole('button', { name: 'New table' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const grid = tabpanel.getByTestId('table-grid');
	await expect(grid).toBeVisible({ timeout: 15_000 });

	// A new table opens EMPTY (no scope yet): pick "all elements" explicitly via
	// the settings popup's scope picker (Select all types) to get the large scope.
	await expect(tabpanel.getByTestId('table-empty-hint')).toBeVisible();
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	await settings.getByText('any element', { exact: true }).click();
	await page.getByRole('button', { name: 'Select all', exact: true }).click();
	await page.keyboard.press('Escape'); // close the type picker popover
	await page.keyboard.press('Escape'); // close the settings dialog
	await expect(settings).toBeHidden();
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });

	// Sized for the whole table although only the first chunk is loaded
	// (smart-city has ~1000 elements at 28px per row; one chunk is 100 rows).
	const scrollHeight = await grid.evaluate((el) => el.scrollHeight);
	expect(scrollHeight).toBeGreaterThan(500 * 28);

	// Jump deep into the table: rows there were never fetched. The window
	// fills with real rows once the chunk lands; no placeholder sticks around.
	await grid.evaluate((el) => el.scrollTo({ top: 500 * 28 }));
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-row-placeholder')).toHaveCount(0, {
		timeout: 15_000
	});
});

/**
 * E2E for inline navigation/row-source definitions (Stage 2 Tasks 4–5):
 * a navigation column or a chains row source can carry its OWN navigation
 * definition — edited in place with the real navigation builder (PathCard /
 * StatusChip), embedded in the column panel via an embedded draft — instead
 * of only referencing a saved navigation artifact.
 */
test('inline navigation column and inline row source', async ({ page }) => {
	test.setTimeout(120_000);
	// Reload the fixtures: the suite shares one backend project across spec
	// files/tests (workers: 1), so state from the previous test must not be
	// assumed (same rationale as the first test's header comment).
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// --- Build a minimal navigation, then "Open as table" (mirrors test 1) ---
	await page.getByRole('button', { name: 'New navigation' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');
	await expect(dock).toContainText('Pick what to start from');
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });
	const openAsTableButton = tabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
	const header = tabpanel.getByTestId('table-header');

	// --- Inline navigation column ------------------------------------------
	// A freshly added navigation column defaults to REF mode with no ref
	// selected (`navigation: {}`), which the backend rejects (422) — the
	// evaluate that add-navigation-column triggers is superseded by the one
	// switching to inline triggers (loadTablePage's generation counter), so
	// switch to inline BEFORE asserting on the (evaluate-derived) header —
	// asserting the header count right after the add click alone would wait
	// on a 422'd load that never produces a 2nd header column.
	// The ColumnManager now lives behind the ⚙ Settings popup (portaled to the
	// body); open it and scope column edits to the dialog. Grid/header
	// assertions below still read from the tabpanel — it renders live behind
	// the overlay — and there are no grid *clicks* in this test, so the popup
	// can stay open through to the end.
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	const columnCountBefore = await header.locator('> div').count();
	await settings.getByTestId('add-navigation-column').click();
	await settings.getByTestId('nav-mode-inline').click();

	// The embedded builder appears with a row-rooted path ("each row's
	// element"); add a relationship step exactly like the standalone builder
	// (same locator sequence as section 1 above, scoped to the inline editor).
	const inlineEditor = settings.getByTestId('inline-nav-editor');
	await expect(inlineEditor).toBeVisible();
	// PathCards start collapsed inside Table settings — expand this one so its
	// editing body (start row, step rows, "+ Follow a relationship") renders.
	const inlineCollapseToggle = inlineEditor.getByTestId('path-collapse-toggle').first();
	await inlineCollapseToggle.click();
	await expect(inlineCollapseToggle).toHaveAttribute('aria-expanded', 'true');
	await expect(inlineEditor).toContainText("each row's element");
	await expect(header.locator('> div')).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	await inlineEditor.getByRole('button', { name: '+ Follow a relationship', exact: true }).click();
	const inlineRelStep = inlineEditor.getByTestId('relationship-step');
	await expect(inlineRelStep).toHaveCount(1);
	await inlineRelStep.getByText('pick a relationship…', { exact: true }).click();
	await page.getByPlaceholder('Relationship type…').fill('SystemContainsComponent');
	await page.getByRole('button', { name: 'SystemContainsComponent', exact: true }).click();
	await expect(inlineRelStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();

	// The embedded status chip previews against the table's first row.
	await expect(inlineEditor.getByTestId('status-chip')).toContainText(/✓ \d+ chains/, {
		timeout: 15_000
	});
	// And the grid itself re-evaluated with the inline definition.
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });

	// --- Inline row source ---------------------------------------------------
	// Switch the rows to an inline chains navigation: the seed is an empty
	// scope-started path, which evaluates to one chain per element — rows
	// appear without further editing. This drops the earlier columns'
	// meaning (chains of length 1); that's fine — the assertion here is only
	// that rows render against the new row source.
	await settings.getByLabel('Row source kind').selectOption('chains');
	await settings.getByTestId('rowsource-mode-inline').click();
	await expect(settings.getByTestId('inline-rowsource-editor')).toBeVisible();
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
});
