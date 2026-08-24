import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { lintRules } from '../rules';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('rules client', () => {
	it('posts the YAML in a JSON envelope and parses positioned errors', async () => {
		server.use(
			http.post(`${BASE}/rules/lint`, async ({ request }) => {
				expect(request.headers.get('content-type')).toContain('application/json');
				expect(await request.json()).toEqual({ yaml: 'rules: [ {' });
				return HttpResponse.json({
					ok: false,
					errors: [{ message: 'Malformed rules YAML', line: 1, column: 11 }]
				});
			})
		);
		const res = await lintRules('rules: [ {', cfg);
		expect(res.ok).toBe(false);
		expect(res.errors[0]).toEqual({ message: 'Malformed rules YAML', line: 1, column: 11 });
		// Absent on the wire, empty here — a parse failure reports no drift.
		expect(res.warnings).toEqual([]);
	});

	it('defaults a message-only schema error to a null position', async () => {
		// Only a YAML PARSE error carries a parser mark; a schema violation
		// legitimately arrives without one.
		server.use(
			http.post(`${BASE}/rules/lint`, () =>
				HttpResponse.json({ ok: false, errors: [{ message: 'Invalid rule set: …' }] })
			)
		);
		const res = await lintRules('rules: [{}]\n', cfg);
		expect(res.errors[0]).toEqual({ message: 'Invalid rule set: …', line: null, column: null });
	});

	it('keeps drift as a warning, leaving ok true', async () => {
		server.use(
			http.post(`${BASE}/rules/lint`, () =>
				HttpResponse.json({
					ok: true,
					warnings: [{ rule: 'sensor-has-owner', message: "unknown stereotype 'Sensor'" }]
				})
			)
		);
		const res = await lintRules('rules: []\n', cfg);
		// Drift is a degradation, not invalidity.
		expect(res.ok).toBe(true);
		expect(res.errors).toEqual([]);
		expect(res.warnings[0].rule).toBe('sensor-has-owner');
	});
});
