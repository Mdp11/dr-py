/**
 * One-way realtime feed client (Phase 5). Opens a WebSocket to the project
 * feed, auto-reconnects with exponential backoff, and hands parsed events to a
 * callback. Pure transport — no app state. The socket is injectable
 * (`socketFactory`) so tests can drive it without a real server.
 */

export interface LeaseLite {
	resource_id: string;
	mode: string;
	holder_id: string;
	/** Holder's email, for "Locked by <email>" display. Optional so older
	 * payloads (and tests) that only carry `holder_id` still typecheck. */
	holder_email?: string;
}

export type FeedEvent =
	| { type: 'snapshot'; model_rev: number; locks: LeaseLite[]; connected: string[] }
	| {
			type: 'commit';
			rev: number;
			commit_id: string;
			author_id: string;
			message: string;
			validation_error_count: number;
			changed_elements: unknown[];
			changed_relationships: unknown[];
			deleted_element_ids: string[];
			deleted_relationship_ids: string[];
	  }
	| { type: 'lock'; action: 'acquired' | 'released' | 'expired'; leases: LeaseLite[] }
	| { type: 'presence'; action: 'join' | 'leave'; user_id: string; connected: string[] }
	| {
			type: 'rebind';
			rev: number;
			from_metamodel_id: string | null;
			to_metamodel_id: string;
			validation_error_count: number;
	  }
	| {
			type: 'artifact';
			action: 'created' | 'updated' | 'deleted';
			artifact: { id: string; kind: string; name: string; artifact_rev: number };
	  };

export interface WebSocketLike {
	readyState: number;
	addEventListener(type: string, cb: (e: unknown) => void): void;
	close(): void;
}

export interface FeedConfig {
	onEvent: (e: FeedEvent) => void;
	onStatus: (connected: boolean) => void;
	url: string;
	socketFactory?: (url: string) => WebSocketLike;
	reconnect?: { baseMs: number; maxMs: number };
	/** Invoked once when the feed hits a TERMINAL close (see {@link isTerminalClose})
	 * and stops reconnecting. The store surfaces this as a banner; this layer stays
	 * pure transport and does not act on it itself. */
	onTerminal?: (code: number) => void;
}

/** Server close codes that are PERMANENT — reconnecting can never succeed:
 * 4401 (no/expired identity), 4403 (non-member), 4404 (unknown project). The
 * backend closes with these in routes/feed.py. Reconnecting on them is an
 * infinite storm, so they terminate the feed immediately. */
const PERMANENT_CLOSE_CODES = new Set([4401, 4403, 4404]);

/** 4408 ("dropped behind") is the NORMAL catch-up path: the server dropped a
 * client whose queue overflowed, and reconnecting re-syncs it — so by design we
 * keep reconnecting on it. The cap below is a backstop for the case where the
 * reconnect itself never establishes (e.g. the server returns 4408 on the
 * upgrade without the socket reaching `open`, so `attempt` is not reset): after
 * this many such consecutive attempts we give up rather than retry forever.
 * NOTE: a client that connects, syncs, then repeatedly falls behind resets
 * `attempt` on each successful open, so it stays on the reconnect path and the
 * cap does not engage — that is intended (each reconnect makes progress), but it
 * means this limit only catches the never-establishes case. A dedicated
 * consecutive-4408 counter would close that gap (tracked follow-up). */
const DROPPED_BEHIND_RETRY_LIMIT = 5;

/** Decide whether a close should terminate the feed (stop reconnecting). Pure so
 * the policy is unit-testable in isolation. */
export function isTerminalClose(code: number, attempt: number): boolean {
	if (PERMANENT_CLOSE_CODES.has(code)) return true;
	if (code === 4408 && attempt >= DROPPED_BEHIND_RETRY_LIMIT) return true;
	return false;
}

export interface FeedConnection {
	close(): void;
}

/** Same-origin WebSocket feed URL for a project. Identity travels on the
 * httpOnly session cookie (browsers send it on the same-origin upgrade), so no
 * query params are needed. */
export function defaultFeedUrl(projectId: string): string {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${location.host}/api/v1/projects/${projectId}/feed`;
}

export function connectFeed(config: FeedConfig): FeedConnection {
	if (!config.url) throw new Error('connectFeed requires config.url');
	const url: string = config.url;
	const factory = config.socketFactory ?? ((u: string) => new WebSocket(u) as WebSocketLike);
	const base = config.reconnect?.baseMs ?? 500;
	const max = config.reconnect?.maxMs ?? 10_000;

	let stopped = false;
	let attempt = 0;
	let sock: WebSocketLike | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function open(): void {
		if (stopped) return;
		const s = factory(url);
		sock = s;
		s.addEventListener('open', () => {
			attempt = 0;
			config.onStatus(true);
		});
		s.addEventListener('message', (e) => {
			const data = (e as MessageEvent).data as string;
			try {
				config.onEvent(JSON.parse(data) as FeedEvent);
			} catch {
				/* ignore malformed frames */
			}
		});
		s.addEventListener('close', (e) => {
			config.onStatus(false);
			if (stopped) return;
			// The CloseEvent carries the server's close code; some terminal codes
			// must NOT trigger a reconnect (see isTerminalClose). `?? 0` keeps a
			// codeless close (e.g. a test fake or an abrupt drop) on the normal
			// reconnect path.
			const code = (e as { code?: number }).code ?? 0;
			if (isTerminalClose(code, attempt)) {
				stopped = true; // also makes onTerminal fire-once: a later close early-returns above
				config.onTerminal?.(code);
				return;
			}
			const delay = Math.min(max, base * 2 ** attempt);
			attempt += 1;
			timer = setTimeout(open, delay);
		});
		s.addEventListener('error', () => {
			/* close fires after error; reconnect handled there */
		});
	}

	open();

	return {
		close(): void {
			stopped = true;
			if (timer) clearTimeout(timer);
			sock?.close();
		}
	};
}
