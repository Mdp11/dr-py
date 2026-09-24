/**
 * Python's `re` for the engine. A pattern is parsed as `re` reads it and
 * rewritten as a `u`-flag `RegExp` answering `re.search` / `re.fullmatch`
 * alike: the dot, the anchors, `\w \d \s`, word boundaries and IGNORECASE are
 * spelled out from Python's own data, never left to JavaScript's. A pattern
 * `re.compile` refuses is `invalid`; one the translation cannot vouch for is
 * `unsupported`, never guessed.
 */
import {
	DIGIT_RANGES,
	IGNORECASE_CASED_RANGES,
	IGNORECASE_EXTRA,
	IGNORECASE_LOWER,
	SPACE_RANGES,
	WORD_RANGES
} from './regex-tables.ts';

export type PyRegex =
	| { kind: 'ok'; test(subject: string): boolean }
	| { kind: 'invalid' }
	| { kind: 'unsupported'; reason: string };

const MAX_CP = 0x10ffff;
// A count at or past `re`'s MAXREPEAT raises OverflowError, not `re.error`.
const MAX_REPEAT = 0xffffffff;
// Past these a count, a look-behind width or the emitted source is unsupported.
const MAX_COUNT = 65535;
const MAX_SOURCE = 1 << 22;
const MEMO_LIMIT = 256;

const BACKSLASH = 0x5c;
const LPAREN = 0x28;
const RPAREN = 0x29;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const PIPE = 0x7c;
const STAR = 0x2a;
const PLUS = 0x2b;
const QUESTION = 0x3f;
const MINUS = 0x2d;
const CARET = 0x5e;
const DOLLAR = 0x24;
const DOT = 0x2e;
const COMMA = 0x2c;
const LT = 0x3c;
const GT = 0x3e;
const EQ = 0x3d;
const BANG = 0x21;
const COLON = 0x3a;
const HASH = 0x23;

// A token as `re` reads one: a code point, or an escaped one offset past Unicode.
const ESCAPED = 0x200000;
const END = -1;

const ch = (text: string): number => text.codePointAt(0)!;
const isDigit = (cp: number): boolean => cp >= 0x30 && cp <= 0x39;
const isOctal = (cp: number): boolean => cp >= 0x30 && cp <= 0x37;
const isHex = (cp: number): boolean =>
	isDigit(cp) || (cp >= 0x41 && cp <= 0x46) || (cp >= 0x61 && cp <= 0x66);
const isAsciiLetter = (cp: number): boolean =>
	(cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff;

// `re`'s single-character escapes, outside a class (`\b` is a boundary there) and inside.
const ESCAPES = new Map([
	[ch('a'), 0x07],
	[ch('f'), 0x0c],
	[ch('n'), 0x0a],
	[ch('r'), 0x0d],
	[ch('t'), 0x09],
	[ch('v'), 0x0b],
	[BACKSLASH, BACKSLASH]
]);
const CLASS_ESCAPES = new Map([...ESCAPES, [ch('b'), 0x08]]);
const FLAG_CHARS = new Set([...'iLmsxau-'].map(ch));
const SET_OPERATORS = new Set([...'-&~|'].map(ch));
const CATEGORY_LETTERS = new Set([...'dDsSwW'].map(ch));

// ---- Code point sets: sorted, disjoint, inclusive ranges, flat [start, end, …].

type CpSet = readonly number[];

function normalize(pairs: CpSet): number[] {
	const spans: [number, number][] = [];
	for (let k = 0; k < pairs.length; k += 2) spans.push([pairs[k]!, pairs[k + 1]!]);
	spans.sort((a, b) => a[0] - b[0]);
	const out: number[] = [];
	for (const [start, end] of spans) {
		if (out.length > 0 && start <= out[out.length - 1]! + 1) {
			out[out.length - 1] = Math.max(out[out.length - 1]!, end);
		} else out.push(start, end);
	}
	return out;
}

function points(cps: readonly number[]): number[] {
	return normalize(cps.flatMap((cp) => [cp, cp]));
}

function union(...sets: CpSet[]): number[] {
	return normalize(sets.flat());
}

function complement(set: CpSet): number[] {
	const out: number[] = [];
	let next = 0;
	for (let k = 0; k < set.length; k += 2) {
		if (set[k]! > next) out.push(next, set[k]! - 1);
		next = set[k + 1]! + 1;
	}
	if (next <= MAX_CP) out.push(next, MAX_CP);
	return out;
}

function intersect(a: CpSet, b: CpSet): number[] {
	return complement(union(complement(a), complement(b)));
}

function has(set: CpSet, cp: number): boolean {
	let lo = 0;
	let hi = set.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (cp < set[2 * mid]!) hi = mid - 1;
		else if (cp > set[2 * mid + 1]!) lo = mid + 1;
		else return true;
	}
	return false;
}

