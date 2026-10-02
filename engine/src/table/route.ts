/**
 * `POST /tables/evaluate` in steps; `orderedRows`, a table's rows in order,
 * kept between calls; and `tableSteps`, a whole table's rows and cells.
 */
import type { ArtifactSet } from '../artifacts/artifact-set.ts';
import type { EvalContext } from '../evaluate/index.ts';
import type { Model } from '../model/model.ts';
import { Meter, NavKeyError, NavValueError } from '../navigation/evaluate.ts';
import { navigationFetch } from '../navigation/route.ts';
import { RefNotFoundError } from '../navigation/resolve.ts';
import { ReadError } from '../read/errors.ts';
import { pageOf, type ReadParams } from '../read/params.ts';
import { snippetFetch } from '../script/snippets.ts';
import type { Steps } from '../steps/steps.ts';
import { pyRepr } from '../value/repr.ts';
import { evaluateCellsSteps, type TableCell } from './cells.ts';
import { NavMemo } from './nav-memo.ts';
import { orderKey, type CachedOrder } from './order-cache.ts';
import { pageBody, type TablePageBody } from './page.ts';
import { checkTableSnippets, resolveTableRefs, tableFetch, tableHasScript } from './resolve.ts';
import {
	buildRowsSteps,
	DEFAULT_TABLE_LIMITS,
	type RowBuild,
	type RowKey,
	type TableLimits
} from './rows.ts';
import { readTableDefinition, type TableDefinition } from './schema.ts';
import { TableScripts } from './script-inputs.ts';
import { orderRowsSteps, sortFallsBackToBuildOrder, sortKeys } from './sort.ts';

/** The body's table: an inline definition, or the id of a saved one. */
export function sourceOf(params: ReadParams): TableDefinition | string {
	const { definition = null, artifact_id: artifactId = null } = params;
	if ((definition === null) === (artifactId === null)) {
		throw new ReadError(422, 'provide exactly one of `definition` / `artifact_id`');
	}
	if (definition !== null) return readTableDefinition(definition, 'definition');
	if (typeof artifactId !== 'string') throw new ReadError(422, 'artifact_id must be a string');
	return artifactId;
}

/**
 * The table with every navigation and snippet it names inlined, through the
 * working copy's artifacts, the table's own inline snippets checked first, as the
 * core's schema checks them where the table is read.
 */
export function resolved(
	artifacts: ArtifactSet,
	source: TableDefinition | string
): TableDefinition {
	let defn: TableDefinition;
	if (typeof source === 'string') {
		try {
			defn = tableFetch(artifacts)(source);
		} catch (error) {
			// The route formats the id with `str`.
			if (error instanceof RefNotFoundError) throw new ReadError(422, `unknown artifact ${source}`);
			throw error;
		}
	} else defn = source;
	checkTableSnippets(defn);
	return resolveTableRefs(defn, navigationFetch(artifacts), snippetFetch(artifacts));
}

/** The core's `ValueError` and `KeyError`, as the routes answer them. */
export function* answered<T>(steps: Steps<T>): Steps<T> {
	try {
		return yield* steps;
	} catch (error) {
		if (error instanceof NavValueError) throw new ReadError(422, error.message);
		if (error instanceof NavKeyError) {
			throw new ReadError(422, `unknown artifact ${pyRepr(error.id)}`);
		}
		throw error;
	}
}

/**
 * The scripts an evaluation of `defn` reads through, for `ctx` that reads any
 * and a table that reaches one; `null` otherwise. One per evaluation: it holds
 * the evaluation's warnings and whether any call it read was an error.
 */
export function tableScripts(ctx: EvalContext, defn: TableDefinition): TableScripts | null {
	return tableHasScript(defn) ? new TableScripts(ctx.scripts) : null;
}

