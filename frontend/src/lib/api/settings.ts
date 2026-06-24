import { apiFetch, type ClientConfig } from './client';
import { ProjectSettingsSchema, type ProjectSettings } from './types';

/** GET /settings — current project policy (any member). */
export function getSettings(cfg?: ClientConfig): Promise<ProjectSettings> {
	return apiFetch('/settings', { method: 'GET', schema: ProjectSettingsSchema }, cfg);
}

/** PATCH /settings — owner-only strict-mode toggle. */
export function updateSettings(strict: boolean, cfg?: ClientConfig): Promise<ProjectSettings> {
	return apiFetch(
		'/settings',
		{ method: 'PATCH', body: { strict_mode: strict }, schema: ProjectSettingsSchema },
		cfg
	);
}
