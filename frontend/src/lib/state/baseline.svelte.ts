import type { ModelOut } from '$lib/api/types';

let _baseline: ModelOut | null = $state(null);
let _filename: string | null = $state(null);
// File System Access API handle (Chromium-only). When set, Save reuses it so
// subsequent saves don't re-prompt for a location.
let _fileHandle: FileSystemFileHandle | null = $state(null);

export function getBaseline(): ModelOut | null {
	return _baseline;
}

export function setBaseline(model: ModelOut | null): void {
	_baseline = model;
}

export function getFilename(): string | null {
	return _filename;
}

export function setFilename(name: string | null): void {
	_filename = name;
}

export function getFileHandle(): FileSystemFileHandle | null {
	return _fileHandle;
}

export function setFileHandle(handle: FileSystemFileHandle | null): void {
	_fileHandle = handle;
}
