import type { Op } from './ops';

let _ops: Op[] = $state([]);

export function getPendingOps(): readonly Op[] {
	return _ops;
}

export function emit(op: Op): void {
	_ops.push(op);
}

export function resetOps(): void {
	_ops = [];
}

export function undoLast(): Op | undefined {
	return _ops.pop();
}
