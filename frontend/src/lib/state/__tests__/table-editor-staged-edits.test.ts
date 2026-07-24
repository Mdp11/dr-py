// Staged definition edits: while the table settings dialog is open, editing
// the definition must NOT re-evaluate the table. Composing a script or
// navigation column produces a long tail of intermediate definitions (type a
// snippet, undo it, try a chain), and each one used to cost a full
// re-evaluation — sweep included — of a grid the modal was covering anyway.
//
// `evaluateTable` is spied on the module, exactly as the sibling store tests
// do: its call count IS the assertion for "did the table reload".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tablesApi from '$lib/api/tables';
import type { TableDefinition, TablePage } from '$lib/api/types';
import {
	abandonTableEvaluationSuspension,
	ensureTableDraft,
	getTableDraft,
	getTableSort,
	loadTablePage,
	remapTableSortForInsert,
	remapTableSortForRemove,
	resetTableEditors,
	resumeTableEvaluation,
	revertSuspendedTableEdits,
	setTableSort,
	suspendTableEvaluation,
	updateTableDefinition
} from '../table-editor.svelte';
import { resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const TAB = 'tbl:draft:1';

function page(): TablePage {
	return {
		columns: [{ kind: 'element', header: '', width_px: null }],
		rows: [{ key: ['e0'], cells: [] }],
		total: 1,
		truncated: false,
		offset: 0,
		model_rev: 1,
		warnings: [],
		script_status: { state: 'ready', done: 1, total: 1 }
	};
}

/** The current definition with one column header changed — a minimal, real
 * definition edit of the kind the settings dialog applies. */
function renamed(header: string): TableDefinition {
	const defn = getTableDraft(TAB)!.definition;
	return { ...defn, columns: defn.columns.map((c, i) => (i === 0 ? { ...c, header } : c)) };
}

/** Widen a fresh draft to `n` element columns so a sort on a later column
 * survives `_sortFor`'s out-of-range net during these remap tests. Mirrors
 * `table-editor.test.ts`'s helper of the same name. */
function widenDraft(tabId: string, n: number): void {
	const d = getTableDraft(tabId)!;
	const col = d.definition.columns[0];
	updateTableDefinition(tabId, {
		...d.definition,
		columns: Array.from({ length: n }, () => ({ ...col }))
	});
}

let spy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	resetTableEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(page()) as ReturnType<typeof vi.fn>;
	await ensureTableDraft(TAB);
	await loadTablePage(TAB, 0);
	spy.mockClear(); // the seed load is not part of any assertion below
});
afterEach(() => {
	resetTableEditors();
	vi.restoreAllMocks();
});

describe('staged table definition edits', () => {
	it('re-evaluates on every edit while NOT suspended', async () => {
		updateTableDefinition(TAB, renamed('a'));
		updateTableDefinition(TAB, renamed('b'));
		await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
	});

	it('applies edits to the draft but evaluates nothing while suspended', async () => {
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('a'));
		updateTableDefinition(TAB, renamed('b'));
		updateTableDefinition(TAB, renamed('c'));

		// The DRAFT is immediate — the editors, the dirty flag and Save all keep
		// working normally; only the evaluation is deferred.
		expect(getTableDraft(TAB)!.definition.columns[0].header).toBe('c');
		expect(getTableDraft(TAB)!.dirty).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});

	it('evaluates exactly ONCE on resume, however many edits were staged', async () => {
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('a'));
		updateTableDefinition(TAB, renamed('b'));
		resumeTableEvaluation(TAB);
		await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
	});

	it('evaluates NOTHING on resume when the definition ended up unchanged', async () => {
		const original = getTableDraft(TAB)!.definition;
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('scratch'));
		updateTableDefinition(TAB, original); // …and undone
		resumeTableEvaluation(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled();
	});

	it('evaluates nothing on resume when the dialog was merely opened and closed', async () => {
		suspendTableEvaluation(TAB);
		resumeTableEvaluation(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled();
	});

	it('keeps the ORIGINAL snapshot when suspend is called twice', async () => {
		const original = getTableDraft(TAB)!.definition;
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('a'));
		suspendTableEvaluation(TAB); // nested open — must not re-snapshot
		updateTableDefinition(TAB, original);
		resumeTableEvaluation(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled();
	});

	it('resume is a no-op for a tab that was never suspended', async () => {
		resumeTableEvaluation(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled();
	});

	it('abandoning a suspension evaluates nothing and re-arms normal evaluation', async () => {
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('a'));
		abandonTableEvaluationSuspension(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled();

		updateTableDefinition(TAB, renamed('b'));
		await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
	});

	it('revert restores the pre-suspend definition and dirty flag; resume then evaluates nothing', async () => {
		const original = getTableDraft(TAB)!.definition;
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('a'));
		updateTableDefinition(TAB, renamed('b'));
		expect(getTableDraft(TAB)!.dirty).toBe(true);

		revertSuspendedTableEdits(TAB);
		expect(getTableDraft(TAB)!.definition).toBe(original); // reference-identical
		expect(getTableDraft(TAB)!.dirty).toBe(false);

		resumeTableEvaluation(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled(); // definition matches the snapshot → no reload
	});

	it('revert restores a sort remapped during the dialog session', async () => {
		setTableSort(TAB, { column: 0, direction: 'asc' });
		await vi.waitFor(() => expect(spy).toHaveBeenCalled());
		spy.mockClear();

		suspendTableEvaluation(TAB);
		// simulate ColumnManager's remove flow: remap the sort alongside the edit
		remapTableSortForRemove(TAB, 0); // sort on the removed column → cleared
		expect(getTableSort(TAB)).toBeUndefined();

		revertSuspendedTableEdits(TAB);
		expect(getTableSort(TAB)).toEqual({ column: 0, direction: 'asc' });
	});

	it('revert before any edit leaves the draft untouched (no spurious dirty)', () => {
		suspendTableEvaluation(TAB);
		revertSuspendedTableEdits(TAB);
		expect(getTableDraft(TAB)!.dirty).toBe(false);
	});

	it('revert is a no-op for a tab that was never suspended', () => {
		updateTableDefinition(TAB, renamed('kept'));
		revertSuspendedTableEdits(TAB);
		expect(getTableDraft(TAB)!.definition.columns[0].header).toBe('kept');
	});

	it('remapTableSortForInsert shifts a sort at/past the insertion point', async () => {
		widenDraft(TAB, 4);
		setTableSort(TAB, { column: 1, direction: 'desc' });
		await vi.waitFor(() => expect(spy).toHaveBeenCalled());
		remapTableSortForInsert(TAB, 1);
		expect(getTableSort(TAB)).toEqual({ column: 2, direction: 'desc' });
		remapTableSortForInsert(TAB, 3); // past the sort → unchanged
		expect(getTableSort(TAB)).toEqual({ column: 2, direction: 'desc' });
	});
});
