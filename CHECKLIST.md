# CHECKLIST

> Verification guide for the **Cloud Technologies** project.

This document is the entry point for grading. The implementation lives in:

| Folder | Purpose |
|---|---|
| `k8s/` | Raw Kubernetes manifests (reference / `kubectl apply -f k8s/`) |
| `helm/aura/` | Parametrized Helm chart with `values-dev.yaml` and `values-prod.yaml` |
| `.github/workflows/` | CI/CD: e2e tests + build & push to GHCR + deploy to kind |
| `scripts/build-load.sh` | One-shot build all 4 images and load them into kind |
| `kind-config.yaml` | Kind cluster definition (maps ports 80/443 to host for the Ingress) |

---

## 1. Quick start

Prerequisites: **docker**, **kind ≥ 0.20**, **kubectl ≥ 1.27**, **helm ≥ 3.10**, **bash**.

```bash
# 1. clone
git clone https://github.com/zofiadobrowolskaa/ecommerce.git
cd ecommerce

# 2. create kind cluster
kind create cluster --name aura --config kind-config.yaml

# 3. install the ingress controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=180s

# 4. build the 4 service images and load them into the kind node
bash scripts/build-load.sh ci

# 5. deploy the chart with the dev overlay, pointing at the locally-loaded images
helm upgrade --install aura ./helm/aura \
  -f helm/aura/values-dev.yaml \
  --set image.registry=docker.io/library \
  --set image.tag=ci \
  --create-namespace --namespace aura \
  --wait --timeout 8m

# 6. smoke-test
kubectl -n aura port-forward svc/api-gateway 3000:3000 &
sleep 4
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/ready
curl -fsS http://localhost:3000/api/products | head -c 200
```

**Expected after step 5:**
```
Release "aura" has been upgraded. Happy Helming!
STATUS: deployed
```
**Expected after step 6:**
```
{"status":"ok","service":"api-gateway"}
{"ready":true}
[{"id":4,"name":"Linework Bangle","sku":"p004",...
```

When done verifying, run `kind delete cluster --name aura` to clean up.

---

## 2. Requirements coverage table

Click any requirement to jump to its detailed verification section.

