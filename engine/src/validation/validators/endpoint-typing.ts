import type { Metamodel } from '../../metamodel/metamodel.ts';
import type { RelRec } from '../../model/records.ts';
import { cmpCodePoint } from '../../value/compare.ts';
import { errorIssue } from '../issue.ts';
import type { Run, Validator } from '../pipeline.ts';

/** Whether the source fits some mapping, the target fits some mapping, and the pair fits one. */
type Decision = { sourceOk: boolean; targetOk: boolean; pairOk: boolean };

const ALL_OK: Decision = { sourceOk: true, targetOk: true, pairOk: true };

/**
 * A relationship's endpoint types against its type's mappings, subtypes
 * included. An endpoint that is not an element renders as `None` and fits.
 */
export class EndpointTyping implements Validator {
	readonly checkName = 'endpoint_typing';
	private readonly mm: Metamodel;
	// relationship type → source type → target type → decision; `null` is no element
	private readonly decisions = new Map<string, Map<string | null, Map<string | null, Decision>>>();

	constructor(mm: Metamodel) {
		this.mm = mm;
	}

	validateRelationship(run: Run, rel: RelRec): void {
		const model = run.model;
		const sourceType = model.findElement(rel.source.id)?.typeName ?? null;
		const targetType = model.findElement(rel.target.id)?.typeName ?? null;
		let bySource = this.decisions.get(rel.typeName);
		if (bySource === undefined) this.decisions.set(rel.typeName, (bySource = new Map()));
		let byTarget = bySource.get(sourceType);
		if (byTarget === undefined) bySource.set(sourceType, (byTarget = new Map()));
		let decision = byTarget.get(targetType);
		if (decision === undefined) {
			decision = this.decide(rel.typeName, sourceType, targetType);
			byTarget.set(targetType, decision);
		}
		const { sourceOk, targetOk, pairOk } = decision;
		if (sourceOk && targetOk && pairOk) return;
		const rt = this.mm.relationshipType(rel.typeName)!;
		const allowed = (ends: string[]) => [...new Set(ends)].sort(cmpCodePoint).join(', ');
		const shown = (typeName: string | null) => typeName ?? 'None';
		if (!sourceOk) {
			run.out.push(
				errorIssue(
					`${rt.name}: source ${shown(sourceType)} is not one of ` +
						`[${allowed(rt.mappings.map((m) => m.source))}]`,
					[rel.id]
				)
			);
		}
		if (!targetOk) {
			run.out.push(
				errorIssue(
					`${rt.name}: target ${shown(targetType)} is not one of ` +
						`[${allowed(rt.mappings.map((m) => m.target))}]`,
					[rel.id]
				)
			);
		}
		if (sourceOk && targetOk && !pairOk) {
			run.out.push(
				errorIssue(
					`${rt.name}: (${shown(sourceType)}, ${shown(targetType)}) ` +
						'matches no declared (source, target) mapping',
					[rel.id]
				)
			);
		}
	}

	private decide(relType: string, sourceType: string | null, targetType: string | null): Decision {
		const rt = this.mm.relationshipType(relType);
		if (rt === undefined || rt.mappings.length === 0) return ALL_OK;
		const fits = (typeName: string, sup: string) => this.mm.isElementSubtype(typeName, sup);
		return {
			sourceOk: sourceType === null || rt.mappings.some((m) => fits(sourceType, m.source)),
			targetOk: targetType === null || rt.mappings.some((m) => fits(targetType, m.target)),
			pairOk:
				sourceType === null ||
				targetType === null ||
				rt.mappings.some((m) => fits(sourceType, m.source) && fits(targetType, m.target))
		};
	}
}
