import { createHash } from 'node:crypto';
import type { Model } from '../../src/index.ts';

function entityHash(id: string, rev: number): bigint {
	const hash = createHash('sha256').update(id, 'utf8').update('\0').update(String(rev));
	return hash.digest().readBigUInt64BE(0);
}

/**
 * The state digest of a model, on Node's SHA-256: the XOR over every entity of
 * the first 8 bytes of SHA-256 over `utf8(id) + 0x00 + ascii(rev)`.
 */
export function stateDigest(model: Model): string {
	let value = 0n;
	for (const element of model.elements()) value ^= entityHash(element.id, element.rev);
	for (const rel of model.relationships()) value ^= entityHash(rel.id, rel.rev);
	return value.toString(16).padStart(16, '0');
}
