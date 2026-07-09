import { expect, test } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

/**
 * Drives the refactored navigation builder (chain rail + results dock):
 * build a root Path (start types → "+ Follow a relationship" → "+ Keep only…"),
 * "Combine with… → A new path" to auto-wrap it into a Union, select nodes via
 * the cards AND the dock picker, assert the dock's numbered column headers and
 * the per-card status chips, set a "→ feeds" value, flip the operator to
 * Difference and see the `base` badge, then Save / Save as… / reopen and
 * assert the structure round-trips.
 *
 * Fixture facts relied on below (examples/smart-city.model.json,
 * smart-city.metamodel.yaml):
 *  - 12 SoftwareSystem elements; SystemContainsComponent (source: System,
 *    target: Component, no explicit `mappings`) hops from them reach every
 *    Component subtype (Service, Microservice, Database, MessageBroker,
 *    Cache) — the relationship step's own target-type picker only offers the
 *    metamodel-declared "Component" (not its concrete subtypes), so the step
 *    below deliberately leaves target types unset ("any type") and instead
 *    narrows via the filter step below.
 *  - `language` is a Microservice-only property (unique across the whole
 *    metamodel) with values including "python"; 5 of the 28 Microservices
 *    reached this way have `language: "python"` — so the relationship-step +
 *    filter-step combo below is guaranteed to produce a non-empty preview.
 */
test('build, combine, select nodes, save, save-as, and reopen round-trips the structure', async ({
	page
}) => {
	test.setTimeout(120_000);
	await openDefaultProject(page);

	// --- 1. Open a new navigation tab ---------------------------------------
	await page.getByRole('button', { name: 'New navigation' }).click();
	await expect(page.getByText('New navigation', { exact: true })).toBeVisible();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');

	// A fresh draft is not runnable: the dock says so, directively.
	await expect(dock).toContainText('Pick what to start from');

	// --- 2. Build the root Path ---------------------------------------------
	// Start types: StereotypePicker in `filter` mode (checkbox list). Set this
	// BEFORE adding the hop so its own unset target pill ("any type") can't
	// collide with the start pill ("any element").
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();

	// exact: true on these three names — the PathCard root is itself a
	// role="button" whose accessible name (computed from contents) CONTAINS
	// every inner label, so a substring match would hit the card too.
	await tabpanel.getByRole('button', { name: '+ Follow a relationship', exact: true }).click();
	const relStep = tabpanel.getByTestId('relationship-step');
	await expect(relStep).toHaveCount(1);
	await relStep.getByText('pick a relationship…', { exact: true }).click();
	await page.getByPlaceholder('Relationship type…').fill('SystemContainsComponent');
	await page.getByRole('button', { name: 'SystemContainsComponent', exact: true }).click();
	await expect(relStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();

	await tabpanel.getByRole('button', { name: '+ Keep only…', exact: true }).click();
	const filterStep = tabpanel.getByTestId('filter-step');
	await expect(filterStep).toHaveCount(1);
	await filterStep.getByRole('button', { name: '+ condition' }).click();
	await filterStep.getByText('property…', { exact: true }).click();
	await page.getByPlaceholder('Filter properties…').fill('language');
	await page.getByRole('button', { name: 'language' }).click();
	await filterStep.getByPlaceholder('value').fill('python');

	// --- 3. The dock auto-runs the (selected, default-root) path ------------
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });
	// Column headers mirror the rail: Start | SystemContainsComponent.
	await expect(dock.locator('thead th')).toHaveCount(2);
	await expect(dock.locator('thead th').nth(1)).toContainText('SystemContainsComponent');

	// --- 4. "Combine with… → A new path" auto-wraps into a Union -----------
	await tabpanel.getByRole('button', { name: 'Combine with… ▾', exact: true }).click();
	await page.getByRole('menuitem', { name: /A new path/ }).click();
	await expect(tabpanel.getByTestId('combine-frame')).toHaveCount(1);
	await expect(tabpanel.getByTestId('path-card')).toHaveCount(2);
	await expect(tabpanel.getByTestId('op-divider')).toContainText('∪ union');
	// The built steps travelled into operand 0 unchanged…
	await expect(tabpanel.getByTestId('relationship-step')).toHaveCount(1);
	await expect(tabpanel.getByTestId('filter-step')).toHaveCount(1);
	// …and the selection followed the node (applyStructuralEdit remap), so the
	// dock still shows Path A's chains rather than falling back to the root.
	await expect(tabpanel.getByTestId('node-picker')).toHaveValue('0');
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });

	// Path B is empty: its card status chip says so.
	const pathB = tabpanel.getByTestId('path-card').nth(1);
	await expect(pathB.getByTestId('status-chip')).toContainText('incomplete');

	// --- 5. Selection: card click and dock picker are the two ways ----------
	await pathB.click();
	await expect(tabpanel.getByTestId('node-picker')).toHaveValue('1');
	await expect(dock).toContainText('Nothing to run yet — pick what Path B starts from');

	await tabpanel.getByTestId('node-picker').selectOption('');
	await expect(dock).toContainText('Combined elements');
	await expect(tabpanel.getByTestId('combine-frame')).toHaveAttribute('data-selected', 'true');

	// --- 6. The feeds chip writes step_index -------------------------------
	const pathA = tabpanel.getByTestId('path-card').first();
	await pathA.getByTestId('feeds-chip').click();
	await page.getByTestId('feeds-option').first().click(); // "the start"
	await expect(pathA.getByTestId('feeds-chip')).toContainText('the start');

	// --- 7. Difference marks the first part `base` -------------------------
	const operator = tabpanel.getByRole('combobox', { name: 'Combination operator' });
	await operator.selectOption('difference');
	await expect(tabpanel.getByTestId('base-badge')).toHaveCount(1);
	await expect(tabpanel.getByTestId('op-divider')).toContainText('− minus');
	await operator.selectOption('union'); // back to a union for the round-trip

	// --- 8. Save, then Save as… --------------------------------------------
	const nameInput = tabpanel.getByTestId('nav-name');
	await expect(nameInput).toHaveValue('New navigation');
	await nameInput.fill('Nav base');
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	const navBaseItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^Nav base$/ }) });
	await expect(navBaseItem).toBeVisible();

	page.on('dialog', (dialog) => void dialog.accept('Nav base copy'));
	await tabpanel.getByRole('button', { name: /Save as/ }).click();
	const navBaseCopyItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^Nav base copy$/ }) });
	await expect(navBaseCopyItem).toBeVisible();
	await expect(navBaseItem).toBeVisible();

	// --- 9. Reopen the ORIGINAL and verify the round-trip ------------------
	await page.getByRole('button', { name: 'Close Nav base copy' }).click();
	await navBaseItem.dblclick();
	const reopened = page.getByRole('tabpanel');
	await expect(reopened.getByTestId('combine-frame')).toHaveCount(1);
	await expect(reopened.getByTestId('path-card')).toHaveCount(2);
	await expect(reopened.getByTestId('results-dock')).toContainText(/✓ \d+ chains/, {
		timeout: 15_000
	});

	const reopenedRelStep = reopened.getByTestId('relationship-step');
	await expect(reopenedRelStep).toHaveCount(1);
	await expect(reopenedRelStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();
	const reopenedFilterStep = reopened.getByTestId('filter-step');
	await expect(reopenedFilterStep).toHaveCount(1);
	await expect(reopenedFilterStep.getByPlaceholder('value')).toHaveValue('python');
	// step_index survived the save/reopen: Path A still feeds the start.
	await expect(reopened.getByTestId('path-card').first().getByTestId('feeds-chip')).toContainText(
		'the start'
	);
});
