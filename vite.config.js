import { defineConfig } from 'vite'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => {
  // Get base path from environment or default
  const rawBasePath = process.env.BASE_PATH || '/tennis/'
  const basePath = rawBasePath.endsWith('/') ? rawBasePath : `${rawBasePath}/`

  return {
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
          // Split vendor chunks: heavy libraries into separate files for better caching
          // Vite 8 (Rolldown) uses `manualChunks` (not `getManualChunks`)
          manualChunks: (id) => {
            if (id.includes('write-excel-file')) return 'vendor-excel'
            if (id.includes('firebase-admin')) return 'vendor-firebase'
            if (id.includes('bullmq')) return 'vendor-bullmq'
            if (id.includes('ioredis')) return 'vendor-redis'
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
