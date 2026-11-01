import type { Mission } from '../game/mission.ts';
import { ORBITAL_IMAGES, REG, deployment, service, orbitalNodes, systemWorkloads, usedCmd, outputHad } from './lib.ts';

export const m1_1: Mission = {
  id: '1.1', chapter: 1, order: 1, title: 'The image that wasn\'t', tagline: 'A typo in a tag, a service that never came up.',
  ticket: {
    from: 'PagerDuty → cargo-api', priority: 'P2', subject: 'cargo-api down after last night\'s deploy (ImagePullBackOff)',
    body: [
      'Last night someone deployed cargo-api 2.1.0 to the freight namespace. The pods never started. Customers see errors on the cargo page.',
      'Find out why the pods are stuck, fix the deployment, and get cargo-api serving again. SLA for P2 is 5 minutes.',
      'Reminder from the briefing on containers: an image reference is REGISTRY/REPOSITORY:TAG. The node\'s runtime (containerd) pulls it — Docker is only used to *build* images in CI.',
    ],
  },
  concepts: [
    { title: 'Image references', body: 'An image is addressed as `registry/repository:tag` (or `@sha256:digest`). No registry means Docker Hub; no tag means `latest`. The **node runtime** (containerd/CRI-O) pulls it when a Pod is scheduled — building with Docker and running on a node are separate concerns.', example: `${REG}/cargo-api:2.1.0` },
    { title: 'ErrImagePull → ImagePullBackOff', body: 'When a pull fails, the kubelet reports `ErrImagePull`, then retries with growing delay (10s, 20s, 40s… up to 5 min): that waiting state is `ImagePullBackOff`. The reason is in the Pod\'s **events** — `kubectl describe pod` shows them.', example: 'kubectl describe pod <name> -n freight' },
    { title: 'Fix the spec, not the pod', body: 'Pods owned by a Deployment are replaced from the Deployment\'s template. Edit the Deployment (`kubectl set image` or `kubectl edit`) and the controller rolls out new Pods. Deleting the broken Pods alone just recreates them with the same bad image.', example: 'kubectl set image deployment/cargo-api cargo-api=IMAGE -n freight' },
  ],
  cluster: {
    seed: 21, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 6 * 3600, object: deployment({ name: 'cargo-api', ns: 'freight', image: `${REG}/cargo-api:2.1.O`, replicas: 2, port: 8080, env: [{ name: 'CARGO_DB_URL', value: 'postgres://cargo-db.freight.svc.cluster.local:5432/cargo' }] }) },
      { ageSeconds: 6 * 3600, object: service({ name: 'cargo-api', ns: 'freight', selector: { app: 'cargo-api' }, port: 80, targetPort: 8080 }) },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'cargo', service: 'freight/cargo-api', rps: 6, label: 'cargo page' }, { id: 'customers', service: 'freight/frontend', rps: 3, label: 'customers' }],
  },
  objectives: [
    { id: 'status', text: 'See the pods\' status with kubectl get pods', check: (c) => usedCmd(c, /^kubectl get (pods?|po)\b/) && outputHad(c, /ImagePullBackOff|ErrImagePull/) },
    { id: 'events', text: 'Find the pull error in the pod events (describe)', check: (c) => usedCmd(c, /^kubectl (describe (pods?|po)|get (events?|ev))\b/) && outputHad(c, /not found|Failed to pull/) },
    { id: 'fix', text: 'Point the deployment at the correct tag: cargo-api:2.1.0', check: (c) => c.view.deploymentImage('freight', 'cargo-api') === `${REG}/cargo-api:2.1.0` },
    { id: 'ready', text: 'cargo-api has 2/2 pods ready', check: (c) => c.view.deploymentReady('freight', 'cargo-api', 2) },
  ],
  hints: [
    { text: 'Look at the pod STATUS column first: `kubectl get pods -n freight`. Then describe one of the cargo-api pods and read the Events at the bottom.', cost: 100 },
    { text: 'The events say the registry can\'t find the tag. Compare it to the image name in the ticket: the tag should be 2.1.0 — look closely at the last character.', cost: 100 },
    { text: `Fix it on the Deployment: \`kubectl set image deployment/cargo-api cargo-api=${REG}/cargo-api:2.1.0 -n freight\`, then \`kubectl rollout status deployment/cargo-api -n freight\`.`, cost: 150 },
  ],
  par: { timeSec: 240, commands: 6 }, timeLimitSec: 300, slo: { minAvailability: 0.35 },
  solution: ['kubectl get pods -n freight', 'kubectl describe pod $(kubectl get pods -n freight -o name | grep cargo-api | head -1 | cut -d/ -f2) -n freight', `kubectl set image deployment/cargo-api cargo-api=${REG}/cargo-api:2.1.0 -n freight`, 'kubectl rollout status deployment/cargo-api -n freight'],
  debrief: { proTips: ['`kubectl get events -n freight --sort-by=.lastTimestamp` shows the newest cluster events last — a quick way to find what just broke.', 'Pin images by digest (`@sha256:…`) in CI to make "what is running" unambiguous.', '`imagePullPolicy: IfNotPresent` is the default for tagged images; `:latest` defaults to `Always`.'] },
};

export const chapter1: Mission[] = [m1_1];
