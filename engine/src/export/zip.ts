/**
 * Zips an export's files — a split export's, an exporter run's, a workbook's
 * parts — in steps, a port of `table_export_engine.build_zip`. `fflate` is
 * the engine's one runtime dependency: pure JS, its sync API spawns no
 * workers, so `src/`'s no-Node-no-DOM rule holds.
 *
 * The archive is laid out as `fflate`'s `zipSync` lays it out: each member's
 * local header carries its CRC-32 and sizes (no data descriptor), `zlib`
 * level 6, every modified time 1980-01-01 00:00, the UTF-8 flag on a
 * non-ASCII name, then the central directory in member order. A member of
 * at most `PUSH_BYTES` is deflated in one `deflateSync` call, as `zipSync`
 * deflates it, so such a member's bytes are `zipSync`'s; a longer one goes
 * through a streaming `Deflate` in pushes of exactly `PUSH_BYTES`, the last
 * one shorter. Every cut is a count of bytes or code units: the meter only
 * says where a step ends, never where a chunk does, so the bytes never
 * depend on the steps.
 */
import { Deflate, deflateSync } from 'fflate';
import { Meter } from '../navigation/evaluate.ts';
import { drain, type Steps } from '../steps/steps.ts';
import { utf8Encoder } from './utf8.ts';

export type ZipFile = { path: string; bytes: Uint8Array };

/**
 * A member written from text: `pieces` read once and encoded as UTF-8 in
 * order. No piece ends inside a surrogate pair, so encoding them in groups
 * writes the bytes their concatenation encodes to.
 */
export type ZipText = { path: string; pieces: Iterable<string> };

export type ZipMember = ZipFile | ZipText;

/** The input one deflate push takes, and the most a member deflated in one call holds. */
const PUSH_BYTES = 64 * 1024;
/** Text gathered, in UTF-16 code units, before it is encoded. */
const TEXT_UNITS = 16 * 1024;
/** Meter units: one per this many bytes deflated, a whole push a step's worth. */
const BYTES_A_UNIT = 64;
/** Meter units a member costs beyond its bytes: `deflateSync`'s tables, its name. */
const MEMBER_UNITS = 16;
/** Meter units: one per this many bytes copied into the archive. */
const COPY_BYTES_A_UNIT = 4096;
/** A streamed member's hash table: 2^20 entries, what `deflateSync` takes past ~430 KiB. */
const STREAM_MEM = 8;

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
/** 1980-01-01 as a DOS date; its time, 00:00, is 0. */
const DOS_DATE = (1 << 5) | 1;
const UTF8_FLAG = 0x800;
const DEFLATED = 8;
const VERSION = 20;

let crcTable: Int32Array | undefined;

/** The CRC-32 (ISO-HDLC) of `bytes`, continued from `crc`. */
function crc32(crc: number, bytes: Uint8Array): number {
	if (crcTable === undefined) {
		crcTable = new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c;
		}
	}
	let c = ~crc;
	for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return ~c >>> 0;
}

/** Counts `units` of work on `meter`; true when the step is full and must end. */
function charge(meter: Meter, units: number): boolean {
	meter.done += units - 1;
	return meter.tick();
}

/** `bytes` in slices of at most `PUSH_BYTES`. */
function* slices(bytes: Uint8Array): Generator<Uint8Array> {
	for (let at = 0; at < bytes.length; at += PUSH_BYTES) {
		yield bytes.subarray(at, at + PUSH_BYTES);
	}
}

/** A member's bytes in slices of at most `PUSH_BYTES`, text encoded a group of pieces at a time. */
function* memberBytes(member: ZipMember): Generator<Uint8Array> {
	if ('bytes' in member) {
		yield* slices(member.bytes);
		return;
	}
	const encoder = utf8Encoder();
	let group: string[] = [];
	let units = 0;
	for (const piece of member.pieces) {
		group.push(piece);
		units += piece.length;
		if (units >= TEXT_UNITS) {
			yield* slices(encoder.encode(group.join('')));
			group = [];
			units = 0;
		}
	}
	if (group.length > 0) yield* slices(encoder.encode(group.join('')));
}

/** One member deflated: its encoded name, CRC-32, sizes and compressed chunks. */
type Deflated = {
	name: Uint8Array;
	utf8: boolean;
	crc: number;
	size: number;
	compressed: number;
	chunks: Uint8Array[];
};

/**
 * A member's bytes deflated as they come: held until more than `PUSH_BYTES`
 * are, then pushed `PUSH_BYTES` at a time, so the pushes are cut by byte
 * counts alone. A member that never outgrows one push is deflated whole.
 */
class MemberDeflater {
	crc = 0;
	size = 0;
	compressed = 0;
	readonly chunks: Uint8Array[] = [];
	private held: Uint8Array[] = [];
	private heldBytes = 0;
	private stream: Deflate | null = null;