| # | Requirement | % | Status | Verify with |
|---|---|---|---|---|
| 1 | [Manifests](#w1--manifests-12) | 12 | ✅ | `ls k8s/` + Helm chart |
| 2 | [Deployments + rolling update](#w2--deployments--rolling-update-10) | 10 | ✅ | `kubectl get deploy api-gateway -o jsonpath='{.spec.strategy}'` |
| 3 | [DB StatefulSet + PVC](#w3--db-statefulset--pvc-12) | 12 | ✅ | `kubectl -n aura get sts,pvc` |
| 4 | [Services + Ingress + isolation](#w4--services--ingress--isolation-10) | 10 | ✅ | `kubectl -n aura get svc,ing` |
| 5 | [ConfigMap + Secret](#w5--configmap--secret-8) | 8 | ✅ | `kubectl -n aura get cm,secret` |
| 6 | [Probes + resources](#w6--probes--resources-10) | 10 | ✅ | `kubectl -n aura describe pod ...` |
| 7 | [securityContext + initContainer + Job](#w7--securitycontext--initcontainer--job-8) | 8 | ✅ | `kubectl -n aura get job seeder` |
| 8 | [CI/CD GitHub Actions](#w8--cicd-github-actions-10) | 10 | ✅ | link to last workflow run |
| 9 | [NetworkPolicy](#w9--networkpolicy-25) | 2.5 | ✅ | `kubectl -n aura get netpol` |
| 10 | [PodDisruptionBudget](#w10--poddisruptionbudget-25) | 2.5 | ✅ | `kubectl -n aura get pdb` |
| 11 | [Helm dev/prod overlays](#w11--helm-devprod-overlays-25) | 2.5 | ✅ | `helm template ... -f values-prod.yaml` |
| 12 | [/metrics observability](#w12--metrics-observability-25) | 2.5 | ✅ | `curl .../metrics` |
| 13 | [CRUD + /health](#w13--crud--health-10) | 10 | ✅ | `curl .../api/products` |
| 14 | [Data persistence](#w14--data-persistence-5) | 5 | ✅ | kill postgres pod → record survives |
| 15 | [Cache (Redis)](#w15--cache-redis-5) | 5 | ✅ | `curl -i .../api/products` shows `X-Cache: HIT` |

---

## 3. Detailed verification

Each section assumes the cluster is running and the chart is installed (steps 1–5 from §1). Each section is independent - run them in any order.

### W1 - Manifests (12%)

> Required: Namespace, Deployment, StatefulSet, Service, Ingress, ConfigMap, Secret, PVC.

The chart renders **29 resources** of **10 different kinds**:

```bash
helm template aura helm/aura -f helm/aura/values-dev.yaml | grep -E '^kind:' | sort | uniq -c
```

Expected:
```
      1 kind: ConfigMap
      5 kind: Deployment
      1 kind: Ingress
      1 kind: Job
      8 kind: NetworkPolicy
      2 kind: PodDisruptionBudget
      1 kind: Secret
      7 kind: Service
      2 kind: StatefulSet
```

Namespace is provisioned by `helm install --create-namespace` (intentional, see [W5] note).

**Files:** `helm/aura/templates/*.yaml` (Helm) + `k8s/*.yaml` (raw reference).

---

### W2 - Deployments + rolling update (10%)

> Required: backend has ≥ 2 replicas and RollingUpdate strategy.

```bash
kubectl -n aura get deploy api-gateway -o jsonpath='{.spec.strategy}' && echo
kubectl -n aura get deploy api-gateway
```

Expected:
```
{"rollingUpdate":{"maxSurge":1,"maxUnavailable":0},"type":"RollingUpdate"}

NAME          READY   UP-TO-DATE   AVAILABLE   AGE
api-gateway   2/2     2            2           ...
```

`maxUnavailable: 0` guarantees **zero downtime** during updates.

Demonstrate a live rolling update:
```bash
# build a v2 image so we can roll over
docker build -t aura-api-gateway:v2 ./backend/api-gateway
kind load docker-image aura-api-gateway:v2 --name aura

kubectl -n aura set image deploy/api-gateway \
  api-gateway=docker.io/library/aura-api-gateway:v2
kubectl -n aura rollout status deploy/api-gateway --timeout=120s
```

Expected progression:
```
Waiting for deployment "api-gateway" rollout to finish: 1 out of 2 new replicas have been updated...
Waiting for deployment "api-gateway" rollout to finish: 1 old replicas are pending termination...
deployment "api-gateway" successfully rolled out
```

**Files:** `helm/aura/templates/30-pg-service-deployment.yaml`, `32-api-gateway-deployment.yaml`, etc.

---

### W3 - DB StatefulSet + PVC (12%)

> Required: database runs as StatefulSet (or justified equivalent) backed by a PersistentVolumeClaim.

```bash
kubectl -n aura get sts
kubectl -n aura get pvc
```

Expected:
```
NAME       READY   AGE
mongodb    1/1     ...
postgres   1/1     ...

NAME              STATUS   VOLUME        CAPACITY   ACCESS MODES   STORAGECLASS
data-mongodb-0    Bound    pvc-...       1Gi        RWO            standard
data-postgres-0   Bound    pvc-...       1Gi        RWO            standard
```

The PVCs are dynamically provisioned via `volumeClaimTemplates` on each StatefulSet, so each replica gets its own persistent volume.

**Files:** `helm/aura/templates/20-postgres-statefulset.yaml`, `21-mongo-statefulset.yaml`.

---

### W4 - Services + Ingress + isolation (10%)

> Required: internal traffic via Service, external via Ingress, database/cache/worker not exposed.

```bash
kubectl -n aura get svc
kubectl -n aura get ing
```

Expected:
```
NAME            TYPE        CLUSTER-IP       PORT(S)
api-gateway     ClusterIP   10.96.74.99      3000/TCP
frontend        ClusterIP   10.96.164.75     8080/TCP
mongo-service   ClusterIP   10.96.8.96       3002/TCP
mongodb         ClusterIP   None             27017/TCP   <-- headless
pg-service      ClusterIP   10.96.101.238    3001/TCP
postgres        ClusterIP   None             5432/TCP    <-- headless
redis           ClusterIP   10.96.146.2      6379/TCP

NAME           CLASS   HOSTS        ADDRESS     PORTS
aura-ingress   nginx   aura.local   localhost   80
```

**Isolation proof:** The Ingress routes only `/`, `/api`, `/api-docs`, `/health`, `/ready`, `/metrics` - **all to `api-gateway` or `frontend`**. `postgres`, `mongodb`, `redis`, `pg-service`, `mongo-service` have no Ingress backend, so they are unreachable from outside the cluster.

```bash
kubectl -n aura get ing aura-ingress -o jsonpath='{.spec.rules[0].http.paths[*].backend.service.name}' && echo
```
Expected: `api-gateway api-gateway api-gateway api-gateway api-gateway frontend`

**Files:** `helm/aura/templates/40-services.yaml`, `50-ingress.yaml`.

---

### W5 - ConfigMap + Secret (8%)

> Required: non-sensitive config in ConfigMap, sensitive in Secret. No real production passwords in code or README.

```bash
kubectl -n aura get cm aura-config -o jsonpath='{.data}' | head -c 200 && echo
kubectl -n aura get secret aura-secret -o jsonpath='{.type}' && echo
kubectl -n aura get secret aura-secret -o jsonpath='{.data}' | head -c 100 && echo
```

Expected:
```
{"API_GATEWAY_PORT":"3000","CATALOG_SERVICE_PORT":"3002","CATALOG_SERVICE_URL":"http://mongo-service:3002","ENVIRONMENT":"dev","INVENTORY_SERVICE_PORT":"3001","INVENTORY_SERVICE_URL":"http://pg-servic
Opaque
{"DATABASE_URL":"cG9zdGdyZX...","MONGO_PASSWORD":"...","MONGO_URI":"...","POSTGRES_PASSWORD":"..."}
```

> ⚠️ **Note on passwords:** the values in `helm/aura/templates/11-secret.yaml` are clearly marked **dev placeholders** (`dev_password_change_me`). In production they are created via `kubectl create secret generic aura-secret --from-literal=POSTGRES_PASSWORD=...` or via an external secret manager (sealed-secrets, ESO). No real production credential lives in this repo.

**Files:** `helm/aura/templates/10-configmap.yaml`, `11-secret.yaml`.

---

### W6 - Probes + resources (10%)

> Required: containers expose readinessProbe + livenessProbe + resources.requests + resources.limits.

```bash
kubectl -n aura get deploy api-gateway -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}' && echo
kubectl -n aura get deploy api-gateway -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}' && echo
kubectl -n aura get deploy api-gateway -o jsonpath='{.spec.template.spec.containers[0].resources}' && echo
```

Expected:
```json
{"failureThreshold":3,"httpGet":{"path":"/ready","port":3000,"scheme":"HTTP"},"initialDelaySeconds":5,"periodSeconds":5,"successThreshold":1,"timeoutSeconds":1}
{"failureThreshold":3,"httpGet":{"path":"/health","port":3000,"scheme":"HTTP"},"initialDelaySeconds":15,"periodSeconds":10,"successThreshold":1,"timeoutSeconds":1}
{"limits":{"cpu":"300m","memory":"256Mi"},"requests":{"cpu":"50m","memory":"128Mi"}}
```

- `/health` (liveness) - checks that the Node.js process is alive (cheap)
- `/ready` (readiness) - pings downstream services; a 503 makes the pod NotReady so traffic shifts to healthy replicas

Same probes are defined on `pg-service` (db ping), `mongo-service` (admin ping), `frontend` (nginx `/health`), `redis` (`redis-cli ping`), `postgres` (`pg_isready`), `mongodb` (tcpSocket :27017).

**Files:** every Deployment / StatefulSet template under `helm/aura/templates/`.

---

### W7 - securityContext + initContainer + Job (8%)

> Required: containers run as non-root with basic securityContext, project uses initContainer or Job for migrations / initialization.

**Non-root:**
```bash
kubectl -n aura get deploy api-gateway -o jsonpath='{.spec.template.spec.securityContext}' && echo
kubectl -n aura exec deploy/api-gateway -- id
```

Expected:
```
{"fsGroup":101,"runAsNonRoot":true,"runAsUser":100}
uid=100(app) gid=101(app) groups=101(app)
```

**initContainer (runs DB migrations before the http server starts):**
```bash
kubectl -n aura get deploy pg-service -o jsonpath='{.spec.template.spec.initContainers[*].name}' && echo
```
Expected: `migrate`

The `migrate` init container runs `npm run migrate` which executes `prisma migrate deploy && knex migrate:latest && knex seed:run`. Only after it exits 0 does the main `pg-service` container start.

**Job (one-shot seeder that populates the catalog via the gateway saga):**
```bash
kubectl -n aura get job seeder
```
Expected:
```
NAME     STATUS     COMPLETIONS   DURATION   AGE
seeder   Complete   1/1           7s         ...
```

The seeder is a Helm `post-install,post-upgrade` hook so it runs every fresh install / upgrade.

Container-level hardening is also applied (`allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]`).

**Files:** all Deployment / Job templates in `helm/aura/templates/`.

---

### W8 - CI/CD GitHub Actions (10%)

> Required: workflow that builds image + runs tests/validation + pushes to registry + deploys via kubectl/Helm/Kustomize + checks rollout.

Three chained workflows live in `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `e2e-tests.yml` | push to main, PRs | Spins up docker compose, runs 12 supertest scenarios against the gateway |
| `docker-build-push.yml` | `workflow_run` after e2e on main | Matrix build of 4 images, pushes `:latest` and `:<sha>` to `ghcr.io/zofiadobrowolskaa/aura-*` |
| `k8s-deploy.yml` | push to main | Creates kind cluster, installs nginx-ingress, builds + kind-loads images, `helm upgrade --install` with `values-dev.yaml`, **explicit `kubectl rollout status` per Deployment**, waits for the seeder Job, runs smoke tests against `/health`, `/ready`, `/api/products` |

**Rollout verification snippet from `k8s-deploy.yml`:**
```yaml
- name: Verify rollout
  run: |
    kubectl -n aura rollout status deploy/api-gateway   --timeout=180s
    kubectl -n aura rollout status deploy/pg-service    --timeout=180s
    kubectl -n aura rollout status deploy/mongo-service --timeout=180s
    kubectl -n aura rollout status deploy/frontend      --timeout=180s
    kubectl -n aura rollout status deploy/redis         --timeout=180s
```

**Last successful run:**
👉 https://github.com/zofiadobrowolskaa/ecommerce/actions

(Pick the most recent green run of "K8s Deploy (kind)" on `main`.)

---

### W9 - NetworkPolicy (2.5%)

> Required: NetworkPolicy limiting traffic between pods - e.g. the database only accepts traffic from the backend.

```bash
kubectl -n aura get netpol
```

Expected (8 policies):
```
NAME                          POD-SELECTOR
default-deny                  <none>                <-- baseline
postgres-allow-pg-service     app=postgres
mongodb-allow-mongo-service   app=mongodb
redis-allow-gateway           app=redis
pg-svc-allow-gateway          app=pg-service
mongo-svc-allow-gateway       app=mongo-service
gateway-allow-ingress         app=api-gateway       <-- ingress controller + seeder Job
frontend-allow-ingress        app=frontend
```

**Live proof - blocked path** (unauthorized pod cannot reach postgres):
```bash
kubectl -n aura run debug-bad --image=curlimages/curl:8.10.1 --restart=Never --rm -i \
  --command -- sh -c 'curl -m 3 -sS -o /dev/null -w "http_code=%{http_code}\n" http://postgres:5432 || echo BLOCKED'
```
Expected: `http_code=000` and `BLOCKED` (request timed out).

**Live proof - allowed path** (the gateway can reach pg-service):
```bash
GATEWAY=$(kubectl -n aura get pod -l app=api-gateway -o jsonpath='{.items[0].metadata.name}')
kubectl -n aura exec "$GATEWAY" -- node -e "require('http').get('http://pg-service:3001/health', r => r.on('data', d => console.log('http_code=' + r.statusCode, d.toString())))"
```
Expected: `http_code=200 {"status":"ok","service":"inventory-order-service"}`

**File:** `helm/aura/templates/70-networkpolicies.yaml`.

---

### W10 - PodDisruptionBudget (2.5%)

> Required: backend has a PDB protecting minimum replica availability during voluntary disruptions.

```bash
kubectl -n aura get pdb
```

Expected:
```
NAME              MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS
api-gateway-pdb   1               N/A               1
pg-service-pdb    1               N/A               1
```

`ALLOWED DISRUPTIONS: 1` confirms the PDB is active and would prevent a drain from taking the last replica down.

**File:** `helm/aura/templates/71-poddisruptionbudget.yaml`.

---

### W11 - Helm dev/prod overlays (2.5%)

> Required: chart supports parameterization across ≥ 2 environments.

```bash
helm lint helm/aura

diff \
  <(helm template aura helm/aura -f helm/aura/values-dev.yaml) \
  <(helm template aura helm/aura -f helm/aura/values-prod.yaml) \
  | head -20
```

Expected diff highlights:
```
<   ENVIRONMENT: "dev"
>   ENVIRONMENT: "prod"
<   replicas: 2
>   replicas: 3
<             cpu: 300m
>             cpu: 1000m
<             cpu: 50m
>             cpu: 200m
```

| Value | `values-dev.yaml` | `values-prod.yaml` |
|---|---|---|
| `gateway.replicas` | 2 | 3 |
| `gateway.resources.requests.cpu` | 50m | 200m |
| `gateway.resources.limits.cpu` | 300m | 1000m |
| `postgres.storage` | 1Gi | 5Gi |
| `mongodb.storage` | 1Gi | 5Gi |
| `ingress.host` | aura.local | aura.example.com |

**Files:** `helm/aura/values.yaml`, `helm/aura/values-dev.yaml`, `helm/aura/values-prod.yaml`.

---

### W12 - /metrics observability (2.5%)

> Required: `/metrics` endpoint, Prometheus annotations, or other observability + instructions to check.

```bash
kubectl -n aura port-forward svc/api-gateway 3000:3000 &
sleep 3
curl -sS http://localhost:3000/metrics | head -15
echo --- custom counter ---
curl -sS http://localhost:3000/metrics | grep '^gateway_http_requests_total'
```

Expected:
```
# HELP gateway_process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE gateway_process_cpu_user_seconds_total counter
gateway_process_cpu_user_seconds_total 0.946456
...
--- custom counter ---
gateway_http_requests_total{method="GET",route="/ready",status="200"} 18
gateway_http_requests_total{method="GET",route="/health",status="200"} 8
gateway_http_requests_total{method="GET",route="/api/products",status="200"} 4
```

Pod-level Prometheus discovery annotations:
```bash
kubectl -n aura get pod -l app=api-gateway -o jsonpath='{.items[0].metadata.annotations}'
```
Expected: `{"prometheus.io/path":"/metrics","prometheus.io/port":"3000","prometheus.io/scrape":"true"}`

`pg-service` and `mongo-service` expose the same `/metrics` endpoint with the same scrape annotations.

**Files:** `backend/api-gateway/src/index.js` (prom-client setup), all backend Deployment templates (annotations).

---

### W13 - CRUD + /health (10%)

> Required: app has one main business resource supporting create + read + a `/health` (or `/ready`) endpoint.

The business resource is **product** (jewellery catalog).

```bash
kubectl -n aura port-forward svc/api-gateway 3000:3000 &
sleep 3

echo '=== /health ===' && curl -fsS http://localhost:3000/health && echo
echo '=== /ready  ===' && curl -fsS http://localhost:3000/ready && echo

echo '=== CREATE product (hybrid saga: writes to both PG and Mongo) ==='
curl -sS -X POST http://localhost:3000/api/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo Bangle","sku":"DEMO-001","price":42,"category_id":1,"long_description":"created for the cloud project demo","specs":{"material":"silver"},"variants":[{"id":"x","color":"Silver","stock":3}]}'

echo
echo '=== READ all products ===' && curl -sS http://localhost:3000/api/products | head -c 200
```

Expected:
```
=== /health === {"status":"ok","service":"api-gateway"}
=== /ready  === {"ready":true}
=== CREATE ... === {"id":<n>,"message":"product created in both databases"}
=== READ ... === [{"id":4,"name":"Linework Bangle",...
```

The gateway is also documented at `http://localhost:3000/api-docs` (Swagger UI generated from OpenAPI 3.0).

**Files:** `backend/api-gateway/src/index.js` (REST routes + saga), `backend/inventory-order-service/src/index.js` (Postgres writes), `backend/catalog-analytics-service/src/index.js` (Mongo writes).

---

### W14 - Data persistence (5%)

> Required: data lives in a database inside the cluster and survives a database pod restart.

```bash
kubectl -n aura port-forward svc/api-gateway 3000:3000 &
sleep 3

# 1. add a record
curl -sS -X POST http://localhost:3000/api/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Persistence Test Ring","sku":"PERSIST-001","price":99,"category_id":1,"long_description":"created to prove postgres pvc survives pod restart","specs":{"material":"silver"},"variants":[{"id":"x","color":"Silver","stock":7}]}'

# remember the id printed by the previous command, e.g. 37
ID=37

# 2. kill the database pod
kubectl -n aura delete pod postgres-0 --force --grace-period=0

# 3. wait for it to come back (StatefulSet recreates with the SAME PVC)
kubectl -n aura wait --for=condition=ready pod postgres-0 --timeout=120s

# 4. read the record back - it must still be there
curl -sS http://localhost:3000/api/products/$ID
```

Expected (the same product, unchanged):
```
{"id":37,"name":"Persistence Test Ring","sku":"PERSIST-001","price":"99.00","stock":7,...}
```

`pg-service` may briefly enter `CrashLoopBackOff` while postgres-0 is down (its `/ready` probe fails), and self-heals once postgres-0 is back. Data is preserved because the PVC (`data-postgres-0`) is reattached to the new pod by the StatefulSet controller.

---

### W15 - Cache (Redis) (5%)

> Required: extra architecture component (cache, queue, or worker) with proof of operation in CHECKLIST.md.

Redis is wired in front of `GET /api/products` with a 30s TTL and explicit invalidation on every product/order mutation.

```bash
kubectl -n aura port-forward svc/api-gateway 3000:3000 &
sleep 3

echo '=== request 1: expect MISS (origin) ==='
curl -sS -D - -o /dev/null http://localhost:3000/api/products | grep -i X-Cache

echo '=== request 2: expect HIT (from redis) ==='
curl -sS -D - -o /dev/null http://localhost:3000/api/products | grep -i X-Cache

echo '=== POST /api/products triggers cache invalidation ==='
curl -sS -X POST http://localhost:3000/api/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Cache Demo","sku":"CACHE-1","price":1,"category_id":1,"long_description":"demo","specs":{},"variants":[{"id":"x","color":"X","stock":1}]}' \
  > /dev/null

echo '=== request 3: expect MISS again (invalidated) ==='
curl -sS -D - -o /dev/null http://localhost:3000/api/products | grep -i X-Cache
```

Expected:
```
=== request 1 ... === X-Cache: MISS
=== request 2 ... === X-Cache: HIT
=== request 3 ... === X-Cache: MISS
```

Redis service is internal (`kubectl -n aura get svc redis` → ClusterIP, not in Ingress) and protected by a NetworkPolicy that only allows `api-gateway` pods.

**Files:** `backend/api-gateway/src/index.js` (cache read/write + invalidation), `helm/aura/templates/22-redis-deployment.yaml`, `helm/aura/templates/70-networkpolicies.yaml` (`redis-allow-gateway`).

---

## 4. CI/CD link

Last successful run of the K8s Deploy workflow on `main`:

👉 **https://github.com/zofiadobrowolskaa/ecommerce/actions/runs/26601375347**

---

## 5. Cleanup

```bash
helm uninstall aura -n aura
kubectl delete ns aura
kind delete cluster --name aura
```

---

## Appendix - file index

```
.
├── CHECKLIST.md                          # this file
├── kind-config.yaml                      # kind cluster definition
├── k8s/                                  # raw reference manifests
│   ├── 00-namespace.yaml
│   ├── 10-configmap.yaml
│   ├── 11-secret.yaml
│   ├── 20-postgres-statefulset.yaml
│   ├── 21-mongo-statefulset.yaml
│   ├── 22-redis-deployment.yaml
│   ├── 30-pg-service-deployment.yaml
│   ├── 31-mongo-service-deployment.yaml
│   ├── 32-api-gateway-deployment.yaml
│   ├── 33-frontend-deployment.yaml
│   ├── 40-services.yaml
│   ├── 50-ingress.yaml
│   ├── 60-seeder-job.yaml
│   ├── 70-networkpolicies.yaml
│   └── 71-poddisruptionbudget.yaml
├── helm/aura/                            # parametrized chart
│   ├── Chart.yaml
│   ├── values.yaml                       # defaults (= dev sizing)
│   ├── values-dev.yaml                   # explicit dev marker
│   ├── values-prod.yaml                  # prod overrides
│   └── templates/                        # 12 templates → 29 rendered resources
├── scripts/
│   └── build-load.sh                     # build 4 images + kind load
└── .github/workflows/
    ├── e2e-tests.yml                     # existing supertest suite
    ├── docker-build-push.yml             # ghcr matrix push, chained after e2e
    └── k8s-deploy.yml                    # kind + helm + rollout status verification
```
