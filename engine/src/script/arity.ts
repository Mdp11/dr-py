/**
 * Positional-parameter count of a snippet's top-level `def <name>`, read
 * without a Python parser. Answers what the oracle's `entry_arity` answers for
 * code that parses: the count of positional-only and ordinary parameters of the
 * first top-level plain `def` of that name (`async def` is not one), `null`
 * when there is none.
 *
 * Strings (every prefix, nested f-string expressions), comments, bracket depth
 * and backslash continuations are tracked so a `def` only counts at column 0 of
 * a logical line. Syntax errors the scan can see (unterminated strings,
 * unbalanced or mismatched brackets, an unclosed signature) answer `null` as
 * the oracle does. A file that does not parse for any other reason may be
 * answered differently; the call itself then fails with the guest's `syntax`
 * error.
 */

const IDENT = /[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/uy;
const DEF = /def[ \t\f]+([\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*)/uy;
const STRING_PREFIX = /^(?:[rRbBuU]|[bB][rR]|[rR][bB]|[fFtT]|[fFtT][rR]|[rR][fFtT])$/;
const CLOSER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const isNewline = (c: string | undefined): boolean => c === '\n' || c === '\r';
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\f';

function endOfLine(code: string, i: number): number {
	while (i < code.length && !isNewline(code[i])) i++;
	return i;
}

/** Index after the string whose opening quote is at `i`, or -1 when unterminated. */
function skipString(code: string, i: number, formatted: boolean): number {
	const quote = code[i]!;
	const triple = code.startsWith(quote.repeat(3), i);
	i += triple ? 3 : 1;
	for (;;) {
		if (i >= code.length) return -1;
		const c = code[i]!;
		if (c === '\\') {
			i += code[i + 1] === '\r' && code[i + 2] === '\n' ? 3 : 2;
		} else if (c === quote) {
			if (!triple) return i + 1;
			if (code.startsWith(quote.repeat(3), i)) return i + 3;
			i++;
		} else if (isNewline(c) && !triple) {
			return -1;
		} else if (formatted && c === '{') {
			if (code[i + 1] === '{') {
				i += 2;
				continue;
			}
			i = skipBracketed(code, i);
			if (i < 0) return -1;
		} else {
			i++;
		}
	}
}

/** Index after the balanced `{...}`, `(...)` or `[...]` starting at `i`, or -1. */
function skipBracketed(code: string, i: number): number {
	let depth = 0;
	while (i < code.length) {
		const c = code[i]!;
		if (c === '{' || c === '(' || c === '[') {
			depth++;
			i++;
		} else if (c === '}' || c === ')' || c === ']') {
			depth--;
			i++;
			if (depth === 0) return i;
		} else if (c === "'" || c === '"') {
			i = skipString(code, i, false);
			if (i < 0) return -1;
		} else {
			i++;
		}
	}
	return -1;
}

/**
 * Skips a string (with its prefix), comment or identifier starting at `i`.
 * Returns the index after it, -1 for an unterminated string, or `null` when `i`
 * starts none of them.
 */
function skipAtom(code: string, i: number): number | null {
	const c = code[i]!;
	if (c === '#') return endOfLine(code, i);
	if (c === "'" || c === '"') return skipString(code, i, false);
	IDENT.lastIndex = i;
	const m = IDENT.exec(code);
	if (m === null) return null;
	const end = i + m[0].length;
	const next = code[end];
	if ((next === "'" || next === '"') && STRING_PREFIX.test(m[0])) {
		return skipString(code, end, /[fFtT]/.test(m[0]));
	}
	return end;
}

/** Parameters of the signature whose `(` is at `open`: [count, index after `)`], or null. */
function parseParams(code: string, open: number): [number, number] | null {
	let i = open + 1;
	const stack: string[] = ['('];
	let count = 0;
	let atStart = true;
	let stopped = false;
	let lambdas = 0;
	while (i < code.length) {
		const c = code[i]!;
		if (isBlank(c) || isNewline(c)) {
			i++;
			continue;
		}
		if (c === '\\') {
			i += 2;
			continue;
		}
		const atom = skipAtom(code, i);
		if (atom !== null) {
			if (atom < 0) return null;
			if (c !== '#') {
				if (stack.length === 1) {
					if (atStart && !stopped && /^[\p{L}\p{Nl}_]/u.test(code.slice(i, atom))) count++;
					else if (code.slice(i, atom) === 'lambda') lambdas++;
				}
				atStart = false;
			}
			i = atom;
			continue;
		}
		if (c === '(' || c === '[' || c === '{') {
			stack.push(c);
		} else if (c === ')' || c === ']' || c === '}') {
			if (stack.pop() !== CLOSER[c]) return null;
			if (stack.length === 0) return [count, i + 1];
		} else if (stack.length === 1) {
			if (c === ',' && lambdas === 0) {
				atStart = true;
				i++;
				continue;
			}
			if (c === ':' && lambdas > 0) lambdas--;
			else if (c === '*' && atStart) stopped = true;
		}
		atStart = false;
		i++;
	}
	return null;
}

/**
 * The parameter counts of every column-0 `def name(...)`, in source order; `[]` when there is none
 * and `null` when the code is unreadable.
 */
export function entryArities(code: string, name = 'value'): number[] | null {
	const wanted = name.normalize('NFKC');
	const found: number[] = [];
	const stack: string[] = [];
	let lineStart = true;
	let i = 0;
	while (i < code.length) {
		const c = code[i]!;
		if (isNewline(c)) {
			i += c === '\r' && code[i + 1] === '\n' ? 2 : 1;
			lineStart = stack.length === 0;
			continue;
		}
		if (c === '\\') {
			const n = code[i + 1];
			i += n === '\r' && code[i + 2] === '\n' ? 3 : 2;
			lineStart = false;
			continue;
		}
		if (lineStart) {
			DEF.lastIndex = i;
			const m = DEF.exec(code);
			if (m !== null && m[1]!.normalize('NFKC') === wanted) {
				let at = i + m[0].length;
				while (isBlank(code[at])) at++;
				if (code[at] === '[') {
					at = skipBracketed(code, at);
					if (at < 0) return null;
					while (isBlank(code[at])) at++;
				}
				if (code[at] !== '(') return null;
				const params = parseParams(code, at);
				if (params === null) return null;
				found.push(params[0]);
				i = params[1];
				lineStart = false;
				continue;
			}
		}
		lineStart = false;
		const atom = skipAtom(code, i);
		if (atom !== null) {
			if (atom < 0) return null;
			i = atom;
			continue;
		}
		if (c === '(' || c === '[' || c === '{') {
			stack.push(c);
		} else if (c === ')' || c === ']' || c === '}') {
			if (stack.pop() !== CLOSER[c]) return null;
		}
		i++;
	}
	return stack.length === 0 ? found : null;
}

/** Parameter count of the first column-0 `def name(...)`; `null` when absent or unreadable. */
export function entryArity(code: string, name = 'value'): number | null {
	return entryArities(code, name)?.[0] ?? null;
}
