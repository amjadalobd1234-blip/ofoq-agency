import { defineConfig } from 'vitest/config';

// Do not inherit the website's database setup or test suite.
export default defineConfig({
  // Prevent Vite from discovering the parent website's Tailwind/PostCSS config.
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
  },
});
