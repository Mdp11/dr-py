/** A streaming UTF-8 decoder: `stream: true` keeps a sequence cut by the end of `input` for the next call. */
export type Utf8Decoder = {
	decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};

type DecoderClass = new (
	label: string,
	options: { fatal: boolean; ignoreBOM: boolean }
) => Utf8Decoder;

/**
 * The host's `TextDecoder`, which a browser worker and Node both have. It is
 * looked up rather than declared: a global declared here would collide with
 * the host typings of whatever project compiles these sources next.
 *
 * Malformed input throws instead of turning into U+FFFD, which no digest
 * would notice; a byte order mark is kept, so that it fails the format check.
 */
export function utf8Decoder(): Utf8Decoder {
	const host = globalThis as unknown as { TextDecoder?: DecoderClass };
	if (host.TextDecoder === undefined) throw new Error('This host has no TextDecoder');
	return new host.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
}
