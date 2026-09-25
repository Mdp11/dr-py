# Engine Snapshot: Snapshot Reader, State Digest and Benchmarks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish sub-project A: the engine computes the state digest with a synchronous SHA-256 of its own, opens a `datarover.snapshot/v2` text from inflated bytes into an indexed replica standing at the header's `rev` and digest, and is measured at model M against CN-3 — open within 3 s, reported next to opening the same model as one document in the same pass — with the documents that close the sub-project.

**Architecture:** Plan 4 of 4 for sub-project A (`architecture/program.md`). The engine gains `src/snapshot/`: `sha256.ts` (FIPS 180-4 in plain TypeScript), `digest.ts` (`entityHash`, `modelDigest`, `formatDigest` — from now on `WorkingCopy`'s default hash, and `WorkingCopy` gains `verifyDigest()`), `lines.ts` (a splitter on LF alone), `utf8.ts` (the host's `TextDecoder`, looked up, not declared) and `open.ts` (`openSnapshot`). No file under `src/` changes on the Python side: the golden scenario `snapshot_v2` grows the texts the server reads alike and the texts it refuses, and `scripts/snapshot_v2.py` writes the benchmark's input. `engine/bench/run.ts` measures; two pixi tasks run it.

**Tech Stack:** Python 3.14 (pytest, ruff); TypeScript 6 (strict, erasable syntax only), vitest 3, eslint 10, prettier 3, Node 22 running the TypeScript sources unbuilt; pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-18-engine-foundation-design.md` — §7 Snapshot and digest, §9 Tests and benchmarks, §11 Done when; §1 for the package rules. Read `architecture/README.md`, `architecture/contracts.md` (CT-1, CT-3), `architecture/constraints.md` (CN-3, CN-5), `architecture/decisions.md` (AD-11, AD-12), `architecture/program.md` (MR-3) and `architecture/conventions.md` first. Plan 3 (`docs/superpowers/plans/2026-09-18-engine-ops.md`) built the working copy this plan hands a snapshot to.

**Provenance:** every code block below was built and run before this plan was written, in a scratch copy of `98387a7` against the real Python core and the repository's own pixi environments; the blocks were then generated from those files, not retyped, and the partial edits are the exact strings a script applied. The tasks were replayed in order in a second clean copy: each failing step failed as stated, each passing step passed, `tsc` (both projects), eslint, prettier and ruff were clean at every task boundary, and the final tree was identical to the scratch copy. End state: 266 engine tests in 38 files, 2,429 Python tests (34 deselected), fixtures current; one fixture changed, `snapshot_v2.json`, now 20 KB. The benchmark ran at model M on the reference PC: open 2.30 s of CN-3's 3 s, against 3.14 s for the same model as one document in the same pass, and 231 MB of heap for one open replica, of 400. The tests were also seen to bite: an `entityHash` that reads its buffer before writing to it, or a padding boundary off by one, fails the hash tests; a `verifyDigest` that skips the committed images fails 2 working-copy tests; a line count checked after the last batch is parsed fails `cut inside a line`; a splitter that also cuts on U+2028 fails 7 tests, a decoder that does not stream 8, one that writes replacement characters, one that strips the byte order mark and a `parseLines` without its guard 1 or 2 each. If a step's expected result does not appear, suspect the environment before the code.

## What the oracle taught this plan

Each of these refines the spec; the spec file was updated to match. Review them before executing.

1. **The server's reader is more forgiving than the writer's rule.** CT-1 has every line end with LF. `decode_snapshot` also reads a text whose last line lacks its LF, and one with CRLF line ends — the CR stays on the line, where JSON reads it as white space — to the same document. `openSnapshot` reads both; the fixture lists them under `same`.
2. **A cut text is refused by its length before anything in it is parsed.** `_decode_v2` counts the lines, then parses them, so a text cut inside a line answers `snapshot v2 holds 8 entity lines, its header promises 6 + 3`, never a JSON error. A reader that parses lines as they arrive would meet the half line first. `openSnapshot` therefore counts every line, keeps the last batch unparsed until the input ends, and checks the count before parsing it; a line past the promised count is counted and not parsed. The fixture holds a text cut after a line and one cut inside a line under `refused`, and the engine gives the server's words for both at every piece size.
3. **The server's decoder never looks at `rev`, `state_digest`, `project_id` or `metamodel_id`** — it returns a document and has no use for them. The engine adopts the first two, so it refuses a header without a non-negative integer `rev`, a digest of sixteen lower-case hex digits, or the two ids as text, in words of its own. It also has its own words, `not a datarover.snapshot/v2 snapshot`, for whatever does not start with `{"format":"datarover.snapshot/v2"` — a v1 document, another format, a header written with spaces, a byte order mark — where the server falls through to its v1 reader and fails in the JSON parser's (`Extra data: line 2 column 1`). The engine says so at the first bytes: a v1 document is one endless line, and nothing may buffer 77 MB of it looking for an LF.
4. **The join trick lets a line with two documents through, on both sides.** The server parses `[` + the lines joined by `,` + `]`; the engine's `parseLines` does the same for the lines the native parser can take. Observed on the core: eight lines holding nine documents under a header promising 6 + 2 load as 6 + 3, no complaint. In the engine the trick was worse than lenient — `parseLines` would have mapped the parsed documents onto the lines by position and silently dropped the last one. `parseLines` now refuses a batch that parses to another count than it has lines, and the reader names the line. Stricter than the oracle on purpose, like an id shared across the two kinds; no fixture holds it.
5. **A count past 2^53 is a count to the server** (`"elements":9223372036854775808` → the line-count refusal, with that number in it). To the engine it is a `bigint`, and no valid count. Both refuse; the words differ. A documented gap, like `Multiplicity.parse` and non-ASCII digits.
6. **`TextDecoder` is looked up, not declared.** The spec had one ambient file declare it. Built both ways: as a `.ts` the declaration fails the test project with `TS2300: Duplicate identifier 'TextDecoder'` against `@types/node`; as a `.d.ts` it passes only because `skipLibCheck` stops looking — and sub-project B compiles these sources under the frontend's DOM typings, where it would collide the same way. `src/snapshot/utf8.ts` reads the constructor off `globalThis` through a type of its own, in one place. Decoding is `fatal` — a replacement character would be invisible to a digest that covers only ids and `rev`s, and the server raises `UnicodeDecodeError` on the same bytes — and keeps a byte order mark, so that it fails the format check as it does on the server. The hash needs UTF-8 too and writes it by hand: an id is short, and a fixed buffer beats an allocation per entity.
7. **`verifyDigest()` reads committed state, which the model alone does not hold.** Staged batches are applied in place, so the model carries bumped `rev`s, temp ids and holes. The recomputation folds the model's entities except those with a committed image, then the images that are not `null`. It sets `diverged` on a mismatch and returns the verdict; `openSnapshot` adopts the header's digest without checking it, as CT-3 has it, and leaves the check to the caller's timing.
8. **The golden runner now hashes with the engine.** `observe()` computes every step's digest with `modelDigest`, so each of the fixtures' steps holds the engine's SHA-256 to `hashlib`. `engine/test/golden/digest.ts` (`node:crypto`) stays as the second opinion: the working-copy tests fold with the engine's hash and are held to digests the reference computed.
9. **An argument is evaluated before the call that replaces it.** `sha256Words(message, write(id, rev), state)` reads `message` before `write` swaps in a larger buffer, so an id past 85 letters would hash the old one. `entityHash` writes first, in a statement of its own; the test of ids of every width has ids of 90 to 390 letters, and Task 1 sees it bite.
10. **What the benchmark found** (model M, Node 22, medians of three passes taken in one run; CN-5 applies to every number): the snapshot opens in 2.30 s — 1.73 s to decode, split, parse and load, 0.52 s to index — and the same model as one document in 3.14 s, 2.26 s of it the exact parse: the line format is worth 0.8 s, and CN-3 holds with a quarter to spare. Neither the batch size (250 to 16,000 lines) nor the piece size (4 KiB to 1 MiB) moves the open time out of 2.1–2.4 s, so 2,000 lines it is, and nothing was tuned. One open replica holds 231 MB of heap, of 400. A first reading of 305 MB was the benchmark's own doing: V8 keeps the last text a regular expression ran over reachable, and after the one-document pass that is 77 MB of document — so the heap is weighed before the document is read. A suspicion that exact-parsed strings keep their 64 KiB piece alive as slices was tested by copying every such line first: 224 MB against 223, refuted. Checking the digest takes 0.2 s; a 1,000-op batch stages in 44 ms and unstages in 39 ms; 100 staged batches rebase over a delta in 14 ms; a delta of 149 entities applies in 8.9 ms. Three things outlast one 16 ms chunk — the index build, the digest check, and the re-sort of an entity map after a rewind restored an old `ord` (58 ms against 2 ms for a plain pass). None matters in Node; all three are logged for sub-project B as `K-32`. Nothing was optimized.
11. **No block of this plan holds a 4-digit unicode escape**, which tooling may decode on the way to disk. TypeScript sources use the braced form. `tests/golden/scenarios/snapshot_v2.py` does hold some, in its element table, since plan 2 — which is why Task 2 edits that file in three places and never shows it whole. The blocks can be typed or extracted alike; the ASCII check still applies.

## Global Constraints

- Everything runs through pixi. There is no global `python` or `node`: use `pixi run <task>`, `pixi run -e core-dev ...`, `pixi run -e frontend ...`. The system `node` is too old for the tooling.
- Work on branch `feat/engine-snapshot`, cut from `engine-migration` (Task 1 cuts it) and fast-forwarded back into it when the plan is done (Task 4). Do not touch `main`.
- **Freeze rule (MR-3):** no behaviour change in `src/data_rover/core/model`, `src/data_rover/core/metamodel` or the model-op applier (`routes/ops.py`). This plan changes no file under `src/`. If the port exposes an oracle bug, stop and raise it: a fix lands on both sides with a fixture, never on one.
- The Python core is the oracle. When a golden test fails, the engine is wrong — never edit a fixture by hand, never loosen a scenario to make a test pass. Fixtures change only through `pixi run golden-fixtures`. Server writers keep emitting snapshot v1; this plan only READS v2 in the engine.
- `engine/src/` uses no DOM API and no Node built-in (`lib: ["ES2023"]`, `types: []`). Tests and `engine/bench/` may import `node:*`.
- TypeScript is erasable syntax only: no parameter properties, no enums, no namespaces. Import specifiers end in `.ts`. No `any` in an exported signature. No `Date.now`, `Math.random`, `Intl` or locale comparison in `src/`.
- SHA-256 is plain TypeScript, not WebCrypto: the digest fold is synchronous. A linear checksum MUST NOT replace it (CT-3).
- Anything observable sorts by code point (`cmpCodePoint`), never with a bare `.sort()` on text that may hold non-ASCII.
- Performance: this plan measures. It optimizes nothing unless the open budget of CN-3 is missed, and then only after raising it with the owner.
- Formatting: tabs, single quotes, no trailing commas, width 100 (prettier, run through `pixi run engine-tidy`); Python is ruff-formatted. `pixi run dr-tidy` lints neither `tests/` nor `scripts/`: run ruff on them by hand, as the steps say.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- Check with `LC_ALL=C grep -rnP --include='*.py' --include='*.ts' '[^[:ascii:]]' tests/golden engine/test`: only `café` in `engine/test/value/serialize.test.ts` may show.
- `architecture/` is tracked and changes in the same commit as the code it describes; `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; end the message with the session's `Co-Authored-By` line.
- A bite-check step breaks a source on purpose. Put it back, see the full count again, and never commit a mutation.

## File Structure

```
tests/golden/scenarios/snapshot_v2.py     + the texts the server reads alike, the texts it refuses
scripts/snapshot_v2.py                    a model file as the inflated v2 text the bench opens

engine/src/snapshot/sha256.ts             sha256, sha256Words
engine/src/snapshot/digest.ts             EntityHash, entityHash, formatDigest, modelDigest
engine/src/snapshot/lines.ts              LineSplitter
engine/src/snapshot/utf8.ts               utf8Decoder: the host's TextDecoder, looked up
engine/src/snapshot/open.ts               openSnapshot, SnapshotHeader, OpenedSnapshot
engine/src/working/working-copy.ts        entityHash optional, verifyDigest()
engine/src/value/parse.ts                 parseLines refuses a line of two documents
engine/src/index.ts                       the new exports

engine/test/snapshot/sha256.test.ts       FIPS vectors, every padding length
engine/test/snapshot/digest.test.ts       the server's vectors, the reference hash, surrogates
engine/test/snapshot/lines.test.ts        the splitter
engine/test/snapshot/text.ts              utf8, cut, trickle, headerLine, snapshotText, refusal
engine/test/snapshot/open.golden.test.ts  the oracle's snapshot, its variants, its refusals; smart-city
engine/test/snapshot/open.test.ts         progress, what is not v2, what cannot be read
engine/test/golden/model-steps.ts         observe() hashes with the engine
engine/test/working/*.ts                  the default hash; verifyDigest
engine/bench/run.ts                       the engine at model M
engine/fixtures/golden/snapshot_v2.json   generated — never edited by hand
pixi.toml, engine/package.json, engine/tsconfig.test.json   engine-bench, engine-bench-data
```

---

### Task 1: The engine's own SHA-256 and state digest

CT-3's hash is the first 8 bytes of SHA-256 over `utf8(id) ‖ 0x00 ‖ ascii(decimal rev)`, folded with XOR. The engine has injected `node:crypto`'s until now; this task writes the hash in plain TypeScript, holds it to the FIPS vectors, to the server's own vectors (`tests/api/test_state_digest.py`) and to the reference on ids of every width, then makes it `WorkingCopy`'s default and adds `verifyDigest()` (findings 7, 8, 9).

**Files:**
- Create: `engine/src/snapshot/sha256.ts`, `engine/src/snapshot/digest.ts`
- Modify: `engine/src/index.ts`, `engine/src/working/working-copy.ts`
- Modify: `engine/test/golden/model-steps.ts`, `engine/test/working/helpers.ts`, `engine/test/working/replica.golden.test.ts`, `engine/test/working/working-copy.test.ts`
- Test: `engine/test/snapshot/sha256.test.ts`, `engine/test/snapshot/digest.test.ts`

**Interfaces:**
- Consumes: `Model.elements()` / `relationships()`, `WorkingCopy` and its `committedElements` / `committedRelationships` images (plan 3); `entityHash` / `stateDigest` of `engine/test/golden/digest.ts` as the reference.
- Produces:
  - `sha256(data: Uint8Array): Uint8Array` (32 bytes); `sha256Words(data: Uint8Array, length: number, state: Int32Array): void` (from `snapshot/sha256.ts`, not from the package index).
  - `type EntityHash = (id: string, rev: number) => bigint` — now exported from `snapshot/digest.ts`; the package index keeps the name.
  - `entityHash(id: string, rev: number): bigint`, `formatDigest(value: bigint): string`, `modelDigest(model: Model): string`.
  - `type WorkingCopyOptions = { entityHash?: EntityHash }`; `new WorkingCopy(model, committed, options = {})`; `WorkingCopy.verifyDigest(): boolean`.

- [ ] **Step 1: Cut the branch**

```bash
git switch engine-migration
git switch -c feat/engine-snapshot
```

- [ ] **Step 2: Write the failing tests of the hash**

`engine/test/snapshot/sha256.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha256 } from '../../src/snapshot/sha256.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const ascii = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));

it('hashes the FIPS 180-4 example messages', () => {
	const vectors: [string, string][] = [
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		[
			'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
		],
		[
			'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
				'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
			'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
		]
	];
	for (const [message, expected] of vectors) expect(hex(sha256(ascii(message)))).toBe(expected);
});

it('hashes a million letters', () => {
	const expected = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
	expect(hex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(expected);
});

it('pads every length around the block boundaries as the reference does', () => {
	for (let length = 0; length <= 200; length++) {
		const data = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
		expect(hex(sha256(data)), `length ${length}`).toBe(
			createHash('sha256').update(data).digest('hex')
		);
	}
});

it('leaves its input alone and keeps no state between calls', () => {
	const data = ascii('abc');
	const first = hex(sha256(data));
	sha256(new Uint8Array(100).fill(7));
	expect(hex(sha256(data))).toBe(first);
	expect(data).toEqual(ascii('abc'));
});
```

`engine/test/snapshot/digest.test.ts`:

```ts
import { expect, it } from 'vitest';
import { entityHash, formatDigest, Model, modelDigest } from '../../src/index.ts';
import { entityHash as referenceHash, stateDigest } from '../golden/digest.ts';
import { seededRandom } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

it("reproduces the server's entity hashes", () => {
	// The vectors of tests/api/test_state_digest.py.
	const vectors: [string, number, string][] = [
		['id-1', 0, 'b83d885159d11dd4'],
		['id-1', 1, '14d07545607c068e'],
		['', 0, 'db3426e878068d28'],
		['caf\u{e9}', 12, 'c9524fe14dc453b5'],
		['\u{1f600}', 3, '7907ed2f4cfeac90']
	];
	for (const [id, rev, expected] of vectors) {
		expect(formatDigest(entityHash(id, rev)), JSON.stringify(id)).toBe(expected);
	}
});

it('agrees with the reference hash on ids of every width and length', () => {
	const random = seededRandom(7);
	const alphabet = ['a', 'Z', '0', '-', '\u{e9}', '\u{3a9}', '\u{20ac}', '\u{2028}', '\u{1f600}'];
	for (let round = 0; round < 400; round++) {
		// Past 85 letters the message buffer grows; past 55 bytes the hash takes a second block.
		const length = round % 8 === 0 ? 90 + Math.floor(random() * 300) : Math.floor(random() * 60);
		let id = '';
		for (let i = 0; i < length; i++) id += alphabet[Math.floor(random() * alphabet.length)];
		const rev = Math.floor(random() * 2 ** (round % 41));
		expect(entityHash(id, rev), `${JSON.stringify(id)} @ ${rev}`).toBe(referenceHash(id, rev));
	}
});

it('writes a lone surrogate as U+FFFD, as TextEncoder does', () => {
	expect(entityHash('a\u{d800}b', 1)).toBe(entityHash('a\u{fffd}b', 1));
	expect(entityHash('\u{dc00}', 1)).toBe(referenceHash('\u{dc00}', 1));
	expect(entityHash('\u{d83d}', 1)).toBe(referenceHash('\u{d83d}', 1));
});

it('formats a digest as sixteen lower-case hex digits', () => {
	expect(formatDigest(0n)).toBe('0000000000000000');
	expect(formatDigest(0xabn)).toBe('00000000000000ab');
	expect(formatDigest(2n ** 64n - 1n)).toBe('ffffffffffffffff');
});

it('folds every element and relationship of a model, in any order', () => {
	expect(modelDigest(new Model(nodeMetamodel()))).toBe('0000000000000000');
	const model = family();
	expect(modelDigest(model)).toBe(stateDigest(model));
	let value = 0n;
	for (const rel of [...model.relationships()].reverse()) value ^= entityHash(rel.id, rel.rev);
	for (const element of [...model.elements()].reverse()) {
		value ^= entityHash(element.id, element.rev);
	}
	expect(formatDigest(value)).toBe(modelDigest(model));
});

it('sees two ids exchanging their revs', () => {
	expect(entityHash('a', 2) ^ entityHash('b', 10)).not.toBe(
		entityHash('a', 10) ^ entityHash('b', 2)
	);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/snapshot"`
Expected: FAIL — both files: `test/snapshot/sha256.test.ts` cannot load `../../src/snapshot/sha256.ts`, and the 6 tests of `test/snapshot/digest.test.ts` fail with `entityHash is not a function` (`formatDigest`, `modelDigest`).

- [ ] **Step 4: Write the hash and the digest**

`engine/src/snapshot/sha256.ts`:

```ts
// SHA-256 (FIPS 180-4), synchronous: the digest fold cannot wait for WebCrypto.

const K = new Int32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const INITIAL = new Int32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const W = new Int32Array(64);
// The last, partial block of a message with its padding: one block, or two.
const TAIL = new Uint8Array(128);

function compress(state: Int32Array, data: Uint8Array, offset: number): void {
	for (let i = 0; i < 16; i++) {
		const j = offset + 4 * i;
		W[i] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!;
	}
	for (let i = 16; i < 64; i++) {
		const x = W[i - 15]!;
		const y = W[i - 2]!;
		const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
		const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
		W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
	}
	let a = state[0]!;
	let b = state[1]!;
	let c = state[2]!;
	let d = state[3]!;
	let e = state[4]!;
	let f = state[5]!;
	let g = state[6]!;
	let h = state[7]!;
	for (let i = 0; i < 64; i++) {
		const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
		const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i]! + W[i]!) | 0;
		const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
		const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
		h = g;
		g = f;
		f = e;
		e = (d + t1) | 0;
		d = c;
		c = b;
		b = a;
		a = (t1 + t2) | 0;
	}
	state[0] = (state[0]! + a) | 0;
	state[1] = (state[1]! + b) | 0;
	state[2] = (state[2]! + c) | 0;
	state[3] = (state[3]! + d) | 0;
	state[4] = (state[4]! + e) | 0;
	state[5] = (state[5]! + f) | 0;
	state[6] = (state[6]! + g) | 0;
	state[7] = (state[7]! + h) | 0;
}

/** Hashes the first `length` bytes of `data` into `state`: the digest as eight 32-bit words. */
export function sha256Words(data: Uint8Array, length: number, state: Int32Array): void {
	state.set(INITIAL);
	const whole = length - (length % 64);
	for (let offset = 0; offset < whole; offset += 64) compress(state, data, offset);
	const rest = length - whole;
	TAIL.fill(0);
	TAIL.set(data.subarray(whole, length));
	TAIL[rest] = 0x80;
	const end = rest < 56 ? 64 : 128;
	// The message length in bits, big-endian, in the last eight bytes.
	const high = Math.floor(length / 0x20000000);
	const low = (length % 0x20000000) * 8;
	for (let i = 0; i < 4; i++) {
		TAIL[end - 8 + i] = (high >>> (24 - 8 * i)) & 0xff;
		TAIL[end - 4 + i] = (low >>> (24 - 8 * i)) & 0xff;
	}
	compress(state, TAIL, 0);
	if (end === 128) compress(state, TAIL, 64);
}

/** The SHA-256 digest of `data`: 32 bytes. */
export function sha256(data: Uint8Array): Uint8Array {
	const state = new Int32Array(8);
	sha256Words(data, data.length, state);
	const out = new Uint8Array(32);
	for (let i = 0; i < 8; i++) {
		const word = state[i]!;
		out[4 * i] = word >>> 24;
		out[4 * i + 1] = (word >>> 16) & 0xff;
		out[4 * i + 2] = (word >>> 8) & 0xff;
		out[4 * i + 3] = word & 0xff;
	}
	return out;
}
```

`engine/src/snapshot/digest.ts`:

```ts
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
```

In `engine/src/index.ts`, replace:

```ts
export { cmpCodePoint } from './value/compare.ts';
```

with:

```ts
export { entityHash, formatDigest, modelDigest, type EntityHash } from './snapshot/digest.ts';
export { sha256 } from './snapshot/sha256.ts';
export { cmpCodePoint } from './value/compare.ts';
```

In `engine/src/index.ts`, replace:

```ts
	type DeltaStatus,
	type EntityHash,
```

with:

```ts
	type DeltaStatus,
```

In `engine/src/working/working-copy.ts`, replace:

```ts
import type { ModelOp } from '../ops/types.ts';
import { readDelta, type CommittedChange, type Delta } from './delta.ts';

/** The 64-bit hash of one `(id, rev)` pair that the state digest folds with XOR. */
export type EntityHash = (id: string, rev: number) => bigint;

export type WorkingCopyOptions = { entityHash: EntityHash };
```

with:

```ts
import type { ModelOp } from '../ops/types.ts';
import type { EntityHash } from '../snapshot/digest.ts';
import { readDelta, type CommittedChange, type Delta } from './delta.ts';

export type WorkingCopyOptions = { entityHash: EntityHash };
```

- [ ] **Step 5: Run the tests**

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/snapshot"`
Expected: PASS — 10 tests in 2 files.

Run: `pixi run engine-test`
Expected: PASS — 219 tests in 36 files.

- [ ] **Step 6: Write the failing tests of the default hash and of `verifyDigest`**

The helpers stop injecting the reference hash, so every working-copy test folds with the engine's own while the digests it is held to still come from the reference; the golden runner's `observe()` hashes with the engine, so every fixture step holds it to `hashlib`.

In `engine/test/working/helpers.ts`, replace:

```ts
import { entityHash, stateDigest } from '../golden/digest.ts';
```

with:

```ts
import { stateDigest } from '../golden/digest.ts';
```

In `engine/test/working/helpers.ts`, replace:

```ts
export const workingCopy = (model: Model, rev = 0) =>
	new WorkingCopy(model, { rev, digest: stateDigest(model) }, { entityHash });
```

with:

```ts
/** Folds with the engine's own hash, while every digest it is held to comes from the reference one. */
export const workingCopy = (model: Model, rev = 0) =>
	new WorkingCopy(model, { rev, digest: stateDigest(model) });
```

In `engine/test/working/replica.golden.test.ts`, delete the line:

```ts
import { entityHash } from '../golden/digest.ts';
```

In `engine/test/working/replica.golden.test.ts`, replace:

```ts
	const replica = new WorkingCopy(model, { rev: 0, digest: '0'.repeat(16) }, { entityHash });
```

with:

```ts
	const replica = new WorkingCopy(model, { rev: 0, digest: '0'.repeat(16) });
```

In `engine/test/golden/model-steps.ts`, replace:

```ts
	ModelError,
	modelLines,
```

with:

```ts
	ModelError,
	modelDigest,
	modelLines,
```

In `engine/test/golden/model-steps.ts`, delete the line:

```ts
import { stateDigest } from './digest.ts';
```

In `engine/test/golden/model-steps.ts`, replace:

```ts
	return { digest: stateDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
```

with:

```ts
	return { digest: modelDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
```

In `engine/test/working/working-copy.test.ts`, replace:

```ts
	SnapshotError,
	verifyConsistent,
	type ModelOp
```

with:

```ts
	SnapshotError,
	verifyConsistent,
	WorkingCopy,
	type ModelOp
```

In `engine/test/working/working-copy.test.ts`, replace:

```ts
		expect([wc.rev, wc.diverged]).toEqual([0, false]);
	});
});
```

with:

```ts
		expect([wc.rev, wc.diverged]).toEqual([0, false]);
	});
});

describe('verifying the digest', () => {
	it('recomputes it from committed state, whatever is staged on top', () => {
		const wc = workingCopy(family());
		expect(wc.verifyDigest()).toBe(true);
		wc.stage([
			rename('a', 'mine'),
			node('tmp_e', 'E'),
			refers('tmp_r', 'tmp_e', 'c'),
			{ kind: 'delete_element', id: 'b' }
		]);
		expect(wc.verifyDigest()).toBe(true);
		expect(wc.diverged).toBe(false);
	});

	it('holds after a delta lands under staged work', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(committed);
		wc.stage([rename('c', 'mine'), { kind: 'delete_relationship', id: 'a-c' }]);
		wc.applyDelta(server.commit([rename('a', 'theirs'), node('tmp_x', 'X')]).delta);
		expect(wc.verifyDigest()).toBe(true);
		expect(wc.diverged).toBe(false);
	});

	it('fails, and sets diverged, when the replica does not hold what the digest names', () => {
		const model = family();
		const wrong = new WorkingCopy(model, { rev: 0, digest: '0'.repeat(16) });
		expect(wrong.verifyDigest()).toBe(false);
		expect(wrong.diverged).toBe(true);

		const wc = workingCopy(family());
		wc.model.setProperty(wc.model.getElement('d'), 'name', 'behind its back');
		expect(wc.verifyDigest()).toBe(false);
		expect(wc.diverged).toBe(true);
	});

	it('takes another hash when one is given', () => {
		const model = family();
		const count = model.elementCount + model.relationshipCount;
		let calls = 0;
		const wc = new WorkingCopy(
			model,
			{ rev: 0, digest: '0'.repeat(16) },
			{ entityHash: () => (calls++, 0n) }
		);
		expect(wc.verifyDigest()).toBe(true);
		expect(calls).toBe(count);
	});
});
```

- [ ] **Step 7: Run them to see them fail**

Run: `pixi run engine-test`
Expected: FAIL — 53 tests in 3 files, 170 pass: all 19 of `test/working/working-copy.test.ts`, the 2 of `replica.golden.test.ts` and the 32 of `invariants.test.ts`, with `Cannot read properties of undefined (reading 'entityHash')` — nobody passes options any more — and `wc.verifyDigest is not a function`.

- [ ] **Step 8: Give the working copy its default hash and `verifyDigest`**

In `engine/src/working/working-copy.ts`, replace:

```ts
import type { EntityHash } from '../snapshot/digest.ts';
```

with:

```ts
import { entityHash, formatDigest, type EntityHash } from '../snapshot/digest.ts';
```

In `engine/src/working/working-copy.ts`, replace:

```ts
export type WorkingCopyOptions = { entityHash: EntityHash };
```

with:

```ts
export type WorkingCopyOptions = {
	/** Replaces the `(id, rev)` hash of the state digest; tests check the engine's own against another. */
	entityHash?: EntityHash;
};
```

In `engine/src/working/working-copy.ts`, replace:

```ts
		options: WorkingCopyOptions
	) {
```

with:

```ts
		options: WorkingCopyOptions = {}
	) {
```

In `engine/src/working/working-copy.ts`, replace:

```ts
		this.entityHash = options.entityHash;
```

with:

```ts
		this.entityHash = options.entityHash ?? entityHash;
```

In `engine/src/working/working-copy.ts`, replace:

```ts
		return this.committedDigest.toString(16).padStart(16, '0');
```

with:

```ts
		return formatDigest(this.committedDigest);
```

In `engine/src/working/working-copy.ts`, replace:

```ts
	// -- staging -------------------------------------------------------------
```

with:

```ts
	/**
	 * Recomputes the state digest from every committed entity — the model's,
	 * with the committed image standing in wherever a staged batch has been —
	 * and compares it with the one held. A mismatch sets `diverged`.
	 */
	verifyDigest(): boolean {
		const hash = this.entityHash;
		let value = 0n;
		for (const element of this.model.elements()) {
			if (!this.committedElements.has(element.id)) value ^= hash(element.id, element.rev);
		}
		for (const rel of this.model.relationships()) {
			if (!this.committedRelationships.has(rel.id)) value ^= hash(rel.id, rel.rev);
		}
		for (const images of [this.committedElements, this.committedRelationships]) {
			for (const image of images.values()) {
				if (image !== null) value ^= hash(image.id, image.rev);
			}
		}
		if (value !== this.committedDigest) this.hasDiverged = true;
		return value === this.committedDigest;
	}

	// -- staging -------------------------------------------------------------
```

- [ ] **Step 9: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 223 tests in 36 files.

- [ ] **Step 10: See the tests bite**

In `engine/src/snapshot/digest.ts`, in `entityHash`, replace the two lines `const length = write(id, rev);` and `sha256Words(message, length, state);` with the one line `sha256Words(message, write(id, rev), state);` and run `pixi run engine-test`.
Expected: FAIL — 1 test of 223, `agrees with the reference hash on ids of every width and length` (finding 9). Put the two lines back.

In `engine/src/working/working-copy.ts`, in `verifyDigest`, replace the line `if (image !== null) value ^= hash(image.id, image.rev);` with `void image;` and run the suite again.
Expected: FAIL — 2 tests: `recomputes it from committed state, whatever is staged on top` and `holds after a delta lands under staged work`. Put the line back and see 223 pass.

- [ ] **Step 11: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

Run: `LC_ALL=C grep -rnP --include='*.py' --include='*.ts' '[^[:ascii:]]' tests/golden engine/test`
Expected: only the `café` line of `engine/test/value/serialize.test.ts`.

```bash
git add engine
git commit -m "Give the engine its own SHA-256 and state digest"
```

---

### Task 2: Open a snapshot

`openSnapshot` turns inflated bytes, cut anywhere, into an indexed replica at the header's `rev` and digest: decode, split on LF, read the header, parse and load 2,000 lines at a time, check the count, index. What it accepts and the words it refuses in are the server's wherever the server has any (findings 1–5); the oracle's side enters through the `snapshot_v2` fixture, which this task grows first.

**Files:**
- Modify: `tests/golden/scenarios/snapshot_v2.py`; generated: `engine/fixtures/golden/snapshot_v2.json`
- Create: `engine/src/snapshot/lines.ts`, `engine/src/snapshot/utf8.ts`, `engine/src/snapshot/open.ts`
- Modify: `engine/src/value/parse.ts`, `engine/src/index.ts`, `engine/test/value/parse.test.ts`
- Move: `engine/test/model/snapshot-v2.golden.test.ts` → `engine/test/snapshot/open.golden.test.ts` (whole file below)
- Test: `engine/test/snapshot/lines.test.ts`, `engine/test/snapshot/text.ts`, `engine/test/snapshot/open.test.ts`

**Interfaces:**
- Consumes: Task 1's `modelDigest`, `WorkingCopy` with its default hash and `verifyDigest()`; `Model.loadElement` / `loadRelationship` / `rebuildIndexes`, `SnapshotError`, `parseJson`, `parseLines`, `modelLines`, `pyDumps` (plans 1–2); `data_rover.api.snapshot_codec.decode_snapshot`, `encode_snapshot_v2`.
- Produces:
  - `openSnapshot(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, metamodel: Metamodel, onProgress?: OpenProgress, options?: OpenOptions): Promise<OpenedSnapshot>`; throws `SnapshotError`.
  - `type OpenedSnapshot = { header: SnapshotHeader; workingCopy: WorkingCopy }`; `type SnapshotHeader = { format; project_id; rev; metamodel_id; elements; relationships; state_digest }` (the wire's names); `type OpenProgress = (done: number, total: number) => void`; `type OpenOptions = ModelOptions & WorkingCopyOptions`; `SNAPSHOT_V2_FORMAT`.
  - `class LineSplitter { push(text: string): string[]; get pending(): string }`.
  - `utf8Decoder(): Utf8Decoder` (from `snapshot/utf8.ts`, not from the package index).
  - `parseLines` throws `SyntaxError` on a line holding more than one document.
  - The fixture `snapshot_v2` gains `same: [{name, text}]` and `refused: [{name, text, error}]`.
  - In tests (`test/snapshot/text.ts`): `utf8(text)`, `cut(bytes, size)`, `trickle(bytes, size)`, `headerLine(model, rev, changes?)`, `snapshotText(model, rev)`, `refusal(opening): Promise<string>`.

- [ ] **Step 1: Grow the scenario**

Three edits; the element table between them stays as it is (finding 11).

In `tests/golden/scenarios/snapshot_v2.py`, replace:

```python
"""A ``datarover.snapshot/v2`` text as the server encodes it (a header line,
then one line per entity) over values a careless reader would lose, with what
the oracle holds after reading it back."""

from __future__ import annotations

import gzip
from typing import Any
```

with:

```python
"""A ``datarover.snapshot/v2`` text as the server encodes it (a header line,
then one line per entity) over values a careless reader would lose, with what
the oracle holds after reading it back.

``same`` lists texts no writer emits that the oracle reads to the same
document; ``refused`` lists texts its decoder refuses in words of its own. A
text it refuses in the JSON parser's words, or accepts by accident, is left
out: the engine's reader answers for those alone."""

from __future__ import annotations

import gzip
import json
from typing import Any
```

In `tests/golden/scenarios/snapshot_v2.py`, replace:

```python
@scenario("snapshot_v2")
```

with:

```python
def _with_header(text: str, **changes: Any) -> str:
    """``text`` with keys of its header line replaced; ``None`` drops a key."""
    first, _, body = text.partition("\n")
    header = json.loads(first)
    for key, value in changes.items():
        if value is None:
            del header[key]
        else:
            header[key] = value
    return json.dumps(header, separators=(",", ":")) + "\n" + body


def _refusal(text: str) -> str:
    try:
        decode_snapshot(text.encode("utf-8"))
    except ValueError as exc:
        assert type(exc) is ValueError, "refused, but not in the decoder's own words"
        return str(exc)
    raise AssertionError("the oracle read a text this scenario expects it to refuse")


@scenario("snapshot_v2")
```

In `tests/golden/scenarios/snapshot_v2.py`, replace:

```python
    return {
        "metamodel": mm.model_dump(mode="json"),
        "text": gzip.decompress(blob).decode("utf-8"),
        **seen,
    }
```

with:

```python
    text = gzip.decompress(blob).decode("utf-8")
    last_line = text[text.rindex("\n", 0, -1) + 1 :]
    same = {
        "the last line without its LF": text[:-1],
        "CRLF line ends": text.replace("\n", "\r\n"),
    }
    for variant in same.values():
        assert decode_snapshot(variant.encode("utf-8")) == decode_snapshot(blob)
    refused = {
        "no element count": _with_header(text, elements=None),
        "a negative count": _with_header(text, relationships=-1),
        "a boolean count": _with_header(text, elements=True),
        "a float count": _with_header(text, elements=6.0),
        "a text count": _with_header(text, relationships="3"),
        "cut after a line": text[: -len(last_line)],
        "cut inside a line": text[: -len(last_line) // 2 - len(last_line)],
        "a line too many": text + last_line,
        "a second LF at the end": text + "\n",
    }
    return {
        "metamodel": mm.model_dump(mode="json"),
        "text": text,
        **seen,
        "same": [{"name": name, "text": variant} for name, variant in same.items()],
        "refused": [
            {"name": name, "text": variant, "error": _refusal(variant)}
            for name, variant in refused.items()
        ],
    }
```

- [ ] **Step 2: Generate the fixture and read what the oracle said**

Run: `pixi run -e core-dev ruff format tests/golden && pixi run -e core-dev ruff check tests/golden`
Expected: `25 files left unchanged`, `All checks passed!`

Run: `pixi run golden-fixtures && git status --short`
Expected: `M engine/fixtures/golden/snapshot_v2.json` and `M tests/golden/scenarios/snapshot_v2.py`, nothing else — no other fixture moves.

Open `engine/fixtures/golden/snapshot_v2.json` and read `refused`: five headers answer `snapshot v2 header carries no valid entity counts`; `cut after a line` and `cut inside a line` both answer `snapshot v2 holds 8 entity lines, its header promises 6 + 3`; `a line too many` and `a second LF at the end` answer the same with `10`.

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/model/snapshot-v2.golden.test.ts"`
Expected: FAIL — 1 test, `expected { digest: '6ef50a6d75d780bd', …(3) } to deeply equal { digest: '6ef50a6d75d780bd', …(5) }`: the fixture has two keys the old test does not know. The test is replaced in Step 6.

- [ ] **Step 3: Write the failing test of the splitter**

`engine/test/snapshot/lines.test.ts`:

```ts
import { expect, it } from 'vitest';
import { LineSplitter } from '../../src/index.ts';

it('hands out a line once its LF has arrived', () => {
	const splitter = new LineSplitter();
	expect(splitter.push('ab')).toEqual([]);
	expect(splitter.pending).toBe('ab');
	expect(splitter.push('c\nd')).toEqual(['abc']);
	expect(splitter.push('')).toEqual([]);
	expect(splitter.push('\n\nxy\nz')).toEqual(['d', '', 'xy']);
	expect(splitter.pending).toBe('z');
	expect(splitter.push('\n')).toEqual(['z']);
	expect(splitter.pending).toBe('');
});

it('cuts on LF alone', () => {
	const splitter = new LineSplitter();
	const lines = splitter.push('a\u{2028}b\u{2029}c\u{85}d\u{b}e\u{c}f\rg\r\nh\n');
	expect(lines).toEqual(['a\u{2028}b\u{2029}c\u{85}d\u{b}e\u{c}f\rg\r', 'h']);
});

it('gives the same lines however the text is cut', () => {
	const text = 'first\n\nthird \u{1f600}\nlast';
	for (let size = 1; size <= text.length; size++) {
		const splitter = new LineSplitter();
		const lines: string[] = [];
		for (let at = 0; at < text.length; at += size) {
			lines.push(...splitter.push(text.slice(at, at + size)));
		}
		expect([...lines, splitter.pending], `pieces of ${size}`).toEqual(text.split('\n'));
	}
});
```

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/snapshot/lines.test.ts"`
Expected: FAIL — 3 tests, `LineSplitter is not a constructor`.

- [ ] **Step 4: Write the splitter**

`engine/src/snapshot/lines.ts`:

```ts
/**
 * Cuts text that arrives in pieces into lines, on LF alone: U+2028 and U+2029
 * occur raw inside a snapshot line, and a CR before the LF stays on the line,
 * where JSON reads it as white space.
 */
export class LineSplitter {
	private rest = '';

	/** The lines `text` completes, without their LF. */
	push(text: string): string[] {
		if (!text.includes('\n')) {
			this.rest += text;
			return [];
		}
		const lines = text.split('\n');
		lines[0] = this.rest + lines[0]!;
		this.rest = lines.pop()!;
		return lines;
	}

	/** What has arrived of the line no LF has ended yet. */
	get pending(): string {
		return this.rest;
	}
}
```

In `engine/src/index.ts`, replace:

```ts
export { sha256 } from './snapshot/sha256.ts';
```

with:

```ts
export { LineSplitter } from './snapshot/lines.ts';
export { sha256 } from './snapshot/sha256.ts';
```

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/snapshot/lines.test.ts"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Make `parseLines` refuse a line of two documents**

In `engine/test/value/parse.test.ts`, replace:

```ts
	it('handles an empty batch', () => {
		expect(parseLines([])).toEqual([]);
	});
```

with:

```ts
	it('handles an empty batch', () => {
		expect(parseLines([])).toEqual([]);
	});

	it('refuses a line that holds more than one document', () => {
		expect(() => parseLines(['{"a":1},{"b":2}', '{"c":3}'])).toThrow(SyntaxError);
		expect(() => parseLines(['{"a":1.5},{"b":2}', '{"c":3}'])).toThrow(SyntaxError);
	});
```

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/value/parse.test.ts"`
Expected: FAIL — 1 test of 7, `expected function to throw an error, but it didn't`.

In `engine/src/value/parse.ts`, replace:

```ts
		const parsed = JSON.parse('[' + fast.map((i) => lines[i]).join(',') + ']') as Value[];
```

with:

```ts
		const parsed = JSON.parse('[' + fast.map((i) => lines[i]).join(',') + ']') as Value[];
		// A line holding `1,2` would shift every document after it.
		if (parsed.length !== fast.length) throw new SyntaxError('A line holds more than one document');
```

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/value/parse.test.ts"`
Expected: PASS — 7 tests.

- [ ] **Step 6: Write the failing tests of the reader**

```bash
git mv engine/test/model/snapshot-v2.golden.test.ts engine/test/snapshot/open.golden.test.ts
```

`engine/test/snapshot/text.ts`:

```ts
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
```

`engine/test/snapshot/open.golden.test.ts` (replace the whole file):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	openSnapshot,
	parseJson,
	verifyConsistent,
	type MetamodelDoc,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe, type Observed } from '../golden/model-steps.ts';
import { cut, refusal, snapshotText, trickle, utf8 } from './text.ts';

type Fixture = Required<Observed> & {
	metamodel: MetamodelDoc;
	text: string;
	same: { name: string; text: string }[];
	refused: { name: string; text: string; error: string }[];
};

const { metamodel, text, same, refused, ...expected } = loadFixture<Fixture>('snapshot_v2');
const mm = Metamodel.fromJSON(metamodel);

describe('the snapshot the server wrote', () => {
	// One byte at a time cuts every multi-byte character and every line.
	it.each([1, 2, 3, 7, 64, 100_000])('opens from pieces of %i bytes', async (size) => {
		const { header, workingCopy } = await openSnapshot(cut(utf8(text), size), mm);
		expect(header).toEqual(JSON.parse(text.slice(0, text.indexOf('\n'))));
		const seen = observe(workingCopy.model);
		expect(seen.state).toEqual(text.slice(0, -1).split('\n').slice(1));
		expect(seen).toEqual(expected);
		expect([workingCopy.rev, workingCopy.digest]).toEqual([42, expected.digest]);
		expect(workingCopy.verifyDigest()).toBe(true);
		verifyConsistent(workingCopy.model);
	});

	it('opens from a source it has to wait for, every uniqueness key in one bucket', async () => {
		const source = trickle(utf8(text), 5);
		const { workingCopy } = await openSnapshot(source, mm, undefined, { hashKey: () => 0 });
		expect(observe(workingCopy.model)).toEqual(expected);
	});

	it.each(same)('reads $name as the oracle does', async ({ text: variant }) => {
		const { workingCopy } = await openSnapshot(cut(utf8(variant), 16), mm);
		expect(observe(workingCopy.model)).toEqual(expected);
	});

	it.each(refused)("refuses $name in the oracle's words", async ({ text: variant, error }) => {
		for (const size of [1, 16, 100_000]) {
			expect(await refusal(openSnapshot(cut(utf8(variant), size), mm))).toBe(error);
		}
	});
});

type SmartCity = {
	metamodel: MetamodelDoc;
	model_file: string;
	digest: string;
	fingerprint: string;
	indexes: string;
};

it('opens the smart-city example, written as a snapshot, into what the oracle holds', async () => {
	const fixture = loadFixture<SmartCity>('smart_city');
	const file = new URL(`../../../${fixture.model_file}`, import.meta.url);
	const doc = parseJson(readFileSync(file, 'utf-8')) as { [key: string]: Value[] };
	const metamodel = Metamodel.fromJSON(fixture.metamodel);
	const written = new Model(metamodel);
	for (const element of doc['elements']!) written.loadElement(element);
	for (const rel of doc['relationships']!) written.loadRelationship(rel);

	const bytes = utf8(snapshotText(written, 7));
	const { header, workingCopy } = await openSnapshot(trickle(bytes, 4096), metamodel);
	expect([header.rev, header.state_digest]).toEqual([7, fixture.digest]);
	const seen = observe(workingCopy.model);
	expect(JSON.parse(seen.indexes)).toEqual(JSON.parse(fixture.indexes));
	expect(seen.fingerprint).toBe(fixture.fingerprint);
	expect(workingCopy.verifyDigest()).toBe(true);
	verifyConsistent(workingCopy.model);
});
```

`engine/test/snapshot/open.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Model, openSnapshot } from '../../src/index.ts';
import { observe } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';
import { cut, headerLine, refusal, snapshotText, utf8 } from './text.ts';

