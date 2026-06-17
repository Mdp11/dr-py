import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectFeed, type FeedEvent, type WebSocketLike } from '../feed';

class FakeSocket implements WebSocketLike {
	readyState = 0;
	listeners: Record<string, ((e: unknown) => void)[]> = {};
	closed = false;
	static last: FakeSocket | null = null;
	constructor(public url: string) {
		FakeSocket.last = this;
	}
	addEventListener(type: string, cb: (e: unknown) => void): void {
		(this.listeners[type] ??= []).push(cb);
	}
	close(): void {
		this.closed = true;
		this.emit('close', {});
	}
	emit(type: string, e: unknown): void {
		for (const cb of this.listeners[type] ?? []) cb(e);
	}
	open(): void {
		this.readyState = 1;
		this.emit('open', {});
	}
	message(data: unknown): void {
		this.emit('message', { data: JSON.stringify(data) });
	}
}

afterEach(() => vi.restoreAllMocks());

describe('connectFeed', () => {
	it('reports open status and parses events', () => {
		const events: FeedEvent[] = [];
		const statuses: boolean[] = [];
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: (e) => events.push(e),
			onStatus: (s) => statuses.push(s)
		});
		const sock = FakeSocket.last!;
		sock.open();
		sock.message({ type: 'presence', action: 'join', user_id: 'bob', connected: ['bob'] });
		expect(statuses).toEqual([true]);
		expect(events[0]).toMatchObject({ type: 'presence', user_id: 'bob' });
	});

	it('reconnects after an unexpected close', () => {
		vi.useFakeTimers();
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		first.emit('close', {});
		vi.advanceTimersByTime(10);
		expect(FakeSocket.last).not.toBe(first); // a new socket was created
		vi.useRealTimers();
	});

	it('close() stops reconnection', () => {
		vi.useFakeTimers();
		const conn = connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		conn.close();
		first.emit('close', {});
		vi.advanceTimersByTime(1000);
		expect(FakeSocket.last).toBe(first); // no reconnect after explicit close
		vi.useRealTimers();
	});
});
