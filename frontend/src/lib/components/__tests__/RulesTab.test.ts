import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import * as rulesApi from '$lib/api/rules';
import {
	ensureRulesDraft,
	getRulesDraft,
	resetRulesEditors,
	setRulesName
} from '$lib/state/rules-editor.svelte';
import { getStagedArtifactOps, resetArtifactEdits } from '$lib/state/artifact-edits.svelte';
import { resetArtifacts } from '$lib/state/artifacts.svelte';
import { resetCheckout, setProjectInfo } from '$lib/state/checkout.svelte';
import { openArtifactTab, resetWorkspaceTabs } from '$lib/state/workspace.svelte';
import RulesTab from '../Rules/RulesTab.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetRulesEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 });
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({ ok: true, errors: [], warnings: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	resetRulesEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	host.remove();
	vi.restoreAllMocks();
});

/** The tab's own `$effect` calls `ensureRulesDraft`, but that is async — seed
 * the draft first so the first render already has one. */
async function open(): Promise<string> {
	const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
	await ensureRulesDraft(tabId);
	app = mount(RulesTab, { target: host, props: { tabId } });
	flushSync();
	return tabId;
}

describe('RulesTab', () => {
	it('renders the YAML editor and a Save button', async () => {
		await open();
		expect(host.querySelector('[data-testid="rules-editor"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="rules-save"]')).not.toBeNull();
	});

	it('Save stages a create_artifact op for the draft', async () => {
		const tabId = await open();
		setRulesName(tabId, 'House rules');
		flushSync();

		host.querySelector<HTMLButtonElement>('[data-testid="rules-save"]')!.click();
		flushSync();

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'validation_rules',
				name: 'House rules',
				payload: { schema_version: 1, yaml: getRulesDraft(tabId)!.yaml }
			}
		]);
	});

	it('marks the Save button while the draft is dirty', async () => {
		const tabId = await open();
		expect(host.querySelector('[data-testid="rules-save"]')!.textContent?.trim()).toBe('Save');
		setRulesName(tabId, 'Edited');
		flushSync();
		expect(host.querySelector('[data-testid="rules-save"]')!.textContent?.trim()).toBe('Save *');
	});

	it('renders a message-only lint error, which the gutter cannot show', async () => {
		// The dominant error class for a rule set: only a YAML PARSE failure
		// carries a position, so every schema violation arrives `line: null` and
		// MetamodelYamlEditor filters it out of the gutter.
		vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: false,
			errors: [
				{ message: "Invalid rule set: rule 'r1' is missing applies_to", line: null, column: null }
			],
			warnings: []
		});
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		await vi.waitFor(() => expect(getRulesDraft(tabId)?.lintErrors).toHaveLength(1));
		app = mount(RulesTab, { target: host, props: { tabId } });
		flushSync();

		const strip = host.querySelector('[data-testid="rules-lint-error"]');
		expect(strip?.textContent?.trim()).toBe("Invalid rule set: rule 'r1' is missing applies_to");
	});

	it('leaves a POSITIONED lint error to the editor gutter', async () => {
		vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: false,
			errors: [{ message: 'Malformed rules YAML', line: 2, column: 5 }],
			warnings: []
		});
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		await vi.waitFor(() => expect(getRulesDraft(tabId)?.lintErrors).toHaveLength(1));
		app = mount(RulesTab, { target: host, props: { tabId } });
		flushSync();

		expect(host.querySelector('[data-testid="rules-lint-error"]')).toBeNull();
	});

	it('disables Save while the lint reports errors', async () => {
		// The server refuses an unparseable rule set at commit, and a staged one
		// takes the whole batch down with it — the client already knows.
		vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: false,
			errors: [{ message: 'Malformed rules YAML', line: 2, column: 5 }],
			warnings: []
		});
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		await vi.waitFor(() => expect(getRulesDraft(tabId)?.lintErrors).toHaveLength(1));
		app = mount(RulesTab, { target: host, props: { tabId } });
		flushSync();

		const save = host.querySelector<HTMLButtonElement>('[data-testid="rules-save"]')!;
		expect(save.disabled).toBe(true);
		expect(save.title).toMatch(/lint error/i);
	});

	it('keeps Save enabled when the lint reports only drift warnings', async () => {
		// Drift is a degradation the server tolerates at save; only errors gate.
		vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: true,
			errors: [],
			warnings: [{ rule: 'sensor-has-owner', message: "unknown stereotype 'Sensor'" }]
		});
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		await vi.waitFor(() => expect(getRulesDraft(tabId)?.lintWarnings).toHaveLength(1));
		app = mount(RulesTab, { target: host, props: { tabId } });
		flushSync();

		expect(host.querySelector<HTMLButtonElement>('[data-testid="rules-save"]')!.disabled).toBe(
			false
		);
	});

	it('renders the drift warnings strip when the lint reports drift', async () => {
		vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: true,
			errors: [],
			warnings: [
				{ rule: 'sensor-has-owner', message: "unknown stereotype 'Sensor'" },
				{ rule: 'mass-set', message: "unknown property 'mass'" }
			]
		});
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		await vi.waitFor(() => expect(getRulesDraft(tabId)?.lintWarnings).toHaveLength(2));
		app = mount(RulesTab, { target: host, props: { tabId } });
		flushSync();

		const strip = host.querySelector('[data-testid="rules-drift-warnings"]');
		expect(strip).not.toBeNull();
		expect(strip!.textContent).toContain('sensor-has-owner');
		expect(strip!.textContent).toContain("unknown property 'mass'");
	});

	it('renders no drift strip when the lint is clean', async () => {
		await open();
		expect(host.querySelector('[data-testid="rules-drift-warnings"]')).toBeNull();
	});
});
