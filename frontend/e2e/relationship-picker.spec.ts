import { test, expect } from '@playwright/test';
import { loadFiles } from './helpers/load';

// Self-contained fixtures (mirrors how smoke.spec.ts builds inline buffers).
// From an `A` element: AtoB is metamodel-allowed; BtoB is not (B-source only).
const METAMODEL = {
	name: 'picker.metamodel.yaml',
	mimeType: 'application/x-yaml',
	buffer: Buffer.from(
		[
			'elements:',
			'  - name: A',
			'    properties:',
			'      - {name: name, datatype: string, multiplicity: "0..1"}',
			'  - name: B',
			'    properties:',
			'      - {name: name, datatype: string, multiplicity: "0..1"}',
			'relationships:',
			'  - name: AtoB',
			'    source: A',
			'    target: B',
			'    target_multiplicity: "0..*"',
			'  - name: BtoB',
			'    source: B',
			'    target: B',
			''
		].join('\n')
	)
};

const MODEL = {
	name: 'picker.model.json',
	mimeType: 'application/json',
	buffer: Buffer.from(
		JSON.stringify({
			elements: [
				{ id: 'a1', type_name: 'A', properties: { name: 'Alpha' } },
				{ id: 'b1', type_name: 'B', properties: { name: 'Bravo' } }
			],
			relationships: []
		})
	)
};

test.beforeEach(async ({ page }) => {
	page.on('dialog', (dialog) => void dialog.accept());
});

test('relationship picker filters by metamodel and reveals all via escape hatch', async ({
	page
}) => {
	test.setTimeout(90_000);
	await page.goto('/');
	await loadFiles(page, { metamodel: METAMODEL, model: MODEL });

	// Wait for the live feed to connect (model is fully loaded and WebSocket is up).
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// Reset the stereotype type filter to "Select all" so both A and B elements
	// are visible in the tree (the filter may be initialized from a prior test's
	// metamodel and show nothing).
	const filterButton = page.locator('[aria-label="Filter stereotypes"]');
	await filterButton.click();
	const selectAllBtn = page.getByRole('button', { name: 'Select all', exact: true });
	await expect(selectAllBtn).toBeVisible({ timeout: 5_000 });
	await selectAllBtn.click();
	await page.keyboard.press('Escape');

	// --- Select element Alpha (type A) in the containment tree ---
	// The tree renders without a view file, so elements appear directly as root
	// rows. Each row has a `button.flex-1` pick button showing the element name.
	const treeEl = page.getByRole('tree', { name: /containment tree/i });
	await expect(treeEl).toBeVisible({ timeout: 15_000 });

	// Wait for at least one element row pick button to appear.
	await expect(treeEl.locator('button.flex-1').first()).toBeVisible({ timeout: 15_000 });

	// Click the pick button for "Alpha". The pick button contains a whitespace-nowrap
	// span with the element display name (see TreeRow.svelte line ~303).
	const alphaPickButton = treeEl.locator('button.flex-1', { hasText: 'Alpha' }).first();
	await expect(alphaPickButton).toBeVisible({ timeout: 10_000 });
	await alphaPickButton.click();

	// Wait for the inspector to show the element (data-testid="inspector").
	const inspector = page.getByTestId('inspector');
	await expect(inspector).toBeVisible({ timeout: 10_000 });

	// --- Open the "New relationship" picker ---
	// NewRelationshipPicker renders a button "New relationship" when collapsed.
	const newRelButton = inspector.getByRole('button', { name: 'New relationship' });
	await expect(newRelButton).toBeVisible({ timeout: 10_000 });
	await newRelButton.click();

	// The picker expands into a form with a type <select> and a "Show all types" checkbox.
	// The type select is the first <select> (combobox role) in the inspector.
	const typeSelect = inspector.getByRole('combobox').first();
	await expect(typeSelect).toBeVisible({ timeout: 5_000 });

	// --- Assertion 1: In filtered (default) mode, AtoB is offered, BtoB is hidden ---
	await expect(typeSelect.getByRole('option', { name: /AtoB/ })).toHaveCount(1);
	await expect(typeSelect.getByRole('option', { name: /BtoB/ })).toHaveCount(0);

	// --- Assertion 2: "Show all types" reveals BtoB ---
	// The checkbox is wrapped by a <label> with text "Show all types". Use getByLabel
	// first; if that fails (implicit label without for=), fall back to locating
	// the checkbox inside the label element.
	const showAllCheckbox = inspector.getByLabel('Show all types');
	await showAllCheckbox.check();
	await expect(typeSelect.getByRole('option', { name: /BtoB/ })).toHaveCount(1);

	// --- Assertion 3: Create AtoB -> Bravo and confirm it appears ---
	// Uncheck "Show all types" so only allowed types are shown, then select AtoB.
	await showAllCheckbox.uncheck();

	// Select the AtoB type. The option label is "AtoB → B" (optionLabel function in the component).
	// Playwright selectOption does not accept regex for label; use value (the rt.name) instead.
	await typeSelect.selectOption({ value: 'AtoB' });

	// After selecting the type, the target select appears (second combobox in the picker).
	// Wait for candidate targets to be fetched (the effect fires asynchronously).
	const targetSelect = inspector.getByRole('combobox').nth(1);
	await expect(targetSelect).toBeVisible({ timeout: 10_000 });

	// Select Bravo as the target. Options are rendered as "{name} — {type_name}".
	// Use value (the element id) for the target select as well.
	await targetSelect.selectOption({ value: 'b1' });

	// Click Create. connectLock auto-acquires a lock on the source+target, then emits the op.
	const createButton = inspector.getByRole('button', { name: 'Create', exact: true });
	await expect(createButton).toBeEnabled({ timeout: 5_000 });
	await createButton.click();

	// After creation, the picker resets (collapses back to "New relationship" button).
	// The new outgoing relationship should appear in the inspector's RelationshipsList.
	// We wait for the inspector to reflect the new relationship (type name "AtoB" visible).
	await expect(inspector.getByText(/AtoB/).first()).toBeVisible({ timeout: 15_000 });
});
