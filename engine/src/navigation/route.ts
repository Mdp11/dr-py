import type { ArtifactSet } from '../artifacts/artifact-set.ts';
import type { EvalContext } from '../evaluate/index.ts';
import { ModelError } from '../model/errors.ts';
import type { Model } from '../model/model.ts';
import { ReadError } from '../read/errors.ts';
import { optionalString, pageOf, type ReadParams } from '../read/params.ts';
import { treeItem, type TreeItem } from '../read/tree.ts';
import { toWire, type Wire } from '../read/wire.ts';
import type { Steps } from '../steps/steps.ts';
import { pyRepr } from '../value/repr.ts';
import {
	DEFAULT_LIMITS,
	evaluateSteps,
	Meter,
	NavKeyError,
	NavValueError,
	type ChainNode,
	type ChainResult
} from './evaluate.ts';
import {
	navigationHasScript,
	NavigationResolveError,
	RefNotFoundError,
	resolveRefs,
	type Fetch
} from './resolve.ts';
import { readNavigation, type NavigationDefinition } from './schema.ts';

/** A chain's terminal value, told from a `TreeItem` by its `kind`. */
export type ChainValueOut = { kind: 'value'; value: Wire };

/** The route's body: one page of chains, `total` counted before paging. */
export type ChainPageOut = {
	step_types: string[];
	chains: (TreeItem | ChainValueOut)[][];
	total: number;
	truncated: boolean;
	warnings: [];
};

/** A saved navigation in the working copy: a staged one first, then the committed one. */
export function navigationFetch(artifacts: ArtifactSet): Fetch {
	return (id) => {
		const artifact = artifacts.resolve(id);
		if (artifact === null || artifact.kind !== 'navigation') throw new RefNotFoundError(id);
		return readNavigation(artifact.payload, `artifact ${pyRepr(id)}`);
	};
}

/** The body's navigation: an inline definition, or the id of a saved one. */
function sourceOf(params: ReadParams): NavigationDefinition | string {
	const { definition = null, artifact_id: artifactId = null } = params;
	if ((definition === null) === (artifactId === null)) {
		throw new ReadError(422, 'provide exactly one of `definition` / `artifact_id`');
	}
	if (definition !== null) return readNavigation(definition, 'definition');
	if (typeof artifactId !== 'string') throw new ReadError(422, 'artifact_id must be a string');
	return artifactId;
}

function resolved(
	artifacts: ArtifactSet,
	source: NavigationDefinition | string
): NavigationDefinition {
	const fetch = navigationFetch(artifacts);
	try {
		if (typeof source !== 'string') return resolveRefs(source, fetch);
		const id = source;
		let saved: NavigationDefinition;
		try {
			saved = fetch(id);
		} catch (error) {
			// The route formats the id with `str`, where a nested ref's is quoted.
			if (error instanceof RefNotFoundError) {
				throw new ReadError(422, `unknown navigation artifact ${id}`);
			}
			throw error;
		}
		return resolveRefs(saved, fetch, new Set([id]));
	} catch (error) {
		if (error instanceof NavigationResolveError) throw new ReadError(422, error.message);
		throw error;
	}
}

function chainItem(model: Model, node: ChainNode): TreeItem | ChainValueOut {
	if (typeof node !== 'string') return { kind: 'value', value: toWire(node.value) };
	const element = model.findElement(node);
	// The route reads the element raw: a `KeyError` it answers 404.
	if (element === undefined) throw new ModelError('key', node);
	return treeItem(model, element);
}

/**
 * `POST .../artifacts/navigation/evaluate` in steps. Before the first step it
 * reads its params and resolves every ref through the working copy's
 * artifacts; a definition that reaches a script refuses with 501, for the
 * server to run, before any pattern is translated. An id no element has,
 * read where the core indexes the model raw, is answered as the route's
 * `LookupError` handler answers it: `unknown navigation artifact 'x'`.
 */
export function evaluateNavigation(ctx: EvalContext, params: ReadParams): Steps<ChainPageOut> {
	const source = sourceOf(params);
	const rowElementId = optionalString(params, 'row_element_id');
	const { limit, offset } = pageOf(params);
	const defn = resolved(ctx.artifacts, source);
	if (navigationHasScript(defn)) throw new ReadError(501, 'reaches a script');
	const { model } = ctx;
	const meter = new Meter(DEFAULT_LIMITS.maxVisited);
	const rowElements = rowElementId === null ? null : [rowElementId];
	const evaluation = evaluateSteps(
		model.metamodel,
		model,
		defn,
		DEFAULT_LIMITS,
		rowElements,
		meter
	);

	return (function* (): Steps<ChainPageOut> {
		let result: ChainResult;
		try {
			result = yield* evaluation;
		} catch (error) {
			if (error instanceof NavKeyError) {
				throw new ReadError(422, `unknown navigation artifact ${pyRepr(error.id)}`);
			}
			if (error instanceof NavValueError) throw new ReadError(422, error.message);
			throw error;
		}
		const chains: (TreeItem | ChainValueOut)[][] = [];
		for (const chain of result.chains.slice(offset, offset + limit)) {
			const row: (TreeItem | ChainValueOut)[] = [];
			for (const node of chain) {
				row.push(chainItem(model, node));
				if (meter.tick()) yield meter.end();
			}
			chains.push(row);
		}
		return {
			step_types: result.stepTypes,
			chains,
			total: result.chains.length,
			truncated: result.truncated,
			warnings: []
		};
	})();
}
