# Kubernetes Mastery — Curriculum at a Glance

*A modern, end-to-end learning path from container basics to platform-scale operations. Eight stages, each with a capstone.*

---

### Stage 1 — Foundations: Containers & the Case for Orchestration
Why Kubernetes (velocity, immutability, declarative config, self-healing) · container images & OCI format · Dockerfiles, multistage builds, image optimization · registries · container runtimes & CRI (containerd/CRI-O).
**Capstone:** containerize and publish an optimized image.

### Stage 2 — Clusters & the Command Line
Managed vs. local clusters (GKE/AKS/EKS, kind, k3s) · cluster architecture (control plane, nodes, DNS) · `kubectl` fluency (namespaces, contexts, get/apply/delete) · CLI debugging · declarative vs. imperative.
**Capstone:** stand up a cluster and deploy/debug a Pod via `kubectl`.

### Stage 3 — Core Workload Primitives
Pods & multi-container patterns · liveness/readiness/startup probes · requests, limits & QoS · labels/selectors/annotations · ReplicaSets & reconciliation · Deployments (rolling updates, rollback, strategies) · DaemonSets · Jobs & CronJobs · `kubectl debug`.
**Capstone:** rolling update and rollback of a multi-tier app.

### Stage 4 — Networking, Service Discovery & Traffic
Services (ClusterIP/NodePort/LoadBalancer) & DNS · EndpointSlices · Ingress and Gateway API · TLS · NetworkPolicy · CNI landscape & eBPF · dual-stack.
**Capstone:** expose the app with TLS and segment traffic with NetworkPolicies.

### Stage 5 — Configuration, State & Security
ConfigMaps & Secrets · secrets management (External Secrets, Sealed Secrets, Vault, CSI driver) · PersistentVolumes/PVCs/StorageClasses, CSI, snapshots · StatefulSets · RBAC · SecurityContext & seccomp · Pod Security Admission & Standards · policy engines (Kyverno, OPA/Gatekeeper) · supply-chain security (cosign/Sigstore, SBOMs) · scanning & runtime (Trivy, Falco, kube-bench).
**Capstone:** replicated stateful datastore with Restricted security profile and signed-image enforcement.

### Stage 6 — Operating in Production
Advanced scheduling (affinity, taints/tolerations, topology spread, priority) · autoscaling (HPA v2, VPA, Cluster Autoscaler, Karpenter, KEDA, in-place resize) · observability — metrics (Prometheus/Grafana), tracing (OpenTelemetry/Jaeger), logging (Loki/Fluent Bit) · reliability (PodDisruptionBudgets, quotas) · backup/DR (Velero) · cost/FinOps · upgrade & version-skew literacy.
**Capstone:** instrument metrics/alerts, custom-metric HPA, and a safe node drain behind a PDB.

### Stage 7 — Extending Kubernetes & the Platform Ecosystem
Packaging (Helm, Kustomize) · GitOps (Argo CD, Flux) & progressive delivery (Argo Rollouts) · CRDs, admission policies & the Operator pattern · operator tooling (controller-runtime, Kubebuilder, Operator SDK) · service mesh (Istio, Linkerd, Cilium; sidecar vs. ambient) · platform engineering & multi-cluster (Cluster API, Crossplane, Backstage) · dev experience (Skaffold, Tilt, k9s).
**Capstone:** GitOps-delivered Helm chart with a canary rollout plus a custom resource & controller.

### Stage 8 (Optional) — Specialization Tracks
AI/ML & GPU (GPU Operator, DRA, Kueue, KServe, Kubeflow) · advanced networking & eBPF (Hubble, Tetragon) · WebAssembly workloads · chaos engineering, profiling & multi-tenancy.

---

### Pacing

| Phase | Stages | Focus |
|---|---|---|
| Fundamentals | 1–3 | Containers, clusters, workloads |
| Building real apps | 4–5 | Networking, config, state, security |
| Running them well | 6 | Observability, scaling, reliability |
| Platform & scale | 7 | Packaging, GitOps, extensibility, platform engineering |
| Depth | 8 | Role/domain specialization |

**Stages 1–6** → build and operate production workloads. **Stages 7–8** → platform and specialization skills for senior roles.
