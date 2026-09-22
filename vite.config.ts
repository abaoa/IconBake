import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

// IconBake — pure frontend icon-font builder.
// SPA, no server runtime required. Works as static site AND inside Tauri.
export default defineConfig({
  plugins: [react()],
  // Relative base so the built dist/ works both at a domain root and in a sub-path.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  // ttf2woff / imagetracerjs are UMD; let Vite pre-bundle them.
  optimizeDeps: {
    include: ['ttf2woff', 'imagetracerjs', 'opentype.js', 'jszip'],
  },
})
