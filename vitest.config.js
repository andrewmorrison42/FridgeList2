// The fast suite: pure core, data layer, migration. Runs in seconds, no browser.
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { exclude: ['test/ui/**', 'node_modules/**'] } });
