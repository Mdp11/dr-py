import { describe, expect, it } from 'vitest';
import { EngineUnavailableError } from '$lib/api/engine-route';
import { createGate, type GateState } from '../gate';

const OPEN: GateState = { state: 'open' };
const CLOSED: GateState = { state: 'closed' };
const FAILED: GateState = { state: 'unavailable', reason: 'the replica failed' };

/** A gate over a state the test moves. */
function gateOver(initial: GateState) {
	const current = { state: initial };
	const gate = createGate(() => current.state);
	return {
		gate,
		move(next: GateState) {
			current.state = next;
			gate.moved();
		}
	};
}

/** Lets the microtasks a settled promise has queued run: none of them waits on a timer. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe('the gate', () => {
	it('an open gate resolves at once', async () => {
		await expect(gateOver(OPEN).gate.whenReady()).resolves.toBeUndefined();
	});

	it('an unavailable gate rejects at once with its reason', async () => {
		const rejected = gateOver(FAILED).gate.whenReady();
		await expect(rejected).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(rejected).rejects.toThrow('the replica failed');
	});

	it('a closed gate holds every caller until it opens', async () => {
		const { gate, move } = gateOver(CLOSED);
		const opened: number[] = [];
		const first = gate.whenReady().then(() => opened.push(1));
		const second = gate.whenReady().then(() => opened.push(2));
		await settle();
		expect(opened).toEqual([]);

		move(OPEN);
		await Promise.all([first, second]);
		expect(opened).toEqual([1, 2]);
	});

	it('callers of one epoch share a promise, the next epoch gets another', async () => {
		const { gate, move } = gateOver(CLOSED);
		const a = gate.whenReady();
		const b = gate.whenReady();
		expect(a).toBe(b);

		move(OPEN);
		await a;
		move(CLOSED);
		const c = gate.whenReady();
		expect(c).not.toBe(a);

		move(OPEN);
		await c;
	});

	it('a state that stays closed holds the callers', async () => {
		const { gate, move } = gateOver(CLOSED);
		let settled = false;
		const held = gate.whenReady().then(() => (settled = true));
		move(CLOSED);
		await settle();
		expect(settled).toBe(false);

		move(OPEN);
		await held;
		expect(settled).toBe(true);
	});

	it('a gate that becomes unavailable rejects every waiting caller', async () => {
		const { gate, move } = gateOver(CLOSED);
		const first = gate.whenReady();
		const second = gate.whenReady(new AbortController().signal);

		move(FAILED);

		await expect(first).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(second).rejects.toThrow('the replica failed');
	});

	it('after an epoch rejected, a later open gate resolves again', async () => {
		const { gate, move } = gateOver(CLOSED);
		const failed = gate.whenReady();
		move(FAILED);
		await expect(failed).rejects.toBeInstanceOf(EngineUnavailableError);

		move(OPEN);
		await expect(gate.whenReady()).resolves.toBeUndefined();
	});

	it('moving with nobody waiting changes nothing', async () => {
		const { gate, move } = gateOver(CLOSED);
		move(FAILED);
		move(OPEN);
		await expect(gate.whenReady()).resolves.toBeUndefined();
	});

	it('an aborted signal rejects its caller alone, at once and while waiting', async () => {
		const { gate, move } = gateOver(CLOSED);
		const early = new AbortController();
		early.abort();
		await expect(gate.whenReady(early.signal)).rejects.toMatchObject({ name: 'AbortError' });

		const late = new AbortController();
		const waiting = gate.whenReady(late.signal);
		const other = gate.whenReady();
		late.abort();
		await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

		move(OPEN);
		await expect(other).resolves.toBeUndefined();
	});

	it('a signal that never aborts leaves nothing behind once the gate opens', async () => {
		const { gate, move } = gateOver(CLOSED);
		const controller = new AbortController();
		const held = gate.whenReady(controller.signal);
		move(OPEN);
		await held;
		controller.abort();
		await expect(held).resolves.toBeUndefined();
	});
});