const NOT_V2 = 'not a datarover.snapshot/v2 snapshot';

const open = (text: string | Uint8Array, size = 64) =>
	openSnapshot(cut(typeof text === 'string' ? utf8(text) : text, size), nodeMetamodel());

/** The family's snapshot with one line (the header is line 1) replaced, or dropped. */
function withLine(number: number, line: string | null): string {
	const lines = snapshotText(family(), 3).slice(0, -1).split('\n');
	lines.splice(number - 1, 1, ...(line === null ? [] : [line]));
	return lines.map((each) => each + '\n').join('');
}

describe('opening', () => {
	// 2,000 lines make a batch; the elements end inside the second one.
	it.each([
		[1500, [2000, 4000, 4500]],
		[1000, [2000, 4000]]
	])('reports progress after every batch: %i relationships', async (relationships, expected) => {
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < 3000; i++) model.createElement('Node', `n${i}`);
		for (let i = 0; i < relationships; i++) model.connect('Refers', `n${i}`, `n${i + 1}`, `r${i}`);
		const calls: [number, number][] = [];
		const { workingCopy } = await openSnapshot(
			cut(utf8(snapshotText(model, 1)), 1 << 16),
			nodeMetamodel(),
			(done, total) => calls.push([done, total])
		);
		expect(calls).toEqual(expected.map((done) => [done, 3000 + relationships]));
		expect(observe(workingCopy.model)).toEqual(observe(model));
	});

	it('opens a snapshot of nothing', async () => {
		const empty = new Model(nodeMetamodel());
		const calls: number[] = [];
		const { header, workingCopy } = await openSnapshot(
			[utf8(snapshotText(empty, 9))],
			nodeMetamodel(),
			(done) => calls.push(done)
		);
		expect([header.elements, header.relationships, workingCopy.rev]).toEqual([0, 0, 9]);
		expect(workingCopy.digest).toBe('0'.repeat(16));
		expect(calls).toEqual([]);
	});

	it('adopts the digest of the header without checking it', async () => {
		const text = withLine(1, headerLine(family(), 3, { state_digest: 'f'.repeat(16) }));
		const { workingCopy } = await open(text);
		expect([workingCopy.digest, workingCopy.diverged]).toEqual(['f'.repeat(16), false]);
		expect(workingCopy.verifyDigest()).toBe(false);
		expect(workingCopy.diverged).toBe(true);
	});
});

