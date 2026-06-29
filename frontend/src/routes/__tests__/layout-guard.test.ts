import { describe, expect, it } from 'vitest';
import { guardDecision } from '../guard';

const admin = { user_id: 'a', email: 'a@x', is_admin: true };
const user = { user_id: 'u', email: 'u@x', is_admin: false };

describe('guardDecision', () => {
	it('redirects anonymous to /login', () => {
		expect(guardDecision('/projects', null).redirectTo).toBe('/login');
		expect(guardDecision('/login', null).redirectTo).toBeNull();
	});
	it('bounces a logged-in user off /login', () => {
		expect(guardDecision('/login', user).redirectTo).toBe('/projects');
	});
	it('blocks non-admins from /admin', () => {
		expect(guardDecision('/admin', user).redirectTo).toBe('/projects');
		expect(guardDecision('/admin', admin).redirectTo).toBeNull();
	});
	it('allows a normal page', () => {
		expect(guardDecision('/p/x', user).redirectTo).toBeNull();
	});
});
