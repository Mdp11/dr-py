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

// the on-disk CR shape (no `complete`) and the wire shape that adds it
const CR_FILE_DOC = {
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
	}
};

const CR_DOC = { ...CR_FILE_DOC, complete: true };

const COMPARE_OUT = {
	model_rev: 3,
	cr: CR_DOC,
	other_element_count: 7,
	other_relationship_count: 2
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

/** Rendered diff cards as `<badge><id>`, in render order (added, modified, deleted). */
function previewCards(): string[] {
	const root = byTestId('proposal-preview');
	const badges = [...root.querySelectorAll('span.font-mono.font-bold')];
	const ids = [...root.querySelectorAll('span.font-mono.text-xs')];
	return badges.map((b, i) => `${b.textContent?.trim()}${ids[i]?.textContent?.trim()}`);
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

		byTestId('mcd-preview').click();
		await settle();
		expect(previewCards()).toEqual(['+n1', '~a', '-b']);

		byTestId('mcd-swap').click();
		flushSync();
		expect(byTestId<HTMLButtonElement>('mcd-replace').disabled).toBe(true);

		byTestId('mcd-preview').click();
		await settle();
		// inverted: the added n1 now reads as deleted and b as added
		expect(previewCards()).toEqual(['+b', '~a', '-n1']);
	});

	it('Create CR relabels the baseline to the direction it saved', async () => {
		vi.spyOn(crApi, 'compareModel').mockResolvedValue(COMPARE_OUT);
		const save = vi
			.spyOn(fileSave, 'saveJsonToFile')
			.mockResolvedValue({ filename: 'x', handle: null } as never);
		open('compare');
		pickFiles([modelFile()]);
		byTestId('mcd-create-cr').click();
		await settle();
		// session → file: the session counts, plus the filename the server lacks
		expect((save.mock.calls[0][0] as typeof CR_FILE_DOC).baseline).toEqual({
			filename: 'city.model.json',
			elementCount: 10,
			relationshipCount: 5
		});

		byTestId('mcd-swap').click();
		flushSync();
		byTestId('mcd-create-cr').click();
		await settle();
		// file → session: the `from` side is now the file, so its counts describe it
		expect((save.mock.calls[1][0] as typeof CR_FILE_DOC).baseline).toEqual({
			filename: 'other.model.json',
			elementCount: 7,
			relationshipCount: 2
		});
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

const crFile = (name: string, cr = CR_FILE_DOC) =>
	new File([JSON.stringify(cr)], name, { type: 'application/json' });

describe('ModelChangeDialog — apply-cr mode', () => {
	it('lists picked CR files in order, rejects non-CR files, and fires no request', async () => {
		const propose = vi.spyOn(crApi, 'proposeCr');
		open('apply-cr');
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(true);
		pickFiles([
			crFile('one.cr.json'),
			new File(['{"elements":[]}'], 'not-a-cr.json', { type: 'application/json' }),
			crFile('two.cr.json')
		]);
		await settle();
		expect(byTestId('mcd-cr-row-0').textContent).toContain('one.cr.json');
		expect(byTestId('mcd-cr-row-1').textContent).toContain('two.cr.json');
		expect(document.body.querySelector('[data-testid="mcd-cr-row-2"]')).toBeNull();
		expect(byTestId('proposal-error').textContent).toContain('not-a-cr.json');
		expect(propose).not.toHaveBeenCalled();
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);
	});

	it('reorder changes the request order; Preview proposes and renders the combined cr', async () => {
		const propose = vi
			.spyOn(crApi, 'proposeCr')
			.mockResolvedValue({ ok: true, modelRev: 3, cr: CR_DOC, ops: [CREATE_OP] });
		const first = { ...CR_FILE_DOC, createdAt: 'first' };
		const second = { ...CR_FILE_DOC, createdAt: 'second' };
		open('apply-cr');
		pickFiles([crFile('first.cr.json', first), crFile('second.cr.json', second)]);
		await settle();
		byTestId('mcd-cr-down-0').click();
		flushSync();
		expect(byTestId('mcd-cr-row-0').textContent).toContain('second.cr.json');

		byTestId('mcd-preview').click();
		await settle();
		const sent = propose.mock.calls[0][0].map((cr) => cr.createdAt);
		expect(sent).toEqual(['second', 'first']);
		expect(byTestId('proposal-preview').textContent).toContain('+1 added');
	});

	it('blocks a selection past MAX_CRS_PER_REQUEST before the server sees it', async () => {
		const propose = vi.spyOn(crApi, 'proposeCr');
		open('apply-cr');
		pickFiles(
			Array.from({ length: crApi.MAX_CRS_PER_REQUEST + 1 }, (_, i) => crFile(`cr${i}.cr.json`))
		);
		await settle();
		expect(byTestId('mcd-gate-hint').textContent).toMatch(
			new RegExp(`at most ${crApi.MAX_CRS_PER_REQUEST}`, 'i')
		);
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(true);
		expect(byTestId<HTMLButtonElement>('mcd-stage').disabled).toBe(true);
		byTestId('mcd-cr-remove-0').click();
		flushSync();
		expect(document.body.querySelector('[data-testid="mcd-gate-hint"]')).toBeNull();
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(false);
		expect(propose).not.toHaveBeenCalled();
	});

	it('remove drops a file', async () => {
		open('apply-cr');
		pickFiles([crFile('a.cr.json'), crFile('b.cr.json')]);
		await settle();
		byTestId('mcd-cr-remove-0').click();
		flushSync();
		expect(byTestId('mcd-cr-row-0').textContent).toContain('b.cr.json');
		expect(document.body.querySelector('[data-testid="mcd-cr-row-1"]')).toBeNull();
	});

	it('a 409 names the conflicting CR by index', async () => {
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: false,
			modelRev: 3,
			crIndex: 1,
			conflicts: [{ kind: 'missing', entity: 'element', id: 'zzz', reason: 'gone' }]
		});
		open('apply-cr');
		pickFiles([crFile('a.cr.json'), crFile('b.cr.json')]);
		await settle();
		byTestId('mcd-stage').click();
		await settle();
		expect(byTestId('proposal-conflicts').textContent).toContain('CR #2 conflicts');
		expect(byTestId('proposal-conflicts').textContent).toContain('element zzz: missing');
	});

	it('Stage edits stages the proposal and closes', async () => {
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: true,
			modelRev: 3,
			cr: CR_DOC,
			ops: [CREATE_OP]
		});
		const stage = vi
			.spyOn(stageProposed, 'stageProposedOps')
			.mockResolvedValue({ ok: true, count: 1 });
		open('apply-cr');
		pickFiles([crFile('a.cr.json')]);
		await settle();
		byTestId('mcd-stage').click();
		await settle();
		expect(stage).toHaveBeenCalledWith([CREATE_OP], 3, {
			elements: [EL('a', 'A'), EL('b', 'B')],
			relationships: []
		});
		expect(document.body.querySelector('[data-testid="mcd-stage"]')).toBeNull();
	});

	it('gates Preview too for a viewer — apply-cr proposes through a write route', async () => {
		vi.mocked(canEdit).mockReturnValue(false);
		open('apply-cr');
		pickFiles([crFile('a.cr.json')]);
		await settle();
		expect(byTestId<HTMLButtonElement>('mcd-preview').disabled).toBe(true);
		expect(byTestId<HTMLButtonElement>('mcd-stage').disabled).toBe(true);
		expect(byTestId('mcd-gate-hint').textContent).toMatch(/view-only/i);
	});

	it('a stale stage outcome is reported, not swallowed', async () => {
		vi.spyOn(crApi, 'proposeCr').mockResolvedValue({
			ok: true,
			modelRev: 3,
			cr: CR_DOC,
			ops: [CREATE_OP]
		});
		vi.spyOn(stageProposed, 'stageProposedOps').mockResolvedValue({ ok: false, reason: 'stale' });
		open('apply-cr');
		pickFiles([crFile('a.cr.json')]);
		await settle();
		byTestId('mcd-stage').click();
		await settle();
		expect(byTestId('proposal-error').textContent).toMatch(/changed since the proposal/);
		expect(document.body.querySelector('[data-testid="mcd-stage"]')).not.toBeNull();
	});
});
