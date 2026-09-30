import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// An explicit index keeps the assets found when a bundler or test runner inlines the package.
export const INDEX_URL = dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));
