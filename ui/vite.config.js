import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // A clean dist every build. Keeping stale bundles was tried as a fix for
    // "refused to apply style ... MIME type ('text/html')", but the cause of
    // that was a cached index.html pointing at a fingerprint that no longer
    // existed, not the sweep itself — that is handled by the no-store header on
    // index.html in main/index.js. Retaining them only grew ~640KB of dead JS
    // per deploy on a box nothing ever cleans.
    emptyOutDir: true,
  },
});