// ---- IGNORECASE as `re` matches it: a class holding a cased member accepts
// every code point whose lowercase is a member's lowercase or one of its extra
// equivalents; one without a cased member matches as written.

type CaseData = { lower: Map<number, number>; extra: Map<number, readonly number[]> };

let caseData: CaseData | undefined;

function cases(): CaseData {
	if (caseData === undefined) {
		const lower = new Map<number, number>();
		for (let k = 0; k < IGNORECASE_LOWER.length; k += 2) {
			lower.set(IGNORECASE_LOWER[k]!, IGNORECASE_LOWER[k + 1]!);
		}
		const extra = new Map<number, readonly number[]>();
		for (let k = 0; k < IGNORECASE_EXTRA.length;) {
			const count = IGNORECASE_EXTRA[k + 1]!;
			extra.set(IGNORECASE_EXTRA[k]!, IGNORECASE_EXTRA.slice(k + 2, k + 2 + count));
			k += 2 + count;
		}
		caseData = { lower, extra };
	}
	return caseData;
}

function loweredMembers(literals: readonly number[], spans: CpSet): number[] {
	const { lower, extra } = cases();
	const spanSet = normalize(spans);
	const dropped: number[] = [];
	const added = literals.map((cp) => lower.get(cp) ?? cp);
	for (const [cp, lowered] of lower) {
		if (has(spanSet, cp)) {
			dropped.push(cp);
			added.push(lowered);
		}
	}
	const image = union(intersect(spanSet, complement(points(dropped))), points(added));
	const equivalents: number[] = [];
	for (const [lowered, more] of extra) if (has(image, lowered)) equivalents.push(...more);
	return union(image, points(equivalents));
}

function lowercaseIn(set: CpSet): number[] {
	const removed: number[] = [];
	const added: number[] = [];
	for (const [cp, lowered] of cases().lower) {
		const inside = has(set, lowered);
		if (has(set, cp) !== inside) (inside ? added : removed).push(cp);
	}
	return union(intersect(set, complement(points(removed))), points(added));
}

type Members = { literals: number[]; spans: number[]; categories: CpSet[] };

function memberSet(members: Members, negate: boolean, ignoreCase: boolean): number[] {
	const { literals, spans, categories } = members;
	const cased =
		ignoreCase &&
		(literals.some((cp) => has(IGNORECASE_CASED_RANGES, cp)) ||
			intersect(normalize(spans), IGNORECASE_CASED_RANGES).length > 0);
	const set = cased
		? lowercaseIn(union(loweredMembers(literals, spans), ...categories))
		: union(points(literals), spans, ...categories);
	return negate ? complement(set) : set;
}

// ---- Emitting JavaScript source.

const categories = new Map<number, CpSet>();

function category(letter: number): CpSet {
	let set = categories.get(letter);
	if (set === undefined) {
		const lower = letter | 0x20;
		const base = lower === ch('d') ? DIGIT_RANGES : lower === ch('s') ? SPACE_RANGES : WORD_RANGES;
		set = letter === lower ? base : complement(base);
		categories.set(letter, set);
	}
	return set;
}

