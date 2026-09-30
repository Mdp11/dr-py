import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build, createServer, preview, type PreviewServer, type ViteDevServer } from 'vite';

import { PYODIDE_FILES } from '../vite.config.ts';

const PACKAGE = join(process.cwd(), 'node_modules', 'pyodide');
const CSP =
	"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; frame-ancestors http://127.0.0.1:5173";

let outDir = '';
let dev: ViteDevServer;
let previewServer: PreviewServer;

function originOf(server: { httpServer: { address(): unknown } | null }): string {
	const address = server.httpServer?.address() as AddressInfo | null | undefined;
	if (!address) throw new Error('the server is not listening');
	return `http://localhost:${address.port}`;
}

beforeAll(async () => {
	outDir = mkdtempSync(join(tmpdir(), 'sandbox-pyodide-'));
	await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } });
	dev = await createServer({ logLevel: 'silent', server: { port: 0, strictPort: false } });
	await dev.listen();
	previewServer = await preview({
		logLevel: 'silent',
		build: { outDir },
		preview: { port: 0, strictPort: false }
	});
}, 120_000);

afterAll(async () => {
	await dev?.close();
	await previewServer?.close();
	if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
});

// `fetch` normalizes dot segments away; this sends the path as written.
function statusOf(origin: string, path: string): Promise<number> {
	return new Promise((done, fail) => {
		const { hostname, port } = new URL(origin);
		const req = request({ hostname, port, path, method: 'GET' }, (res) => {
			res.resume();
			done(res.statusCode ?? 0);
		});
		req.on('error', fail);
		req.end();
	});
}

function expectIsolated(res: Response): void {
	expect(res.headers.get('content-security-policy')).toBe(CSP);
	expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
	expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
}

describe('PYODIDE_FILES', () => {
	it('names the five files the script worker loads', () => {
		expect([...PYODIDE_FILES].sort()).toEqual([
			'pyodide-lock.json',
			'pyodide.asm.mjs',
			'pyodide.asm.wasm',
			'pyodide.mjs',
			'python_stdlib.zip'
		]);
	});
});

describe('the build', () => {
	it('copies exactly the five files, byte for byte', () => {
		const copied = readdirSync(join(outDir, 'pyodide')).sort();
		expect(copied).toEqual([...PYODIDE_FILES].sort());
		for (const name of PYODIDE_FILES) {
			expect(statSync(join(outDir, 'pyodide', name)).size).toBe(statSync(join(PACKAGE, name)).size);
		}
	});
});

describe.each([
	['vite dev', () => originOf(dev)],
	['the built site under vite preview', () => originOf(previewServer)]
])('%s', (_name, origin) => {
	it.each(PYODIDE_FILES)('serves /pyodide/%s with the isolation headers', async (name) => {
		const res = await fetch(`${origin()}/pyodide/${name}`);
		expect(res.status).toBe(200);
		expectIsolated(res);
		const body = await res.arrayBuffer();
		expect(body.byteLength).toBe(statSync(join(PACKAGE, name)).size);
	});

	it('types the assets', async () => {
		const wasm = await fetch(`${origin()}/pyodide/pyodide.asm.wasm`);
		expect(wasm.headers.get('content-type')).toBe('application/wasm');
		const module = await fetch(`${origin()}/pyodide/pyodide.mjs`);
		expect(module.headers.get('content-type')).toMatch(/javascript/);
	});

	it.each([
		'/pyodide/package.json',
		'/pyodide/pyodide.js',
		'/pyodide/pyodide.d.ts',
		'/pyodide/',
		'/pyodide',
		'/pyodide/../package.json',
		'/pyodide/%2e%2e/package.json',
		'/pyodide/..%2fpackage.json',
		'/pyodide/pyodide.mjs/../package.json',
		'/pyodide/nested/pyodide.mjs'
	])('answers 404 for %s', async (path) => {
		expect(await statusOf(origin(), path)).toBe(404);
	});
});
