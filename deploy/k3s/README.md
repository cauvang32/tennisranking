# K3s deployment guide: single-node learning to production HA

This is an **opt-in deployment path** for the tennis-ranking application. It
does not replace or remove the existing PM2, Docker Compose, or normal GitLab
jobs. It supports a one-node learning deployment first and an explicit later
promotion to three-node HA.

The design deliberately does not install or use K3s Traefik. NPMplus remains
the public TLS terminator, CDN/cache, Anubis gate, rate limiter, and reverse
proxy. GitLab is the only deployment authority. GitHub tests and builds a GHCR
image but has no kubeconfig, deployment job, or cluster credentials.

## Architecture and availability boundary

```text
Internet
   |
NPMplus (TLS, CDN/cache, Anubis, rate limits)
   |
   +-- node-1:30001 --+
   +-- node-2:30001 --+--> Service --> 3 API pods
   +-- node-3:30001 --+                  |  |  |
                                             +--> shared Longhorn uploads (RWX)
                                             +--> CloudNativePG PostgreSQL (3)
                                             +--> cache Redis + Sentinel (3+3)
                                             +--> queue Redis + Sentinel (3+3)
                                                          |
                                                   2 FCM workers
```

CloudNativePG exposes `tennis-postgres-rw`; the Redis operator exposes
`redis-cache-master` and `redis-queue-master`. Applications use those stable
service names, so leader changes do not require application configuration
changes. Cache Redis is disposable; queue Redis uses AOF and `noeviction`.

**One physical machine is not HA.** Set `K3S_MODE=single` to run one API, one
FCM worker, one PostgreSQL instance, one instance of each Redis role, and one
Longhorn copy. Kubernetes can restart a failed process, but it cannot survive
loss of that server, disk, kernel, power, or network. Set `K3S_MODE=ha` only
after three independent server nodes and replicated storage are ready.

| Mode | Nodes | API / FCM | PostgreSQL | Each Redis + Sentinel | Longhorn copies |
|---|---:|---:|---:|---:|---:|
| `single` | 1 | 1 / 1 | 1 | 1 + 1 | 1 |
| `ha` | 3+ | 3 / 2 | 3 | 3 + 3 | 3 |

NPMplus itself remains outside this cluster. Its availability is a separate
concern: if it is only on one server, it is still a public single point of
failure even when the application cluster is healthy.

## What is included

- `Dockerfile.k3s`: one non-root, immutable image for the API, FCM worker, and
  migration Job. The existing worker `Dockerfile` is unchanged.
- `deploy/k3s/platform/`: pinned K3s Helm Controller resources for Longhorn,
  cert-manager, CloudNativePG, and the OpsTree Redis operator.
- `deploy/k3s/base/`: HA declarations for the API, FCM, PostgreSQL, two Redis
  replication groups with Sentinel, RWX uploads, probes, resources, disruption
  budgets, and network policy. The guarded renderer reduces replicas when
  `K3S_MODE=single`.
- `scripts/k3s/`: context-guarded platform bootstrap, secret creation,
  data import, migration, backup, deploy, and image rollback scripts.
- GitLab jobs that build a GitLab Registry image by digest and manually deploy
  it. The original PM2 jobs remain available.
- A GitHub workflow that tests and builds/publishes a GHCR image only.

Pinned component versions should be reviewed monthly and upgraded in staging
one component at a time. The current declarations use cert-manager `v1.21.0`,
CloudNativePG chart `0.29.0`, Barman Cloud plugin `v0.13.0`, Redis operator
chart `0.25.0`, and Longhorn `v1.12.0`.

## Phase 0: required decisions and capacity

For `K3S_MODE=single`, start with one Linux server with at least 4 vCPU, 8 GiB
RAM, adequate SSD space, and an off-server backup destination. This is suitable
for learning or accepting a known single-server availability risk.

Do not claim HA until all of these are true:

- Three Linux servers are available in distinct failure domains. Use static
  private IPs and reliable low-latency links.
