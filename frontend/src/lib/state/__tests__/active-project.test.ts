import { describe, expect, it } from 'vitest';
import { getActiveProjectId, setActiveProject, clearActiveProject } from '../active-project.svelte';

describe('active project store', () => {
	it('tracks the active id', () => {
		expect(getActiveProjectId()).toBeNull();
		setActiveProject('proj-1');
		expect(getActiveProjectId()).toBe('proj-1');
		clearActiveProject();
		expect(getActiveProjectId()).toBeNull();
	});
});
