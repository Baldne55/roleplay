import { defineConfig } from 'vite';
import Vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [Vue()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./Src', import.meta.url)),
      '@Shared': fileURLToPath(new URL('../Shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../Production/Windows/resources/[local]/roleplay/Dist/UI',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        assetFileNames: 'Assets/[name]-[hash][extname]',
        chunkFileNames: 'Assets/[name]-[hash].js',
        entryFileNames: 'Assets/[name]-[hash].js',
      },
    },
  },
});
