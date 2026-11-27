import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Lists the .glb files under public/models (see docs/MODELING_SPEC.md) as the virtual module
// 'virtual:lowrange-models', so the game loads only models that exist. Re-read on every
// page load in dev; adding a model needs a browser refresh.
function modelList() {
  const id = 'virtual:lowrange-models', rid = '\0' + id;
  const root = path.resolve('public/models');
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.glb$/i.test(e.name) ? [path.join(dir, e.name)] : [])) : []);
  return {
    name: 'lowrange-models',
    resolveId: (s) => (s === id ? rid : null),
    load(s) {
      if (s !== rid) return null;
      const files = walk(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
      return `export default ${JSON.stringify(files)};`;
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(root)) { const m = server.moduleGraph.getModuleById(rid); if (m) server.moduleGraph.invalidateModule(m); }
    },
  };
}

export default defineConfig({
  // relative asset URLs so the same dist/ works on the web and inside the desktop app (app://)
  base: './',
  plugins: [modelList()],
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  // entries: scan only the real page, not index.html copies in agent worktrees under .claude/
  optimizeDeps: { entries: ['index.html'], esbuildOptions: { target: 'esnext' } },
  server: { port: 5199, watch: { ignored: ['**/.claude/**'] } },
});
