import type { Model } from '../model/model.ts';
import { dumpIndexes, type IndexDump } from './dump-indexes.ts';

function structuralFaults(model: Model): string[] {
	const faults: string[] = [];
	let lastOrd = -Infinity;
	for (const element of model.elements()) {
		if (element.ord <= lastOrd) faults.push(`element order at ${element.id}`);
		lastOrd = element.ord;
		element.out.forEach((rel, i) => {
			if (rel.outAt !== i || rel.source !== element) faults.push(`out position of ${rel.id}`);
		});
		element.in.forEach((rel, i) => {
			if (rel.inAt !== i || rel.target !== element) faults.push(`in position of ${rel.id}`);
		});
		if ((element.rootName === null) !== element.parents.length > 0) {
			faults.push(`root flag of ${element.id}`);
		}
		const bucket = model.indexes.buckets.get(element.uniq);
		if (bucket !== element && !(bucket instanceof Set && bucket.has(element))) {
			faults.push(`uniqueness bucket of ${element.id}`);
		}
	}
	lastOrd = -Infinity;
	for (const rel of model.relationships()) {
		if (rel.ord <= lastOrd) faults.push(`relationship order at ${rel.id}`);
		lastOrd = rel.ord;
		if (model.findElement(rel.source.id) !== rel.source) faults.push(`source of ${rel.id}`);
		if (model.findElement(rel.target.id) !== rel.target) faults.push(`target of ${rel.id}`);
	}
	return faults;
}

/**
 * Throws unless the incrementally maintained indexes equal a fresh rebuild.
 * It rebuilds them in place — which leaves a consistent model as it was — so
 * it is a full pass over the model: tests and debugging only.
 */
export function verifyConsistent(model: Model): void {
	const faults = structuralFaults(model);
	const kept = dumpIndexes(model);
	model.rebuildIndexes();
	const fresh = dumpIndexes(model);
	for (const section of Object.keys(kept) as (keyof IndexDump)[]) {
		if (JSON.stringify(kept[section]) !== JSON.stringify(fresh[section])) faults.push(section);
	}
	if (faults.length > 0) {
		throw new Error('indexes differ from a fresh rebuild in: ' + faults.join(', '));
	}
}
