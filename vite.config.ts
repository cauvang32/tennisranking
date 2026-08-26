import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => {
  // Get base path from environment or default
  const rawBasePath = process.env.BASE_PATH || '/tennis/'
  const basePath = rawBasePath.endsWith('/') ? rawBasePath : `${rawBasePath}/`

  return {
    plugins: [react()],
    // Backend secrets live in the repository-root .env. The browser build does
    // not consume that file; BASE_PATH is supplied explicitly by the build job.
    envDir: 'config/vite-env',

    // Set base path for subpath deployment - use environment variable
    base: mode === 'production' ? basePath : '/',

    // Build configuration
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      // Enable source maps for production debugging (optional)
      sourcemap: false,
      // Minification target for modern browsers
      target: 'es2020',
      // Use terser for smaller production bundles
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: mode === 'production',
          drop_debugger: true
        }
      },
      // CSS code splitting
      cssCodeSplit: true,
      // Vite 8 uses Rolldown instead of Rollup — renamed from rollupOptions
      rolldownOptions: {
        // Bundle analysis plugin (outputs HTML report on build)
        plugins: [
          visualizer({
            open: mode === 'development',
            filename: 'stats.html',
            gzipSize: true,
            brotliSize: true
          })
        ],
        output: {
          // Use content-hash for long-term caching (immutable assets)
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          // Split vendor chunks so heavy frontend libraries cache independently.
          // Only browser-imported packages belong here — firebase-admin / bullmq /
          // ioredis are server-side and never reach the SPA bundle.
          // Vite 8 (Rolldown) uses `manualChunks` (not `getManualChunks`).
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('write-excel-file')) return 'vendor-excel'
              if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react'
              if (id.includes('node_modules')) return 'vendor-shared'
            }
          }
        }
      }
    },

    // Development server configuration
    server: {
      port: 5173,
      host: '127.0.0.1', // Restrict to localhost for security
      // Proxy API requests to the backend during development
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          // Don't rewrite the path since server expects /api
          rewrite: (path) => path
        },
        '/uploads': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          rewrite: (path) => path
        }
      }
    },

    // Preview server configuration (for production build testing)
    preview: {
      port: 4173,
      host: true
    }
  }
})
