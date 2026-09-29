import type { ElementRec } from '../../model/records.ts';
import type { Structure } from '../../model/structure.ts';
import { errorIssue } from '../issue.ts';
import type { Run, Validator } from '../pipeline.ts';

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

/**
 * An element has at most one containment parent. In the scope, every element
 * whose first-parent chain reaches a cycle is reported, the ones hanging
 * below the cycle included.
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
			if (el !== undefined && reachesCycle(run.structure, el, safe)) {
				run.out.push(
					errorIssue(`Containment cycle detected involving element ${id}`, [id], 'structural')
				);
			}
		}
	}
}
