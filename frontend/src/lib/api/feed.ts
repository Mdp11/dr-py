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
		s.addEventListener('close', () => {
			config.onStatus(false);
			if (stopped) return;
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
