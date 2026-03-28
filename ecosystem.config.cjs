// PM2 Cluster configuration for Tennis Ranking System
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save && pm2 startup   (auto-start on reboot)
//
// Cluster notes:
//   - Rate limiting is cluster-safe: each limiter uses Redis (rate-limit-redis-tennis:<name>)
//   - SSE (/api/events) is cluster-safe: each worker subscribes to PostgreSQL LISTEN/NOTIFY
//   - dataVersion is cluster-safe: first worker to handle invalidation writes the canonical
//     version to Redis (version-lock); all others read it back, ensuring SSE clients on every
//     worker receive the same version number
//   - Set instances to a fixed number (e.g. 2) if you want predictable pool sizes.
//     With 'max', each worker creates its own pg.Pool — keep DB_POOL_MAX low (e.g. 5).

module.exports = {
  apps: [
    {
      name: 'tennis',
      script: 'server.js',

      // Cluster mode: one worker per CPU core (change to a number like 2 if preferred)
      instances: process.env.PM2_INSTANCES || '2',
      exec_mode: 'cluster',

      // Restart worker automatically if it crashes
      autorestart: true,
      watch: false,

      // Graceful reload: wait up to 5 s for in-flight requests to finish
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,

      // Memory ceiling per worker — restart if exceeded (adjust to your server RAM)
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'development',
      },

      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
}
