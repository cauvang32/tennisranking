/**
 * PM2 ecosystem configuration for Tennis Ranking System.
 *
 * Use ./scripts/start-with-redis.sh to start — it waits for Docker's
 * Redis port forwarding to be ready before launching PM2.
 */

module.exports = {
  apps: [
    {
      name: 'tennis',
      script: 'server.js',
      exec_mode: 'cluster_mode',
      instances: 2,
      max_memory_restart: '200M',
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
}
