/** What `fn` throws, or `undefined`: lets a test check the error's class and its exact text. */
export function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}
