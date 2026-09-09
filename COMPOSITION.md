# Composing Alibaba infrastructure with Alchemy

0.2.0 uses the exact Alchemy `2.0.0-beta.76` and Effect `4.0.0-rc.112` peers
and the consumer overrides in README. It intentionally redesigns the input API:
there are no 0.1.0 compatibility aliases or automatic state migrations.

## Desired configuration

ACK clusters and node pools, RDS and Tair instances, VPC networks and vSwitches,
and RDS databases accept desired properties directly. The provider derives SDK
create and update requests internally. Public `create`, `modify`, `spec` and
cluster `upgrade` bags are rejected rather than silently ignored.

For example, set `kubernetesVersion` on a cluster, `scalingGroup.desiredSize` on a
node pool, `DBInstanceStorage` and `serverlessConfig` on RDS, and `instanceClass`
or `storage` on Tair. Metadata such as VPC `description` is also a desired input.
ACK `upgradePolicy` controls how to execute an upgrade; its target version comes
only from `kubernetesVersion`. Deletion settings and SSL configuration remain
separate domain options, with no second copy of desired creation values.

Use the 0.2.0 declarations and examples when composing a stack. This release does
not promise to consume 0.1.0 serialized props. Retain ownership and dependency
checks when adopting infrastructure, independently of the input API version.

| Change | Behavior |
| --- | --- |
| ACK version/spec, deletion protection, RRSA, maintenance | Modify or upgrade the existing cluster |
| Node-pool count, image, instance types | Modify the existing pool |
| RDS class/storage/storage type/category/serverless settings | Modify and wait for observed convergence |
| RDS default whitelist | Update the existing default group |
| ECS type/security groups/public bandwidth | Resize with graceful stop/start where required; update membership/bandwidth |
| Immutable ACK/RDS input with unchanged explicit name | Fail planning; choose a new name or separately destroy the old resource |
| Ambiguous ACK/RDS names | Fail; never choose an arbitrary match |
| Missing saved physical ID | Report that ID absent; never switch to a namesake |

## ACK and Kubernetes

`ManagedCluster.connection` is a serializable upstream Kubernetes connection.
It contains cluster identity and endpoint preferences, not a kubeconfig or key.
The registered ACK adapter fetches fresh temporary credentials on each connection.
`connectionOptions` selects private/public API access and a lifetime of 15–4320
minutes (default: private, 180 minutes). The runner must reach that endpoint.
An established mTLS transport uses those credentials until it reconnects; this
is not a background credential-renewal daemon.

Compose upstream providers when using Manifest, Deployment, Job or StatefulSet:

```ts
import * as Alibaba from "alchemy-alibaba";
import * as Layer from "effect/Layer";

const providers = Layer.mergeAll(
  Alibaba.providersFromEnvironment(),
  Alibaba.Kubernetes.providers(),
);
```

For an existing cluster, `ACK.clusterConnection(clusterId, options)` supplies the
same descriptor without adopting the cluster. `ACK.getKubeconfig(clusterId,
options)` is an Effect requiring `AlibabaClients`; it returns `{ config,
expiration }` with `config: Redacted<string>`. File-writing, stage restrictions,
exclusive creation and `0600` permissions remain application policy.

`Kubernetes.Secret` delegates read/apply/delete to upstream `ManifestProvider`.
Its `data` accepts plain UTF-8 values wrapped in `Redacted.make`; it Base64-encodes
only at the apply boundary. Outputs are object references without secret data,
and errors that could echo the submitted Secret are sanitized. `Redacted` is
not state encryption: use a protected state backend.

Inside a stack, use attribute references to establish dependencies:

```ts
const secret = yield* Alibaba.Kubernetes.Secret("RuntimeSecret", {
  cluster: cluster.connection,
  namespace: namespace.name,
  name: "runtime",
  data: { DATABASE_URL: databaseUrl }, // Redacted<string>
});
const workload = yield* Alibaba.Kubernetes.Manifest("Workload", {
  cluster: cluster.connection,
  manifest: {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api", namespace: secret.namespace },
    spec: {
      selector: { matchLabels: { app: "api" } },
      template: {
        metadata: { labels: { app: "api" } },
        spec: { containers: [{
          name: "api", image: image.imageUri,
          envFrom: [{ secretRef: { name: secret.name } }],
        }] },
      },
    },
  },
});
```

These snippets assume resources declared earlier in the same stack. A complete
compilation-checked example is in `examples/kubernetes.alchemy.ts`. Keep
workload probes, migration-job ordering, image-pull configuration, ingress and
service-account manifests in the application. Use upstream Deployment/Job when
their contract fits; Manifest preserves existing Kubernetes specifications.
Services and ingress controllers own their cloud load balancers through their
existing controller lifecycle. There is no second Alibaba Kubernetes CRUD layer.

For existing workloads, move each object into the Alchemy graph under its
existing name and namespace only after reviewing its current owner and plan.
Changing a Secret does not by itself restart pods that consume it through
environment variables; include an application rollout revision when rotating it.
Keep image publishing, SQL migrations, fixtures, customer-data policy and
production approval gates explicit in the application.

## Explicit outbound networking

Use `VPC.NatGateway`, `VPC.Eip`, `VPC.EipAssociation`, and `VPC.SnatEntry` for
new stacks that should own their outbound infrastructure:

