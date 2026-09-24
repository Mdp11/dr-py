import type { ArtifactSet } from '../artifacts/artifact-set.ts';
import type { Model } from '../model/model.ts';
import { evaluateNavigation } from '../navigation/route.ts';
import type { ReadParams } from '../read/params.ts';
import type { ViewPlacements } from '../read/placements.ts';
import { searchModel } from '../search/search-model.ts';
import type { Steps } from '../steps/steps.ts';

/** What an evaluation reads: the working model, the project's artifacts and the view placements. */
export type EvalContext = { model: Model; artifacts: ArtifactSet; placements: ViewPlacements };

/**
 * An evaluation: the response body of the route it stands for, always in
 * steps. It reads its params, resolves what it needs and translates its
 * patterns before the first step, so that a refusal leaves nothing behind.
 */
export type Evaluation = (ctx: EvalContext, params: ReadParams) => Steps<unknown>;

/** Every evaluation, by the name of the `lib/api` function it answers for. */
export const EVALUATIONS: { readonly [method: string]: Evaluation } = {
	searchModel,
	evaluateNavigation
};
