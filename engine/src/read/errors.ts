/** A read the engine refuses, in the HTTP vocabulary of the route it stands for. */
export class ReadError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail: string) {
		super(detail);
		this.name = 'ReadError';
		this.status = status;
		this.detail = detail;
	}
}
