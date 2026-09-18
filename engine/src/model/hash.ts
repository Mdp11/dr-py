/**
 * A 53-bit string hash (cyrb53). Uniqueness buckets are keyed by it, so that
 * the index holds one number per element rather than one key text; a
 * collision only costs an exact comparison.
 */
export function hashKey(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ unit, 2654435761);
		h2 = Math.imul(h2 ^ unit, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
