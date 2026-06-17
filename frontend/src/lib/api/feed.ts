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
	| { type: 'presence'; action: 'join' | 'leave'; user_id: string; connected: string[] };

export interface WebSocketLike {
	readyState: number;
	addEventListener(type: string, cb: (e: unknown) => void): void;
	close(): void;
}

export interface FeedConfig {
	onEvent: (e: FeedEvent) => void;
	onStatus: (connected: boolean) => void;
	url?: string;
	socketFactory?: (url: string) => WebSocketLike;
	reconnect?: { baseMs: number; maxMs: number };
}

export interface FeedConnection {
	close(): void;
}

// Single-user dev identity, mirroring api/client.ts DEV_IDENTITY_HEADERS.
const DEV_USER = 'default-user';
const DEV_EMAIL = 'dev@example.com';

export function defaultFeedUrl(): string {
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const q = `x-user-id=${encodeURIComponent(DEV_USER)}&x-user-email=${encodeURIComponent(DEV_EMAIL)}`;
	return `${proto}//${location.host}/api/v1/projects/default/feed?${q}`;
}

export function connectFeed(config: FeedConfig): FeedConnection {
	const url = config.url ?? defaultFeedUrl();
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
