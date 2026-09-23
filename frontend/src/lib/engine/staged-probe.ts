/**
 * Whether the user has model edits staged in the replica, for what must not
 * hold the replica's answers to the server's while they differ by those
 * edits (the dev shadow comparison). The model store sets the probe while it
 * follows the replica; without one nothing is staged.
 */

let _probe: (() => boolean) | null = null;

export function setStagedProbe(probe: (() => boolean) | null): void {
	_probe = probe;
}

export function anyStaged(): boolean {
	return _probe?.() ?? false;
}
