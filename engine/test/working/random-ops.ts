import type { Model, ModelOp, Value } from '../../src/index.ts';

const NAMES = ['', 'a', 'b', 'B', '\u{e9}', '\u{1f600}'];
const CODES: Value[] = [0, 1, true, 2, null];

/**
 * Random op batches against the metamodel of the `ops_churn` fixture (`Part`
 * and `Slot`; `Owns`, `Seats`, `Feeds`). Most batches land; some name an
 * entity that is gone by then, and a few are wrong on purpose.
 */
export class RandomOps {
	private temps = 0;
	private readonly random: () => number;
	private readonly prefix: string;

	constructor(random: () => number, prefix = 'tmp_') {
		this.random = random;
		this.prefix = prefix;
	}

	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)]!;
	}

	batch(model: Model): ModelOp[] {
		const parts = [...model.elements()].filter((e) => e.typeName === 'Part').map((e) => e.id);
		const slots = [...model.elements()].filter((e) => e.typeName === 'Slot').map((e) => e.id);
		const rels = [...model.relationships()].map((r) => r.id);
		const ops: ModelOp[] = [];
		const count = 1 + Math.floor(this.random() * 4);
		for (let i = 0; i < count; i++) {
			const kind = this.pick([
				...Array<string>(4).fill('create'),
				...Array<string>(6).fill('update'),
				...Array<string>(5).fill('connect'),
				'delete_rel',
				'delete',
				'delete',
				'stale'
			]);
			if (kind === 'create') {
				const temp_id = `${this.prefix}${++this.temps}`;
				const type_name = this.pick(['Part', 'Part', 'Slot']);
				(type_name === 'Part' ? parts : slots).push(temp_id);
				ops.push({ kind: 'create_element', temp_id, type_name, properties: { name: 'new' } });
			} else if (kind === 'update' && parts.length + slots.length > 0) {
				const id = this.pick([...parts, ...slots]);
				const some = this.pick([...parts, ...slots, 'dangling']);
				const patch: { [key: string]: Value } = { name: this.pick([...NAMES, null]) };
				if (slots.includes(id)) {
					patch['code'] = this.pick(CODES);
					patch['holder'] = some;
				} else {
					patch['peers'] = [some, this.pick([...parts, 'dangling'])];
				}
				ops.push({ kind: 'update_element', id, properties_patch: patch });
			} else if (kind === 'connect' && parts.length > 0) {
				const type_name = this.pick(['Owns', 'Seats', 'Feeds']);
				const sources = type_name === 'Feeds' ? slots : parts;
				const targets = type_name === 'Owns' ? parts : slots;
				if (sources.length === 0 || targets.length === 0) continue;
				const temp_id = `${this.prefix}${++this.temps}`;
				rels.push(temp_id);
				ops.push({
					kind: 'create_relationship',
					temp_id,
					type_name,
					source_id: this.pick(sources),
					target_id: this.pick(targets)
				});
			} else if (kind === 'delete_rel' && rels.length > 0) {
				ops.push({ kind: 'delete_relationship', id: this.pick(rels) });
			} else if (kind === 'delete' && parts.length + slots.length > 0) {
				ops.push({ kind: 'delete_element', id: this.pick([...parts, ...slots]) });
			} else if (kind === 'stale') {
				ops.push({ kind: 'delete_element', id: 'gone' });
			}
		}
		return ops;
	}
}
