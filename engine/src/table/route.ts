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
import type { Steps } from '../steps/steps.ts';
import { pyRepr } from '../value/repr.ts';
import { evaluateCellsSteps, type TableCell } from './cells.ts';
import { NavMemo } from './nav-memo.ts';
import { orderKey, type CachedOrder } from './order-cache.ts';
import { pageBody, type TablePageBody } from './page.ts';
import { resolveTableRefs, tableFetch, tableHasScript } from './resolve.ts';
import {
	buildRowsSteps,
	DEFAULT_TABLE_LIMITS,
	type RowBuild,
	type RowKey,
	type TableLimits
} from './rows.ts';
import { readTableDefinition, type TableDefinition } from './schema.ts';
import { orderRowsSteps } from './sort.ts';

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

/** The table with every navigation it names inlined, through the working copy's artifacts. */
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
	return resolveTableRefs(defn, navigationFetch(artifacts));
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
 * The rows of a resolved `defn` that reaches no script, built and sorted
 * whole, each pass with a memo of its own. With `ctx.working`, the order is
 * kept once sorted, under the table and where the working copy stood at the
 * call, and a later call there reads it back without a step. Rows and order
 * read only `maxRows`, which every route's limits share.
 */
export function orderedRows(
	ctx: EvalContext,
	defn: TableDefinition,
	meter: Meter
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
		if (hit !== undefined) return hit;
		const built = yield* buildRowsSteps(model, defn, DEFAULT_TABLE_LIMITS, meter, new NavMemo());
		const keys = yield* orderRowsSteps(
			model,
			defn,
			built.keys,
			built.baseSlots,
			meter,
			new NavMemo()
		);
		const order: CachedOrder = {
			keys,
			truncated: built.truncated,
			baseTotal: built.baseTotal,
			baseSlots: built.baseSlots
		};
		kept?.cache.put(kept.key, kept.stamp, order);
		return order;
	})();
}

/**
 * The route body in steps. Before the first step it reads its params and
 * resolves the table and every navigation it names through the working copy's
 * artifacts; a table that reaches a script refuses with 501, for the server
 * to run. The rows come from `orderedRows`, then only the page's cells are
 * evaluated, with a memo of their own.
 */
export function evaluateTable(ctx: EvalContext, params: ReadParams): Steps<TablePageBody> {
	const source = sourceOf(params);
	const { limit, offset } = pageOf(params);
	const defn = resolved(ctx.artifacts, source);
	if (tableHasScript(defn)) throw new ReadError(501, 'reaches a script');
	const { model } = ctx;
	const rev = ctx.working?.rev ?? 0;
	const meter = new Meter(0);
	const rows = orderedRows(ctx, defn, meter);

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
				new NavMemo()
			);
			return pageBody(defn, {
				keys,
				cells,
				total: order.keys.length,
				baseTotal: order.baseTotal,
				truncated: order.truncated,
				offset,
				rev
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
