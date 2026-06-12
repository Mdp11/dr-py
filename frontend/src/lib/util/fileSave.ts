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
	fallbackDownloadBlob(filename, new Blob([text], { type: 'application/json' }));
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

function fallbackDownloadBlob(filename: string, blob: Blob): void {
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
 * Stream an HTTP `Response` body to a file.
 *
 * Preferred path: `response.body.pipeTo(writable)` so the payload is never
 * materialized as a string/blob in the page (the /model/download flow can be
 * tens of MB). Falls back to `response.blob()` for browsers without
 * `ReadableStream.pipeTo` or without the File System Access API (where the
 * save happens via an <a download> object URL anyway).
 *
 * Same handle-reuse contract as {@link saveJsonToFile}.
 */
export async function saveResponseToFile(
	response: Response,
	suggestedName: string,
	handle: FileSystemFileHandle | null = null
): Promise<SaveResult> {
	const showSaveFilePicker = getShowSaveFilePicker();

	let target = handle;
	if (target === null && showSaveFilePicker) {
		target = await showSaveFilePicker({
			suggestedName,
			types: [
				{
					description: 'JSON model',
					accept: { 'application/json': ['.json'] }
				}
			]
		});
	}

	if (target !== null) {
		const writable = await target.createWritable();
		const body = response.body;
		if (body !== null && typeof body.pipeTo === 'function') {
			await body.pipeTo(writable); // pipeTo closes the writable on completion
		} else {
			const blob = await response.blob();
			await writable.write(blob);
			await writable.close();
		}
		return { filename: target.name, handle: target };
	}

	// No File System Access API: buffer to a Blob and trigger a download.
	fallbackDownloadBlob(suggestedName, await response.blob());
	return { filename: suggestedName, handle: null };
}