```ts
const nat = yield* Alibaba.VPC.NatGateway("Nat", {
  vpcId: network.vpcId, vSwitchId: subnet.vSwitchId,
});
const eip = yield* Alibaba.VPC.Eip("Eip", { bandwidth: 5 });
const association = yield* Alibaba.VPC.EipAssociation("NatAddress", {
  allocationId: eip.allocationId, instanceId: nat.natGatewayId,
  instanceType: "Nat",
});
const snat = yield* Alibaba.VPC.SnatEntry("Outbound", {
  snatTableId: nat.snatTableId, sourceVSwitchId: subnet.vSwitchId,
  snatIp: association.ipAddress,
});
```

The association's IP output orders SNAT after binding and before unbinding.
Changing the NAT may temporarily interrupt outbound connectivity while the old
SNAT and EIP association are removed. Deletes never force-detach another owner's
binding. Enhanced Internet NAT creates its default VPC route when none exists;
we do not duplicate that service-owned route with a speculative route resource.
An existing conflicting route still needs explicit network planning. See
[Alibaba's CreateNatGateway contract](https://www.alibabacloud.com/help/en/nat-gateway/developer-reference/api-vpc-2016-04-28-createnatgateway-natgws).

For newly composed ACK clusters with this network, disable ACK's automatic
`natGateway`/`snatEntry` creation. Existing ACK-created gateways need a reviewed
ownership transition; changing those cluster creation fields is not an in-place
network migration. Treat that ownership transition as a separate network change.

## Database operation settings

`RDS.Instance` owns `backupPolicy`, `parameters`, and `maintenanceWindow`; Alibaba
does not require an AWS-style parameter-group resource. Omitted settings become
unmanaged and retain their cloud values. Maintenance windows use UTC, for example
`02:00Z-03:00Z`. `restartForParameterChanges` defaults to false; the output lists
`pendingRestartParameters` when configured values differ from running values.
Enable it explicitly when a parameter change may restart the database.

RDS resize properties include only supported convergence fields. Deferred
`effectiveTime` values are rejected because a normal reconciliation cannot
claim that a future resize completed. `switchForce` and `compressionMode` are
observed and reconciled rather than silently ignored.

`restoreFrom: { instanceId, backupId }` or `{ instanceId, restoreTime }` calls
`CloneDBInstance` to create a separate target. The source must exist and match the
requested engine/version; use a postpaid target. Changing the restore source
replaces that target. The source is never deleted or modified. Supply the target's
network/class/storage and whitelist as ordinary desired inputs. Clone does not
accept the full CreateDBInstance request: only its supported target settings are
forwarded. Clone cannot tag at creation; an interrupted clone before ownership
tagging requires inventory review and explicit adoption, not name-only recovery.
Restore availability, backup compatibility and regional/engine restrictions still
need an approved live acceptance test. PostgreSQL grant revocation and permanent
recycle-bin destruction retain the limitations in LIVE-VALIDATION.md.

## Workload identity and images

ACK creates its RRSA OIDC provider when RRSA is enabled. Use the cluster's
`oidcProviderArn` and `oidcIssuer` outputs with `ACK.rrsaTrustPolicy` to scope a
`RAM.Role` to one namespace/service account. Grant permissions using `RAM.Policy`
and `RAM.RolePolicyAttachment`. Do not create a duplicate OIDC provider. RRSA's
pod-identity webhook and namespace injection label must also be installed and
configured; `ACK.rrsaServiceAccountAnnotations(role.name)` supplies the role
annotation. See [Alibaba's RRSA setup](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/use-rrsa-to-authorize-pods-to-access-different-cloud-services).

Custom policies update through new default versions, rotating the oldest
non-default version when Alibaba's five-version limit is reached. Deletion
removes non-default versions and refuses externally attached permissions rather
than detaching unrelated roles. RAM resources are account-scoped.

`ACR.Image` delegates Docker builds and pushes to Alchemy's Docker.Image provider,
fetching a temporary ACR token at the SDK boundary. Supply instance/repository
IDs, the full repository URI, an explicit release tag, and upstream `build`
options. Compose `ACR.imageProvidersFromEnvironment()` alongside the core providers;
image builds additionally need Alchemy's normal Docker/Node platform services.
The core provider collection never requires a Docker daemon.

Consume `image.imageUri`, the registry-observed `repository@sha256:...`, in
workloads. Use a new immutable tag for changed contents. Deleting Image removes
local build artifacts; published tags remain repository-owned because running
pods may still need them. Existing ACK ACR credential-helper configuration can
continue handling pod image pulls.

## Independent VM storage and access

`ECS.KeyPair` imports a public key and never generates or returns a private key.
Changing the imported key does not rotate keys already installed in running VMs.
`ECS.Disk` manages independent postpaid disks, supports growth, and refuses silent
shrink or forced deletion of an attached disk. `ECS.DiskAttachment` uses
`deleteWithInstance: false`; a VM replacement can reattach the retained disk.
Filesystem formatting, mounting and growth remain guest responsibilities.

Ingress and egress rule resources support IPv4, IPv6 or security-group peers
(one peer form per rule), priority and accept/drop policies. They preserve other
rules and delete by observed rule ID. See ECS.md for VM replacement and shutdown.

## Deliberate scope limits

Multi-region environment resolution,
RDS proxies/replicas, KMS, ECI, queues, custom route tables and separate load
balancer resources need concrete application requirements. They are not gaps in
the current workload scope. All new behavior has local validation;
no cloud operations are part of the repository checks.
