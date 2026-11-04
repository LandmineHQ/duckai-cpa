import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: rootDir,
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(rootDir, 'src') }
  },
  build: {
    outDir: path.resolve(rootDir, '../web'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787'
    }
  }
});
