import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import IssuesPanel from '../Workspace/IssuesPanel.svelte';
import * as validationApi from '$lib/api/validation';
import type { RulesStatus } from '$lib/api/validation';
import { setOverlay, clearOverlay } from '$lib/state/validation.svelte';
import { adoptSummary, refetchIssues, resetModelStore } from '$lib/state/model.svelte';

vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

afterEach(() => {
	document.body.innerHTML = '';
	clearOverlay();
	resetModelStore();
	vi.restoreAllMocks();
});

function seedSummary() {
	adoptSummary({
		model_rev: 1,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: {},
		undo_depth: 0
	});
}

async function seedRulesStatus(rulesStatus: RulesStatus) {
	vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
		model_rev: 1,
		issues: [],
		counts: {},
		truncated: false,
		rules_status: rulesStatus
	});
	await refetchIssues();
}

function chipButtons(): HTMLButtonElement[] {
	const chips = document.body.querySelector('[data-testid="check-chips"]');
	if (chips === null) throw new Error('check-chips not found');
	return Array.from(chips.querySelectorAll('button'));
}

describe('IssuesPanel rule chips', () => {
	it('renders a rule:* check as its bare rule name, and filters on click', async () => {
		seedSummary();
		setOverlay([
			{
				severity: 'error',
				message: 'zone conflict',
				target_ids: ['a'],
				check: 'rule:zoned',
				origin: 'on_server'
			},
			{
				severity: 'warning',
				message: 'facets issue',
				target_ids: ['b'],
				check: 'facets',
				origin: 'on_server'
			}
		]);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const labels = chipButtons().map((b) => b.textContent?.trim());
		expect(labels).toContain('zoned (1)');

		const ruleChip = chipButtons().find((b) => b.textContent?.trim() === 'zoned (1)');
		ruleChip!.click();
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).toContain('zone conflict');
		expect(text).not.toContain('facets issue');

		unmount(c);
	});
});

describe('IssuesPanel skipped-rules banner', () => {
	it('shows a banner naming the skipped count with a set_name / rule / reason list', async () => {
		seedSummary();
		await seedRulesStatus({
			total: 3,
			skipped: [
				{
					artifact_id: 'art1',
					set_name: 'zoning',
					rule: 'zoned',
					reason: 'unknown stereotype Zone'
				}
			],
			eval_errors: {}
		});
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const banner = document.body.querySelector('[data-testid="rules-skipped-banner"]');
		expect(banner).not.toBeNull();
		const text = banner!.textContent ?? '';
		expect(text).toContain('1 rule');
		expect(text).toContain('skipped');
		expect(text).toContain('zoning');
		expect(text).toContain('zoned');
		expect(text).toContain('unknown stereotype Zone');

		unmount(c);
	});

	it('renders a whole-set parse failure (rule: "") sensibly, not blank', async () => {
		seedSummary();
		await seedRulesStatus({
			total: 2,
			skipped: [
				{ artifact_id: 'art2', set_name: 'broken-set', rule: '', reason: 'YAML parse error' }
			],
			eval_errors: {}
		});
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const banner = document.body.querySelector('[data-testid="rules-skipped-banner"]');
		expect(banner).not.toBeNull();
		const text = banner!.textContent ?? '';
		expect(text).toContain('broken-set');
		expect(text).toContain('YAML parse error');
		// a blank rule name renders as a placeholder, not an empty/missing token
		expect(text).not.toContain('broken-set /  —');
		expect(text).toMatch(/broken-set \/ \S/);
		// A set that would not PARSE is not a set that drifted from the schema:
		// the summary counts it as a rule set, and never calls it a mismatch.
		const summary = banner!.querySelector('summary')!.textContent ?? '';
		expect(summary).toContain('1 rule set skipped — parse failure');
		expect(summary).not.toContain('schema mismatch');

		unmount(c);
	});

	it('counts drifted rules and unparseable sets separately in the summary', async () => {
		seedSummary();
		await seedRulesStatus({
			total: 4,
			skipped: [
				{ artifact_id: 'a1', set_name: 'zoning', rule: 'zoned', reason: 'unknown stereotype' },
				{ artifact_id: 'a1', set_name: 'zoning', rule: 'owned', reason: 'unknown property' },
				{ artifact_id: 'a2', set_name: 'broken-set', rule: '', reason: 'YAML parse error' }
			],
			eval_errors: {}
		});
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const summary =
			document.body.querySelector('[data-testid="rules-skipped-banner"] summary')?.textContent ??
			'';
		expect(summary).toContain('2 rules skipped — schema mismatch');
		expect(summary).toContain('1 rule set skipped — parse failure');

		unmount(c);
	});

	it('renders no banner when skipped is empty', async () => {
		seedSummary();
		await seedRulesStatus({ total: 3, skipped: [], eval_errors: {} });
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		expect(document.body.querySelector('[data-testid="rules-skipped-banner"]')).toBeNull();

		unmount(c);
	});

	it('renders no banner when rules_status is null (no rule sets compiled)', () => {
		seedSummary();
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		expect(document.body.querySelector('[data-testid="rules-skipped-banner"]')).toBeNull();

		unmount(c);
	});
});
