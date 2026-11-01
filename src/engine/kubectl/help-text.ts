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
  scale           Set a new size for a deployment or replica set

Cluster Management Commands:
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  cluster-info    Display cluster information

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  exec            Execute a command in a container
  port-forward    Forward one or more local ports to a pod
  wait            Wait for a specific condition on one or many resources

Other Commands:
  api-resources   Print the supported API resources on the server
  config          Modify kubeconfig files (current-context, get-contexts, set-context --current --namespace)
  version         Print the client and server version information

Not available in the simulator (yet): patch, diff, replace, debug, auth, cp, attach, taint, autoscale, kustomize (-k).
Use "kubectl <command> --help" for more information about a given command.
`;
