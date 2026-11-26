import { defineConfig } from 'vite';
export default defineConfig({
  // relative asset URLs so the same dist/ works on the web and inside the desktop app (app://)
  base: './',
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: { port: 5199 },
});