- Each node has at least 4 vCPU and 8 GiB RAM; 8 vCPU and 16 GiB is a safer
  starting point because PostgreSQL, Redis, Longhorn, and temporary migration
  pods overlap. Keep at least 25% CPU/RAM headroom.
- Each node has a dedicated SSD/NVMe path for Longhorn. Do not use the OS disk
  for a serious production database.
- An S3-compatible bucket in another failure domain has versioning and object
  lock enabled. Its credential is limited to the tennis backup prefix.
- NPMplus can reach TCP `30001` on every K3s node over a private network.
- A maintenance window and tested rollback decision are agreed. Database
  migrations are forward-only; `rollout undo` only changes application images.
- Time synchronization, host backups, alerting, and UPS/provider recovery are
  in place.

Suggested firewall rules:

| Port | Source | Purpose |
|---|---|---|
| 6443/TCP | admin and K3s nodes | Kubernetes API |
| 2379-2380/TCP | K3s server nodes only | embedded etcd |
| 8472/UDP | K3s nodes only | Flannel VXLAN; never expose publicly |
| 10250/TCP | K3s nodes only | kubelet |
| 30001/TCP | NPMplus host(s) only | tennis NodePort |
| 22/TCP | administration network only | SSH |

Use the complete current K3s requirements and Longhorn requirements rather
than treating this table as a complete host firewall policy.

## Phase 1: prepare every node

On Ubuntu/Debian, install the Longhorn dependencies and enable iSCSI:

```bash
sudo apt-get update
sudo apt-get install -y open-iscsi nfs-common cryptsetup jq curl
sudo systemctl enable --now iscsid
```

Give Longhorn its own mounted filesystem at `/var/lib/longhorn`. Verify each
node has unique hostname, machine ID, MAC, and product UUID. Configure the
kernel/sysctl requirements reported by K3s and Longhorn before enabling
`protect-kernel-defaults`.

Copy [`config.yaml.example`](config.yaml.example) to
`/etc/rancher/k3s/config.yaml` on each server. Replace the token and control
plane DNS/VIP. The `disable` list is mandatory: it prevents Traefik and
ServiceLB from being installed. Configuration-critical flags must match on all
server nodes.

Choose and pin a reviewed K3s patch version; never install an unreviewed moving
channel directly into production. If installing the first server now and you
intend to add HA servers later, initialize embedded etcd immediately:

```bash
export INSTALL_K3S_VERSION='v1.36.2+k3s1'  # example pin; verify support first
curl -sfL https://get.k3s.io | sh -s - server --cluster-init
```

For single-node learning, stop after the first server. When promoting to HA,
server 2 and server 3 add this to their `config.yaml`:

```yaml
server: https://CONTROL_PLANE_PRIVATE_DNS:6443
```

Then install the same pinned version:

```bash
export INSTALL_K3S_VERSION='v1.36.2+k3s1'
curl -sfL https://get.k3s.io | sh -s - server
```

Validate the node and confirm Traefik is absent:

```bash
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl -n kube-system get pods
sudo k3s kubectl -n kube-system get deployment traefik  # must be NotFound
```

Copy `/etc/rancher/k3s/k3s.yaml` to the protected GitLab shell runner, change
its server address from `127.0.0.1` to the private control-plane DNS/VIP, set
mode `0600`, and give the context an unmistakable name such as
`tennis-production-k3s`. Do not store this kubeconfig in Git or GitHub.

## Phase 2: install platform operators

From a protected administration host or the protected GitLab shell runner:

```bash
export KUBECONFIG=/secure/path/tennis-k3s.yaml
export K3S_CONTEXT=tennis-production-k3s
export K3S_CONFIRM_CLUSTER="$K3S_CONTEXT"
export K3S_MODE=single
bash scripts/k3s/bootstrap-platform.sh
```

This uses K3s's built-in Helm Controller, then waits for CRDs and controllers.
Inspect failed `helm-install-*` jobs before retrying:

