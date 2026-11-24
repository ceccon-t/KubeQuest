export const COMMAND_MATRIX = `kubectl controls the Kubernetes cluster manager. (Kubequest simulator — supported subset)

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a deployment, replica set, service or pod and expose it as a new Kubernetes service
  run             Run a particular image on the cluster
  set             Set specific features on objects (image, env, resources)
  explain         Get documentation for a resource
  get             Display one or many resources
  edit            Edit a resource on the server
  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector

Deploy Commands:
  rollout         Manage the rollout of a resource (status, history, undo, restart, pause, resume)
  scale           Set a new size for a deployment, replica set or stateful set
  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller

Cluster Management Commands:
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  taint           Update the taints on one or more nodes
  cluster-info    Display cluster information

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  exec            Execute a command in a container
  port-forward    Forward one or more local ports to a pod
  auth            Inspect authorization (can-i, whoami)
  debug           Create debugging sessions for troubleshooting workloads (ephemeral containers)

Advanced Commands:
  apply           Apply a configuration to a resource by file name or stdin (-f, -k)
  patch           Update fields of a resource
  wait            Wait for a specific condition on one or many resources
  kustomize       Build a kustomization target from a directory

Settings Commands:
  label           Update the labels on a resource
  annotate        Update the annotations on a resource

Other Commands:
  api-resources   Print the supported API resources on the server
  config          Modify kubeconfig files (current-context, get-contexts, set-context --current --namespace)
  version         Print the client and server version information

Global flags: -n/--namespace, -A, --as, --as-group. Also on this workstation: helm (v3, local charts) and git (one branch, one remote).
Not available in the simulator (yet): diff, replace, cp, attach, proxy, events, certificate, completion.
Use "kubectl <command> --help" for more information about a given command.
`;
