// A worker_threads stand-in for the script worker's side of the reply buffer:
// on each `read` it arms, posts `bridge`, optionally stays busy so the reply
// lands before it waits, then blocks in `readReply` and posts the bytes back.
import { parentPort, workerData } from 'node:worker_threads';
import { armReply, readReply } from '../../../src/script/bridge-buffer.ts';

const buffer = (workerData as { buffer: SharedArrayBuffer }).buffer;
const port = parentPort;
if (port === null) throw new Error('buffer-reader runs as a worker');

port.on('message', (message: { type: 'read'; spinMs?: number }) => {
	armReply(buffer);
	port.postMessage({ type: 'bridge' });
	if (message.spinMs !== undefined) {
		const until = performance.now() + message.spinMs;
		while (performance.now() < until);
	}
	const bytes = readReply(buffer, () => port.postMessage({ type: 'more' }));
	port.postMessage({ type: 'reply', bytes });
});
