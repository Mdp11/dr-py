import { z } from 'zod';
import { apiFetch } from './client';

const API = { baseUrl: '/api/v1' };

export const MeSchema = z.object({
	user_id: z.string(),
	email: z.string(),
	is_admin: z.boolean()
});
export type Me = z.infer<typeof MeSchema>;

export function login(email: string, password: string): Promise<Me> {
	return apiFetch(
		'/auth/login',
		{ method: 'POST', body: { email, password }, schema: MeSchema },
		API
	);
}

export function logout(): Promise<void> {
	return apiFetch('/auth/logout', { method: 'POST' }, API);
}

export function me(): Promise<Me> {
	return apiFetch('/auth/me', { method: 'GET', schema: MeSchema }, API);
}

export function changePassword(oldPassword: string, newPassword: string): Promise<void> {
	return apiFetch(
		'/auth/change-password',
		{ method: 'POST', body: { old_password: oldPassword, new_password: newPassword } },
		API
	);
}
