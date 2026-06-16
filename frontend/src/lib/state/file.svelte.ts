// File identity of the loaded model: the filename shown in the TopBar /
// StatusBar and the File System Access handle Save reuses so repeat saves
// don't re-prompt for a location. (The model DATA lives server-side; the
// client mirror is `model.svelte.ts`.)

let _filename: string | null = $state(null);
// Filenames of the loaded metamodel/view files. Display-only (shown in the
// TopBar info tooltip); the model filename above doubles as the Save name.
let _metamodelFilename: string | null = $state(null);
let _viewFilename: string | null = $state(null);
// File System Access API handle (Chromium-only). When set, Save reuses it so
// subsequent saves don't re-prompt for a location.
let _fileHandle: FileSystemFileHandle | null = $state(null);

export function getFilename(): string | null {
	return _filename;
}

export function setFilename(name: string | null): void {
	_filename = name;
}

export function getMetamodelFilename(): string | null {
	return _metamodelFilename;
}

export function setMetamodelFilename(name: string | null): void {
	_metamodelFilename = name;
}

export function getViewFilename(): string | null {
	return _viewFilename;
}

export function setViewFilename(name: string | null): void {
	_viewFilename = name;
}

export function getFileHandle(): FileSystemFileHandle | null {
	return _fileHandle;
}

export function setFileHandle(handle: FileSystemFileHandle | null): void {
	_fileHandle = handle;
}

// File System Access handle for the VIEW file (kept separate from the model's
// handle above so a "Save view" never overwrites the model file, or vice-versa).
let _viewFileHandle: FileSystemFileHandle | null = $state(null);

export function getViewFileHandle(): FileSystemFileHandle | null {
	return _viewFileHandle;
}

export function setViewFileHandle(handle: FileSystemFileHandle | null): void {
	_viewFileHandle = handle;
}