```bash
kubectl -n kube-system get helmcharts,job,pod
kubectl -n longhorn-system get pods
kubectl -n cnpg-system get pods
kubectl -n redis-operator get pods
```

In single mode, confirm the one node/disk is schedulable and new Longhorn
volumes use one replica. In HA mode, confirm three nodes are schedulable and
volumes use three replicas. In both modes, configure an off-site backup target.
Apply the recurring job and assign the uploads volume to group
`tennis-uploads`:

```bash
kubectl apply -f deploy/k3s/backup/longhorn-recurring-job.yaml
```

The recurring job is ineffective until Longhorn has valid backup-target
credentials and the volume is assigned to that group.

## Phase 3: configure protected GitLab variables

Create masked, protected GitLab variables. File variables are identified below.
Do not add any of these to GitHub.

| Variable | Form | Meaning |
|---|---|---|
| `K3S_CONTEXT` | text | exact protected runner kubectl context |
| `K3S_MODE` | text | defaults to `single` in CI; override with `ha` only after adding nodes |
| `K3S_DB_PASSWORD` | masked text | strong PostgreSQL application password |
| `K3S_REDIS_PASSWORD` | masked text | 24+ URL-safe random characters |
| `K3S_REGISTRY_USER` | masked text | read-only GitLab deploy-token username |
| `K3S_REGISTRY_PASSWORD` | masked text | read-only GitLab deploy-token password |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | protected file | Firebase service-account JSON |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | masked text | bootstrap admin |
| `EDITOR_USERNAME`, `EDITOR_PASSWORD` | masked text | bootstrap editor |
| `JWT_SECRET`, `CSRF_SECRET` | masked text | different random values, at least 32 characters |
| `K3S_S3_DESTINATION` | protected text | e.g. `s3://bucket/tennis-prod` |
| `K3S_S3_ENDPOINT` | protected text | HTTPS S3 endpoint |
| `K3S_S3_ACCESS_KEY`, `K3S_S3_SECRET_KEY` | masked text | restricted backup credentials |

The registry credentials must be a long-lived, read-only deploy token. Do not
use the short-lived CI job credential for pod restarts days later.

The GitLab Docker runner must allow Docker-in-Docker for `build-k3s-image`.
The protected shell runner needs `kubectl`, its protected kubeconfig, network
access to the API, `pg_dump`/`pg_restore` for first import, and no GitHub runner
registration.

## Phase 4: build an immutable image

Merge or push the reviewed branch to the GitLab default branch. GitLab runs
tests/lint and pushes
`registry.quocanh.tech/$CI_PROJECT_PATH/k3s:$CI_COMMIT_SHA`, recording the
repository digest as a dotenv artifact. The registry host is intentionally
pinned without the obsolete public `:5005` port because NPMplus terminates TLS
on port 443. Deployment accepts only `image@sha256:...`, never a mutable tag.

GitHub independently builds the same Dockerfile and may publish the result to
GHCR. It is not the source used by `deploy-k3s` and cannot reach the cluster.

Before production, build and exercise the image in a disposable namespace:

```bash
docker build -f Dockerfile.k3s -t tennis-k3s:test .
docker inspect tennis-k3s:test --format '{{.Config.User}}'
```

## Phase 5: prepare data services without starting the app

For the **first migration only**, run prepare-only mode from a protected host.
Export all variables listed above and point the Firebase variable at a local
file. `K3S_IMAGE` must be the GitLab digest artifact.

```bash
export K3S_CONFIRM_CLUSTER="$K3S_CONTEXT"
export K3S_MODE=single
export K3S_PREPARE_ONLY=true
export K3S_IMAGE='registry.quocanh.tech/owner/project/k3s@sha256:...'
export K3S_FIREBASE_SERVICE_ACCOUNT_FILE=/secure/firebase.json
bash scripts/k3s/deploy.sh
```

