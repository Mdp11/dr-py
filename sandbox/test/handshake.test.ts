import { afterEach, describe, expect, it } from 'vitest';
import { connectPort } from '../src/handshake.ts';

const APP = 'http://127.0.0.1:5173';
const parent = {};
const expected = { origin: APP, parent };

const channels: MessageChannel[] = [];

function ports(n: number): MessagePort[] {
	const out: MessagePort[] = [];
	for (let i = 0; i < n; i++) {
		const channel = new MessageChannel();
		channels.push(channel);
		out.push(channel.port1);
	}
	return out;
}

function event(overrides: Partial<{ origin: string; source: unknown; data: unknown; n: number }>) {
	return {
		origin: overrides.origin ?? APP,
		source: 'source' in overrides ? overrides.source : parent,
		data: 'data' in overrides ? overrides.data : { type: 'connect' },
		ports: ports(overrides.n ?? 1)
	};
}

afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
});

describe('connectPort', () => {
	it('returns the port of a connect from the parent at the app origin', () => {
		const e = event({});
		expect(connectPort(e, expected)).toBe(e.ports[0]);
	});

	it('refuses another origin', () => {
		expect(connectPort(event({ origin: 'http://localhost:5173' }), expected)).toBeNull();
	});

	it('refuses another source', () => {
		expect(connectPort(event({ source: {} }), expected)).toBeNull();
		expect(connectPort(event({ source: null }), expected)).toBeNull();
	});

	it('refuses another type', () => {
		expect(connectPort(event({ data: { type: 'port' } }), expected)).toBeNull();
		expect(connectPort(event({ data: {} }), expected)).toBeNull();
	});

	it('refuses no port and two ports', () => {
		expect(connectPort(event({ n: 0 }), expected)).toBeNull();
		expect(connectPort(event({ n: 2 }), expected)).toBeNull();
	});

	it('refuses data that is not an object', () => {
		for (const data of [null, undefined, 'connect', 1, true]) {
			expect(connectPort(event({ data }), expected)).toBeNull();
		}
	});
});
