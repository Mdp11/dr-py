// Save JSON to a file using the File System Access API when available, with a
// browser <a download> fallback. Returns the resolved filename and (when
// supported) the FileSystemFileHandle so the caller can reuse it for repeat
// saves without re-prompting.

interface SaveResult {
	filename: string;
	handle: FileSystemFileHandle | null;
}

interface ShowSaveFilePicker {
	(options?: {
		suggestedName?: string;
		types?: { description?: string; accept: Record<string, string[]> }[];
	}): Promise<FileSystemFileHandle>;
}

function getShowSaveFilePicker(): ShowSaveFilePicker | null {
	if (typeof window === 'undefined') return null;
	const fn = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
	return typeof fn === 'function' ? fn : null;
}

async function writeViaHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
	const writable = await handle.createWritable();
	await writable.write(text);
	await writable.close();
}

function fallbackDownload(filename: string, text: string): void {
	const blob = new Blob([text], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/**
 * Save a JSON-serializable value to a file.
 *
 * When `handle` is provided, reuses it (no dialog). Otherwise prompts via the
 * File System Access API on supported browsers, or falls back to a download
 * triggered through an <a download> link.
 */
export async function saveJsonToFile(
	value: unknown,
	suggestedName: string,
	handle: FileSystemFileHandle | null = null
): Promise<SaveResult> {
	const text = JSON.stringify(value, null, 2);

	if (handle) {
		await writeViaHandle(handle, text);
		return { filename: handle.name, handle };
	}

	const showSaveFilePicker = getShowSaveFilePicker();
	if (showSaveFilePicker) {
		const picked = await showSaveFilePicker({
			suggestedName,
			types: [
				{
					description: 'JSON model',
					accept: { 'application/json': ['.json'] }
				}
			]
		});
		await writeViaHandle(picked, text);
		return { filename: picked.name, handle: picked };
	}

	fallbackDownload(suggestedName, text);
	return { filename: suggestedName, handle: null };
}
