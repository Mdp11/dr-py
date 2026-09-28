/** `now`'s UTC day as `YYYYMMDD`: the `${date}` an export's names read, as the server stamps it. */
export function utcDate(now: Date = new Date()): string {
	const month = String(now.getUTCMonth() + 1).padStart(2, '0');
	const day = String(now.getUTCDate()).padStart(2, '0');
	return `${now.getUTCFullYear()}${month}${day}`;
}