describe('what is not a v2 snapshot', () => {
	it.each([
		['nothing at all', ''],
		['a v1 document', '{"elements":[],"relationships":[]}'],
		['another format', snapshotText(family(), 3).replace('snapshot/v2', 'snapshot/v3')],
		['a header written with spaces', snapshotText(family(), 3).replace('{"format"', '{ "format"')],
		['a byte order mark', '\u{feff}' + snapshotText(family(), 3)]
	])('refuses %s', async (_, text) => {
		expect(await refusal(open(text))).toBe(NOT_V2);
	});

	it('refuses an endless first line at its first bytes, without reading on', async () => {
		function* source(): Generator<Uint8Array> {
			yield utf8('{"elements":[{"id":"a","type_name":"Node","properties":{},"rev":0},');
			throw new Error('read past the first piece');
		}
		expect(await refusal(openSnapshot(source(), nodeMetamodel()))).toBe(NOT_V2);
	});
});

describe('a text that cannot be read', () => {
	it('refuses bytes that are not UTF-8, in the middle or cut at the end', async () => {
		const bytes = utf8(withLine(2, '{"id":"\u{e9}","type_name":"Node","properties":{},"rev":0}'));
		const at = bytes.indexOf(0xc3);
		expect(await refusal(open(bytes.slice(0, at + 1)))).toBe('snapshot is not valid UTF-8');
		bytes[at] = 0xe9;
		for (const size of [1, 64]) {
			expect(await refusal(open(bytes, size))).toBe('snapshot is not valid UTF-8');
		}
	});

	it.each([
		['no rev', { rev: null }, 'snapshot v2 header carries no valid rev'],
		['a negative rev', { rev: -1 }, 'snapshot v2 header carries no valid rev'],
		['no digest', { state_digest: null }, 'snapshot v2 header carries no valid state digest'],
		[
			'a digest in upper case',
			{ state_digest: 'ABCDEF0123456789' },
			'snapshot v2 header carries no valid state digest'
		],
		['no project', { project_id: null }, 'snapshot v2 header names no project and metamodel'],
		['no metamodel', { metamodel_id: 7 }, 'snapshot v2 header names no project and metamodel']
	])('refuses a header with %s', async (_, changes, message) => {
		expect(await refusal(open(withLine(1, headerLine(family(), 3, changes))))).toBe(message);
	});

	it('refuses a header that is not JSON', async () => {
		const text = withLine(1, '{"format":"datarover.snapshot/v2",');
		expect(await refusal(open(text))).toMatch(/^snapshot v2 header: /);
	});

	it('names the line that does not parse', async () => {
		expect(await refusal(open(withLine(4, '{"id":"c",')))).toMatch(/^snapshot v2 line 4: /);
		expect(await refusal(open(withLine(6, '')))).toMatch(/^snapshot v2 line 6: /);
	});

	it('refuses a line that holds two documents instead of shifting the rest', async () => {
		const lines = snapshotText(family(), 3).slice(0, -1).split('\n');
		// Seven entities on six lines, under a header that promises six.
		const header = headerLine(family(), 3, { elements: 3 });
		const text = [header, `${lines[1]},${lines[2]}`, ...lines.slice(3)].join('\n') + '\n';
		expect(await refusal(open(text))).toMatch(/^snapshot v2 line 2: /);
	});

	it("passes on the bulk loader's refusals", async () => {
		const twice = '{"id":"a","type_name":"Node","properties":{},"rev":0}';
		expect(await refusal(open(withLine(3, twice)))).toBe("Duplicate element id 'a' in snapshot");
		const orphan = '{"id":"a-b","type_name":"Contains","source_id":"x","target_id":"b","rev":0}';
		expect(await refusal(open(withLine(6, orphan)))).toBe(
			"Relationship 'a-b' references unknown source 'x'"
		);
	});
});
```

- [ ] **Step 7: Run them to see them fail**

Run: `pixi run -e frontend bash -c "cd engine && npx vitest run test/snapshot/open"`
Expected: FAIL — 40 tests in 2 files, `openSnapshot is not a function`.

- [ ] **Step 8: Write the reader**

`engine/src/snapshot/utf8.ts`:

```ts
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
```

`engine/src/snapshot/open.ts`:

```ts
import type { Metamodel } from '../metamodel/metamodel.ts';
import { SnapshotError } from '../model/errors.ts';
import { Model, type ModelOptions } from '../model/model.ts';
import { parseJson, parseLines } from '../value/parse.ts';
import type { Value } from '../value/types.ts';
import { WorkingCopy, type WorkingCopyOptions } from '../working/working-copy.ts';
import { LineSplitter } from './lines.ts';
import { utf8Decoder } from './utf8.ts';

