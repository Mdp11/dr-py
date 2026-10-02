/**
 * `POST /tables/script-errors` in steps: every script cell of a table that is
 * an error, addressed by its place in the grid the page route shows.
 */
import type { EvalContext } from '../evaluate/index.ts';
import { displayName } from '../model/naming.ts';
import { Meter } from '../navigation/evaluate.ts';
import { pageOf, type ReadParams } from '../read/params.ts';
import type { Steps } from '../steps/steps.ts';
import { evaluateCellsSteps, NOT_COMPUTED_MESSAGE } from './cells.ts';
import { NavMemo } from './nav-memo.ts';
import { tableHasScript } from './resolve.ts';
import { answered, orderedRows, resolved, sourceOf, tableScripts } from './route.ts';
import { DEFAULT_TABLE_LIMITS } from './rows.ts';

/** The most error items one answer lists; `total_errors` counts them all. */
export const SCRIPT_ERRORS_CAP = 200;

/** One failed script cell: the row's place, the row's element if its key opens with one, and the column's. */
export type ScriptErrorItem = {
	row_index: number;
	row_element_id: string | null;
	row_label: string | null;
	column_index: number;
	column_label: string;
	message: string;
};

export type ScriptErrorsBody = {
	state: 'ready';
	errors: ScriptErrorItem[];
	total_errors: number;
	truncated: boolean;
};

const EMPTY: ScriptErrorsBody = { state: 'ready', errors: [], total_errors: 0, truncated: false };

/**
 * The route body in steps. `offset` and `limit` are read for their bounds and
 * then ignored: the recap spans the whole table, in the order its page shows.
 * A table that reaches no script has none to list.
 */
export function tableScriptErrors(ctx: EvalContext, params: ReadParams): Steps<ScriptErrorsBody> {
	const source = sourceOf(params);
	pageOf(params);
	const defn = resolved(ctx.artifacts, source);
	const reaches = tableHasScript(defn);
	const scripts = tableScripts(ctx, defn);
	const { model } = ctx;
	const meter = new Meter(0);
	const rows = reaches ? orderedRows(ctx, defn, meter, scripts) : null;

	return answered(
		(function* (): Steps<ScriptErrorsBody> {
			if (rows === null) return { ...EMPTY, errors: [] };
			const { keys, baseSlots } = yield* rows;
			const cells = yield* evaluateCellsSteps(
				model,
				defn,
				keys,
				baseSlots,
				DEFAULT_TABLE_LIMITS,
				meter,
				new NavMemo(),
				scripts
			);
			const errors: ScriptErrorItem[] = [];
			let total = 0;
			cells.forEach((row, rowIndex) => {
				row.forEach((cell, columnIndex) => {
					let message: string;
					if (cell.kind === 'pending') message = NOT_COMPUTED_MESSAGE;
					else if (cell.kind === 'error') message = cell.message!;
					else return;
					total += 1;
					if (errors.length >= SCRIPT_ERRORS_CAP) return;
					const first = keys[rowIndex]![0];
					const id = typeof first === 'string' ? first : null;
					const element = id === null ? undefined : model.findElement(id);
					const column = defn.columns[columnIndex]!;
					errors.push({
						row_index: rowIndex,
						row_element_id: id,
						row_label: element === undefined ? null : displayName(element),
						column_index: columnIndex,
						column_label: column.header || column.kind,
						message
					});
				});
			});
			return { state: 'ready', errors, total_errors: total, truncated: total > errors.length };
		})()
	);
}
