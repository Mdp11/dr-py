import { redirect } from '@sveltejs/kit';
import { fetchMe } from '$lib/state/auth.svelte';
import { guardDecision } from './guard';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = async ({ url }) => {
	const me = await fetchMe();
	const { redirectTo } = guardDecision(url.pathname, me);
	if (redirectTo && redirectTo !== url.pathname) throw redirect(307, redirectTo);
	return { me };
};
