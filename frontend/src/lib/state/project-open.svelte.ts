/**
 * Whether a project boot/reload sequence is in flight. Set by boot() and
 * onReloadModel() around their metamodel → view → summary loads, and read by
 * the containment tree to show a loading skeleton instead of the misleading
 * intermediate states those sequential loads otherwise paint on a WARM open
 * ("Load a metamodel…" → "Model is empty." → blank rows). The global
 * open-progress overlay only covers COLD opens (GET /model/status reports
 * hydrating/validating); a warm open is 'ready' immediately, so this flag is
 * the only loading signal the tree gets.
 */

let _opening = $state(false);

export function isProjectOpening(): boolean {
	return _opening;
}

export function setProjectOpening(value: boolean): void {
	_opening = value;
}