function cpSource(cp: number): string {
	return isDigit(cp) || isAsciiLetter(cp) || cp === 0x5f
		? String.fromCharCode(cp)
		: `\\u{${cp.toString(16)}}`;
}

function setSource(set: CpSet): string {
	if (set.length === 2 && set[0] === set[1]) return cpSource(set[0]!);
	let out = '[';
	for (let k = 0; k < set.length; k += 2) {
		out += cpSource(set[k]!);
		if (set[k + 1]! > set[k]!) out += '-' + cpSource(set[k + 1]!);
	}
	return out + ']';
}

// A cased literal under IGNORECASE, as the class it matches.
const casedLiterals = new Map<number, string>();

let wordClass: string | undefined;

function boundary(negated: boolean): string {
	wordClass ??= setSource(WORD_RANGES);
	const w = wordClass;
	return negated
		? `(?:(?<=${w})(?=${w})|(?<!${w})(?!${w}))`
		: `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`;
}

const START = '(?<![\\s\\S])';
const END_OF_TEXT = '(?![\\s\\S])';

// ---- The parser: `re`'s own, over code points, emitting as it goes.

class Refusal extends Error {
	readonly answer: PyRegex;
	constructor(answer: PyRegex) {
		super(answer.kind);
		this.answer = answer;
	}
}

function invalid(): never {
	throw new Refusal({ kind: 'invalid' });
}

function unsupported(reason: string): never {
	throw new Refusal({ kind: 'unsupported', reason });
}

type Item = {
	kind: 'unit' | 'at' | 'group' | 'look' | 'repeat' | 'ref';
	source: string;
	// `re`'s width bounds, which decide whether a look-behind is allowed.
	lo: number;
	hi: number;
	// Groups certain to hold a match once this item has matched.
	sure: number[];
};

type Member = { cp: number } | { category: CpSet };

const unit = (source: string): Item => ({ kind: 'unit', source, lo: 1, hi: 1, sure: [] });
const at = (source: string): Item => ({ kind: 'at', source, lo: 0, hi: 0, sure: [] });

function quantifier(min: number, max: number): string {
	if (min === 0 && max === Infinity) return '*';
	if (min === 1 && max === Infinity) return '+';
	if (min === 0 && max === 1) return '?';
	if (max === Infinity) return `{${min},}`;
	return min === max ? `{${min}}` : `{${min},${max}}`;
}

class Parser {
	private readonly cps: number[];
	private i = 0;
	private readonly flags = { i: false, m: false, s: false };
	private groups = 0;
	private readonly open = new Set<number>();
	private readonly names = new Map<string, number>();
	// The first group number opened inside the outermost look-behind, while in one.
	private lookbehindFrom: number | null = null;
	private size = 0;

	constructor(cps: number[]) {
		this.cps = cps;
	}

	parse(): string {
		this.leadingFlags();
		const body = this.alternation(new Set());
		if (this.i < this.cps.length) invalid();
		return body.source;
	}

	private peek(): number | undefined {
		return this.cps[this.i];
	}

	private eat(cp: number): boolean {
		if (this.cps[this.i] !== cp) return false;
		this.i++;
		return true;
	}

	// The caller has refused a pattern ending in an unpaired backslash.
	private token(): number {
		const cp = this.cps[this.i++];
		if (cp === undefined) return END;
		return cp === BACKSLASH ? ESCAPED + this.cps[this.i++]! : cp;
	}

	private leadingFlags(): void {
		const cps = this.cps;
		while (cps[this.i] === LPAREN && cps[this.i + 1] === QUESTION) {
			const first = cps[this.i + 2];
			if (first === undefined || !FLAG_CHARS.has(first)) return;
			let j = this.i + 2;
			let letters = '';
			while (j < cps.length && isAsciiLetter(cps[j]!)) letters += String.fromCharCode(cps[j++]!);
			if (cps[j] !== RPAREN || !/^[ims]+$/.test(letters)) {
				unsupported('inline flags other than a leading (?i), (?m) or (?s)');
			}
			for (const flag of letters) this.flags[flag as 'i' | 'm' | 's'] = true;
			this.i = j + 1;
		}
	}

