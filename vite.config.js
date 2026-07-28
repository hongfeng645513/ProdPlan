import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The build is bundled into one self-contained dist/index.html so the planning
// board can be opened straight from disk (or e-mailed round the plant) without
// a web server.
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: { outDir: 'dist', assetsInlineLimit: 100000000, cssCodeSplit: false },
})
