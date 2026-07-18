// Fetch-once cache of the snippet docs payload. Docs are static per server
// process (facade + configured limits), so one fetch per project session is
// enough; reset re-arms it (wired at onReloadModel with the other resets).
// Failures degrade silently by design: no docs ⇒ the panel shows one
// "unavailable" line and editor intelligence stays inert — never a toast.

import { getSnippetDocs as fetchSnippetDocs } from '$lib/api/snippets';
import type { SnippetDocsOut } from '$lib/api/types';

let _docs: SnippetDocsOut | null = $state(null);
let _pending: Promise<void> | null = null;

export function getSnippetDocs(): SnippetDocsOut | null {
	return _docs;
}

export function ensureSnippetDocs(): Promise<void> {
	if (_docs) return Promise.resolve();
	if (_pending) return _pending;
	_pending = fetchSnippetDocs()
		.then((d) => {
			_docs = d;
		})
		.catch(() => {
			/* silent degrade — see module comment */
		})
		.finally(() => {
			_pending = null;
		});
	return _pending;
}

export function resetSnippetDocs(): void {
	_docs = null;
	_pending = null;
}