	private alternation(sure: ReadonlySet<number>): Item {
		const branches = [this.sequence(new Set(sure))];
		while (this.eat(PIPE)) branches.push(this.sequence(new Set(sure)));
		if (branches.length === 1) return branches[0]!;
		return {
			kind: 'group',
			source: '(?:' + branches.map((b) => b.source).join('|') + ')',
			lo: Math.min(...branches.map((b) => b.lo)),
			hi: Math.max(...branches.map((b) => b.hi)),
			sure: []
		};
	}

	private sequence(sure: Set<number>): Item {
		const items: Item[] = [];
		for (;;) {
			const cp = this.peek();
			if (cp === undefined || cp === PIPE || cp === RPAREN) break;
			this.i++;
			if (cp === STAR || cp === PLUS || cp === QUESTION || cp === LBRACE) {
				this.repeat(cp, items, sure);
				continue;
			}
			const item = this.atom(cp, sure);
			if (item.kind === 'unit' || item.kind === 'at') {
				this.size += item.source.length;
				if (this.size > MAX_SOURCE) unsupported('a translation past 4 MiB');
			}
			items.push(item);
			for (const group of item.sure) sure.add(group);
		}
		return {
			kind: 'group',
			source: items.map((item) => item.source).join(''),
			lo: items.reduce((sum, item) => sum + item.lo, 0),
			hi: items.reduce((sum, item) => sum + item.hi, 0),
			sure: items.flatMap((item) => item.sure)
		};
	}

	private repeat(cp: number, items: Item[], sure: Set<number>): void {
		let min = cp === PLUS ? 1 : 0;
		let max = cp === QUESTION ? 1 : Infinity;
		if (cp === LBRACE) {
			const counts = this.counts();
			if (counts === null) {
				items.push(this.literal(LBRACE));
				return;
			}
			[min, max] = counts;
		}
		const last = items[items.length - 1];
		if (last === undefined || last.kind === 'at' || last.kind === 'repeat') invalid();
		const lazy = this.eat(QUESTION);
		if (!lazy && this.eat(PLUS)) unsupported('a possessive quantifier');
		if (last.kind === 'look') unsupported('a repeated look-around');
		for (const group of last.sure) sure.delete(group);
		items[items.length - 1] = {
			kind: 'repeat',
			source: last.source + quantifier(min, max) + (lazy ? '?' : ''),
			lo: last.lo * min,
			hi: max === 0 || last.hi === 0 ? 0 : last.hi * max,
			sure: []
		};
	}

