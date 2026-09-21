/** The sandbox site's origin: compared with `event.origin` by `===`. */
export const SANDBOX_ORIGIN: string =
	import.meta.env.VITE_SANDBOX_ORIGIN ?? 'http://localhost:5174';

/** Whether two URLs name the same host, whatever their ports. */
export function sameHost(a: string, b: string): boolean {
	try {
		return new URL(a).hostname === new URL(b).hostname;
	} catch {
		return false;
	}
}
