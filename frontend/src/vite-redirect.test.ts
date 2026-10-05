import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { localhostRedirectHandler } from '../vite.config';

function respond() {
	const headers: Record<string, string> = {};
	const res = {
		statusCode: 200,
		setHeader: (name: string, value: string) => void (headers[name] = value),
		end: vi.fn()
	};
	return { res: res as unknown as ServerResponse & { statusCode: number }, headers, end: res.end };
}

const request = (host: string | undefined, url = '/p/x?y=1') =>
	({ headers: { host }, url }) as unknown as IncomingMessage;

describe('localhostRedirect', () => {
	it('answers 302 to the loopback address for a localhost host', () => {
		const { res, headers, end } = respond();
		const next = vi.fn();
		localhostRedirectHandler(request('localhost:5173'), res, next);
		expect(res.statusCode).toBe(302);
		expect(headers['Location']).toBe('http://127.0.0.1:5173/p/x?y=1');
		expect(end).toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
	});

	it('passes the loopback host through', () => {
		const { res, end } = respond();
		const next = vi.fn();
		localhostRedirectHandler(request('127.0.0.1:5173'), res, next);
		expect(next).toHaveBeenCalledOnce();
		expect(end).not.toHaveBeenCalled();
	});

	it('passes a request with no host through', () => {
		const { res } = respond();
		const next = vi.fn();
		localhostRedirectHandler(request(undefined), res, next);
		expect(next).toHaveBeenCalledOnce();
	});
});