	// `{m}`, `{m,}`, `{,n}`, `{m,n}`; null where `re` reads the brace as a literal.
	private counts(): [number, number] | null {
		const here = this.i;
		if (this.peek() === RBRACE) return null;
		const lo = this.digits();
		const comma = this.eat(COMMA);
		const hi = comma ? this.digits() : lo;
		if (!this.eat(RBRACE)) {
			this.i = here;
			return null;
		}
		const min = lo === '' ? 0 : Number(lo);
		const max = hi === '' ? Infinity : Number(hi);
		if (min >= MAX_REPEAT || (max !== Infinity && max >= MAX_REPEAT)) {
			unsupported('a repetition count re overflows on');
		}
		if (max < min) invalid();
		if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) {
			unsupported(`a repetition count past ${MAX_COUNT}`);
		}
		return [min, max];
	}

	private digits(): string {
		let out = '';
		while (this.i < this.cps.length && isDigit(this.cps[this.i]!)) {
			out += String.fromCharCode(this.cps[this.i++]!);
		}
		return out;
	}

	private atom(cp: number, sure: ReadonlySet<number>): Item {
		switch (cp) {
			case BACKSLASH:
				return this.escape(this.cps[this.i++]!, sure);
			case LBRACKET:
				return this.charClass();
			case LPAREN:
				return this.group(sure);
			case DOT:
				return unit(this.flags.s ? '[\\s\\S]' : '[^\\n]');
			case CARET:
				return at(this.flags.m ? '(?<![^\\n])' : START);
			case DOLLAR:
				return at(this.flags.m ? `(?=\\n|${END_OF_TEXT})` : `(?=\\n?${END_OF_TEXT})`);
			default:
				return this.literal(cp);
		}
	}

	private literal(cp: number): Item {
		if (isSurrogate(cp)) unsupported('a surrogate code point');
		if (!this.flags.i || !has(IGNORECASE_CASED_RANGES, cp)) return unit(cpSource(cp));
		let source = casedLiterals.get(cp);
		if (source === undefined) {
			source = setSource(memberSet({ literals: [cp], spans: [], categories: [] }, false, true));
			casedLiterals.set(cp, source);
		}
		return unit(source);
	}

	private escape(c: number, sure: ReadonlySet<number>): Item {
		switch (c) {
			case ch('A'):
				return at(START);
			case ch('z'):
			case ch('Z'):
				return at(END_OF_TEXT);
			case ch('b'):
				return at(boundary(false));
			case ch('B'):
				return at(boundary(true));
			case ch('d'):
			case ch('D'):
			case ch('s'):
			case ch('S'):
			case ch('w'):
			case ch('W'):
				return unit(setSource(category(c)));
		}
		const simple = ESCAPES.get(c);
		if (simple !== undefined) return this.literal(simple);
		if (c === ch('x') || c === ch('u') || c === ch('U')) return this.literal(this.hex(c));
		if (c === ch('N')) unsupported('a named character escape');
		if (c === ch('0')) return this.literal(this.octal(c));
		if (isDigit(c)) return this.numbered(c, sure);
		if (isAsciiLetter(c)) invalid();
		return this.literal(c);
	}

	private hex(c: number): number {
		const width = c === ch('x') ? 2 : c === ch('u') ? 4 : 8;
		let text = '';
		while (text.length < width && this.i < this.cps.length && isHex(this.cps[this.i]!)) {
			text += String.fromCharCode(this.cps[this.i++]!);
		}
		if (text.length !== width) invalid();
		const value = parseInt(text, 16);
		if (value > MAX_CP) invalid();
		return value;
	}

	// An octal escape: the first digit and up to two more.
	private octal(first: number): number {
		let text = String.fromCharCode(first);
		while (text.length < 3 && this.i < this.cps.length && isOctal(this.cps[this.i]!)) {
			text += String.fromCharCode(this.cps[this.i++]!);
		}
		return parseInt(text, 8);
	}

	// `\1`…`\99` is a group; three octal digits are a code point.
	private numbered(c: number, sure: ReadonlySet<number>): Item {
		let text = String.fromCharCode(c);
		const second = this.peek();
		if (second !== undefined && isDigit(second)) {
			this.i++;
			text += String.fromCharCode(second);
			const third = this.peek();
			if (isOctal(c) && isOctal(second) && third !== undefined && isOctal(third)) {
				this.i++;
				const value = parseInt(text + String.fromCharCode(third), 8);
				if (value > 0o377) invalid();
				return this.literal(value);
			}
		}
		return this.reference(Number(text), sure);
	}

	private reference(group: number, sure: ReadonlySet<number>): Item {
		if (group > this.groups || this.open.has(group)) invalid();
		if (this.lookbehindFrom !== null && group >= this.lookbehindFrom) invalid();
		if (this.flags.i) unsupported('a back-reference under (?i)');
		if (this.lookbehindFrom !== null) unsupported('a back-reference in a look-behind');
		// JavaScript matches a reference to an unset group as empty, where `re` fails it.
		if (!sure.has(group)) unsupported('a back-reference to a group that may not have matched');
		return { kind: 'ref', source: `(?:\\${group})`, lo: 0, hi: 0, sure: [] };
	}

	private group(sure: ReadonlySet<number>): Item {
		if (!this.eat(QUESTION)) return this.capture(null, sure);
		const c = this.cps[this.i++];
		switch (c) {
			case undefined:
				return invalid();
			case ch('P'): {
				if (this.eat(LT)) return this.capture(this.name(GT), sure);
				if (!this.eat(EQ)) return invalid();
				const group = this.names.get(this.name(RPAREN));
				return group === undefined ? invalid() : this.reference(group, sure);
			}
			case COLON: {
				const body = this.enclosed(sure);
				return { ...body, kind: 'group', source: `(?:${body.source})` };
			}
			case EQ:
			case BANG: {
				const body = this.enclosed(sure);
				const head = c === EQ ? '(?=' : '(?!';
				return { kind: 'look', source: `${head}${body.source})`, lo: 0, hi: 0, sure: [] };
			}
			case LT: {
				const d = this.cps[this.i++];
				if (d !== EQ && d !== BANG) return invalid();
				return this.lookbehind(d === EQ ? '(?<=' : '(?<!', sure);
			}
			case HASH:
				return unsupported('a comment group');
			case LPAREN:
				return unsupported('a conditional group');
			case GT:
				return unsupported('an atomic group');
			default:
				if (FLAG_CHARS.has(c)) return unsupported('inline flags not at the start or scoped');
				return invalid();
		}
	}

	private capture(name: string | null, sure: ReadonlySet<number>): Item {
		const group = ++this.groups;
		if (name !== null) {
			if (this.names.has(name)) invalid();
			this.names.set(name, group);
		}
		this.open.add(group);
		const body = this.enclosed(sure);
		this.open.delete(group);
		return { ...body, kind: 'group', source: `(${body.source})`, sure: [group, ...body.sure] };
	}

	private lookbehind(head: string, sure: ReadonlySet<number>): Item {
		const outermost = this.lookbehindFrom === null;
		if (outermost) this.lookbehindFrom = this.groups + 1;
		const body = this.alternation(sure);
		if (outermost) this.lookbehindFrom = null;
		if (!this.eat(RPAREN)) invalid();
		if (body.lo !== body.hi) unsupported('a look-behind of varying width');
		if (body.lo > MAX_COUNT) unsupported(`a look-behind wider than ${MAX_COUNT}`);
		return { kind: 'look', source: `${head}${body.source})`, lo: 0, hi: 0, sure: [] };
	}

	private enclosed(sure: ReadonlySet<number>): Item {
		const body = this.alternation(sure);
		if (!this.eat(RPAREN)) invalid();
		return body;
	}

	private name(terminator: number): string {
		let name = '';
		for (;;) {
			const t = this.token();
			if (t === END) invalid();
			if (t === terminator) break;
			name += t >= ESCAPED ? '\\' + String.fromCodePoint(t - ESCAPED) : String.fromCodePoint(t);
		}
		if (name === '') invalid();
		if ([...name].some((c) => ch(c) > 0x7f)) unsupported('a group name past ASCII');
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid();
		return name;
	}

	private charClass(): Item {
		if (this.peek() === LBRACKET) unsupported('a nested set');
		const negate = this.eat(CARET);
		const members: Members = { literals: [], spans: [], categories: [] };
		const distinct = new Set<string>();
		for (;;) {
			const t = this.token();
			if (t === END) invalid();
			if (t === RBRACKET && distinct.size > 0) break;
			const first = this.member(t, distinct.size > 0);
			if (!this.eat(MINUS)) {
				this.add(members, distinct, first);
				continue;
			}
			const u = this.token();
			if (u === END) invalid();
			if (u === RBRACKET) {
				this.add(members, distinct, first);
				this.add(members, distinct, { cp: MINUS });
				break;
			}
			if (u === MINUS) unsupported('a set operation');
			const second = this.member(u, false);
			if (!('cp' in first) || !('cp' in second) || second.cp < first.cp) invalid();
			members.spans.push(first.cp, second.cp);
			distinct.add(`${first.cp}-${second.cp}`);
		}
		const single = distinct.size === 1 && members.literals.length > 0;
		const beyondBmp =
			members.literals.some((cp) => cp > 0xffff) || members.spans.some((cp) => cp > 0xffff);
		if (this.flags.i && !single && beyondBmp) unsupported('a set past U+FFFF under (?i)');
		return unit(setSource(memberSet(members, negate, this.flags.i)));
	}

	private add(members: Members, distinct: Set<string>, member: Member): void {
		if ('cp' in member) {
			members.literals.push(member.cp);
			distinct.add(`${member.cp}`);
		} else {
			members.categories.push(member.category);
			distinct.add(`c${members.categories.length}`);
		}
	}

	private member(t: number, nonEmpty: boolean): Member {
		if (t >= ESCAPED) return this.classEscape(t - ESCAPED);
		if (t === LBRACKET) unsupported('a nested set');
		if (nonEmpty && SET_OPERATORS.has(t) && this.peek() === t) unsupported('a set operation');
		return { cp: t };
	}

	private classEscape(c: number): Member {
		const simple = CLASS_ESCAPES.get(c);
		if (simple !== undefined) return { cp: simple };
		if (CATEGORY_LETTERS.has(c)) return { category: category(c) };
		if (c === ch('x') || c === ch('u') || c === ch('U')) return this.classCp(this.hex(c));
		if (c === ch('N')) unsupported('a named character escape');
		if (isOctal(c)) {
			const value = this.octal(c);
			if (value > 0o377) invalid();
			return { cp: value };
		}
		if (isDigit(c) || isAsciiLetter(c)) invalid();
		return { cp: c };
	}

	private classCp(cp: number): Member {
		if (isSurrogate(cp)) unsupported('a surrogate code point');
		return { cp };
	}
}