This creates secrets, PVCs, CloudNativePG, and both Redis systems. It does not
run schema migrations and does not start API or FCM pods. In single mode,
expect one PostgreSQL pod and one pod for each Redis/Sentinel role:

```bash
kubectl -n tennis-prod get cluster,pods,pvc,svc,endpoints
kubectl -n tennis-prod describe cluster tennis-postgres
```

## Phase 6: rehearse the migration before the real window

Do this against a staging namespace/cluster with a recent production snapshot.
Record duration, artifact hashes, row counts, upload counts, and every manual
step. A rehearsal is successful only after a restore drill, authentication,
admin mutations, FCM delivery, SSE updates, uploads, and failover tests pass.

Create a custom-format source dump without changing the source database:

```bash
export PGPASSWORD='SOURCE_PASSWORD'
pg_dump -h 127.0.0.1 -p 5432 -U SOURCE_USER -d SOURCE_DB \
  --format=custom --no-owner --no-privileges \
  --file=/secure/tennis-precutover.dump
unset PGPASSWORD
sha256sum /secure/tennis-precutover.dump
pg_restore --list /secure/tennis-precutover.dump >/dev/null
```

Use `pg_dump` from the same PostgreSQL major version as the target (currently
PostgreSQL 15). PostgreSQL does not guarantee that a dump created by a newer
major client can be restored into an older server. When the current source is
the repository's PostgreSQL 15 Compose container, create the dump with its
matching client:

```bash
docker exec -e PGPASSWORD="${DB_PASSWORD}" tennis-postgres \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" \
  --format=custom --no-owner --no-privileges \
  > /secure/tennis-precutover.dump
chmod 600 /secure/tennis-precutover.dump
```

Never pass a database password inside a URL argument in shared shell history.

## Phase 7: production maintenance window and data copy

This is the dangerous cutover boundary. Keep NPMplus pointing at PM2 until the
new system is fully verified.

1. Put the site into maintenance/read-only mode at NPMplus.
2. Stop writers: `pm2 stop tennis` and stop the old FCM worker. Keep old
   PostgreSQL/Redis running.
3. Take a final source `pg_dump` as shown above and record its SHA-256.
4. Take a filesystem snapshot/backup of the current upload directory.
5. Import into the **target**. This script deliberately drops/recreates only
   the new `tennis` database and requires an exact confirmation value:

```bash
export K3S_CONFIRM_DATABASE_RESTORE=tennis-prod
bash scripts/k3s/import-database.sh /secure/tennis-final.dump
```

6. Copy uploads to the Longhorn RWX PVC:

```bash
export K3S_CONFIRM_UPLOAD_IMPORT=tennis-prod
bash scripts/k3s/import-uploads.sh /home/vps/tennisranking-data/uploads
```

7. Run the idempotent migration Job:

```bash
bash scripts/k3s/run-migration.sh
```

8. Configure off-site PostgreSQL WAL archiving and create a blocking base
   backup. Do not proceed if it fails:

```bash
bash scripts/k3s/configure-backup.sh
```

9. Perform a restore drill into a separate cluster name/namespace. A backup
   object existing is not proof it can be restored.
10. Start workloads by running normal deployment with prepare-only unset:

```bash
unset K3S_PREPARE_ONLY
bash scripts/k3s/deploy.sh
```

The deploy script reruns checksum-protected migrations safely, then waits for
the API and FCM rollouts.

## Phase 8: verify before changing NPMplus

Test directly through every node while the public site is still in maintenance:

```bash
for node in 192.0.2.11 192.0.2.12 192.0.2.13; do
  curl --fail --show-error "http://${node}:30001/health"
  curl --fail --show-error "http://${node}:30001/ready"
done

kubectl -n tennis-prod get pods -o wide
kubectl -n tennis-prod logs deployment/tennis-app --tail=100
kubectl -n tennis-prod logs deployment/tennis-fcm-worker --tail=100
```

Also verify:

- source and target row counts for players, matches, users, devices, sessions,
  cup tables, seasons, daily stats, and migration tracking tables;
