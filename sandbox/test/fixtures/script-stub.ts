// A worker_threads peer that speaks the script worker's protocol over the real
// reply buffer and the real wire format, with a scripted "guest": what a run
// does is named by the batch's `code`. It stands where Pyodide stands in the
// browser, so the host's side of the protocol can be driven without a browser.
import { parentPort, workerData } from 'node:worker_threads';
import { dumpDefault } from '../../../engine/src/script/bridge.ts';
import { armReply, readReply } from '../../../engine/src/script/bridge-buffer.ts';
import { batchFromWire, type WireBatch } from '../../../engine/src/script/wire.ts';

const port = parentPort;
if (port === null) throw new Error('script-stub runs as a worker');

const mode = (workerData as { mode: string }).mode;
const decoder = new TextDecoder('utf-8', { fatal: true });
let reply: SharedArrayBuffer | null = null;
let trips = 0;

function transport(text: string): string {
	if (reply === null) throw new Error('not initialised');
	trips++;
	armReply(reply);
	port!.postMessage({ type: 'bridge', text });
	return decoder.decode(readReply(reply, () => port!.postMessage({ type: 'more' })));
}

function blockForever(): never {
	const cell = new Int32Array(new SharedArrayBuffer(4));
	for (;;) Atomics.wait(cell, 0, 0);
}

function results(batch: WireBatch, roots: string[]): { text: string }[] {
	const calls = batchFromWire(batch).calls;
	switch (batch.code) {
		case 'echo':
			return calls.map((call, i) => ({
				text: `${transport(`req:${call.elementIds.join(',')}`)}|${roots[i]}`
			}));
		case 'big':
			return [{ text: transport('big') }];
		case 'slow': {
			const start = Date.now();
			while (Date.now() < start + 150);
			return [{ text: `${start},${Date.now()}` }];
		}
		case 'floats':
			return [
				{
					text: dumpDefault(calls.map((call) => [call.inputs ?? null, call.doc ?? null]))
				}
			];
		case 'violation':
			port!.postMessage({ type: 'csp-violation', directive: 'script-src', blocked: 'eval' });
			port!.postMessage({ type: 'csp-violation', directive: 7 });
			return [];
		case 'hang':
			transport('about to hang');
			return blockForever();
		case 'crash':
			throw new Error('boom');
		case 'fail':
			port!.postMessage({ type: 'failed', message: 'the guest broke' });
			return blockForever();
		default:
			throw new Error(`unknown script ${batch.code}`);
	}
}

port.on('message', (message: { type: string; [key: string]: unknown }) => {
	if (message.type === 'init') {
		reply = message.reply as SharedArrayBuffer;
		if (mode === 'silent') return;
		if (mode === 'failed') port.postMessage({ type: 'failed', message: 'pyodide did not boot' });
		else if (mode === 'crash') throw new Error('crashed at boot');
		else port.postMessage({ type: 'ready', ms: 7 });
	} else if (message.type === 'run') {
		trips = 0;
		const out = results(message.batch as WireBatch, message.roots as string[]);
		port.postMessage({ type: 'done', run: message.run, results: out, trips, ms: 3 });
	}
});
