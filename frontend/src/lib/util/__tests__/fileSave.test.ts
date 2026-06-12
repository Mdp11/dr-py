import { describe, expect, it } from 'vitest';
import { saveResponseToFile } from '../fileSave';

/** Fake FileSystemFileHandle whose writable collects everything written. */
function makeHandle(name: string): {
	handle: FileSystemFileHandle;
	written: () => string;
	closed: () => boolean;
} {
	const chunks: Uint8Array[] = [];
	let closedFlag = false;
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			chunks.push(chunk);
		},
		close() {
			closedFlag = true;
		}
	});
	// add the FileSystemWritableFileStream write() used by the blob fallback
	const fsWritable = writable as WritableStream<Uint8Array> & {
		write: (data: Blob) => Promise<void>;
		close: () => Promise<void>;
	};
	const writer = { current: null as WritableStreamDefaultWriter<Uint8Array> | null };
	fsWritable.write = async (data: Blob) => {
		writer.current ??= writable.getWriter();
		await writer.current.write(new Uint8Array(await data.arrayBuffer()));
	};
	fsWritable.close = async () => {
		writer.current ??= writable.getWriter();
		await writer.current.close();
	};
	const handle = {
		name,
		createWritable: async () => fsWritable
	} as unknown as FileSystemFileHandle;
	return {
		handle,
		written: () => {
			const total = chunks.reduce((n, c) => n + c.length, 0);
			const buf = new Uint8Array(total);
			let off = 0;
			for (const c of chunks) {
				buf.set(c, off);
				off += c.length;
			}
			return new TextDecoder().decode(buf);
		},
		closed: () => closedFlag
	};
}

describe('saveResponseToFile', () => {
	it('pipes the response body into the handle writable (streaming path)', async () => {
		const { handle, written, closed } = makeHandle('model.json');
		const response = new Response('{"elements": []}');
		const result = await saveResponseToFile(response, 'ignored.json', handle);
		expect(result).toEqual({ filename: 'model.json', handle });
		expect(written()).toBe('{"elements": []}');
		expect(closed()).toBe(true);
	});

	it('falls back to blob() when the response has no pipeable body', async () => {
		const { handle, written, closed } = makeHandle('model.json');
		// a Response whose body is consumed via blob(): simulate the no-pipeTo
		// environment by nulling out the stream
		const raw = new Response('{"relationships": []}');
		const fake = {
			body: null,
			blob: () => raw.blob()
		} as unknown as Response;
		const result = await saveResponseToFile(fake, 'ignored.json', handle);
		expect(result.filename).toBe('model.json');
		expect(written()).toBe('{"relationships": []}');
		expect(closed()).toBe(true);
	});
});
