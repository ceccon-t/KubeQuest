import type { Mission } from '../game/mission.ts';
import type { ContainerBehaviour } from '../engine/images.ts';
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

const NOTIFIER_BAD: ContainerBehaviour = {
  ports: [8080], memoryMiB: 40, cpuMillis: 10, startMs: 700, crashAfterMs: 1200, sizeBytes: 31_400_000, digest: 'b7e4f1a90c2d5e8b3a6c9d0e1f4a7b2c5d8e0f3a6b9c1d4e7f0a2b5c8d1e3f6a',
  logs: { start: ['notifier 1.3.0-dev (build 4f2a91c) starting'], onCrash: ['panic: smtp: unknown auth mechanism "XOAUTH3" (config schema v2 required)', '', 'goroutine 1 [running]:', 'main.loadMailer(...)', '\t/src/notifier/mail.go:41 +0x2b8'] },
};

export const m1_2: Mission = {
  id: '1.2', chapter: 1, order: 2, title: 'The tag that moved', tagline: 'Same Deployment, same tag — two different programs.',
  ticket: {
    from: 'Ana (team-notify)', priority: 'P2', subject: 'One notifier pod crash-loops, its twins are fine — same image?!',
    body: [
      'After the node pool recycled a worker this morning, the notifier pod that was rescheduled keeps crashing. The other two replicas — same Deployment, same image line — run happily.',
      `The Deployment uses \`${REG}/notifier:latest\`. CI pushed a development build last night. I have a suspicion about what "latest" means now.`,
      `Find the difference between the healthy pods and the broken one, then pin the Deployment to the released version: \`${REG}/notifier:1.2.0\`.`,
    ],
  },
  concepts: [
    { title: 'Images are layers; tags are pointers', body: 'An OCI image is a stack of read-only **layers** plus a config, identified by a content **digest** (`sha256:…`). A **tag** is only a movable pointer to a digest: pushing a new build under the same tag silently repoints it. Two nodes that pulled `:latest` on different days can run different code.', example: "kubectl get pod NAME -o jsonpath='{.status.containerStatuses[0].imageID}'" },
    { title: 'imagePullPolicy', body: '`IfNotPresent` (default for a versioned tag) reuses the image a node already has. `Always` (default for `:latest` or no tag) asks the registry on every container start. Neither makes a mutable tag safe: pin a version tag, or better, a digest.', example: `image: ${REG}/notifier:1.2.0   # or …/notifier@sha256:4c1d…` },
    { title: 'In the real world: building images', body: 'CI builds images from a **Dockerfile**: each instruction is a cached layer, so order them from least to most frequently changing. A **multistage build** compiles in one stage and copies only the binary into a small final image. Building (Docker, BuildKit) is unrelated to running: nodes use a **CRI** runtime such as containerd.', example: 'kubectl get nodes -o wide   # CONTAINER-RUNTIME column' },
  ],
  cluster: {
    seed: 22, nodes: orbitalNodes(), namespaces: ['freight'], images: ORBITAL_IMAGES,
    objects: [
      ...systemWorkloads(),
      { ageSeconds: 2 * 86400, object: deployment({ name: 'notifier', ns: 'freight', image: `${REG}/notifier:latest`, replicas: 3, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: deployment({ name: 'frontend', ns: 'freight', image: `${REG}/frontend:1.4.0`, replicas: 2, port: 8080 }) },
      { ageSeconds: 3 * 86400, object: service({ name: 'frontend', ns: 'freight', selector: { app: 'frontend' }, port: 80, targetPort: 8080 }) },
    ],
    traffic: [{ id: 'customers', service: 'freight/frontend', rps: 3, label: 'customers' }],
  },
  objectives: [
    { id: 'spot', text: 'Find the notifier pod that is crash-looping', check: (c) => c.flags.has('moved') && usedCmd(c, /^kubectl (get|describe) (pods?|po)\b/) && outputHad(c, /CrashLoopBackOff|\bError\b/) },
    { id: 'digest', text: 'Compare the Image ID (digest) of a healthy pod with the broken one', check: (c) => outputHad(c, /sha256:4c1d9a2e/) && outputHad(c, /sha256:b7e4f1a9/) },
    { id: 'pin', text: 'Pin the Deployment to notifier:1.2.0', check: (c) => c.view.deploymentImage('freight', 'notifier') === `${REG}/notifier:1.2.0` },
    { id: 'ready', text: 'notifier is 3/3 ready on the pinned version', check: (c) => c.view.deploymentImage('freight', 'notifier') === `${REG}/notifier:1.2.0` && c.view.deploymentReady('freight', 'notifier', 3) },
    { id: 'runtime', text: 'Bonus: check which container runtime the nodes use', optional: true, check: (c) => usedCmd(c, /^kubectl (get (nodes?|no)\b.*-o[= ]?wide|describe (nodes?|no))/) && outputHad(c, /containerd:\/\//) },
  ],
  chaos: [
    { id: 'push', at: { afterSeconds: 4 }, action: { type: 'addImage', image: `${REG}/notifier:latest`, behaviour: NOTIFIER_BAD } },
    { id: 'recycle', at: { afterSeconds: 5 }, action: { type: 'killPods', namespace: 'freight', selector: 'app=notifier', count: 1 }, announce: { from: 'node-pool', text: 'A worker was recycled; one notifier pod was rescheduled and pulled its image again.' } },
    { id: 'moved', at: { afterSeconds: 5 }, action: { type: 'flag', flag: 'moved' } },
  ],
  hints: [
    { text: '`kubectl get pods -n freight` shows which notifier pod restarts. Its logs (`kubectl logs POD -n freight --previous`) show a build the others are not running.', cost: 100 },
    { text: 'All three pods say `notifier:latest`, but `kubectl describe pods -n freight -l app=notifier | grep "Image ID"` prints the digest each one actually runs. Two different sha256 values = two different images behind one tag.', cost: 100 },
    { text: `Pin it: \`kubectl set image deployment/notifier notifier=${REG}/notifier:1.2.0 -n freight\`, then \`kubectl rollout status deployment/notifier -n freight\`.`, cost: 150 },
  ],
  par: { timeSec: 300, commands: 7 }, timeLimitSec: 600, slo: { minAvailability: 0.95 },
  solution: ['sleep 14', 'kubectl get pods -n freight', 'kubectl describe pods -n freight -l app=notifier | grep "Image ID"', `kubectl set image deployment/notifier notifier=${REG}/notifier:1.2.0 -n freight`, 'kubectl rollout status deployment/notifier -n freight', 'kubectl get nodes -o wide'],
  debrief: { proTips: ['Admission policies can reject `:latest` outright — you will write one in Chapter 5.', 'Registries can make tags immutable (Harbor, ECR, GCR); turn it on for release repositories.', 'Scanners (Trivy, Grype) and signatures (cosign) work on digests, which is one more reason to deploy by digest.'] },
};

export const chapter1: Mission[] = [m1_1, m1_2];
