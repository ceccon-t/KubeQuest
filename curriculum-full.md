# Kubernetes Mastery — A Comprehensive Learning Path

*A complete, modern curriculum taking a learner from container fundamentals to operating production-grade, platform-scale Kubernetes. Reflects current (2026) practice.*

---

## How This Curriculum Is Structured

The path is organized into **seven stages**, each building on the last. Early stages establish fundamentals and a working mental model; middle stages cover the full workload, networking, configuration, storage, and security surface; later stages address operations, the production ecosystem, extensibility, and specialization.

Each stage lists **learning objectives**, the **topics** it covers, and a **capstone** to consolidate the skills. A learner should be able to *do* the capstone before advancing.

> **Prerequisites:** comfort with the Linux command line, basic networking (TCP/IP, DNS, HTTP), and at least one programming language. No prior container or orchestration experience assumed.

---

## Stage 1 — Foundations: Containers & the Case for Orchestration

**Objective:** Understand what containers are, why they changed software delivery, and the problems an orchestrator solves.

**Topics**
- The motivation for Kubernetes: velocity, immutability, declarative configuration, self-healing, decoupling.
- How orchestration enables scaling of both applications and the teams that build them (microservices, separation of concerns).
- Container fundamentals: images, layers, and the OCI image format.
- Building images with Docker: Dockerfiles, layer caching, image-size optimization, multistage builds.
- Image security basics and storing images in a registry.
- Running containers locally; resource limits at the container level.
- The container runtime landscape: the Container Runtime Interface (CRI), containerd, and CRI-O — and the key distinction that **building** images with Docker is independent of the **node runtime** that runs them.

**Capstone:** Containerize a small web application with an optimized multistage build and push it to a registry.

---

## Stage 2 — Getting Hands-On: Clusters & the Command Line

**Objective:** Stand up clusters and become fluent with the primary client tooling.

**Topics**
- Provisioning options: managed cloud services (GKE, AKS, EKS) vs. local clusters (kind, minikube, k3s/k3d).
- Cluster architecture overview: control plane (API server, scheduler, controller manager, etcd) and nodes (kubelet, kube-proxy, container runtime), cluster DNS.
- `kubectl` essentials: namespaces, contexts and kubeconfig, viewing objects (`get`/`describe`, output formats), create/apply/delete, labeling and annotating.
- Debugging from the CLI: `logs`, `exec`, `cp`, `port-forward`, `top`, and command autocompletion.
- Declarative vs. imperative workflows, and why declarative YAML is the foundation of everything that follows.

**Capstone:** Spin up a local cluster, deploy the Stage 1 image as a bare Pod, and inspect/debug it entirely via `kubectl`.

---

## Stage 3 — Core Workload Primitives

**Objective:** Master the building blocks used to run and manage applications.

**Topics**
- **Pods:** the Pod manifest, multi-container Pods and when to use them, lifecycle.
- **Health & resources:** liveness, readiness, and startup probes; resource requests and limits; Quality of Service classes.
- **Volumes (intro):** sharing data between containers and persisting beyond the container lifecycle.
- **Labels, selectors & annotations:** the metadata system that wires controllers to Pods (equality- and set-based selectors).
- **ReplicaSets:** reconciliation loops and the controller pattern.
- **Deployments:** rolling updates, rollout history and rollback, update strategies (Recreate, RollingUpdate, surge/unavailable tuning), controlling rollout health.
- **DaemonSets:** running one Pod per node for agents and collectors.
- **Jobs & CronJobs:** run-to-completion work, parallelism, work queues, indexed Jobs, failure handling, scheduled jobs.
- **Debugging workloads:** ephemeral containers and `kubectl debug` for live and distroless Pods.

**Capstone:** Deploy a multi-tier app as Deployments with probes and resource limits; perform a zero-downtime rolling update and a rollback.

---

## Stage 4 — Networking, Service Discovery & Traffic

**Objective:** Connect workloads to each other and expose them to the outside world.

**Topics**
- **Services:** ClusterIP, NodePort, LoadBalancer; cluster DNS and service discovery; the readiness-to-endpoint relationship.
- **EndpointSlices** and how traffic is routed to Pods at scale.
- **Ingress** (the established L7 model) and the **Gateway API** (the role-oriented successor: GatewayClass / Gateway / HTTPRoute), including hostname/path routing and TLS termination.
- **NetworkPolicy:** namespaced L3/L4 segmentation and why enforcement depends on the CNI.
- **The CNI landscape:** what the choice of plugin (e.g., Cilium, Calico) affects — policy support, performance, observability — and an introduction to **eBPF**-based networking.
- Dual-stack IPv4/IPv6 awareness.

**Capstone:** Expose the Stage 3 app through a Gateway (or Ingress) with TLS, and lock down traffic between tiers with NetworkPolicies.

---

## Stage 5 — Configuration, State & Security

**Objective:** Configure applications cleanly, run stateful workloads, and secure the cluster.

