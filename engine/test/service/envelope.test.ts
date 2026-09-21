import { describe, expect, it } from 'vitest';
import { connect, refusal, settle } from './helpers.ts';

describe('the envelope', () => {
	it('answers with the id of the request', async () => {
		const client = connect();
		expect(await client.callAs('a-string', 'staged')).toEqual([]);
		expect(await client.callAs(7, 'staged')).toEqual([]);
		expect(client.answers).toEqual([
			{ id: 'a-string', ok: true, result: [] },
			{ id: 7, ok: true, result: [] }
		]);
	});

	it('ignores a message without an id or a method', async () => {
		const client = connect();
		client.post({ method: 'staged' });
		client.post({ id: 3 });
		client.post({ id: 4, method: 7 });
		client.post('noise');
		client.post(null);
		await settle();
		expect(client.answers).toEqual([]);
		expect(await client.call('staged')).toEqual([]);
	});

	it('answers an unknown method with 404', async () => {
		const client = connect();
		expect(await refusal(client.call('frobnicate'))).toEqual({
			status: 404,
			detail: "No method 'frobnicate'"
		});
	});

	it('answers a bug with 500 and its message, and serves the next request', async () => {
		const client = connect();
		const params = new Proxy(
			{},
			{
				get() {
					throw new Error('boom');
				}
			}
		);
		expect(await refusal(client.call('open', params))).toEqual({ status: 500, detail: 'boom' });
		expect(await client.call('staged')).toEqual([]);
	});
});
