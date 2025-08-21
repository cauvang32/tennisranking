import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  // Get base path from environment or default
  const basePath = process.env.BASE_PATH || '/tennis/'
  
  return {
    // Set base path for subpath deployment - use environment variable
    base: mode === 'production' ? basePath : '/',
    
    // Build configuration
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      // Ensure relative paths work correctly
      rollupOptions: {
        output: {
          // Use relative paths for assets
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js'
        }
      }
    },
    
    // Development server configuration
    server: {
      port: 5173,
      host: true, // Allow external connections
      // Proxy API requests to the backend during development
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          // Don't rewrite the path since server expects /api
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
