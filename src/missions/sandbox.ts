import type { Mission } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads } from './lib.ts';

export const SANDBOX: Mission = {
  id: 'sandbox', chapter: 99, order: 0, title: 'Sandbox', tagline: 'Free play on a copy of orbital-prod. Nothing is graded.', sandbox: true,
  ticket: { from: 'You', priority: 'P4', subject: 'Sandbox cluster', body: ['A four-node cluster with the freight stack already running and light traffic on the frontend.', 'Manifests for every workload are in ~/manifests. Break things, fix things, try every command in `kubectl help`.', 'Images you can use: ' + Object.keys(ORBITAL_IMAGES).map((k) => k.replace('registry.orbital.local/freight/', '')).join(', ') + ', nginx:1.27, redis:7, busybox:1.36.'] },
  concepts: [],
  cluster: {
    seed: 7, nodes: orbitalNodes(), namespaces: ['freight', 'billing'], images: ORBITAL_IMAGES, evictionSeconds: 60,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 3, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 2 * 86400, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.0`, replicas: 2, port: 8080, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db:5432/cargo' }] }) },
      { ageSeconds: 2 * 86400, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 5 * 86400, object: deployment({ name: 'cargo-db', ns: 'freight', image: 'redis:7', replicas: 1, port: 6379, containerName: 'db' }) },
      { ageSeconds: 9 * 86400, object: deployment({ name: 'invoicer', ns: 'billing', image: `${REG}/notifier:1.2.0`, replicas: 2, port: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 6, label: 'customers' }],
  },
  files: {
    'manifests/frontend.yaml': `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: frontend\n  namespace: freight\n  labels:\n    app: frontend\nspec:\n  replicas: 3\n  selector:\n    matchLabels:\n      app: frontend\n  template:\n    metadata:\n      labels:\n        app: frontend\n    spec:\n      containers:\n      - name: frontend\n        image: ${REG}/frontend:1.4.0\n        ports:\n        - containerPort: 8080\n`,
    'manifests/cargo-api.yaml': `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: cargo-api\n  namespace: freight\n  labels:\n    app: cargo-api\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: cargo-api\n  template:\n    metadata:\n      labels:\n        app: cargo-api\n    spec:\n      containers:\n      - name: cargo-api\n        image: ${REG}/cargo-api:2.1.0\n        ports:\n        - containerPort: 8080\n        env:\n        - name: CARGO_DB_URL\n          value: postgres://cargo-db:5432/cargo\n`,
  },
  objectives: [], hints: [], par: { timeSec: 1, commands: 1 }, solution: [], debrief: { proTips: [] },
};
