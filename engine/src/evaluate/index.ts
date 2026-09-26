import type { ArtifactSet } from '../artifacts/artifact-set.ts';
import { exportTable, previewTableJson } from '../export/route.ts';
import type { Model } from '../model/model.ts';
import { evaluateNavigation } from '../navigation/route.ts';
import type { ReadParams } from '../read/params.ts';
import type { ViewPlacements } from '../read/placements.ts';
import { searchModel } from '../search/search-model.ts';
import type { Steps } from '../steps/steps.ts';
import type { TableOrderCache } from '../table/order-cache.ts';
import { evaluateTable } from '../table/route.ts';

/**
 * Where the working copy stands — the rev its committed state is at, and its
 * staged version — and the table orders kept for it: an order is kept under
 * both, since nothing else moves the model.
 */
export type WorkingStamp = { rev: number; stagedVersion: number; tableOrders: TableOrderCache };

/**
 * What an evaluation reads: the working model, the project's artifacts and
 * the view placements; `working` absent, the committed state is at rev 0, as
 * a session that has seen no commit, and no table order is kept.
 */
export type EvalContext = {
	model: Model;
	artifacts: ArtifactSet;
	placements: ViewPlacements;
	working?: WorkingStamp;
};

/**
 * An evaluation: the response body of the route it stands for, always in
 * steps. It reads its params, resolves what it needs and translates its
 * patterns before the first step, so that a refusal leaves nothing behind.
 */
export type Evaluation = (ctx: EvalContext, params: ReadParams) => Steps<unknown>;

/** Every evaluation, by the name of the `lib/api` function it answers for. */
export const EVALUATIONS: { readonly [method: string]: Evaluation } = {
	searchModel,
	evaluateNavigation,
	evaluateTable,
	exportTable,
	previewTableJson
};
