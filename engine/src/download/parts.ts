import { PART_BYTES } from '../export/route.ts';
import { surrogateRefusal, utf8Encoder } from '../export/utf8.ts';

// Any surrogate code unit, paired or lone: a piece holding one is looked at closely.
const SURROGATE = /[\uD800-\uDFFF]/;

/** The longest UTF-8 character: the least a part must hold. */
const MAX_CHAR_BYTES = 4;

/** Code points in `text`, whose surrogates are all paired. */
function codePoints(text: string): number {
	let pairs = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) pairs++;
	}
	return text.length - pairs;
}

/**
 * A document written piece by piece as UTF-8 into parts of at most
 * `partBytes` bytes, a character never split across two. Each piece is
 * encoded as it comes, so no string longer than one piece is ever held.
 */
export class PartWriter {
	private readonly partBytes: number;
	private readonly encoder = utf8Encoder();
	private readonly parts: ArrayBuffer[] = [];
	private part: Uint8Array<ArrayBuffer>;
	private used = 0;
	// Code points written so far: where a refusal counts its position from.
	private written = 0;
	private finished = false;

	constructor(partBytes = PART_BYTES) {
		if (!Number.isInteger(partBytes) || partBytes < MAX_CHAR_BYTES) {
			throw new RangeError(`a part holds at least ${MAX_CHAR_BYTES} bytes`);
		}
		this.partBytes = partBytes;
		this.part = new Uint8Array(partBytes);
	}

	/**
	 * Appends `text`. A lone surrogate is Python's 422, its position counted
	 * in code points from the start of the document; nothing of `text` is
	 * written then.
	 */
	write(text: string): void {
		if (this.finished) throw new Error('the document is finished');
		let length = text.length;
		if (SURROGATE.test(text)) {
			const refusal = surrogateRefusal(text, false, this.written);
			if (refusal !== null) throw refusal;
			length = codePoints(text);
		}
		let rest = text;
		for (;;) {
			const { read, written } = this.encoder.encodeInto(rest, this.part.subarray(this.used));
			this.used += written;
			if (read === rest.length) break;
			// The part cannot take the next character whole: it goes into the next one.
			this.parts.push(this.filled());
			this.part = new Uint8Array(this.partBytes);
			this.used = 0;
			rest = rest.slice(read);
		}
		this.written += length;
	}

	/** Ends the document: every part, the last one included; no part is empty. */
	finish(): ArrayBuffer[] {
		if (!this.finished && this.used > 0) this.parts.push(this.filled());
		this.finished = true;
		return this.parts;
	}

	/** The part being filled as it stands: its buffer when full, else a copy of what it holds. */
	private filled(): ArrayBuffer {
		return this.used === this.partBytes ? this.part.buffer : this.part.slice(0, this.used).buffer;
	}
}
