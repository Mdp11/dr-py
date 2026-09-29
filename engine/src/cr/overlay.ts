/**
 * A change request's effects over the working copy, without copying it or
 * writing to it: per kind, the entities the change requests set or deleted,
 * iterated as the Python dict `apply_change_request` fills would be.
 */
import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { workingElement, workingRel, type CrElement, type CrRelationship } from './diff.ts';

/**
 * One kind's working records, overlaid with what change requests set and
 * deleted. Iteration follows a Python dict after the same `d[id] = …` and
 * `d.pop(id, None)`: a set keeps an id present in the current state in its
 * place, and appends any other; a delete then a set appends.
 */
export class CrOverlay<R extends { readonly id: string; ord: number }, E> {
	private readonly find: (id: string) => R | undefined;
	private readonly image: (rec: R) => E;
	/** Working ids set and never deleted since: they keep their place. */
	private readonly placed = new Map<string, E>();
	/** Every other id set, in the order it was appended; a `Map` keeps a present key's place. */
	private readonly appended = new Map<string, E>();
	/** Working ids deleted and not set again. */
	private readonly gone = new Set<string>();

	constructor(find: (id: string) => R | undefined, image: (rec: R) => E) {
		this.find = find;
		this.image = image;
	}

	static elements(model: Model): CrOverlay<ElementRec, CrElement> {
		return new CrOverlay((id) => model.findElement(id), workingElement);
	}

	static relationships(model: Model): CrOverlay<RelRec, CrRelationship> {
		return new CrOverlay((id) => model.findRelationship(id), workingRel);
	}

	/** The entity in the current state: the overlay's, else the working record's image. */
	get(id: string): E | undefined {
		const entity = this.placed.get(id) ?? this.appended.get(id);
		if (entity !== undefined || this.gone.has(id)) return entity;
		const rec = this.find(id);
		return rec === undefined ? undefined : this.image(rec);
	}

	has(id: string): boolean {
		if (this.placed.has(id) || this.appended.has(id)) return true;
		return !this.gone.has(id) && this.find(id) !== undefined;
	}

	/** The working record's image, whatever the overlay holds. */
	base(id: string): E | undefined {
		const rec = this.find(id);
		return rec === undefined ? undefined : this.image(rec);
	}

	/** `d[id] = entity`. */
	set(id: string, entity: E): void {
		if (this.placed.has(id)) this.placed.set(id, entity);
		else if (this.appended.has(id)) this.appended.set(id, entity);
		else if (this.gone.delete(id)) this.appended.set(id, entity);
		else if (this.find(id) !== undefined) this.placed.set(id, entity);
		else this.appended.set(id, entity);
	}

	/** `d.pop(id, None)`: a no-op for an id not in the current state. */
	delete(id: string): void {
		if (this.placed.delete(id)) this.gone.add(id);
		else if (this.appended.delete(id)) {
			if (this.find(id) !== undefined) this.gone.add(id);
		} else if (!this.gone.has(id) && this.find(id) !== undefined) this.gone.add(id);
	}

	/** The ids set and present, in the current state's order: working ids by `ord`, then appended ones. */
	touched(): string[] {
		return [...this.byOrd(this.placed.keys()), ...this.appended.keys()];
	}

	/** The working ids absent from the current state, by `ord`. */
	deleted(): string[] {
		return this.byOrd(this.gone);
	}

	private byOrd(ids: Iterable<string>): string[] {
		return [...ids]
			.map((id) => this.find(id)!)
			.sort((a, b) => a.ord - b.ord)
			.map((rec) => rec.id);
	}
}