- file count, total bytes, and a sample hash comparison for uploads;
- anonymous reads, admin/editor login, CSRF-protected mutation, logout, and
  cookie flags through a temporary NPMplus hostname;
- SSE/event refresh with `proxy_buffering off`;
- one real FCM notification with both workers healthy;
- BullMQ queue drains and does not lose jobs during worker restart;
- PostgreSQL backup and Longhorn upload backup show successful completion.

## Phase 9: switch NPMplus

Add [`npmplus-http-upstream.conf.example`](npmplus-http-upstream.conf.example)
to NPMplus's global `http {}` configuration. In single mode, keep only the
first server line and use the learning node's private IP. In HA mode, use all
three private node IPs. Test and reload Nginx. In the existing
`nginx_custom_config.conf`, change only each upstream target from
`http://localhost:3001` to `http://tennis_k3s`.

Run NPMplus's equivalent of `nginx -t` before reloading; never make the proxy
configuration and DNS change in the same untested action.

Preserve all existing Anubis, cache, rate-limit, forwarded-header, cookie, and
security-header rules. In particular, preserve `X-Forwarded-For $remote_addr`
and keep SSE buffering disabled. Do not expose NodePort `30001` to the public
Internet; allow only NPMplus source addresses in the host firewall.

Remove maintenance mode, invalidate the NPMplus cache once, and watch error
rate, latency, PostgreSQL replication, Redis leaders, queue depth, restarts,
PVC health, and FCM delivery continuously through the rollback window.

## Normal GitLab deployment after cutover

For later releases, approve the manual `deploy-k3s` job. It serializes changes
with `resource_group: production-k3s`, receives the exact image digest from the
build job, applies secrets/config safely, runs the migration Job, performs a
zero-unavailable rolling update, and waits for both deployments.

Keep the protected GitLab variable `K3S_MODE=single` until the HA promotion is
complete. The deploy job uses the same mode-aware renderer as manual deploys.

Do not approve the old PM2 `deploy` job while K3s is the active production
writer. Both paths are intentionally retained, but running both against the
same production database can duplicate background work and confuse rollback.

## Rollback and PM2 fallback

There are three different rollback cases:

1. **Bad app image, compatible schema:** run GitLab's manual
   `rollback-k3s-image` job. It uses Deployment revision history. It does not
   revert SQL.
2. **K3s app failure before public cutover:** keep NPMplus on PM2, stop K3s app
   and FCM deployments, diagnose without customer impact.
3. **K3s failure after data cutover:** do not simply restart PM2 against the old
   database; it is now stale. Put NPMplus in maintenance, stop all K3s writers,
   take a final target backup, restore/synchronize the target database and
   uploads to the old stack, run the existing compatible migrations, start one
   FCM worker path only, verify, and only then point NPMplus back to localhost.

Emergency stop of K3s writers:

```bash
kubectl -n tennis-prod scale deployment/tennis-app --replicas=0
kubectl -n tennis-prod scale deployment/tennis-fcm-worker --replicas=0
```

The original `.gitlab-ci.yml` PM2 `deploy`/`rollback`, `ecosystem.config.cjs`,
Compose PostgreSQL/Redis/FCM services, and original `Dockerfile` remain in the
repository. That is the fallback mechanism—not an automatic dual-active mode.

## Backup and restore operations

PostgreSQL uses continuous WAL archiving plus daily base backups with 30-day
retention. Uploads use Longhorn backups. Redis cache does not need restoration;
queue Redis uses AOF, but important work should be recoverable from PostgreSQL
because Redis replication is not a substitute for backup.

At least monthly:

- restore PostgreSQL into an isolated namespace using the Barman plugin and a
  new cluster name;
- restore the uploads volume to a new PVC and compare sample hashes;
- record recovery point objective and recovery time objective actually
  achieved;
- test loss of one node, PostgreSQL primary, Redis master, API pod, and FCM
  worker separately;
