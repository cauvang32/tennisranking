import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Standalone Vitest config (separate from vite.config.ts) so tests run with a
// controlled environment. The backend .env sets NODE_ENV=production; if it
// leaked into the test process, React would load its production build which does
// not export `act`, breaking @testing-library/react. Forcing NODE_ENV=test keeps
// React on the development build and makes the suite hermetic (no accidental
// dependency on the live backend .env).
process.env.NODE_ENV = 'test'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
