import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Steps } from '../steps/steps.ts';
import { cmpCodePoint } from '../value/compare.ts';
import type { WorkingCopy } from '../working/working-copy.ts';
import type { PreviewBody } from './bodies.ts';

/** Ids a refusal names. */
const LIMIT = 5;
/** Entities visited per step. */
const VISITS = 2048;

/**
 * The first ids of `ids` by code point, as the server's `ORDER BY ... LIMIT`
 * reads them: it names the ones in id order.
 */
const firstIds = (ids: Iterable<string>) => [...ids].sort(cmpCodePoint).slice(0, LIMIT);

/**
 * Why the server's commit of a rebind to `candidate` refuses the committed
 * state, in the words of its 422; `null` when it holds none. The server judges
 * its head rows before the batch's model ops run, and so does this, over the
 * committed state of `wc` whatever is staged. The checks run in the server's
 * order and the first that fails answers:
 *
 * 1. entities the candidate cannot hold (a type it lacks, an abstract element
 *    type, a property it does not declare), elements then relationships, each
 *    in state order, the first five ids;
 * 2. an element with two containment parents under the candidate's containment
 *    types, in id order, else an element on a containment cycle;
 * 3. an element-valued property under the candidate (a property whose datatype
 *    is an element type) holding a string, or a list of them, that names no
 *    committed element, the first five holders in id order.
 *
 * Preview only: it reads every committed entity.
 */
export function* rebindRefusal(wc: WorkingCopy, candidate: Metamodel): Steps<string | null> {
	const entities = wc.model.elementCount + wc.model.relationshipCount;
	const total = 3 * entities;
	let done = 0;
	const visited = () => ++done % VISITS === 0;

	let refused = 0;
	const refusedIds: string[] = [];
	const note = (id: string) => {
		if (refusedIds.length < LIMIT) refusedIds.push(id);
		refused++;
	};
	const cannotHold = (props: object, declared: ReadonlySet<string>) =>
		!Object.keys(props).every((key) => declared.has(key));
	for (const el of wc.committedElementsInOrder()) {
		const type = candidate.elementType(el.typeName);
		if (
			type === undefined ||
			type.abstract ||
			cannotHold(el.props, candidate.effectiveElementPropertyNames(el.typeName))
		) {
			note(el.id);
		}
		if (visited()) yield { done, total };
	}
	for (const rel of wc.committedRelationshipsInOrder()) {
		if (
			candidate.relationshipType(rel.typeName) === undefined ||
			cannotHold(rel.props, candidate.effectiveRelationshipPropertyNames(rel.typeName))
		) {
			note(rel.id);
		}
		if (visited()) yield { done, total };
	}
	if (refused > 0) {
		return `rebind leaves ${refused} entities the new metamodel cannot hold: ${refusedIds.join(', ')}`;
	}

	const containment = new Set(
		candidate.relationships.filter((t) => candidate.isContainment(t.name)).map((t) => t.name)
	);
	if (containment.size > 0) {
		const parents = new Map<string, string>();
		const secondParents = new Set<string>();
		for (const rel of wc.committedRelationshipsInOrder()) {
			if (containment.has(rel.typeName)) {
				if (parents.has(rel.targetId)) secondParents.add(rel.targetId);
				parents.set(rel.targetId, rel.sourceId);
			}
			if (visited()) yield { done, total };
		}
		const violations = secondParents.size > 0 ? firstIds(secondParents) : cycleHeads(parents);
		if (violations.length > 0) {
			return (
				'rebind leaves containment the new metamodel forbids ' +
				`(an element with two parents, or a cycle): ${violations.join(', ')}`
			);
		}
	}
	done = 2 * entities;

	// Which properties are references depends on the metamodel, per type.
	const elementRefs = new Map<string, readonly string[]>();
	const relationshipRefs = new Map<string, readonly string[]>();
	const refNames = (
		cache: Map<string, readonly string[]>,
		typeName: string,
		properties: (name: string) => readonly { name: string; datatype: string }[]
	) => {
		let names = cache.get(typeName);
		if (names === undefined) {
			names = properties(typeName)
				.filter((p) => candidate.isElementType(p.datatype))
				.map((p) => p.name);
			cache.set(typeName, names);
		}
		return names;
	};
	const holders = new Set<string>();
	const holdsDangling = (
		id: string,
		props: { [name: string]: unknown },
		names: readonly string[]
	) => {
		for (const name of names) {
			const value = props[name];
			if (value === undefined || value === null) continue;
			for (const item of Array.isArray(value) ? value : [value]) {
				if (typeof item === 'string' && !wc.hasCommittedElement(item)) holders.add(id);
			}
		}
	};
	for (const el of wc.committedElementsInOrder()) {
		const names = refNames(elementRefs, el.typeName, (t) =>
			candidate.effectiveElementProperties(t)
		);
		if (names.length > 0) holdsDangling(el.id, el.props, names);
		if (visited()) yield { done, total };
	}
	for (const rel of wc.committedRelationshipsInOrder()) {
		const names = refNames(relationshipRefs, rel.typeName, (t) =>
			candidate.effectiveRelationshipProperties(t)
		);
		if (names.length > 0) holdsDangling(rel.id, rel.props, names);
		if (visited()) yield { done, total };
	}
	if (holders.size > 0) {
		return (
			'rebind leaves element references that point to no element, ' +
			`held by: ${firstIds(holders).join(', ')}`
		);
	}
	return null;
}

/**
 * Up to five elements, one on each containment cycle, found by walking the
 * parent chains in the order the parents were first read: each chain is a path
 * until it meets itself or a chain walked before.
 */
function cycleHeads(parents: ReadonlyMap<string, string>): string[] {
	const cyclic: string[] = [];
	const walked = new Set<string>();
	for (const start of parents.keys()) {
		if (walked.has(start)) continue;
		const path = new Set<string>();
		let node: string | undefined = start;
		while (node !== undefined && !walked.has(node)) {
			if (path.has(node)) {
				cyclic.push(node);
				break;
			}
			path.add(node);
			node = parents.get(node);
		}
		for (const id of path) walked.add(id);
		if (cyclic.length >= LIMIT) break;
	}
	return cyclic;
}

/**
 * `POST /commits/preview`'s body for a rebind the server's commit would
 * refuse: it blocks, and `block_reason` is the 422 detail the commit answers.
 * The scan under the candidate is not run, so it lists no issue.
 */
export function rebindBlockedBody(reason: string): PreviewBody {
	return {
		conformance_error_count: 0,
		structural_blockers: [],
		issues: [],
		would_block: true,
		block_reason: reason
	};
}