- confirm etcd snapshots are copied off-cluster and test control-plane restore.

Never perform the first restore drill during a real outage.

## Promote the learning node to HA later

Do not change `K3S_MODE` merely because a second node was added. Embedded etcd
and the stateful services need a three-node quorum, so promote only after three
independent server nodes are `Ready`.

1. Take and verify PostgreSQL, uploads, Longhorn, and etcd backups.
2. If the original K3s installation uses SQLite, follow the official K3s
   conversion procedure to initialize embedded etcd on the first server before
   joining other server nodes. If the first node was installed with
   `--cluster-init`, it already uses embedded etcd.
3. Join server 2 and server 3 with the same K3s token and configuration-critical
   flags. Confirm all three nodes are `Ready` and etcd has quorum.
4. Reapply the platform in HA mode so future Longhorn volumes request three
   copies:

```bash
export K3S_MODE=ha
export K3S_CONFIRM_CLUSTER="$K3S_CONTEXT"
bash scripts/k3s/bootstrap-platform.sh
```

5. In Longhorn, change every existing tennis volume from one replica to three.
   Wait until all rebuilds are healthy before scaling databases. Changing the
   default only affects new volumes; it does not rewrite existing volumes.
6. Expand PostgreSQL and both Redis systems first without changing application
   pods:

```bash
export K3S_PREPARE_ONLY=true
bash scripts/k3s/deploy.sh
kubectl -n tennis-prod wait --for=condition=Ready cluster/tennis-postgres --timeout=30m
kubectl -n tennis-prod get pods -o wide
```

7. Confirm PostgreSQL has three healthy instances and each Redis/Sentinel role
   has three pods spread across the nodes. Then scale the application layer:

```bash
unset K3S_PREPARE_ONLY
bash scripts/k3s/deploy.sh
```

8. Change the protected GitLab variable to `K3S_MODE=ha`, configure NPMplus
   with all three NodePort endpoints, test node loss, and only then describe the
   deployment as HA.

## Upgrades and maintenance

- Drain one node at a time and respect disruption budgets. Confirm Longhorn
  replica health before continuing to the next node.
- Upgrade K3s one supported minor at a time, server nodes before agents, after
  checking the compatibility matrices for Longhorn, CloudNativePG,
  cert-manager, and the Redis operator.
- Update one platform version per pull request and rehearse rollback.
- Keep PostgreSQL major upgrades separate from K3s and application releases.
- Rotate registry, database, Redis, JWT/CSRF, Firebase, and backup credentials
  deliberately. A Redis password rotation needs coordinated pod/application
  rollout.
- Scan the built image and operator images; immutable tags/digests reduce drift
  but do not remove patching duties.

## Useful diagnostics

```bash
kubectl -n tennis-prod get all,pvc
kubectl -n tennis-prod get cluster,redisreplication,redissentinel,backup,scheduledbackup
kubectl -n tennis-prod describe cluster tennis-postgres
kubectl -n tennis-prod get events --sort-by=.lastTimestamp
kubectl -n tennis-prod top pods
kubectl -n longhorn-system get volumes.longhorn.io
kubectl -n kube-system get helmcharts
```

Every mutation script compares `kubectl config current-context` with
`K3S_CONTEXT` and additionally requires `K3S_CONFIRM_CLUSTER` to match. Treat a
failed guard as a safety feature, not something to bypass.

## Primary references

- [K3s HA embedded etcd](https://docs.k3s.io/datastore/ha-embedded)
- [K3s configuration](https://docs.k3s.io/installation/configuration)
- [K3s networking requirements](https://docs.k3s.io/installation/requirements)
- [Longhorn installation requirements](https://longhorn.io/docs/1.12.0/deploy/install/)
- [CloudNativePG documentation](https://cloudnative-pg.io/documentation/current/)
- [Barman Cloud plugin](https://cloudnative-pg.io/plugin-barman-cloud/)
- [OpsTree Redis operator](https://redis-operator.opstree.dev/)
- [Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
