import { afterAll } from 'vitest';

// bits-ui's BodyScrollLock schedules a ~24ms cleanup timeout when the last
// Dialog unmounts (at test cleanup). Give it time to fire while the
// happy-dom environment is still alive, or vitest intermittently reports an
// unhandled teardown error in any dialog-mounting test file.
afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 100));
});
