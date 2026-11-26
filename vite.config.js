import { defineConfig } from 'vite';
export default defineConfig({
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: { port: 5199 },
});