export const SNAPSHOT_V2_FORMAT = 'datarover.snapshot/v2';

// A writer puts `format` first, so these characters tell a v2 snapshot from anything else.
const V2_PREFIX = `{"format":"${SNAPSHOT_V2_FORMAT}"`;
const DIGEST = /^[0-9a-f]{16}$/;
// Lines parsed and loaded at a time: enough for one native parse to pay off,
// few enough to stay a short task between two chunks.
const BATCH_LINES = 2000;

/** The first line of a snapshot, in the wire's names. */
export type SnapshotHeader = {
	format: string;
	project_id: string;
	rev: number;
	metamodel_id: string;
	elements: number;
	relationships: number;
	state_digest: string;
};

export type OpenedSnapshot = { header: SnapshotHeader; workingCopy: WorkingCopy };

/** Told after every batch of entities: how many are loaded, of how many. */
export type OpenProgress = (done: number, total: number) => void;

export type OpenOptions = ModelOptions & WorkingCopyOptions;

function checkFormat(start: string): void {
	if (!start.startsWith(V2_PREFIX)) throw new SnapshotError(`not a ${SNAPSHOT_V2_FORMAT} snapshot`);
}

const isCount = (value: Value | undefined): value is number =>
	typeof value === 'number' && value >= 0;

function readHeader(line: string): SnapshotHeader {
	checkFormat(line);
	let doc: Value;
	try {
		doc = parseJson(line);
	} catch (caught) {
		throw new SnapshotError(`snapshot v2 header: ${(caught as Error).message}`);
	}
	const header = doc as { [key: string]: Value };
	const field = (key: string) => (Object.hasOwn(header, key) ? header[key] : undefined);
	const [elements, relationships] = [field('elements'), field('relationships')];
	if (!isCount(elements) || !isCount(relationships)) {
		throw new SnapshotError('snapshot v2 header carries no valid entity counts');
	}
	const [rev, digest] = [field('rev'), field('state_digest')];
	if (!isCount(rev)) throw new SnapshotError('snapshot v2 header carries no valid rev');
	if (typeof digest !== 'string' || !DIGEST.test(digest)) {
		throw new SnapshotError('snapshot v2 header carries no valid state digest');
	}
	const [projectId, metamodelId] = [field('project_id'), field('metamodel_id')];
	if (typeof projectId !== 'string' || typeof metamodelId !== 'string') {
		throw new SnapshotError('snapshot v2 header names no project and metamodel');
	}
	return {
		format: SNAPSHOT_V2_FORMAT,
		project_id: projectId,
		rev,
		metamodel_id: metamodelId,
		elements,
		relationships,
		state_digest: digest
	};
}

