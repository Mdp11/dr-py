import { PyFloat, type Value } from './types.ts';

/**
 * A literal, in value position, that native `JSON.parse` would get wrong: a
 * float (Python always writes `.`, `e` or `E`), an integer that may exceed
 * 2^53, a bare non-finite constant, or `-0` (an `int` 0 in Python, `-0` in
 * JavaScript). A match inside a string is harmless — the exact parser is
 * merely slower.
 */
const NEEDS_EXACT = /(?:^|[:[,])\s*(?:-?(?:\d+[.eE]|\d{16,}|Infinity|NaN)|-0(?!\d))/;

export function needsExactParse(text: string): boolean {
	return NEEDS_EXACT.test(text);
}

const ESCAPES: Record<string, string> = {
	'"': '"',
	'\\': '\\',
	'/': '/',
	b: '\b',
	f: '\f',
	n: '\n',
	r: '\r',
	t: '\t'
};

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;

/**
 * `floatConstants` reads a bare `NaN`, `Infinity` or `-Infinity` as the float
 * it stands for, as `json.loads` does, instead of keeping its source text.
 */
export type ParseOptions = { floatConstants?: boolean };

class ExactParser {
	private readonly text: string;
	private readonly floatConstants: boolean;
	private pos = 0;

	constructor(text: string, options: ParseOptions) {
		this.text = text;
		this.floatConstants = options.floatConstants ?? false;
	}

	parse(): Value {
		const value = this.value();
		this.skip();
		if (this.pos !== this.text.length) this.fail('Extra data');
		return value;
	}

	private fail(what: string): never {
		throw new SyntaxError(`${what} at position ${this.pos}`);
	}

	private skip(): void {
		WHITESPACE.lastIndex = this.pos;
		WHITESPACE.test(this.text);
		this.pos = WHITESPACE.lastIndex;
	}

	private literal(word: string, value: Value): Value {
		if (!this.text.startsWith(word, this.pos)) this.fail('Expecting value');
		this.pos += word.length;
		return value;
	}

	private value(): Value {
		this.skip();
		const ch = this.text[this.pos];
		if (ch === '{') return this.object();
		if (ch === '[') return this.array();
		if (ch === '"') return this.string();
		if (ch === 't') return this.literal('true', true);
		if (ch === 'f') return this.literal('false', false);
		if (ch === 'n') return this.literal('null', null);
		// The bare constants keep their source text, as `parse_model_json` does,
		// unless they are read as floats.
		if (ch === 'N') return this.literal('NaN', this.constant('NaN', NaN));
		if (ch === 'I') return this.literal('Infinity', this.constant('Infinity', Infinity));
		if (ch === '-' && this.text[this.pos + 1] === 'I')
			return this.literal('-Infinity', this.constant('-Infinity', -Infinity));
		return this.number();
	}

	private constant(text: string, value: number): Value {
		return this.floatConstants ? new PyFloat(value) : text;
	}

	private number(): Value {
		NUMBER.lastIndex = this.pos;
		const match = NUMBER.exec(this.text);
		if (match === null) this.fail('Expecting value');
		this.pos = NUMBER.lastIndex;
		const literal = match[0];
		if (match[1] !== undefined || match[2] !== undefined) return new PyFloat(Number(literal));
		const n = Number(literal);
		if (Number.isSafeInteger(n)) return n === 0 ? 0 : n;
		return BigInt(literal);
	}

	private string(): string {
		let out = '';
		let start = ++this.pos;
		for (;;) {
			const ch = this.text[this.pos];
			if (ch === undefined) this.fail('Unterminated string');
			if (ch === '"') {
				out += this.text.slice(start, this.pos++);
				return out;
			}
			if (ch === '\\') {
				out += this.text.slice(start, this.pos);
				const esc = this.text[this.pos + 1];
				if (esc === 'u') {
					const code = this.text.slice(this.pos + 2, this.pos + 6);
					if (!/^[0-9a-fA-F]{4}$/.test(code)) this.fail('Invalid \\uXXXX escape');
					out += String.fromCharCode(parseInt(code, 16));
					this.pos += 6;
				} else {
					const plain = esc === undefined ? undefined : ESCAPES[esc];
					if (plain === undefined) this.fail('Invalid \\escape');
					out += plain;
					this.pos += 2;
				}
				start = this.pos;
			} else this.pos++;
		}
	}

	private array(): Value[] {
		const out: Value[] = [];
		this.pos++;
		this.skip();
		if (this.text[this.pos] === ']') {
			this.pos++;
			return out;
		}
		for (;;) {
			out.push(this.value());
			this.skip();
			const ch = this.text[this.pos++];
			if (ch === ']') return out;
			if (ch !== ',') this.fail("Expecting ',' delimiter");
		}
	}

	private object(): { [key: string]: Value } {
		const out: { [key: string]: Value } = {};
		this.pos++;
		this.skip();
		if (this.text[this.pos] === '}') {
			this.pos++;
			return out;
		}
		for (;;) {
			this.skip();
			if (this.text[this.pos] !== '"') this.fail('Expecting property name');
			const key = this.string();
			this.skip();
			if (this.text[this.pos++] !== ':') this.fail("Expecting ':' delimiter");
			const value = this.value();
			// `__proto__` must become an own property, as JSON.parse makes it.
			Object.defineProperty(out, key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true
			});
			this.skip();
			const ch = this.text[this.pos++];
			if (ch === '}') return out;
			if (ch !== ',') this.fail("Expecting ',' delimiter");
		}
	}
}

/** Parses JSON exactly: floats as `PyFloat`, big integers as `bigint`. */
export function parseExact(text: string, options: ParseOptions = {}): Value {
	return new ExactParser(text, options).parse();
}

/** Parses one JSON document, exactly, as fast as its content allows. */
export function parseJson(text: string): Value {
	return needsExactParse(text) ? parseExact(text) : (JSON.parse(text) as Value);
}

/**
 * Parses many single-line documents. Lines the native parser handles exactly
 * go through it in one call; the rest go through the exact parser.
 */
export function parseLines(lines: readonly string[]): Value[] {
	const out = new Array<Value>(lines.length);
	const fast: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (needsExactParse(line)) out[i] = parseExact(line);
		else fast.push(i);
	}
	if (fast.length > 0) {
		const parsed = JSON.parse('[' + fast.map((i) => lines[i]).join(',') + ']') as Value[];
		// A line holding `1,2` would shift every document after it.
		if (parsed.length !== fast.length) throw new SyntaxError('A line holds more than one document');
		for (let k = 0; k < fast.length; k++) out[fast[k]!] = parsed[k]!;
	}
	return out;
}