/**
 * The rows of a resolved `defn`, built and sorted whole, each pass with a memo
 * of its own. With `ctx.working`, the order is kept once sorted, under the
 * table and where the working copy stood at the call, and a later call there
 * reads it back without a step. Rows and order read only `maxRows`, which
 * every route's limits share.
 *
 * With `scripts`, the passes read through it, and an order is kept only if no
 * call it read was an error: a pending call sorts as empty, and a timeout is
 * not the answer the next call gets. A kept order that falls back to the build
 * order tells so again, as the pass that built it did.
 */
export function orderedRows(
	ctx: EvalContext,
	defn: TableDefinition,
	meter: Meter,
	scripts: TableScripts | null = null
): Steps<CachedOrder> {
	const { model, working } = ctx;
	const kept =
		working === undefined
			? null
			: {
					cache: working.tableOrders,
					key: orderKey(defn),
					stamp: { rev: working.rev, stagedVersion: working.stagedVersion }
				};
	return (function* (): Steps<CachedOrder> {
		const hit = kept?.cache.get(kept.key, kept.stamp);
		if (hit !== undefined) {
			if (scripts !== null && sortFallsBackToBuildOrder(defn, sortKeys(defn))) {
				scripts.warnings.add('sort_needs_script_nav');
			}
			return hit;
		}
		const built = yield* buildRowsSteps(
			model,
			defn,
			DEFAULT_TABLE_LIMITS,
			meter,
			new NavMemo(),
			scripts
		);
		const keys = yield* orderRowsSteps(
			model,
			defn,
			built.keys,
			built.baseSlots,
			meter,
			new NavMemo(),
			scripts
		);
		const order: CachedOrder = {
			keys,
			truncated: built.truncated,
			baseTotal: built.baseTotal,
			baseSlots: built.baseSlots
		};
		if (scripts === null || !scripts.errored) kept?.cache.put(kept.key, kept.stamp, order);
		return order;
	})();
}

/**
 * The route body in steps. Before the first step it reads its params and
 * resolves the table and every navigation and snippet it names through the
 * working copy's artifacts, the table's own inline snippets checked first. The rows come from
 * `orderedRows`, then only the page's cells are evaluated, with a memo of their
 * own. A table that reaches a script answers complete, with the evaluation's
 * warnings.
 */
export function evaluateTable(ctx: EvalContext, params: ReadParams): Steps<TablePageBody> {
	const source = sourceOf(params);
	const { limit, offset } = pageOf(params);
	const defn = resolved(ctx.artifacts, source);
	const scripts = tableScripts(ctx, defn);
	const { model } = ctx;
	const rev = ctx.working?.rev ?? 0;
	const meter = new Meter(0);
	const rows = orderedRows(ctx, defn, meter, scripts);

	return answered(
		(function* (): Steps<TablePageBody> {
			const order = yield* rows;
			const keys = order.keys.slice(offset, offset + limit);
			const cells = yield* evaluateCellsSteps(
				model,
				defn,
				keys,
				order.baseSlots,
				DEFAULT_TABLE_LIMITS,
				meter,
				new NavMemo(),
				scripts
			);
			return pageBody(defn, {
				keys,
				cells,
				total: order.keys.length,
				baseTotal: order.baseTotal,
				truncated: order.truncated,
				offset,
				rev,
				warnings: scripts === null ? null : scripts.warnings.entries
			});
		})()
	);
}

/** Every row of a table in order, with its cells. */
export type TableRows = Omit<RowBuild, 'keys'> & { keys: RowKey[]; cells: TableCell[][] };

/**
 * A whole table, uncached: its rows built and sorted, and every row's cells.
 * `defn` is resolved and reaches no script.
 */
export function* tableSteps(
	model: Model,
	defn: TableDefinition,
	limits: TableLimits
): Steps<TableRows> {
	const meter = new Meter(0);
	const built = yield* buildRowsSteps(model, defn, limits, meter, new NavMemo());
	const keys = yield* orderRowsSteps(
		model,
		defn,
		built.keys,
		built.baseSlots,
		meter,
		new NavMemo()
	);
	const cells = yield* evaluateCellsSteps(
		model,
		defn,
		keys,
		built.baseSlots,
		limits,
		meter,
		new NavMemo()
	);
	return { ...built, keys, cells };
}