/** `parseLines`, with a line that does not parse named by its number in the snapshot. */
function parseBatch(lines: readonly string[], firstLine: number): Value[] {
	try {
		return parseLines(lines);
	} catch (batchError) {
		lines.forEach((line, i) => {
			try {
				parseJson(line);
			} catch (caught) {
				throw new SnapshotError(`snapshot v2 line ${firstLine + i}: ${(caught as Error).message}`);
			}
		});
		throw batchError;
	}
}

class Reader {
	header: SnapshotHeader | null = null;
	// Entity lines seen, loaded or not: a line past the promised ones is only counted.
	seen = 0;

	private readonly model: Model;
	private readonly onProgress: OpenProgress | undefined;
	private batch: string[] = [];

	constructor(model: Model, onProgress: OpenProgress | undefined) {
		this.model = model;
		this.onProgress = onProgress;
	}

	get total(): number {
		return this.header === null ? 0 : this.header.elements + this.header.relationships;
	}

	take(lines: readonly string[]): void {
		for (const line of lines) {
			if (this.header === null) this.header = readHeader(line);
			else {
				if (this.seen++ < this.total) this.batch.push(line);
				if (this.batch.length >= BATCH_LINES) this.load();
			}
		}
	}

	/** Parses and loads the lines held: the first `elements` of a snapshot are elements. */
	load(): void {
		if (this.batch.length === 0) return;
		const { model } = this;
		const elements = this.header!.elements;
		const first = model.elementCount + model.relationshipCount;
		// The header is line 1.
		parseBatch(this.batch, first + 2).forEach((doc, i) => {
			if (first + i < elements) model.loadElement(doc);
			else model.loadRelationship(doc);
		});
		this.batch = [];
		this.onProgress?.(model.elementCount + model.relationshipCount, this.total);
	}
}

