import { z } from 'zod';
import { apiFetch } from './client';

const API = { baseUrl: '/api/v1' };

export const AdminUserSchema = z.object({
	id: z.string(),
	email: z.string(),
	is_admin: z.boolean(),
	is_active: z.boolean()
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const MemberSchema = z.object({
	user_id: z.string(),
	email: z.string(),
	role: z.enum(['owner', 'editor', 'viewer'])
});
export type Member = z.infer<typeof MemberSchema>;

export function listUsers(q = ''): Promise<AdminUser[]> {
	return apiFetch(
		'/admin/users',
		{ method: 'GET', query: { q: q || undefined }, schema: z.array(AdminUserSchema) },
		API
	);
}

export function createUser(input: {
	email: string;
	password: string;
	is_admin: boolean;
}): Promise<AdminUser> {
	return apiFetch('/admin/users', { method: 'POST', body: input, schema: AdminUserSchema }, API);
}

export function patchUser(
	id: string,
	patch: { is_admin?: boolean; is_active?: boolean; password?: string }
): Promise<AdminUser> {
	return apiFetch(
		`/admin/users/${id}`,
		{ method: 'PATCH', body: patch, schema: AdminUserSchema },
		API
	);
}

export function deleteUser(id: string): Promise<void> {
	return apiFetch(`/admin/users/${id}`, { method: 'DELETE' }, API);
}

export function listMembers(projectId: string): Promise<Member[]> {
	return apiFetch(
		`/admin/projects/${projectId}/members`,
		{ method: 'GET', schema: z.array(MemberSchema) },
		API
	);
}

export function addMember(
	projectId: string,
	userId: string,
	role: Member['role']
): Promise<Member> {
	return apiFetch(
		`/admin/projects/${projectId}/members`,
		{ method: 'POST', body: { user_id: userId, role }, schema: MemberSchema },
		API
	);
}

export function removeMember(projectId: string, userId: string): Promise<void> {
	return apiFetch(`/admin/projects/${projectId}/members/${userId}`, { method: 'DELETE' }, API);
}
