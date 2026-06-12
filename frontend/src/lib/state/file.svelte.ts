// File identity of the loaded model: the filename shown in the TopBar /
// StatusBar and the File System Access handle Save reuses so repeat saves
// don't re-prompt for a location. (The model DATA lives server-side; the
// client mirror is `model.svelte.ts`.)

let _filename: string | null = $state(null);
// File System Access API handle (Chromium-only). When set, Save reuses it so
// subsequent saves don't re-prompt for a location.
let _fileHandle: FileSystemFileHandle | null = $state(null);

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