/**
 * Reads a `datarover.snapshot/v2` text — the header line, then one line per
 * element, then one per relationship — from inflated bytes cut anywhere, into
 * an indexed replica at the header's `rev` and state digest. Lines are parsed
 * and loaded as they arrive, so the text is never held whole.
 *
 * The digest is adopted, not checked: `verifyDigest()` does that, whenever the
 * caller chooses. A text that cannot be read throws `SnapshotError`.
 */
export async function openSnapshot(
	chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	metamodel: Metamodel,
	onProgress?: OpenProgress,
	options: OpenOptions = {}
): Promise<OpenedSnapshot> {
	const model = new Model(metamodel, options);
	const reader = new Reader(model, onProgress);
	const splitter = new LineSplitter();
	const decoder = utf8Decoder();
	const decode = (chunk?: Uint8Array) => {
		try {
			return decoder.decode(chunk, { stream: chunk !== undefined });
		} catch {
			throw new SnapshotError('snapshot is not valid UTF-8');
		}
	};

	for await (const chunk of chunks) {
		reader.take(splitter.push(decode(chunk)));
		// Anything but a v2 snapshot may be one endless line: refuse it at its first bytes.
		if (reader.header === null && splitter.pending.length >= V2_PREFIX.length) {
			checkFormat(splitter.pending);
		}
	}
	reader.take(splitter.push(decode()));
	// A last line may lack its LF; the server's own reader takes it too.
	if (splitter.pending !== '') reader.take([splitter.pending]);
	const header = reader.header;
	if (header === null) throw new SnapshotError(`not a ${SNAPSHOT_V2_FORMAT} snapshot`);
	// Checked before the last lines are parsed: what a cut text gets wrong first is its length.
	if (reader.seen !== reader.total) {
		throw new SnapshotError(
			`snapshot v2 holds ${reader.seen} entity lines, ` +
				`its header promises ${header.elements} + ${header.relationships}`
		);
	}
	reader.load();
	model.rebuildIndexes();
	const committed = { rev: header.rev, digest: header.state_digest };
	return { header, workingCopy: new WorkingCopy(model, committed, options) };
}
```

In `engine/src/index.ts`, replace:

```ts
export { LineSplitter } from './snapshot/lines.ts';
```

with:

```ts
export { LineSplitter } from './snapshot/lines.ts';
export {
	openSnapshot,
	SNAPSHOT_V2_FORMAT,
	type OpenedSnapshot,
	type OpenOptions,
	type OpenProgress,
	type SnapshotHeader
} from './snapshot/open.ts';
```

- [ ] **Step 9: Run the tests**

Run: `pixi run engine-test`
Expected: PASS — 266 tests in 38 files.

- [ ] **Step 10: See the tests bite**

In `engine/src/snapshot/open.ts`, in `openSnapshot`, add the line `reader.load();` right above `const header = reader.header;` — the last batch is then parsed before the lines are counted — and run `pixi run engine-test`.
Expected: FAIL — 1 test of 266, `refuses 'cut inside a line' in the oracle's words` (finding 2). Take the line out.

In the same file, change `{ stream: chunk !== undefined }` to `{ stream: false }` and run the suite again.
Expected: FAIL — 8 tests of `test/snapshot/open.golden.test.ts`: the pieces of 1, 2 and 3 bytes, the source it has to wait for, and the four line-count refusals, which are also read a byte at a time. Put it back.

In `engine/src/value/parse.ts`, delete the line `if (parsed.length !== fast.length) throw new SyntaxError('A line holds more than one document');` and run the suite again.
Expected: FAIL — 2 tests: `refuses a line that holds more than one document` and `refuses a line that holds two documents instead of shifting the rest` (finding 4). Put the line back and see 266 pass.

- [ ] **Step 11: Tidy and commit**

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics.

Run: `pixi run -e core-dev ruff format --check tests/golden && pixi run -e core-dev ruff check tests/golden`
Expected: `25 files already formatted`, `All checks passed!`

Run: `pixi run -e core-dev pytest tests/golden -q`
Expected: `1 passed` — the committed fixtures are what the core produces.

Run: `LC_ALL=C grep -rnP --include='*.py' --include='*.ts' '[^[:ascii:]]' tests/golden engine/test`
Expected: only the `café` line of `engine/test/value/serialize.test.ts`.

```bash
git add tests/golden engine
git commit -m "Open a v2 snapshot into a replica at its rev and digest"
```

---

### Task 3: Measure the engine at model M

The benchmark opens model M as a v2 snapshot and, in the same pass, as one document (AD-11, CN-5); checks the digest; weighs one open replica; stages and unstages a 1,000-op batch; rebases 100 staged batches of one op each over a delta; applies a delta. It checks itself — a replica off its digest stops the run. The input is written once from `benchmarks/large.model.json` by a Python script; both files are git-ignored and local.

**Files:**
- Create: `scripts/snapshot_v2.py`, `engine/bench/run.ts`
- Modify: `pixi.toml`, `engine/package.json`, `engine/tsconfig.test.json`

**Interfaces:**
- Consumes: `openSnapshot`, `WorkingCopy.stage` / `unstage` / `applyDelta` / `verifyDigest`, `entityHash`, `formatDigest`, `parseExact`, `Model`, `Metamodel` (the package index); `encode_snapshot_v2`, `build_model_from_dicts`, `parse_model_json`, `load_metamodel_file`.
- Produces: `pixi run engine-bench-data` (writes `benchmarks/large.snapshot.v2` and `benchmarks/large.snapshot.v2.metamodel.json`), `pixi run engine-bench` (prints the table; exits 1 when an input is missing).

- [ ] **Step 1: Write the script that writes the input**

`scripts/snapshot_v2.py`:

```python
"""Write a model JSON file as the snapshot the engine opens.

Two files land next to each other: ``<out>``, the INFLATED
``datarover.snapshot/v2`` text (inflating is the engine host's job, so the
engine's benchmark starts from these bytes), and ``<out>.metamodel.json``, the
metamodel as ``GET /metamodel`` serves it.

Run from the repo root (``pixi run engine-bench-data`` does, for model M):

    pixi run -e core-dev python scripts/snapshot_v2.py \\
        --model benchmarks/large.model.json \\
        --metamodel examples/smart-city.metamodel.yaml \\
        --out benchmarks/large.snapshot.v2
"""

from __future__ import annotations

import argparse
import json
import sys
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.serialize import parse_model_json  # noqa: E402
from data_rover.api.snapshot_codec import encode_snapshot_v2  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--metamodel", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rev", type=int, default=1)
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(
            f"{args.model} is missing: examples/generate_large_model.py writes it "
            "(--scale 170 for model M)"
        )
    metamodel = load_metamodel_file(args.metamodel)
    model = build_model_from_dicts(
        metamodel, parse_model_json(args.model.read_bytes()), strict=False
    )
    inflate = zlib.decompressobj(16 + zlib.MAX_WBITS)
    blob = encode_snapshot_v2(
        model, project_id="bench", rev=args.rev, metamodel_id=args.metamodel.name
    )
    size = 0
    with args.out.open("wb") as out:
        for chunk in blob:
            size += out.write(inflate.decompress(chunk))
        size += out.write(inflate.flush())
    doc = args.out.with_name(args.out.name + ".metamodel.json")
    doc.write_text(
        json.dumps(metamodel.model_dump(mode="json"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(
        f"wrote {args.out}: {len(model.elements)} elements, "
        f"{len(model.relationships)} relationships, {size / 1_048_576:.1f} MiB; "
        f"and {doc.name}"
    )


if __name__ == "__main__":
    main()
```

Run: `pixi run -e core-dev ruff format --check scripts/snapshot_v2.py && pixi run -e core-dev ruff check scripts/snapshot_v2.py`
Expected: `1 file already formatted`, `All checks passed!`

- [ ] **Step 2: Write the benchmark and its tasks**

`engine/bench/run.ts`:

```ts
/**
 * The engine at model M: opening a snapshot, against opening the same model
 * as one document in the same pass; the digest check; the heap one replica
 * holds; staging, rewinding, rebasing and a delta.
 *
 * `pixi run engine-bench-data` writes the input once, `pixi run engine-bench`
 * measures. Timings drift between sessions: compare only numbers of one run.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
	entityHash,
	formatDigest,
	Metamodel,
	Model,
	openSnapshot,
	parseExact,
	type Delta,
	type ElementRec,
	type MetamodelDoc,
	type ModelOp,
	type RelRec,
	type Value,
	type WorkingCopy
} from '../src/index.ts';

const PASSES = 3;
const CHUNK_BYTES = 1 << 16;
const OPEN_BUDGET_MS = 3000;
const HEAP_BUDGET_MB = 400;

const DIR = new URL('../../benchmarks/', import.meta.url);
const SNAPSHOT = new URL('large.snapshot.v2', DIR);
const METAMODEL = new URL('large.snapshot.v2.metamodel.json', DIR);
const DOCUMENT = new URL('large.model.json', DIR);

for (const file of [SNAPSHOT, METAMODEL, DOCUMENT]) {
	if (!existsSync(file)) {
		console.error(`Missing ${file.pathname}: run \`pixi run engine-bench-data\` first.`);
		process.exit(1);
	}
}

/** What is measured, in the order it is shown. */
const ROWS = {
	open: 'open the snapshot: inflated bytes to indexed replica',
	openRead: '  decode, split, parse, load',
	openIndex: '  index',
	document: 'open the same model as one document',
	documentParse: '  exact parse',
	documentLoad: '  load',
	documentIndex: '  index',
	nativeParse: '  (its native parse, which loses 1 vs 1.0)',
	verify: 'verify the digest: every entity hashed',
	iterate: 'iterate every entity in state order',
	stage: 'stage a 1,000-op batch',
	unstage: 'unstage it: every touched entity back in its place',
	iterateAfter: 'iterate again: the first time re-sorts',
	rebase: 'rebase 100 staged batches over a delta',
	unstageEntity: 'unstage one entity among 100 staged batches',
	delta: 'apply a delta (99 changed, 40 new, 10 deleted), nothing staged'
};
type Row = keyof typeof ROWS;

const timings = new Map<Row, number[]>();

function record(row: Row, ms: number): void {
	timings.set(row, [...(timings.get(row) ?? []), ms]);
}

function timed<T>(row: Row, run: () => T): T {
	const start = performance.now();
	const result = run();
	record(row, performance.now() - start);
	return result;
}

const count = (n: number) => n.toLocaleString('en-US');

const median = (values: readonly number[]) =>
	[...values].sort((a, b) => a - b)[values.length >> 1]!;

function* cut(bytes: Uint8Array): Generator<Uint8Array> {
	for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.subarray(at, at + CHUNK_BYTES);
}

