/**
 * The replica routes (CLAUDE.md "Replica routes"): the snapshot descriptor,
 * the snapshot bytes, the tail envelope and the metamodel document — every
 * text a replica needs, read raw where the engine reads it raw (AD-26) and
 * not re-serialized. Pure API layer: no `lib/state/*`, no `lib/engine/*`.
 */

import { z } from 'zod';
import { apiFetchRaw, type ClientConfig } from './client';
import { NotFoundError } from './errors';

export const SnapshotDescriptorSchema = z.object({
	rev: z.number().int(),
	metamodel_id: z.string(),
	state_digest: z.string(),
	elements: z.number().int(),
	relationships: z.number().int(),
	// a whole path as the backend sees it (e.g. "/api/v1/projects/p/replica/
	// snapshots/12"), not an absolute URL — see routes/replica.py::_descriptor.
	url: z.string()
});
export type SnapshotDescriptor = z.infer<typeof SnapshotDescriptorSchema>;

export type TailBody = { text: string; fromRev: number; headRev: number; complete: boolean };

// Names only the envelope fields the shell reads for itself (D15); the text
// itself crosses to the engine untouched, parsed there by the exact parser.
const TailEnvelopeSchema = z.object({
	from_rev: z.number().int(),
	head_rev: z.number().int(),
	complete: z.boolean()
});

/** GET /replica/snapshot — the descriptor of the snapshot to open from, or
 * `null` when the project has no model yet (404). A 503 (store unavailable)
 * throws. */
export async function getSnapshotDescriptor(
	cfg?: ClientConfig
): Promise<SnapshotDescriptor | null> {
	let response: Response;
	try {
		response = await apiFetchRaw('/replica/snapshot', { method: 'GET' }, cfg);
	} catch (err) {
		if (err instanceof NotFoundError) return null;
		throw err;
	}
	const text = await response.text();
	return SnapshotDescriptorSchema.parse(JSON.parse(text));
}

/** GET /replica/snapshots/{rev} (or wherever the descriptor's `url` points).
 * `url` is a whole path (fact 16 of the plan), so this is called with
 * `baseUrl: ''` — it lands on the page's own origin. Returns the raw
 * `Response`: the body is a stream of gzip bytes the caller reads in chunks. */
export function fetchSnapshot(url: string, signal?: AbortSignal): Promise<Response> {
	return apiFetchRaw(url, { method: 'GET', signal }, { baseUrl: '' });
}

/** GET /replica/tail?from_rev= — the text is handed to the engine untouched
 * (AD-26: `JSON.parse` would lose `1.0` and integers past 2^53, which the
 * digest cannot see); the three envelope fields are read here, separately,
 * for the shell's own bookkeeping (D15). */
export async function fetchTail(fromRev: number, cfg?: ClientConfig): Promise<TailBody> {
	const response = await apiFetchRaw(
		'/replica/tail',
		{ method: 'GET', query: { from_rev: fromRev } },
		cfg
	);
	const text = await response.text();
	const envelope = TailEnvelopeSchema.parse(JSON.parse(text));
	return {
		text,
		fromRev: envelope.from_rev,
		headRev: envelope.head_rev,
		complete: envelope.complete
	};
}

/** GET /metamodel, read the way the engine wants it: the document as
 * `JSON.parse` gives it (AD-22 — no zod reshape) and the `X-Metamodel-Id`
 * header the descriptor's `metamodel_id` is paired against (`''` without the
 * header). */
export async function fetchMetamodelDocument(
	cfg?: ClientConfig
): Promise<{ doc: unknown; metamodelId: string }> {
	const response = await apiFetchRaw('/metamodel', { method: 'GET' }, cfg);
	const metamodelId = response.headers.get('X-Metamodel-Id') ?? '';
	const text = await response.text();
	return { doc: JSON.parse(text), metamodelId };
}
