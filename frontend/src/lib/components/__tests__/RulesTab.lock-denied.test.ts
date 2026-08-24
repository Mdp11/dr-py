// A lock-denied rules tab must not accumulate edits that can never land: the
// name field, the YAML editor and Save all go dead behind a holder banner whose
// only control is Retry.
//
// Uses the real rules-editor store (the idiom SnippetTab.lock-denied.test.ts
// established) rather than mocking `$lib/state`: `setRulesLockDenied` is a
// direct setter, so a denied tab needs no lease or network simulation.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as rulesApi from '$lib/api/rules';
import {
	ensureRulesDraft,
	getRulesDraft,
	resetRulesEditors,
	setRulesLockDenied
} from '$lib/state/rules-editor.svelte';
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
	resetCheckout();
	host.remove();
	vi.restoreAllMocks();
});

async function open(deniedBy: string | null): Promise<string> {
	const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rule set' });
	await ensureRulesDraft(tabId);
	if (deniedBy !== null) setRulesLockDenied(tabId, deniedBy);
	app = mount(RulesTab, { target: host, props: { tabId } });
	flushSync();
	return tabId;
}

describe('RulesTab lock-denied', () => {
	it('names the holder in a banner carrying a Retry', async () => {
		await open('peer@x');
		const banner = host.querySelector('[role="status"]');
		expect(banner).not.toBeNull();
		expect(banner!.textContent).toContain('peer@x');
		expect(banner!.querySelector('button')?.textContent?.trim()).toBe('Retry');
	});

	it('renders no banner while the tab holds its check-out', async () => {
		await open(null);
		expect(host.querySelector('[role="status"]')).toBeNull();
	});

	it('disables Save while denied', async () => {
		await open('peer@x');
		const save = host.querySelector<HTMLButtonElement>('[data-testid="rules-save"]');
		expect(save).not.toBeNull();
		expect(save!.disabled).toBe(true);
	});

	it('leaves Save enabled while the tab holds its check-out', async () => {
		await open(null);
		expect(host.querySelector<HTMLButtonElement>('[data-testid="rules-save"]')!.disabled).toBe(
			false
		);
	});

	it('disables the name field while denied', async () => {
		await open('peer@x');
		const name = host.querySelector<HTMLInputElement>('[aria-label="Rule set name"]');
		expect(name).not.toBeNull();
		expect(name!.disabled).toBe(true);
	});

	it('puts the YAML editor in read-only mode while denied', async () => {
		const tabId = await open('peer@x');
		const editor = host.querySelector('[data-testid="rules-editor"]');
		expect(editor).not.toBeNull();
		// CodeMirror renders its read-only document without the contenteditable
		// host a writable one carries, so a denied tab cannot be typed into.
		expect(editor!.querySelector('[contenteditable="true"]')).toBeNull();
		expect(getRulesDraft(tabId)?.dirty).toBe(false);
	});

	it('leaves the YAML editor typeable while the tab holds its check-out', async () => {
		await open(null);
		const editor = host.querySelector('[data-testid="rules-editor"]');
		expect(editor!.querySelector('[contenteditable="true"]')).not.toBeNull();
	});
});