/** Every `stride`-th item from `offset` that passes, `count` of them. */
function sample<T>(items: readonly T[], count: number, offset: number, pass: (item: T) => boolean) {
	const stride = Math.max(1, Math.floor(items.length / (count * 4)));
	const out: T[] = [];
	for (let i = offset; i < items.length && out.length < count; i += stride) {
		if (pass(items[i]!)) out.push(items[i]!);
	}
	if (out.length < count) throw new Error(`the model holds too few entities to sample ${count}`);
	return out;
}

const renamed = (element: ElementRec, name: string): ModelOp => ({
	kind: 'update_element',
	id: element.id,
	properties_patch: { name }
});

const committed = (element: ElementRec, name: string): Value => ({
	id: element.id,
	type_name: element.typeName,
	properties: { ...element.props, name },
	rev: element.rev + 1
});

/** A delta over untouched entities, its digest folded the way the server maintains it. */
function deltaOver(
	wc: WorkingCopy,
	changed: readonly ElementRec[],
	added: { elements: readonly ElementRec[]; relationships: readonly RelRec[] },
	deleted: readonly RelRec[]
): Delta {
	let digest = BigInt('0x' + wc.digest);
	for (const element of changed) {
		digest ^= entityHash(element.id, element.rev) ^ entityHash(element.id, element.rev + 1);
	}
	for (const rel of deleted) digest ^= entityHash(rel.id, rel.rev);
	const tag = `bench-${wc.rev}-`;
	const elements = added.elements.map((like, i) => {
		digest ^= entityHash(`${tag}e${i}`, 0);
		return { id: `${tag}e${i}`, type_name: like.typeName, properties: { ...like.props }, rev: 0 };
	});
	const relationships = added.relationships.map((like, i) => {
		digest ^= entityHash(`${tag}r${i}`, 0);
		return {
			id: `${tag}r${i}`,
			type_name: like.typeName,
			source_id: like.source.id,
			target_id: like.target.id,
			properties: {},
			rev: 0
		};
	});
	return {
		rev: wc.rev + 1,
		prev_rev: wc.rev,
		state_digest: formatDigest(digest),
		changed_elements: [
			...changed.map((element, i) => committed(element, `theirs ${i}`)),
			...elements
		],
		changed_relationships: relationships,
		deleted_element_ids: [],
		deleted_relationship_ids: deleted.map((rel) => rel.id)
	};
}

const entities = (model: Model): [ElementRec[], RelRec[]] => [
	[...model.elements()],
	[...model.relationships()]
];

function measureEdits(wc: WorkingCopy): void {
	const { model } = wc;
	const metamodel = model.metamodel;
	let [elements, relationships] = timed('iterate', () => entities(model));
	const named = (element: ElementRec) =>
		metamodel.effectiveElementPropertyNames(element.typeName).has('name');
	const leaf = (element: ElementRec) =>
		element.out.every((rel) => !metamodel.isContainment(rel.typeName));
	const any = () => true;

	// Deletions come last, relationships first: nothing names an entity already gone.
	const batch: ModelOp[] = [
		...sample(elements, 500, 0, named).map((element, i) => renamed(element, `mine ${i}`)),
		...sample(elements, 200, 1, named).map((like, i): ModelOp => ({
			kind: 'create_element',
			temp_id: `tmp_e${i}`,
			type_name: like.typeName,
			properties: { name: `new ${i}` }
		})),
		...sample(relationships, 200, 1, any).map((like, i): ModelOp => ({
			kind: 'create_relationship',
			temp_id: `tmp_r${i}`,
			type_name: like.typeName,
			source_id: like.source.id,
			target_id: like.target.id
		})),
		...sample(relationships, 50, 0, any).map((rel): ModelOp => ({
			kind: 'delete_relationship',
			id: rel.id
		})),
		...sample(elements, 50, 2, leaf).map((element): ModelOp => ({
			kind: 'delete_element',
			id: element.id
		}))
	];
	if (batch.length !== 1000) throw new Error(`the batch holds ${batch.length} ops`);
	timed('stage', () => wc.stage(batch));
	timed('unstage', () => wc.unstage('all'));
	// A deleted entity came back as a new record: the lists are read again.
	[elements, relationships] = timed('iterateAfter', () => entities(model));

	const mine = sample(elements, 100, 3, named);
	mine.forEach((element, i) => wc.stage([renamed(element, `mine ${i}`)]));
	const theirs = sample(elements, 100, 5, named);
	const one = deltaOver(wc, theirs.slice(0, 1), { elements: [], relationships: [] }, []);
	timed('rebase', () => wc.applyDelta(one));
	timed('unstageEntity', () => wc.unstage({ entity: mine[50]!.id }));
	wc.unstage('all');

	const delta = deltaOver(
		wc,
		theirs.slice(1),
		{ elements: sample(elements, 20, 7, any), relationships: sample(relationships, 20, 7, any) },
		sample(relationships, 10, 9, any)
	);
	timed('delta', () => wc.applyDelta(delta));
	const sound = !wc.diverged && wc.verifyDigest();
	if (!sound) throw new Error('the bench drove the replica off its digest');
}

const bytes = readFileSync(SNAPSHOT);
const metamodelDoc = JSON.parse(readFileSync(METAMODEL, 'utf-8')) as MetamodelDoc;

const heapMb: number[] = [];
let counts = '';

async function pass(): Promise<void> {
	const start = performance.now();
	let loaded = start;
	const { header, workingCopy } = await openSnapshot(
		cut(bytes),
		Metamodel.fromJSON(metamodelDoc),
		(done, total) => {
			if (done === total) loaded = performance.now();
		}
	);
	const end = performance.now();
	record('open', end - start);
	record('openRead', loaded - start);
	record('openIndex', end - loaded);
	if (!timed('verify', () => workingCopy.verifyDigest())) {
		throw new Error('the snapshot does not hold what its digest names');
	}
	counts = `${count(header.elements)} elements, ${count(header.relationships)} relationships`;
	// Weighed before the document is read: the last text a regular expression
	// ran over stays reachable, and further down that is the whole document.
	globalThis.gc?.();
	globalThis.gc?.();
	heapMb.push(process.memoryUsage().heapUsed / 2 ** 20);

	const text = readFileSync(DOCUMENT, 'utf-8');
	const documentStart = performance.now();
	const doc = timed('documentParse', () => parseExact(text)) as { [key: string]: Value[] };
	const model = new Model(Metamodel.fromJSON(metamodelDoc));
	timed('documentLoad', () => {
		for (const element of doc['elements']!) model.loadElement(element);
		for (const rel of doc['relationships']!) model.loadRelationship(rel);
	});
	timed('documentIndex', () => model.rebuildIndexes());
	record('document', performance.now() - documentStart);
	timed('nativeParse', () => JSON.parse(text) as unknown);

	measureEdits(workingCopy);
}

for (let i = 0; i < PASSES; i++) await pass();

const width = Math.max(...Object.values(ROWS).map((label) => label.length));
const shown = (ms: number) => ms.toFixed(ms < 10 ? 1 : 0);
const open = median(timings.get('open')!);
const heap = median(heapMb);

console.log(
	`\nModel M: ${counts}, ${(bytes.length / 2 ** 20).toFixed(1)} MiB inflated. ` +
		`Node ${process.version}; ms, median of ${PASSES} passes [each pass].\n`
);
for (const [row, label] of Object.entries(ROWS) as [Row, string][]) {
	const values = timings.get(row)!;
	const each = values.map(shown).join(' ');
	console.log(`${label.padEnd(width)}  ${shown(median(values)).padStart(6)}   [${each}]`);
}
const collected = globalThis.gc === undefined ? '   (run without --expose-gc: not collected)' : '';
const each = heapMb.map((mb) => mb.toFixed(0)).join(' ');
console.log(
	`${'heap after GC with one replica open, MB'.padEnd(width)}  ${heap.toFixed(0).padStart(6)}   [${each}]${collected}`
);
const verdict = (within: boolean) => (within ? 'within budget' : 'OVER BUDGET');
console.log(
	`\nopen: ${open.toFixed(0)} of ${OPEN_BUDGET_MS} ms, ${verdict(open <= OPEN_BUDGET_MS)}; ` +
		`heap: ${heap.toFixed(0)} of ${HEAP_BUDGET_MB} MB, ${verdict(heap <= HEAP_BUDGET_MB)}`
);
```

In `engine/package.json`, replace:

```json
		"test": "vitest run",
```

with:

```json
		"test": "vitest run",
		"bench": "node --expose-gc --disable-warning=ExperimentalWarning bench/run.ts",
```

In `engine/tsconfig.test.json`, replace:

```json
"include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
```

with:

```json
"include": ["src/**/*.ts", "test/**/*.ts", "bench/**/*.ts", "vitest.config.ts"]
```

In `pixi.toml`, replace:

```toml
[feature.core-dev.tasks.core-lint]
```

with:

```toml
[feature.core-dev.tasks.engine-bench-data]
description = "Write benchmarks/large.model.json as the v2 snapshot that engine-bench opens"
cmd = "python scripts/snapshot_v2.py --model benchmarks/large.model.json --metamodel examples/smart-city.metamodel.yaml --out benchmarks/large.snapshot.v2"
default-environment = "core-dev"

[feature.core-dev.tasks.core-lint]
```

In `pixi.toml`, replace:

```toml
[feature.frontend.tasks.engine-tidy]
```

with:

```toml
[feature.frontend.tasks.engine-bench]
description = "Benchmark the engine at model M (run engine-bench-data once before)"
cmd = "npm run bench"
cwd = "engine"

[feature.frontend.tasks.engine-tidy]
```

Run: `pixi run engine-tidy`
Expected: nothing reformatted, no diagnostics — `bench/` is now type-checked with the tests.

- [ ] **Step 3: Write the input**

If `benchmarks/large.model.json` is missing, write it first: `pixi run -e core-dev python examples/generate_large_model.py --scale 170 --out benchmarks/large.model.json`.

Run: `pixi run engine-bench-data`
Expected: `wrote benchmarks/large.snapshot.v2: 170340 elements, 126820 relationships, 73.4 MiB; and large.snapshot.v2.metamodel.json`

- [ ] **Step 4: Measure**

Close whatever else is running on the machine.

Run: `pixi run engine-bench`
Expected: about a minute, then the table below — these are the numbers of the pass this plan was verified in — ending in `within budget` twice. Timings drift between sessions (CN-5); what must hold is the verdict and the order of things: the snapshot opens faster than the document, and nothing but the two opens and the digest check takes more than 100 ms.

```
Model M: 170,340 elements, 126,820 relationships, 73.4 MiB inflated. Node v22.22.3; ms, median of 3 passes [each pass].

open the snapshot: inflated bytes to indexed replica              2304   [2377 2223 2304]
  decode, split, parse, load                                      1731   [1862 1731 1695]
  index                                                            515   [515 492 608]
open the same model as one document                               3140   [3205 3104 3140]
  exact parse                                                     2259   [2288 2218 2259]
  load                                                             395   [398 395 395]
  index                                                            489   [512 489 486]
  (its native parse, which loses 1 vs 1.0)                         479   [505 479 471]
verify the digest: every entity hashed                             202   [206 202 199]
iterate every entity in state order                                1.9   [2.8 1.8 1.9]
stage a 1,000-op batch                                              44   [47 43 44]
unstage it: every touched entity back in its place                  39   [39 40 38]
iterate again: the first time re-sorts                              58   [58 59 43]
rebase 100 staged batches over a delta                              14   [14 15 13]
unstage one entity among 100 staged batches                         13   [13 12 13]
apply a delta (99 changed, 40 new, 10 deleted), nothing staged     8.9   [8.9 7.7 8.9]
heap after GC with one replica open, MB                            231   [231 231 231]

