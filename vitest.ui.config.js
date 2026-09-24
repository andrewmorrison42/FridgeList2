// The browser suite: the app as a person uses it — real key presses, taps and
// scrolling in a real browser at phone size. Slower, so run separately:
//   npm run test:ui
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/ui/**/*.test.js'], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
});
