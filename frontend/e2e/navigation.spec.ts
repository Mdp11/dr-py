import { expect, test } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

/**
 * Drives the reworked (Stage-2, composition-capable) navigation builder:
 * build a root Path leaf (start types + a relationship step + a filter
 * step), "+ insert navigation" it into a 2-operand Combine, expand the root
 * AND a nested operand's chain preview, Save, Save as… (handling the
 * `window.prompt` dialog), then reopen the originally-saved navigation from
 * the sidebar tree and assert the whole composition round-trips.
 *
 * Fixture facts relied on below (examples/smart-city.model.json,
 * smart-city.metamodel.yaml):
 *  - 12 SoftwareSystem elements; SystemContainsComponent (source: System,
 *    target: Component, no explicit `mappings`) hops from them reach every
 *    Component subtype (Service, Microservice, Database, MessageBroker,
 *    Cache) — the relationship step's own target-type picker only offers the
 *    metamodel-declared "Component" (not its concrete subtypes), so the step
 *    below deliberately leaves target types unset ("Any type") and instead
 *    narrows via the filter step below.
 *  - `language` is a Microservice-only property (unique across the whole
 *    metamodel) with values including "python"; 5 of the 28 Microservices
 *    reached this way have `language: "python"` — so the relationship-step +
 *    filter-step combo below is guaranteed to produce a non-empty preview.
 */
