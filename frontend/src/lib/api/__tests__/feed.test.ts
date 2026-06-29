import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectFeed, defaultFeedUrl, type FeedEvent, type WebSocketLike } from '../feed';

describe('defaultFeedUrl', () => {
	it('is project-scoped and carries no identity query params', () => {
		const url = defaultFeedUrl('proj-7');
		expect(url).toContain('/api/v1/projects/proj-7/feed');
		// Identity rides the httpOnly session cookie on the same-origin upgrade,
		// so the URL must carry no query string (no identity params) at all.
		expect(url).not.toContain('?');
	});
});

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

	it('treats a permanent close code (4403) as terminal: no reconnect, onTerminal fired once', () => {
		vi.useFakeTimers();
		const terminal: number[] = [];
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			onTerminal: (code) => terminal.push(code),
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		first.emit('close', { code: 4403 });
		vi.advanceTimersByTime(1000);
		expect(FakeSocket.last).toBe(first); // no reconnect after a permanent close
		expect(terminal).toEqual([4403]);
		vi.useRealTimers();
	});

	it.each([4401, 4404])('treats close code %i as terminal', (code) => {
		vi.useFakeTimers();
		const terminal: number[] = [];
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			onTerminal: (c) => terminal.push(c),
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		first.emit('close', { code });
		vi.advanceTimersByTime(1000);
		expect(FakeSocket.last).toBe(first);
		expect(terminal).toEqual([code]);
		vi.useRealTimers();
	});

	it('reconnects on a normal close code without firing onTerminal', () => {
		vi.useFakeTimers();
		const terminal: number[] = [];
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			onTerminal: (c) => terminal.push(c),
			reconnect: { baseMs: 10, maxMs: 100 }
		});
		const first = FakeSocket.last!;
		first.open();
		first.emit('close', { code: 1006 });
		vi.advanceTimersByTime(10);
		expect(FakeSocket.last).not.toBe(first); // reconnected
		expect(terminal).toEqual([]);
		vi.useRealTimers();
	});

	it('reconnects on 4408 (dropped-behind) until N consecutive retries, then goes terminal', () => {
		vi.useFakeTimers();
		const terminal: number[] = [];
		connectFeed({
			url: 'ws://x/feed',
			socketFactory: (u) => new FakeSocket(u),
			onEvent: () => {},
			onStatus: () => {},
			onTerminal: (c) => terminal.push(c),
			reconnect: { baseMs: 1, maxMs: 1 }
		});
		// Each 4408 close (without an intervening successful open that would reset
		// `attempt`) should reconnect for the first N tries, then give up.
		let sock = FakeSocket.last!;
		for (let i = 0; i < 5; i++) {
			sock.emit('close', { code: 4408 });
			vi.advanceTimersByTime(1);
			sock = FakeSocket.last!;
		}
		// 5 reconnects happened; the next 4408 (attempt has climbed to the limit)
		// is terminal.
		const beforeTerminal = FakeSocket.last!;
		beforeTerminal.emit('close', { code: 4408 });
		vi.advanceTimersByTime(1000);
		expect(FakeSocket.last).toBe(beforeTerminal); // no further reconnect
		expect(terminal).toEqual([4408]);
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
