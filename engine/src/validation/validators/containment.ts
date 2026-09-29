import type { ElementRec } from '../../model/records.ts';
import type { Structure } from '../../model/structure.ts';
import { errorIssue, type Issue } from '../issue.ts';
import type { Run, Validator, WholeGlobal } from '../pipeline.ts';

/**
 * Whether the first-parent chain from `start` reaches a cycle. `safe` holds
 * elements known to reach a root, shared across one run; a chain that reaches
 * a cycle adds nothing to it.
 */
function reachesCycle(structure: Structure, start: ElementRec, safe: Set<ElementRec>): boolean {
	const seen = new Set<ElementRec>();
	let node: ElementRec | null = start;
	while (node !== null && !seen.has(node) && !safe.has(node)) {
		seen.add(node);
		node = structure.parentsOf(node)[0]?.source ?? null;
	}
	if (node === null || safe.has(node)) {
		for (const element of seen) safe.add(element);
		return false;
	}
	return true;
}

const cycleIssue = (id: string) =>
	errorIssue(`Containment cycle detected involving element ${id}`, [id], 'structural');

/**
 * An element has at most one containment parent. In the scope, every element
 * whose first-parent chain reaches a cycle is reported, the ones hanging
 * below the cycle included; over the whole model, only the first contained
 * element whose chain does.
 */
export class Containment implements Validator {
	readonly checkName = 'containment';

	validateElement(run: Run, el: ElementRec): void {
		const n = run.structure.parentsOf(el).length;
		if (n > 1) {
			run.out.push(
				errorIssue(
					`Element ${el.id} has ${n} containment parents (must have at most one)`,
					[el.id],
					'structural'
				)
			);
		}
	}

	validateGlobal(run: Run, scope: readonly string[]): void {
		const safe = new Set<ElementRec>();
		for (const id of scope) {
			const el = run.model.findElement(id);
			if (el !== undefined && reachesCycle(run.structure, el, safe)) run.out.push(cycleIssue(id));
		}
	}

	/**
	 * Contained elements in the order their first containment parent comes in
	 * the relationships, as the parents map is keyed; the first whose chain
	 * reaches a cycle is the one reported.
	 */
	validateWhole(run: Run, out: Issue[]): WholeGlobal {
		const safe = new Set<ElementRec>();
		let found = false;
		return {
			relationship(rel) {
				if (found || run.structure.parentsOf(rel.target)[0] !== rel) return;
				if (reachesCycle(run.structure, rel.target, safe)) {
					out.push(cycleIssue(rel.target.id));
					found = true;
				}
			}
		};
	}
}
