import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the demo server (server/index.ts) on https://localhost:5174 in middleware mode.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
});
