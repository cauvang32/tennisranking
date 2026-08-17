import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const render = (manifest, mode, image) => execFileSync(
  'bash',
  ['scripts/k3s/render-manifest.sh', manifest, ...(image ? [image] : [])],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, K3S_MODE: mode }
  }
)

describe('K3s manifest renderer', () => {
  it('reduces stateful services to one instance in single-node mode', () => {
    const postgres = render('deploy/k3s/base/postgres.yaml', 'single')
    const redis = render('deploy/k3s/base/redis.yaml', 'single')

    expect(postgres).toContain('instances: 1')
    expect(postgres).toContain('primaryUpdateMethod: restart')
    expect(postgres).not.toContain('minSyncReplicas')
    expect(redis.match(/clusterSize: 1/g)).toHaveLength(4)
    expect(redis).not.toContain('clusterSize: 3')
  })

  it('renders one API and one FCM pod with the immutable image', () => {
    const image = 'registry.quocanh.tech/example/app@sha256:' + 'a'.repeat(64)
    const app = render('deploy/k3s/base/app.yaml', 'single', image)
    const worker = render('deploy/k3s/base/fcm-worker.yaml', 'single', image)

    expect(app).toContain('replicas: 1')
    expect(app).toContain('minAvailable: 1')
    expect(worker).toContain('replicas: 1')
    expect(app).toContain(`image: ${image}`)
    expect(worker).toContain(`image: ${image}`)
  })

  it('preserves HA replica counts in HA mode', () => {
    const postgres = render('deploy/k3s/base/postgres.yaml', 'ha')
    const redis = render('deploy/k3s/base/redis.yaml', 'ha')

    expect(postgres).toContain('instances: 3')
    expect(postgres).toContain('minSyncReplicas: 1')
    expect(redis.match(/clusterSize: 3/g)).toHaveLength(4)
  })
})
