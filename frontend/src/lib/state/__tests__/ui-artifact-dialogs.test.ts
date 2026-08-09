import { describe, expect, it } from 'vitest';
import {
	getExportArtifactsOpen,
	getExportArtifactsSeed,
	getImportArtifactsOpen,
	openExportArtifacts,
	openImportArtifacts,
	setExportArtifactsOpen,
	setImportArtifactsOpen
} from '../ui.svelte';

describe('artifact dialog open-state', () => {
	it('opens export with a seed and clears it on close', () => {
		expect(getExportArtifactsOpen()).toBe(false);
		openExportArtifacts(['a1', 'a2']);
		expect(getExportArtifactsOpen()).toBe(true);
		expect(getExportArtifactsSeed()).toEqual(['a1', 'a2']);
		setExportArtifactsOpen(false);
		expect(getExportArtifactsOpen()).toBe(false);
		expect(getExportArtifactsSeed()).toEqual([]);
	});

	it('defaults the export seed to empty', () => {
		openExportArtifacts();
		expect(getExportArtifactsSeed()).toEqual([]);
		setExportArtifactsOpen(false);
	});

	it('tracks import open-state', () => {
		expect(getImportArtifactsOpen()).toBe(false);
		openImportArtifacts();
		expect(getImportArtifactsOpen()).toBe(true);
		setImportArtifactsOpen(false);
		expect(getImportArtifactsOpen()).toBe(false);
	});
});
