let _notice = $state<string | null>(null);

export function setLockNotice(msg: string | null): void {
	_notice = msg;
}
export function getLockNotice(): string | null {
	return _notice;
}
