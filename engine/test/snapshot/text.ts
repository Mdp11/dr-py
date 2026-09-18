import { expect } from 'vitest';
import { modelDigest, modelLines, pyDumps, SnapshotError, type Model } from '../../src/index.ts';

export const utf8 = (text: string) => new TextEncoder().encode(text);

/** `bytes` in pieces of `size` bytes, cut wherever that falls. */
export function* cut(bytes: Uint8Array, size: number): Generator<Uint8Array> {
	for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/** The same pieces from a source that makes the reader wait for each. */
export async function* trickle(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
	for (const piece of cut(bytes, size)) {
		await Promise.resolve();
		yield piece;
	}
}

/** The header line a server would write over `model`, with any field replaced. */
export function headerLine(model: Model, rev: number, changes: object = {}): string {
	return pyDumps({
		format: 'datarover.snapshot/v2',
		project_id: 'demo',
		rev,
		metamodel_id: 'mm-1',
		elements: model.elementCount,
		relationships: model.relationshipCount,
		state_digest: modelDigest(model),
		...changes
	});
}

/** `model` as the snapshot text a server would write at `rev`. */
export function snapshotText(model: Model, rev: number): string {
	return [headerLine(model, rev), ...modelLines(model)].map((line) => line + '\n').join('');
}

/** The message of the `SnapshotError` an opening fails with. */
export async function refusal(opening: Promise<unknown>): Promise<string> {
	const error = await opening.then(
		() => undefined,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(SnapshotError);
	return (error as SnapshotError).message;
}
