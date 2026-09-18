import type { Model } from '../model/model.ts';
import { sha256Words } from './sha256.ts';

/** The 64-bit hash of one `(id, rev)` pair that the state digest folds with XOR. */
export type EntityHash = (id: string, rev: number) => bigint;

const state = new Int32Array(8);
let message = new Uint8Array(256);

/**
 * Writes `utf8(id)`, a zero byte and the decimal digits of `rev` into
 * `message`; returns the length. A lone surrogate is written as U+FFFD, as
 * `TextEncoder` writes it — the server cannot hash such an id at all.
 */
function write(id: string, rev: number): number {
	const digits = String(rev);
	const room = 3 * id.length + 1 + digits.length;
	if (message.length < room) message = new Uint8Array(2 * room);
	let at = 0;
	for (let i = 0; i < id.length; i++) {
		let code = id.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdfff) {
			const next = code <= 0xdbff ? id.charCodeAt(i + 1) : NaN;
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
				i++;
			} else code = 0xfffd;
		}
		if (code < 0x80) message[at++] = code;
		else if (code < 0x800) {
			message[at++] = 0xc0 | (code >> 6);
			message[at++] = 0x80 | (code & 0x3f);
		} else if (code < 0x10000) {
			message[at++] = 0xe0 | (code >> 12);
			message[at++] = 0x80 | ((code >> 6) & 0x3f);
			message[at++] = 0x80 | (code & 0x3f);
		} else {
			message[at++] = 0xf0 | (code >> 18);
			message[at++] = 0x80 | ((code >> 12) & 0x3f);
			message[at++] = 0x80 | ((code >> 6) & 0x3f);
			message[at++] = 0x80 | (code & 0x3f);
		}
	}
	message[at++] = 0;
	for (let i = 0; i < digits.length; i++) message[at++] = digits.charCodeAt(i);
	return at;
}

/**
 * One entity's share of the state digest: the first 8 bytes of SHA-256 over
 * `utf8(id) + 0x00 + ascii(decimal rev)`. Elements and relationships share one
 * id namespace, so one function serves both.
 */
export function entityHash(id: string, rev: number): bigint {
	// `write` may replace `message`, so it runs first.
	const length = write(id, rev);
	sha256Words(message, length, state);
	return (BigInt(state[0]! >>> 0) << 32n) | BigInt(state[1]! >>> 0);
}

/** The wire form of a digest: 16 lower-case hex digits. */
export function formatDigest(value: bigint): string {
	return value.toString(16).padStart(16, '0');
}

/** The state digest of every element and relationship, by full recomputation. */
export function modelDigest(model: Model): string {
	let value = 0n;
	for (const element of model.elements()) value ^= entityHash(element.id, element.rev);
	for (const rel of model.relationships()) value ^= entityHash(rel.id, rel.rev);
	return formatDigest(value);
}
