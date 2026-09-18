/**
 * A refused op batch. `status` speaks the HTTP vocabulary callers already
 * branch on; `detail` is the server's text for the same refusal.
 */
export class OpError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail: string) {
		super(detail);
		this.name = 'OpError';
		this.status = status;
		this.detail = detail;
	}
}