function translate(pattern: string, mode: 'search' | 'fullmatch'): PyRegex {
	const cps = Array.from(pattern, ch);
	if (cps.some(isSurrogate)) return { kind: 'unsupported', reason: 'a lone surrogate' };
	let trailing = 0;
	while (trailing < cps.length && cps[cps.length - 1 - trailing] === BACKSLASH) trailing++;
	if (trailing % 2 === 1) return { kind: 'invalid' };
	let body: string;
	try {
		body = new Parser(cps).parse();
	} catch (error) {
		if (error instanceof Refusal) return error.answer;
		throw error;
	}
	// V8 also tries a `u` search between the halves of a surrogate pair, where
	// every look-around sees no neighbour. Anchored natively, a match starts at
	// the text's start and moves a code point at a time, so the body only ever
	// stands on code point boundaries.
	const source = mode === 'fullmatch' ? `^(?:${body})$` : `^[\\s\\S]*?(?:${body})`;
	let compiled: RegExp;
	try {
		compiled = new RegExp(source, 'u');
	} catch {
		return { kind: 'unsupported', reason: 'the translation does not compile' };
	}
	return { kind: 'ok', test: (subject) => compiled.test(subject) };
}

const memo = new Map<string, PyRegex>();

/**
 * What the host cannot run although Python can: a pattern nested past the
 * translator's stack or a subject past the translated `RegExp`'s backtracking
 * stack (a `RangeError`), and a translation V8 will not compile (a
 * `SyntaxError`, thrown on first run, since V8 compiles lazily and apart for
 * one-byte and two-byte subjects). Nothing else: any other error is a bug.
 */
export function beyondHost(error: unknown): boolean {
	return (
		error instanceof RangeError ||
		(error instanceof SyntaxError && error.message.endsWith('Regular expression too large'))
	);
}

/** `re.search` / `re.fullmatch` of `pattern` as a JavaScript test, `invalid`
 * where `re` refuses the pattern, or `unsupported` where the translation
 * cannot vouch for Python's answer. Memoized per pattern and mode. */
export function translatePyRegex(pattern: string, mode: 'search' | 'fullmatch'): PyRegex {
	const key = `${mode}:${pattern}`;
	const known = memo.get(key);
	if (known !== undefined) {
		memo.delete(key);
		memo.set(key, known);
		return known;
	}
	const answer = translate(pattern, mode);
	if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!);
	memo.set(key, answer);
	return answer;
}
