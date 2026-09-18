/**
 * Cuts text that arrives in pieces into lines, on LF alone: U+2028 and U+2029
 * occur raw inside a snapshot line, and a CR before the LF stays on the line,
 * where JSON reads it as white space.
 */
export class LineSplitter {
	private rest = '';

	/** The lines `text` completes, without their LF. */
	push(text: string): string[] {
		if (!text.includes('\n')) {
			this.rest += text;
			return [];
		}
		const lines = text.split('\n');
		lines[0] = this.rest + lines[0]!;
		this.rest = lines.pop()!;
		return lines;
	}

	/** What has arrived of the line no LF has ended yet. */
	get pending(): string {
		return this.rest;
	}
}
