/* */
export function withTimeout<T>(
	p: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		handle = setTimeout(() => resolve(undefined), ms);
		handle.unref?.();
	});
	return Promise.race([p, timeout]).finally(() => {
		if (handle) clearTimeout(handle);
	});
}
