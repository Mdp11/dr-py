/**
 * Whether a project boot/reload sequence is in flight. Set by boot() and
 * onReloadModel() around their metamodel → view → summary loads, and read by
 * the containment tree to show a loading skeleton instead of the misleading
 * intermediate states those sequential loads otherwise paint on a WARM open
 * ("Load a metamodel…" → "Model is empty." → blank rows). The tree's
 * loading signal is this flag.
 */

let _opening = $state(false);

export function isProjectOpening(): boolean {
	return _opening;
}

export function setProjectOpening(value: boolean): void {
	_opening = value;
}