test('build, compose into a combine, save, save-as, and reopen round-trips the structure', async ({
	page
}) => {
	test.setTimeout(120_000);
	await openDefaultProject(page);

	// --- 1. Open a new navigation tab -----------------------------------------
	// bits-ui hides inactive Tabs.Content panels via the `hidden` attribute, so
	// getByRole('tabpanel') always resolves to the one active panel.
	await page.getByRole('button', { name: 'New navigation' }).click();
	await expect(page.getByText('New navigation', { exact: true })).toBeVisible();
	const tabpanel = page.getByRole('tabpanel');

	// --- 2. Build the root Path leaf -------------------------------------------
	// Start types: the picker is a checkbox filter list (StereotypePicker,
	// mode="filter"), not role="option". Set this BEFORE adding the
	// relationship step so its own (still-unset) target-type trigger is the
	// only "Any type" text left on the page.
	await tabpanel.getByText('Any type', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();

	// Relationship step.
	await tabpanel.getByRole('button', { name: '+ relationship step' }).click();
	const relStep = tabpanel.locator('[data-testid="relationship-step"]');
	await expect(relStep).toHaveCount(1);
	// Relationship-type picker (StereotypePicker, mode="create"): picking an
	// item auto-closes the popover, no Escape needed.
	await relStep.getByText('pick relationship', { exact: true }).click();
	await page.getByPlaceholder('Relationship type…').fill('SystemContainsComponent');
	await page.getByRole('button', { name: 'SystemContainsComponent', exact: true }).click();
	await expect(relStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();
	// Target types deliberately left as "Any type" — the metamodel only maps
	// this relationship to the abstract "Component" (not its concrete
	// subtypes like Microservice), so narrowing happens via the filter step
	// below instead.

	// Filter step: one property condition (language = python).
	await tabpanel.getByRole('button', { name: '+ filter step' }).click();
	const filterStep = tabpanel.locator('[data-testid="filter-step"]');
	await expect(filterStep).toHaveCount(1);
	await filterStep.getByRole('button', { name: '+ condition' }).click();
	await filterStep.getByText('property…', { exact: true }).click();
	await page.getByPlaceholder('Filter properties…').fill('language');
	// The property-picker row also renders the datatype badge ("string"), so
	// the accessible name is "language string" — match by substring.
	await page.getByRole('button', { name: 'language' }).click();
	await filterStep.getByPlaceholder('value').fill('python');
	await expect(filterStep.getByPlaceholder('value')).toHaveValue('python');

	// --- 3. "+ insert navigation" at the root auto-wraps into a Combine -------
	// Root is still a bare Path here, so this is the only "+ insert
	// navigation" button on the page.
	await tabpanel.getByRole('button', { name: '+ insert navigation' }).click();
	const combineLabel = tabpanel.getByText('Combine', { exact: true });
	await expect(combineLabel).toBeVisible();
	const operatorSelect = combineLabel.locator('xpath=following-sibling::select[1]');
	await expect(operatorSelect).toHaveValue('union');
	const operands = tabpanel.locator('ul > li');
	await expect(operands).toHaveCount(2);
	// The built steps travelled into operand 0 unchanged.
	await expect(tabpanel.locator('[data-testid="relationship-step"]')).toHaveCount(1);
	await expect(tabpanel.locator('[data-testid="filter-step"]')).toHaveCount(1);

	// --- 4. Expand previews ------------------------------------------------
	// The root node is expanded by default (see navigation-editor.svelte.ts)
	// and auto-runs on every edit — no manual Run button, no explicit expand
	// click needed here. Assert the combined preview settles into either
	// rendered chains or the "definition not complete" hint.
	await expect(
		tabpanel.getByText(/of \d+ chains/).or(tabpanel.getByText('Complete the steps to see results'))
	).toBeVisible({ timeout: 15_000 });

	// Now expand operand 0's OWN nested preview (not auto-expanded — only the
	// root is). Scope to the operand `<li>` that holds the relationship step
	// (its nearest `<li>` ancestor), so we hit its PathLeafEditor's own
	// "Toggle preview" button, not the root Combine's.
	const operand0 = relStep.locator('xpath=ancestor::li[1]');
	await operand0.getByRole('button', { name: 'Toggle preview' }).click();
	// language=python Microservices reached via SystemContainsComponent from a
	// SoftwareSystem exist in the fixture, so this settles on real chains.
	await expect(operand0.getByText(/of \d+ chains/)).toBeVisible({ timeout: 15_000 });

	// --- 5. Save, then Save as… -------------------------------------------
	const nameInput = tabpanel.locator('input.w-56');
	await expect(nameInput).toHaveValue('New navigation');
	await nameInput.fill('Nav base');
	// Anchored to avoid matching "Save as…" too (/^Save/ alone would).
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	const navBaseItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^Nav base$/ }) });
	await expect(navBaseItem).toBeVisible();

	// Save-as uses window.prompt — the ONLY dialog this test ever triggers.
	page.on('dialog', (dialog) => void dialog.accept('Nav base copy'));
	await tabpanel.getByRole('button', { name: /Save as/ }).click();
	const navBaseCopyItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^Nav base copy$/ }) });
	await expect(navBaseCopyItem).toBeVisible();
	await expect(navBaseItem).toBeVisible(); // the original is untouched, both are in the library

	// --- 6. Reopen the ORIGINAL saved navigation and verify the round-trip --
	// The active tab is now "Nav base copy" (Save-as rebinds the tab).
	await page.getByRole('button', { name: 'Close Nav base copy' }).click();
	await navBaseItem.dblclick();
	// Reopening a saved navigation auto-runs its (still-default-expanded) root
	// once immediately.
	const reopened = page.getByRole('tabpanel');
	await expect(reopened.getByText(/of \d+ chains/)).toBeVisible({ timeout: 15_000 });

	const reopenedCombineLabel = reopened.getByText('Combine', { exact: true });
	await expect(reopenedCombineLabel).toBeVisible();
	await expect(reopenedCombineLabel.locator('xpath=following-sibling::select[1]')).toHaveValue(
		'union'
	);
	await expect(reopened.locator('ul > li')).toHaveCount(2);

	const reopenedRelStep = reopened.locator('[data-testid="relationship-step"]');
	await expect(reopenedRelStep).toHaveCount(1);
	await expect(reopenedRelStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();

	const reopenedFilterStep = reopened.locator('[data-testid="filter-step"]');
	await expect(reopenedFilterStep).toHaveCount(1);
	await expect(reopenedFilterStep.getByText('language', { exact: false })).toBeVisible();
	await expect(reopenedFilterStep.getByPlaceholder('value')).toHaveValue('python');
});