	/** Takes a slice of at most `PUSH_BYTES`; the bytes it deflated. */
	write(bytes: Uint8Array): number {
		this.crc = crc32(this.crc, bytes);
		this.size += bytes.length;
		this.held.push(bytes);
		this.heldBytes += bytes.length;
		if (this.heldBytes <= PUSH_BYTES) return 0;
		this.push(this.take(PUSH_BYTES), false);
		return PUSH_BYTES;
	}

	/** Deflates what is held; the bytes it deflated. */
	end(): number {
		const rest = this.heldBytes;
		const last = this.take(rest);
		if (this.stream === null) this.collect(deflateSync(last, { level: 6 }));
		else this.push(last, true);
		return rest;
	}

	private push(bytes: Uint8Array, final: boolean): void {
		this.stream ??= new Deflate({ level: 6, mem: STREAM_MEM }, (chunk) => this.collect(chunk));
		this.stream.push(bytes, final);
	}

	private collect(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.compressed += chunk.length;
	}

	/** The first `n` bytes held, taken out. */
	private take(n: number): Uint8Array {
		const first = this.held[0];
		if (first !== undefined && first.length === n) {
			this.held.shift();
			this.heldBytes -= n;
			return first;
		}
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const next = this.held[0]!;
			const used = Math.min(next.length, n - at);
			out.set(next.subarray(0, used), at);
			at += used;
			if (used === next.length) this.held.shift();
			else this.held[0] = next.subarray(used);
		}
		this.heldBytes -= n;
		return out;
	}
}

function* deflateMember(member: ZipMember, meter: Meter): Steps<Deflated> {
	const name = utf8Encoder().encode(member.path);
	if (name.length > 0xffff) throw new Error(`zip entry path is too long: ${member.path}`);
	const deflater = new MemberDeflater();
	for (const bytes of memberBytes(member)) {
		const pushed = deflater.write(bytes);
		if (pushed > 0 && charge(meter, pushed / BYTES_A_UNIT)) yield meter.end();
	}
	const last = deflater.end();
	if (charge(meter, MEMBER_UNITS + Math.ceil(last / BYTES_A_UNIT))) yield meter.end();
	return {
		name,
		utf8: name.length !== member.path.length,
		crc: deflater.crc,
		size: deflater.size,
		compressed: deflater.compressed,
		chunks: deflater.chunks
	};
}

/** The fields a local header and its central directory record share, from `at` on. */
function writeCommon(view: DataView, at: number, member: Deflated): void {
	view.setUint16(at, member.utf8 ? UTF8_FLAG : 0, true);
	view.setUint16(at + 2, DEFLATED, true);
	view.setUint16(at + 4, 0, true);
	view.setUint16(at + 6, DOS_DATE, true);
	view.setUint32(at + 8, member.crc, true);
	view.setUint32(at + 12, member.compressed, true);
	view.setUint32(at + 16, member.size, true);
	view.setUint16(at + 20, member.name.length, true);
}

/**
 * `members` zipped in the given order, a step every so many bytes deflated
 * or copied. Nothing is returned before the last step.
 */
export function* zipSteps(members: readonly ZipMember[], meter: Meter): Steps<Uint8Array> {
	const deflated: Deflated[] = [];
	for (const member of members) deflated.push(yield* deflateMember(member, meter));

	let localBytes = 0;
	let centralBytes = 0;
	for (const member of deflated) {
		localBytes += LOCAL_HEADER + member.name.length + member.compressed;
		centralBytes += CENTRAL_HEADER + member.name.length;
	}
	const out = new Uint8Array(localBytes + centralBytes + END_RECORD);
	const view = new DataView(out.buffer);
	const offsets: number[] = [];
	let at = 0;
	for (const member of deflated) {
		offsets.push(at);
		view.setUint32(at, 0x04034b50, true);
		view.setUint16(at + 4, VERSION, true);
		writeCommon(view, at + 6, member);
		out.set(member.name, at + LOCAL_HEADER);
		at += LOCAL_HEADER + member.name.length;
		for (const chunk of member.chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		if (charge(meter, 1 + Math.floor(member.compressed / COPY_BYTES_A_UNIT))) yield meter.end();
	}
	for (const [i, member] of deflated.entries()) {
		view.setUint32(at, 0x02014b50, true);
		view.setUint16(at + 4, VERSION, true);
		view.setUint16(at + 6, VERSION, true);
		writeCommon(view, at + 8, member);
		view.setUint32(at + 42, offsets[i]!, true);
		out.set(member.name, at + CENTRAL_HEADER);
		at += CENTRAL_HEADER + member.name.length;
		if (meter.tick()) yield meter.end();
	}
	view.setUint32(at, 0x06054b50, true);
	view.setUint16(at + 8, deflated.length, true);
	view.setUint16(at + 10, deflated.length, true);
	view.setUint32(at + 12, centralBytes, true);
	view.setUint32(at + 16, localBytes, true);
	return out;
}

/** `members` zipped at once. */
export function zipEntries(members: readonly ZipMember[]): Uint8Array {
	return drain(zipSteps(members, new Meter(0)));
}