open: 2304 of 3000 ms, within budget; heap: 231 of 400 MB, within budget
```

If the last line says `OVER BUDGET` for `open`, run it once more on a quiet machine. If it still does, STOP and raise it with the owner: whether to optimize inside this plan is their decision, not the executor's.

- [ ] **Step 5: Commit**

```bash
git add scripts/snapshot_v2.py engine pixi.toml
git commit -m "Benchmark the engine at model M"
```

---

### Task 4: Run everything, document, close sub-project A

**Files:**
- Modify: `CLAUDE.md`, `BACKLOG.md`, `architecture/README.md`, `architecture/program.md`, `architecture/decisions.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Run everything**

Run: `pixi run dr-test`
Expected: core pytest 2,429 passed / 34 deselected; frontend vitest 2,492 passed in 252 files; engine vitest 266 passed in 38 files.

Run: `pixi run dr-tidy`
Expected: no file changes, no diagnostics; `git status --short` prints nothing.

- [ ] **Step 2: Describe the reader, the digest and the benchmark; close A; log what B inherits**

The numbers in these edits are those of the pass this plan was verified in (2026-09-18, the reference PC). If Task 3's medians for `open` or the heap differ from them by more than a quarter, tell the owner before committing rather than editing the numbers silently.

In `CLAUDE.md`, replace:

```markdown
pixi run golden-fixtures                 # regenerate engine/fixtures/golden from the Python core
```

with:

```markdown
pixi run golden-fixtures                 # regenerate engine/fixtures/golden from the Python core
pixi run engine-bench-data               # once: benchmarks/large.model.json as the v2 snapshot the bench opens
pixi run engine-bench                    # the engine at model M: open vs one document, heap, staging, rebase, delta
```

In `CLAUDE.md`, replace:

```markdown
Today it holds the **value layer, the metamodel, the record-graph store, the op applier and the working copy**; nothing in the frontend or the server imports it yet.
```

with:

```markdown
It holds the **value layer, the metamodel, the record-graph store, the op applier, the working copy, the snapshot reader and the state digest** — all of sub-project A; nothing in the frontend or the server imports it yet.
```

In `CLAUDE.md`, replace:

```markdown
The `(id, rev)` hash is injected (`entityHash`) until the engine has its own SHA-256. Every operation returns a change set.
```

with:

```markdown
The `(id, rev)` hash is the engine's own (`src/snapshot/`); the `entityHash` option replaces it, which is how tests hold it to another implementation. `verifyDigest()` recomputes the digest from every COMMITTED entity — the model's, with the committed image standing in wherever a staged batch has been — and sets `diverged` on a mismatch. Every operation returns a change set.
- **`src/snapshot/`** — `sha256` is FIPS 180-4 in plain TypeScript, synchronous because the digest fold cannot wait for WebCrypto; `entityHash(id, rev)` is CT-3's hash (the first 8 bytes over `utf8(id) ‖ 0x00 ‖ ascii(rev)`, the UTF-8 written by hand, a lone surrogate as U+FFFD), `modelDigest(model)` the port of `state_digest.model_digest`, and both are `WorkingCopy`'s default. `openSnapshot(chunks, metamodel, onProgress?, options?)` reads a `datarover.snapshot/v2` text from inflated bytes cut anywhere and returns `{header, workingCopy}` at the header's `rev` and `state_digest` — adopted, not checked: `verifyDigest()` is the check, whenever the caller chooses. Bytes are decoded by the host's `TextDecoder` (`fatal`, the byte order mark kept so that it fails the format check), reached through a typed `globalThis` lookup in `utf8.ts` because a declared global would collide with the host typings of any project that compiles these sources; `LineSplitter` cuts on LF alone; lines are parsed and loaded 2,000 at a time through `parseLines`, the first `elements` of them as elements, so the text is never held whole. Anything that does not start with `{"format":"datarover.snapshot/v2"` is refused at its first bytes. A refusal is a `SnapshotError`: the server's two texts (`snapshot v2 header carries no valid entity counts`, `snapshot v2 holds N entity lines, its header promises E + R` — the count is checked BEFORE the last lines are parsed, which is what gives a cut text the server's answer), the bulk loader's own, or the engine's for what the server's decoder never looks at (`rev`, `state_digest`, the ids, invalid UTF-8, a line that is not one JSON document, named by its number). Like the server's reader it takes a last line without its LF and CRLF line ends.
- **`bench/run.ts`** (`pixi run engine-bench`, input written once by `pixi run engine-bench-data` → `scripts/snapshot_v2.py`) measures model M in three passes: opening the snapshot against opening the same model as one document in the same pass, the digest check, the heap of one open replica, a 1,000-op batch staged and unstaged, a rebase of 100 staged batches, a delta. It weighs the heap BEFORE it reads the document: the last text a regular expression ran over stays reachable in V8, and there that is 77 MB.
```

In `CLAUDE.md`, replace:

```markdown
`parseJson`/`parseLines` route each line: a regex pre-scan sends lines holding a float, a 16-digit integer, a bare `Infinity`/`NaN` or `-0` to the exact parser and everything else to native `JSON.parse`.
```

with:

```markdown
`parseJson`/`parseLines` route each line: a regex pre-scan sends lines holding a float, a 16-digit integer, a bare `Infinity`/`NaN` or `-0` to the exact parser and everything else to native `JSON.parse`, many lines to a call — which is why `parseLines` refuses a line holding more than one document instead of shifting every document after it.
```

In `CLAUDE.md`, replace:

```markdown
`ops_recreate` (an entity created again under its id, unchanged in type and ends) is kept out of it, because no delta can express that (`K-31`).
```

with:

```markdown
`ops_recreate` (an entity created again under its id, unchanged in type and ends) is kept out of it, because no delta can express that (`K-31`). `snapshot_v2` holds a snapshot text as the server encodes it, the texts no writer emits that the server reads alike (`same`) and the ones its decoder refuses in its own words (`refused`); `engine/test/snapshot/open.golden.test.ts` opens them all, cut into pieces as small as one byte. Every `observe()` of the golden runner computes its digest with the engine's own hash, so each fixture step holds it to `hashlib`.
```

In `CLAUDE.md`, replace:

```markdown
NO writer emits it yet, and `decode_snapshot` recognizes it by its first bytes,
```

with:

```markdown
NO server writer emits it yet (`scripts/snapshot_v2.py` writes one from a model file, inflated, for the engine's benchmark; the engine's `openSnapshot` reads it), and `decode_snapshot` recognizes it by its first bytes,
```

In `architecture/README.md`, replace:

```markdown
**Status:** approved 2026-09-18 · nothing built yet.
```

with:

```markdown
**Status:** approved 2026-09-18 · sub-project A built ([program.md](program.md)).
```

In `architecture/program.md`, replace:

```markdown
| A | Engine foundation | in progress — plans 1–3 of 4 landed (value layer, golden pipeline; Python snapshot v2 and digest, metamodel, store, indexes, mutation boundary; op applier, working copy) |
```

with:

```markdown
| A | Engine foundation | done — every golden fixture passes in Node; at M the engine opens a snapshot in 2.3 s of CN-3's 3 s and one open replica holds 231 MB of heap *(measured, Node 22, `pixi run engine-bench`, 2026-09-18)* |
```

In `architecture/decisions.md`, replace:

```markdown
one pass, Node 22, 2026-09-18)*. Sub-project A MUST confirm open stays within CN-3.
```

with:

```markdown
one pass, Node 22, 2026-09-18)*. Sub-project A confirmed that open stays within CN-3: from
inflated bytes to indexed replica 2.30 s — 1.73 s to decode, split, parse and load, 0.52 s to
index — against 3.14 s for the same model as one document, 2.26 s of it the exact parse
*(measured, medians of 3 in one pass, Node 22, `pixi run engine-bench`, 2026-09-18)*.
```

In `BACKLOG.md`, replace:

```markdown
A → F. A (engine foundation) is built as four plans; the first three — package, value layer
and golden-fixture pipeline; Python snapshot v2 and state digest, metamodel, record-graph
store, indexes and mutation boundary; op applier and working copy — have landed. The freeze rule (`MR-3`) covers `core/model`,
`core/metamodel` and the model-op applier from the start of A's second plan. Size: very large.
```

with:

```markdown
A → F. A (engine foundation) has landed: package, value layer and golden-fixture pipeline;
Python snapshot v2 and state digest; metamodel, record-graph store, indexes and mutation
boundary; op applier and working copy; snapshot reader, the engine's own SHA-256 digest and
the benchmark at model M (`pixi run engine-bench`: open 2.3 s of the 3 s budget). B (replica
and frontend seam) is next and inherits `K-30`, `K-31` and `K-32`. The freeze rule (`MR-3`)
covers `core/model`, `core/metamodel` and the model-op applier from the start of A's second
plan. Size: very large.
```

In `BACKLOG.md`, replace:

```markdown
that ends at its old `rev` hashes to the same `(id, rev)` pair. Fix, in B: name such ids in
both `deleted_*` and `changed_*`, or add a `recreated_*` list to the delta.
```

with:

```markdown
that ends at its old `rev` hashes to the same `(id, rev)` pair. Fix, in B: name such ids in
both `deleted_*` and `changed_*`, or add a `recreated_*` list to the delta.

### K-32 · Three engine operations run longer than one 16 ms chunk at model M · `open` · perf · *2026-09-18*
`architecture/system.md` rule 4 has the engine yield to the event loop between chunks of at
most 16 ms (CN-3). Measured at M by `pixi run engine-bench` (Node 22, medians of 3):
`rebuildIndexes()` at the end of `openSnapshot` is one 0.52 s task; `verifyDigest()` hashes
297,160 entities in 0.2 s; and the first ordered iteration after a rewind that put an entity
back at an old `ord` re-sorts the whole entity map, 58 ms against 2 ms for a plain pass. None
of it matters in Node. In the engine worker (sub-project B) the first two must run in slices
— CT-3 already says the digest check runs in the background — and the third wants an insert
in place, or a sort kept to the entities that moved. Everything else measured stays under
50 ms: a 1,000-op batch stages in 44 ms and unstages in 39 ms, 100 staged batches rebase over
a delta in 14 ms, a 149-entity delta applies in 8.9 ms.
```

- [ ] **Step 3: Commit and bring the branch home**

```bash
git add CLAUDE.md BACKLOG.md architecture
git commit -m "Close the engine foundation: snapshot reader, digest and benchmarks documented"
git switch engine-migration
git merge --ff-only feat/engine-snapshot
```

---

## After this plan

Sub-project A is done: every golden fixture passes, the invariants hold, open meets CN-3 at M. What comes next is the owner's call — sub-project B (replica and frontend seam) starts with its own brainstorm and spec (RC-9). What B inherits:

- `K-30` (the server's rollback is not exact) and `K-31` (a delta cannot say "created again") must be settled before the server serves the digest; `K-29` (an id shared by an element and a relationship) stays logged; `K-32` lists the three engine operations that outlast one 16 ms chunk at M.
- `openSnapshot` takes any `AsyncIterable<Uint8Array>`; the shell's `DecompressionStream` output needs wrapping where `ReadableStream` is not async-iterable. It never yields to the event loop on its own: a source that resolves at once keeps it in one task.
- The server's writers still emit snapshot v1; switching them to `encode_snapshot_v2` is B's, and with it `prev_rev` and `state_digest` on the commit delta.
- The merged branches `feat/engine-value-layer`, `feat/engine-store`, `feat/engine-ops` and `feat/engine-snapshot` can go once the owner says so.
