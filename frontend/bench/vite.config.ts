import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { crossOriginIsolation } from '../vite.config.ts';

const BENCHMARKS = new URL('../../benchmarks/', import.meta.url);
const ENGINE_BENCH = new URL('../../engine/bench/', import.meta.url);

/** What the bench page reads: model M's data, and the gate's table and rules. */
const DATA: Record<string, { file: URL; type: string }> = {
	'/data/snapshot.gz': {
		file: new URL('large.snapshot.v2.gz', BENCHMARKS),
		type: 'application/gzip'
	},
	'/data/metamodel.json': {
		file: new URL('large.snapshot.v2.metamodel.json', BENCHMARKS),
		type: 'application/json'
	},
	'/data/table.json': {
		file: new URL('big-table.json', ENGINE_BENCH),
		type: 'application/json'
	},
	'/data/rules.json': {
		file: new URL('large.rules.json', BENCHMARKS),
		type: 'application/json'
	}
};

/**
 * The snapshot as the server serves it: its gzip bytes with their length and
 * no `Content-Encoding`, so the browser hands them over as they are.
 */
function benchData(): Plugin {
	const serve: Connect.NextHandleFunction = (req, res, next) => {
		const entry = req.method === 'GET' ? DATA[req.url ?? ''] : undefined;
		if (entry === undefined) return next();
		const path = fileURLToPath(entry.file);
		res.setHeader('Content-Type', entry.type);
		res.setHeader('Content-Length', String(statSync(path).size));
		res.setHeader('Cache-Control', 'no-store');
		createReadStream(path).pipe(res);
	};
	return {
		name: 'bench-data',
		configureServer(server) {
			server.middlewares.use(serve);
		}
	};
}

export default defineConfig({
	root: 'bench',
	plugins: [crossOriginIsolation(), benchData()],
	resolve: {
		alias: { $lib: fileURLToPath(new URL('../src/lib', import.meta.url)) }
	},
	server: { host: '127.0.0.1', port: 5173, strictPort: true }
});
