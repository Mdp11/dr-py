import type { Me } from '$lib/api/auth';

export interface GuardDecision {
	redirectTo: string | null;
}

/** Pure guard: where (if anywhere) to redirect given the path and current user.
 * - unauthenticated (me=null) anywhere except /login → /login
 * - authenticated on /login → /projects
 * - non-admin on /admin* → /projects
 */
export function guardDecision(pathname: string, me: Me | null): GuardDecision {
	const onLogin = pathname === '/login';
	if (!me) return { redirectTo: onLogin ? null : '/login' };
	if (onLogin) return { redirectTo: '/projects' };
	if (pathname.startsWith('/admin') && !me.is_admin) return { redirectTo: '/projects' };
	return { redirectTo: null };
}
