/**
 * Insights: what a senior engineer pairing with the player would say the moment an objective is
 * completed. They guide attention ("look at…", "a pro would check…"), they do not give answers.
 * Keyed by mission id → objective id. Enforced by tests/missions/content.test.ts.
 */
export const INSIGHTS: Record<string, Record<string, string>> = {
  '0.1': {
    nodes: 'Four nodes, one of them `control-plane`. A pro glances at AGE and VERSION first: a node much younger than the others, or on a different kubelet version, is where the weird problems usually live.',
    'pods-all': 'Notice how much of the list is `kube-system` — cluster plumbing you did not deploy (DNS, kube-proxy). Experienced eyes filter it out mentally and scan the remaining rows for anything that is not `1/1 Running` with `0` restarts.',
    describe: 'That wall of text has a shape worth memorising: identity at the top, then one block per container with its **State** and **Last State**, then Conditions, then Events. When something is wrong, read it bottom-up — Events first.',
    deploy: 'READY `2/2`, UP-TO-DATE 2, AVAILABLE 2: three numbers that should agree. The day they disagree (say READY 1/2 for ten minutes) is the day you have an incident, and `get deploy` is the fastest way to notice it across a whole namespace.',
  },
  '1.1': {
    status: '`0/1` READY with `ImagePullBackOff`, and the AGE says these pods have been failing since the deploy. A pro reads STATUS as a category: anything containing *Image* is a registry/name problem, not an application problem — no point reading app logs yet.',
    events: 'Read the `Failed` event literally: it prints the exact reference the node asked the registry for. A pro compares that string, character by character, with the tag in the release ticket — tags are opaque, `2.1.O` and `2.1.0` are two different images. Also note the sequence: `Pulling` → `Failed` → `BackOff`, with growing delays.',
    fix: 'You changed the Deployment, not the pods. Watch the map: a new ReplicaSet appears and the old pods are replaced — the controller does the deletion for you. If you had deleted the pods by hand, they would have come back with the same broken tag.',
    ready: 'Endpoints are back and the SLO meter is recovering. Before closing the ticket a pro asks "how did a bad tag reach prod?" — the answer (no image validation in CI, or a human typing tags) is the real fix.',
  },
  '2.1': {
    all: 'One row stands out: STATUS `CrashLoopBackOff` and RESTARTS climbing. Note the NAMESPACE column — your eyes should go there first, because every follow-up command needs `-n` with that value.',
    node: 'The NODE column tells you where it runs; the IP tells you it was scheduled and started. A pro checks whether *other* pods on that node are healthy — if they are, the node is innocent and the problem is in the pod.',
    label: 'Labelling did not restart or change the pod; metadata edits are free. Teams build dashboards on labels like `triage=p1`, so this is how you hand off work without a chat message.',
    ctx: 'Your prompt did not change, but every command from now on defaults to `billing`. A pro keeps this in mind when a `get pods` suddenly shows "No resources found" — it usually means the context, not the cluster, changed.',
    selector: 'Selectors are the same mechanism Services and ReplicaSets use to find their pods. If `-l tier=edge` lists exactly the pods you expected, a Service with that selector would route to exactly them.',
  },
  '2.2': {
    logs: 'The line that matters is the one just before the process exits: a required variable is missing. A pro also notices what is *not* there — no stack trace, no connection attempt — the app never got far enough to touch the database.',
    describe: '`Exit Code: 1` with a `Last State` block confirms the app chose to exit; `137` would have meant the kernel or kubelet killed it. The restart count tells you how long this has been going on; with backoff doubling, each retry buys you less information.',
    env: 'The Deployment template now carries the variable, so every new pod gets it. Check `kubectl get pods`: the old crash-looping pods are being replaced rather than fixed in place — pods are immutable, templates are not.',
    declarative: 'The `last-applied-configuration` annotation now contains your env block. That is what protects your fix from the next CI run: apply compares the file against what it applied last time, not against what someone changed by hand.',
    ready: 'Two ready endpoints and the error rate is falling. A pro now reads the SLO total, not just the last minute: that is the number that goes in the incident report.',
  },
  '2.3': {
    dryrun: 'Open the file. Notice `creationTimestamp: null`, `strategy: {}` and `status: {}` — harmless scaffolding kubectl emits. Also notice the container `name` was derived from the image; you may want to rename it before this goes into git.',
    apply: '`created` on the first apply. A pro immediately runs `kubectl get deploy notifier -o yaml | grep last-applied` once in their life, to see what apply stores — then never worries about it again.',
    delete: 'Nothing recreated `notifier-manual`: no ReplicaSet owned it. Compare with the pods of your new Deployment, which have an `ownerReferences` entry. That difference is the whole reason unmanaged pods are a liability.',
    'scale-declarative': 'The output said `configured`, and the ReplicaSet was scaled by the controller. If a colleague had run `kubectl scale` by hand earlier, your apply would have reverted it — which is exactly the point: the file wins.',
  },
  '2.4': {
    env: 'Scroll past the variables you set: Kubernetes injected `KUBERNETES_SERVICE_HOST` and friends. A pro knows every pod gets these for free and that `HOSTNAME` is the pod name — handy in logs.',
    healthz: 'The Service name resolved from inside the pod without a namespace suffix because the pod\'s resolv.conf has a search list. A pro tests from a *different* namespace with `frontend.freight` to be sure the full name works too.',
    pf: 'port-forward goes through the API server, so it works even when the pod has no Service at all. Notice the local port you chose has nothing to do with the Service port — only the remote side must match the container.',
    dns: 'The answer shows the fully qualified name and a `10.96.x.x` address: a ClusterIP, not a pod IP. Traffic to it is load-balanced by kube-proxy; that indirection is why pods can come and go without clients noticing.',
  },
  '3.1': {
    delete: 'Look at the map: the tile faded and a new one appeared within seconds, with a different suffix. The pod did not "come back" — a replacement was created. A pro checks the AGE column to tell replacements from survivors.',
    rs: 'DESIRED, CURRENT and READY all equal: the loop has converged. The ReplicaSet name ends in a hash of the pod template; if you ever see two ReplicaSets with non-zero replicas for one Deployment, a rollout is in progress or stuck.',
    scale: 'Five ready pods, and the endpoints count on the service hub went up as each one became Ready. A pro now checks `get pods -o wide`: are the five spread across nodes? Two on one node is fine; five on one node is a single point of failure.',
    events: '`SuccessfulCreate` events are the ReplicaSet\'s diary. In a real incident, counting them tells you how many times a pod has been replaced — a cheap proxy for "how often is this thing dying".',
  },
  '3.2': {
    image: 'The Deployment\'s revision annotation ticked up and a second ReplicaSet appeared. Watch the two DESIRED numbers move in opposite directions — that is maxSurge/maxUnavailable at work, one step at a time.',
    status: 'The messages you just saw ("X out of 4 new replicas have been updated…") are the controller\'s own status conditions. A pro wires this exact command into CI with a `--timeout` so a stuck rollout fails the pipeline instead of waiting forever.',
    undo: 'Compare `rollout history` before and after: the rollback did not restore revision 2, it created a new revision with the old template. History only moves forward — which is why change-cause annotations are worth the extra keystrokes.',
    history: 'CHANGE-CAUSE is `<none>` unless someone records it. A pro annotates (`kubernetes.io/change-cause`) or at least keeps the CI job id in the template, because "what was revision 3?" is the first question in a post-mortem.',
  },
  '3.3': {
    readiness: 'New pods now show `0/1 Running` for about twelve seconds before `1/1`. That `0/1` is the probe doing its job: the container runs, but it is kept out of the endpoints. Before, that window was invisible — and full of 503s.',
    liveness: 'Both probes point at port 8080 but different paths. A pro keeps them different on purpose: `/healthz` must stay cheap and dependency-free, or an upstream outage turns into a restart storm of perfectly healthy pods.',
    declarative: 'The rollout you triggered is itself the test: if the probe path or port were wrong, new pods would never become Ready, the rollout would stall at the maxUnavailable boundary, and old pods would keep serving. Check `get deploy` — READY vs AVAILABLE — whenever a rollout feels slow.',
    rolled: 'Zero drops during a rolling update of three pods with a twelve-second warm-up. The same manifest without probes would have shed roughly a third of requests for ~12 seconds, three times over.',
    survive: 'A pod was killed and replaced, and the SLO meter did not flinch: the replacement stayed out of the endpoints until `/readyz` said yes. This is the difference between "Running" and "Ready" paying for itself.',
  },
  '3.4': {
    diagnose: '`OOMKilled` in STATUS or in `Last State` with exit code 137 — not an application bug. A pro reads the limit in the same `describe` output and the "loading 312 MiB" line in the logs, and does the subtraction before touching anything.',
    limit: 'The limit went up and the pods are being replaced. Notice requests and limits are separate numbers: the limit protects the node from the pod, the request protects the pod from the scheduler\'s optimism.',
    ready: 'Zero restarts on fresh pods: the ceiling is above the real peak. A pro leaves headroom (not 320Mi for a 312MiB app) because the next release will use more, not less.',
    'no-pending': 'Both pods scheduled, so the requests fit alongside the frontends on 2 Gi workers. If one had stayed Pending, `describe pod` would have said `Insufficient memory` — read that as "my request", not "the cluster is full".',
    qos: '`Burstable`, because requests ≠ limits. Under node memory pressure, BestEffort pods are evicted first, then Burstable above their request. For a critical singleton you would set them equal and get `Guaranteed`.',
  },
  '3.5': {
    job: '`Complete 3/3` with three pods in `Completed` state that were not deleted — Jobs keep them so you can read their logs. A pro sets `ttlSecondsAfterFinished` in real clusters so finished pods do not pile up.',
    cron: 'The Job it created is named `nightly-report-<minutes-since-epoch>`: deterministic names are how the controller avoids double-scheduling. LAST SCHEDULE in `get cronjobs` is your first check when "the nightly thing did not run".',
    ds: 'One pod per worker, none on the control plane — the DaemonSet respected the `NoSchedule` taint there. If you needed the agent on the control plane too, you would add a toleration, not a replica count.',
    newnode: 'You did nothing and the agent landed on the new node within seconds. That is the DaemonSet contract. A pro verifies it with `get pods -o wide -l app=log-agent` after every node-pool change.',
    logs: '`kubectl logs job/NAME` picked one of the pods; with parallelism you might want `-l job-name=reindex --prefix` to see all of them and spot the one that failed.',
  },
  '3.6': {
    policy: 'Both manifests now declare probes and a memory limit — the same three lines you would be asked for in a code review. In Chapter 5 an admission policy rejects pods without them; today you are the policy, and you just passed.',
    frontend: 'Zero-downtime for frontend because readiness gated traffic during the rollout. Glance at `rollout history`: the revision you can roll back to is right there if anything goes wrong at the cargo-api step.',
    cargo: 'Two services released, SLO still green. A pro checks the endpoints of *both* services after a multi-service release, because "frontend is up" says nothing about the API behind it.',
    nodeloss: 'Did you notice the 40 seconds where pods on worker-b were NotReady but still listed? The ReplicaSet counted them as present and created nothing until eviction. That gap is why capacity headroom and topology spread matter more than any single setting.',
    drain: '`drain` did the cordon for you and evicted pod by pod; the DaemonSet pod stayed because you told it to ignore those. A pro runs `get pods -o wide` right after to confirm the node is really empty of application pods before handing it over.',
    uncordon: 'Uncordoning did not move anything back — the scheduler only places *new* pods. If you want the load rebalanced, you trigger it (a rollout restart) or let a descheduler do it. Shift over; everything is ready.',
  },
  '4.1': {
    endpoints: '`<none>` is the entire diagnosis: the Service exists, DNS resolves, and there is nothing behind it. A pro now has exactly two suspects — labels not matching the selector, or pods not Ready — and checks the cheaper one first.',
    compare: 'Put the SELECTOR column next to the pod labels. The keys differ: `app` versus `app.kubernetes.io/name`. That "cleanup PR" renamed one side only. Selectors match on keys *and* values, exactly.',
    dns: 'nslookup succeeded and curl was refused: the name is fine, the routing has no targets. When both fail, suspect DNS or the namespace; when only curl fails, suspect endpoints or readiness.',
    fix: 'The endpoints appeared the moment the selector and labels agreed — no restart, no rollout. Whichever side you changed, a pro makes the other side\'s owners aware: the next cleanup PR will hit the same wall.',
  },
  '4.2': {
    nodeport: 'PORT(S) now reads `80:3xxxx/TCP`. The left number is what cluster clients use; the right one is opened on *every* node, including ones with no frontend pod — kube-proxy forwards from there.',
    'curl-np': 'That worked against a node that may not even run a frontend pod. A pro remembers the flip side: NodePorts are reachable from anywhere that can reach the node, so they are rarely left open in production without a firewall.',
    lb: 'EXTERNAL-IP went from `<pending>` to an address once the cloud controller finished. On bare metal it would stay pending forever — a common first-day surprise on a home cluster.',
    'curl-lb': 'The load balancer forwards to the NodePort, which forwards to the pods: three hops for one request. An Ingress or Gateway in front of a single LoadBalancer is how teams avoid paying for one balancer per service.',
  },
};
