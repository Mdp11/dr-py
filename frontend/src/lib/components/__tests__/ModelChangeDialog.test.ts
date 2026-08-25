import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as crApi from '$lib/api/changeRequest';
import * as stageProposed from '$lib/state/stage-proposed';
import * as fileSave from '$lib/util/fileSave';
import { canEdit, hasStagedOps } from '$lib/state';
import ModelChangeDialog from '../ModelChangeDialog.svelte';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		canEdit: vi.fn(() => true),
		hasStagedOps: vi.fn(() => false),
		getFilename: vi.fn(() => 'city.model.json'),
		getModelRev: vi.fn(() => 3),
		getModelSummary: vi.fn(() => ({
			model_rev: 3,
			element_count: 10,
			relationship_count: 5,
			elements_by_type: {},
			issue_counts: null,
			undo_depth: 0
		})),
		setLockNotice: vi.fn()
	};
});

const EL = (id: string, name: string) => ({ id, type_name: 'Item', properties: { name }, rev: 0 });

const CR_DOC = {
	format: 'datarover.cr/v1' as const,
	createdAt: '2026-01-01T00:00:00.000Z',
	baseline: { filename: null, elementCount: 10, relationshipCount: 5 },
	ops: {
		elements: {
			added: [EL('n1', 'N')],
			modified: [{ id: 'a', before: EL('a', 'A'), after: EL('a', 'A2') }],
			deleted: [EL('b', 'B')]
		},
		relationships: { added: [], modified: [], deleted: [] }
	},
	complete: true
};

const COMPARE_OUT = {
	model_rev: 3,
	cr: CR_DOC,
	other_element_count: 10,
	other_relationship_count: 5
};

const CREATE_OP = {
	kind: 'create_element' as const,
	temp_id: 'tmp_1',
	id: 'n1',
	type_name: 'Item',
	properties: { name: 'N' }
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	vi.mocked(canEdit).mockReturnValue(true);
	vi.mocked(hasStagedOps).mockReturnValue(false);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
});

function open(mode: 'compare' | 'apply-cr') {
	app = mount(ModelChangeDialog, { target: host, props: { open: true, mode } });
	flushSync();
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.body.querySelector<T>(`[data-testid="${id}"]`);
	if (!el) throw new Error(`${id} not rendered`);
	return el;
}

function pickFiles(files: File[]): void {
	const input = byTestId<HTMLInputElement>('mcd-file-input');
	Object.defineProperty(input, 'files', { value: files, configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}

async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const modelFile = () =>
	new File(['{"elements":[],"relationships":[]}'], 'other.model.json', {
		type: 'application/json'
	});

describe('ModelChangeDialog — compare mode', () => {
	it('fires no request on file pick; Preview diff calls compare and renders', async () => {
		const compare = vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		open('compare');
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(true);

		pickFiles([modelFile()]);
		expect(compare).not.toHaveBeenCalled();
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);

		byTestId('mcd-preview').click();
		await settle();
		expect(compare).toHaveBeenCalledTimes(1);
		const preview = byTestId('proposal-preview');
		expect(preview.textContent).toContain('+1 added');
		expect(preview.textContent).toContain('~1 modified');
		expect(preview.textContent).toContain('−1 deleted');
	});

	it('Swap inverts the preview and disables Replace', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-swap').click();
		flushSync();
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);

		byTestId('mcd-preview').click();
		await settle();
		// inverted: the added n1 now reads as deleted and b as added
		const rows = byTestId('proposal-preview').textContent ?? '';
		expect(rows).toContain('+1 added');
		expect(rows).toContain('−1 deleted');
		expect(document.body.querySelector('[data-testid="proposal-preview"]')).not.toBeNull();
	});

	it('Create CR saves the (inverted when swapped) CR under the CR filename', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		const save = vi
			.spyOn(fileSave, 'saveJsonToFile')
			.mockResolvedValue({ filename: 'x', handle: null } as never);
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-create-cr').click();
		await settle();
		expect(save).toHaveBeenCalledTimes(1);
		const [doc, name] = save.mock.calls[0] as [Record<string, unknown>, string];
		expect(name).toMatch(/_city\.model\.cr\.json$/);
		expect(doc.complete).toBeUndefined();
		expect((doc.ops as typeof CR_DOC.ops).elements.added.map((e) => e.id)).toEqual(['n1']);

		byTestId('mcd-swap').click();
		flushSync();
		byTestId('mcd-create-cr').click();
		await settle();
		const [inv, invName] = save.mock.calls[1] as [Record<string, unknown>, string];
		expect(invName).toMatch(/_other\.model\.cr\.json$/);
		expect((inv.ops as typeof CR_DOC.ops).elements.deleted.map((e) => e.id)).toEqual(['n1']);
	});

	it('Replace proposes the compare CR and stages the ops with prestate', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		const propose = vi
			.spyOn(crApi, 'proposeCr')
			.mockResolvedValue({ ok: true, modelRev: 3, cr: CR_DOC, ops: [CREATE_OP] });
		const stage = vi
			.spyOn(stageProposed, 'stageProposedOps')
			.mockResolvedValue({ ok: true, count: 1 });
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-replace').click();
		await settle();
		expect(propose).toHaveBeenCalledWith([CR_DOC]);
		expect(stage).toHaveBeenCalledWith([CREATE_OP], 3, {
			elements: [EL('a', 'A'), EL('b', 'B')],
			relationships: []
		});
		// staged → the dialog closed itself
		expect(document.body.querySelector('[data-testid="mcd-replace"]')).toBeNull();
	});

	it('Replace renders a 409 as conflicts and stages nothing', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: false,
			modelRev: 3,
			crIndex: 0,
			conflicts: [{ kind: 'before_mismatch', entity: 'element', id: 'a', reason: 'moved' }]
		});
		const stage = vi.spyOn(stageProposed, 'stageProposedOps');
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-replace').click();
		await settle();
		expect(stage).not.toHaveBeenCalled();
		expect(byTestId('proposal-conflicts').textContent).toContain('element a: before_mismatch');
	});

	it('Replace is gated on edit rights and a clean staged buffer', () => {
		vi.mocked(hasStagedOps).mockReturnValue(true);
		open('compare');
		pickFiles([modelFile()]);
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);
		expect(byTestId('mcd-gate-hint').textContent).toMatch(/commit or discard/i);
		unmount(app!);
		app = null;

		vi.mocked(hasStagedOps).mockReturnValue(false);
		vi.mocked(canEdit).mockReturnValue(false);
		open('compare');
		pickFiles([modelFile()]);
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);
		expect(byTestId('mcd-gate-hint').textContent).toMatch(/view-only/i);
		// a viewer can still preview and create a CR
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);
		expect(byTestId<HTMLButtonElement>('mcd-create-cr').disabled).toBe(false);
	});
});