**Topics**
- **Configuration:** ConfigMaps and Secrets (as env vars, args, and mounted volumes); image pull secrets; naming constraints.
- **Secrets management done right:** the limits of native Secrets and the ecosystem answers — External Secrets Operator, Sealed Secrets, Vault, the Secrets Store CSI Driver.
- **Persistent storage:** PersistentVolumes, PersistentVolumeClaims, StorageClasses, dynamic provisioning via **CSI**, volume snapshots, and ephemeral volumes.
- **Stateful workloads:** StatefulSets (stable identity, ordered startup, `volumeClaimTemplates`); patterns for singletons and replicated data stores.
- **Access control:** RBAC — identity (users, groups, service accounts), Roles/ClusterRoles and bindings, testing with `kubectl auth can-i`.
- **Workload security:** SecurityContext hardening (non-root, read-only root filesystem, dropped capabilities, no privilege escalation), seccomp, and **Pod Security Admission** with the Pod Security Standards (Privileged / Baseline / Restricted).
- **Policy as code:** admission-control policy engines (Kyverno, OPA/Gatekeeper) for org-wide guardrails.
- **Supply-chain security:** image signing and verification (cosign/Sigstore), SBOMs, SLSA, and admission-time enforcement.
- **Scanning & runtime security:** Trivy, Falco, kube-bench / CIS benchmarks.

**Capstone:** Run a replicated stateful datastore with persistent storage; apply a Restricted Pod Security profile, scoped RBAC, and a policy rule that rejects unsigned images.

---

## Stage 6 — Operating in Production

**Objective:** Keep applications healthy, observable, scalable, and resilient under real conditions.

**Topics**
- **Advanced scheduling:** node/pod affinity & anti-affinity, taints & tolerations, topology spread constraints, priority & preemption, scheduling readiness/gates.
- **Autoscaling:** Horizontal Pod Autoscaler v2 (CPU, memory, custom/external metrics, scaling behavior); Vertical Pod Autoscaler; node autoscaling with Cluster Autoscaler and Karpenter; event-driven autoscaling and scale-to-zero with KEDA; in-place Pod resource resize.
- **Observability — the three pillars:**
  - Metrics: Prometheus, Alertmanager, Grafana; the distinction between metrics-server and kube-state-metrics.
  - Tracing: OpenTelemetry, Jaeger / Tempo.
  - Logging: Loki, EFK/ELK, Fluentd / Fluent Bit.
- **Reliability engineering:** PodDisruptionBudgets, ResourceQuotas and LimitRanges, graceful node drains and upgrades.
- **Backup & disaster recovery:** cluster and persistent-volume backup (e.g., Velero).
- **Cost & FinOps:** cost visibility and right-sizing (OpenCost / Kubecost).
- **Cluster lifecycle literacy:** release cadence, support windows, version skew, and reading deprecation/removal notices to plan upgrades.

**Capstone:** Instrument the app with metrics, dashboards, and alerts; configure HPA on a custom metric; and demonstrate safe behavior during a simulated node drain protected by a PodDisruptionBudget.

---

## Stage 7 — Extending Kubernetes & the Platform Ecosystem

**Objective:** Shape Kubernetes to an organization's needs and operate it as a platform.

**Topics**
- **Packaging & delivery:** Helm (charts, dependencies, OCI registries) and Kustomize (overlays, built into kubectl); choosing and combining them.
- **GitOps:** Git as the single source of truth with pull-based reconciliation (Argo CD, Flux); progressive delivery — canary and blue-green with automated analysis (Argo Rollouts).
- **Extensibility:** CustomResourceDefinitions (structural schemas), the admission webhook model and CEL-based admission policies, and the **Operator pattern**.
- **Operator tooling:** controller-runtime, Kubebuilder, Operator SDK / OLM, OperatorHub.
- **Service mesh:** mTLS, traffic management, and L7 observability without app changes; sidecar vs. sidecarless/ambient architectures (Istio, Linkerd, Cilium).
- **Platform engineering & multi-cluster:** Internal Developer Platforms and golden paths, cluster lifecycle at fleet scale (Cluster API), infrastructure-as-control-plane (Crossplane), and developer portals (Backstage).
- **Developer experience:** inner-loop tooling (Skaffold, Tilt, Telepresence) and cluster UIs (k9s, Lens, Headlamp).

**Capstone:** Package the app as a Helm chart (or Kustomize set), deliver it via a GitOps controller with an automated canary rollout, and extend the cluster with a simple custom resource and controller.

---

## Stage 8 (Optional) — Specialization Tracks

Deeper dives to pursue based on role and domain:

- **AI/ML & GPU workloads:** GPU scheduling (NVIDIA GPU Operator), Dynamic Resource Allocation (DRA), batch/queueing (Kueue), model/LLM serving (KServe), ML platforms (Kubeflow).
- **Advanced networking & eBPF:** deep CNI tuning, eBPF-based observability and enforcement (Hubble, Tetragon), admin-tier network policy.
- **Emerging runtimes:** WebAssembly (Wasm) workloads on Kubernetes.
- **Resilience & scale:** chaos engineering (Chaos Mesh, LitmusChaos), continuous profiling (Parca, Pixie), multi-tenancy (vcluster, hierarchical namespaces).

---

## Suggested Pacing

| Phase | Stages | Focus |
|---|---|---|
| **Fundamentals** | 1–3 | Containers, clusters, and running workloads |
| **Building real apps** | 4–5 | Networking, configuration, state, and security |
| **Running them well** | 6 | Observability, scaling, and reliability |
| **Platform & scale** | 7 | Packaging, GitOps, extensibility, and platform engineering |
| **Depth** | 8 | Role- and domain-specific specialization |

A learner who completes Stages 1–6 can confidently build and operate production workloads; Stages 7–8 develop the platform and specialization skills expected of senior and platform-focused roles.
