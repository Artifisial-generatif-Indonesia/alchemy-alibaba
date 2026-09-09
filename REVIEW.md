Review of Alibaba resources against Alchemy AWS, 2026-09-09

Compared this repository at `d4e6ea2` with the sibling Alchemy checkout at
`b979ffc6`, and inspected Takdol's infrastructure and the sibling `ODIN` project.
The provider pins Alchemy `2.0.0-beta.76`; Takdol currently pins `beta.72`.
`../odin` does not exist on this filesystem; `../ODIN` is the reviewed project.

At the reviewed baseline, the foundation followed much of Alchemy's architecture,
but replacement safety needed fixing. Four focused local regression probes
failed: three demonstrated successful-looking replacement followed by deletion
of the only physical resource; the fourth demonstrated an ignored RDS setting.
These are observations from the real SDK against the repository's loopback
simulator, not connected-cloud results.

Alibaba ECS manages VMs, so its direct AWS reference is **EC2**. AWS **ECS** is
also useful as the reference for container images, services, tasks, identity,
and deployment ergonomics. It is not a matching API for Alibaba ECS.

**Resolution status**

The findings below describe the pre-change revision and its original probes.
Implementation now addresses findings 1–5 with permanent passing regressions;
Takdol's package extraction (finding 6) is deferred until 0.2.0 is released.
The earlier isolated consumer draft predates the final input redesign. See COMPOSITION.md
for the new API and composition, and SUPPORT-MATRIX.md for test evidence.

Added the workload-relevant missing capabilities: ACK temporary credentials and
connection adapter; Secret over upstream Kubernetes; EIP/NAT/SNAT; RDS backups,
parameters, maintenance and restore; RAM/RRSA; ACR Image over upstream Docker;
and ECS public-key import, independent disks/attachments and full ingress/egress.
Default routes are owned by Alibaba's enhanced NAT API, RRSA OIDC is ACK-owned,
and Kubernetes load balancers remain controller-owned. These are Alibaba API
boundaries, not separate resources to recreate. Conditional capabilities listed
below have no demonstrated current consumer requirement.

Tag diffing uses Alchemy helpers; desired inputs have no legacy compatibility layer;
long-running cluster/database/VM operations report progress. New helpers split
identity, credentials, RDS configuration and API-specific observation from the
main reconcilers. 0.2.0 intentionally breaks the 0.1.0 input contract; no automatic state migration is provided. Resource-scoped multi-region
configuration and filename-only reorganization remain unnecessary for these
consumers; separate client layers retain explicit region guards.

**Original findings, in priority order**

1. **P1 — Named replacements can delete the resource that the new generation
   just reused.**

   Locations: [RDS instance](src/rds/instance.ts), `diff` at line 499 and
   `reconcile` at line 545; [ACK cluster](src/ack/managed-cluster.ts), lines 386
   and 431; [ACK node pool](src/ack/node-pool.ts), lines 311 and 338.

   Each provider requests create-before-delete replacement when its `create`
   object changes. Reconcile then finds the old resource by the unchanged
   explicit name and returns its ID as the replacement's ID. Cleanup deletes
   that same ID. There is no guard distinguishing recovery of this generation
   from reuse of the generation being replaced.

   Reproduced with persisted Alchemy state and the real SDK:

   | Resource | Change with explicit name unchanged | Observed result |
   | --- | --- | --- |
   | RDS instance | `create.DBInstanceStorage`: 20 → 40 | Deploy succeeds, returns original ID and 20 GB, inventory contains zero instances |
   | ACK cluster | `create.containerCidr` changes | Deploy succeeds, returns original cluster ID, inventory contains zero clusters |
   | ACK node pool | `create.scalingGroup.desiredSize`: 1 → 2 | Deploy succeeds, returns original pool ID, inventory contains zero pools |

   Takdol supplies explicit names and puts storage and node count in precisely
   these create fields. See its [environment stack](../takdol/infra/alchemy-alibaba/disposable-environment.alchemy.ts).

   Follow Alchemy's generation-based physical identity and immutable-property
   planning, but account for Alibaba name lookup explicitly. Prefer in-place
   updates for mutable settings. For real replacement, ensure a distinct new
   physical resource; when a fixed identity prevents coexistence, plan the
   appropriate delete-first transition or reject it clearly. Never silently
   return the outgoing physical ID. Do not blanket-enable delete-first for
   stateful databases. The local [ECS replacement test](src/protocol/ecs.test.ts)
   already covers this class of mistake for VMs; extend it to ACK and RDS.

2. **P2 — The public API exposes request phases instead of one desired state,
   causing unnecessary replacements.**

   The same diffs compare the entire `create` object. Changing a cluster
   version, node count, RDS storage, or a create-time whitelist can therefore
   replace infrastructure even where an update API exists. Callers must know
   to preserve obsolete creation values and separately populate `upgrade`,
   `modify`, or `spec`.

   Alchemy's [EKS Cluster](../alchemy/packages/alchemy/src/AWS/EKS/Cluster.ts),
   [Nodegroup](../alchemy/packages/alchemy/src/AWS/EKS/Nodegroup.ts), and
   [RDS DBInstance](../alchemy/packages/alchemy/src/AWS/RDS/DBInstance.ts)
   expose desired properties and route them internally to create/update APIs.
   Use that pattern. The final 0.2.0 decision explicitly drops compatibility with existing inputs.
   Alibaba's [ModifyDBInstanceSpec](https://www.alibabacloud.com/help/en/rds/developer-reference/api-rds-2014-08-15-modifydbinstancespec)
   supports changing class and storage; the split is not required by the API.

   [ECS Instance](src/ecs/instance.ts), lines 82–98 and 224–227, similarly
   treats instance type and security-group membership as immutable and always
   deletes first. Alchemy's [EC2 Instance](../alchemy/packages/alchemy/src/AWS/EC2/Instance.ts)
   updates both. Alibaba supports
   [stopped-instance resizing](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-modifyinstancespec)
   and [joining security groups](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-joinsecuritygroup).
   Implement those transitions with their actual API constraints; retaining
   replacement for image/bootstrap changes is consistent with the AWS model.

3. **P2 — Some accepted RDS spec changes are silently ignored.**

   [InstanceProps.spec](src/rds/instance.ts) at line 75 accepts the complete SDK
   request, but `specMatches` at line 193 checks only a subset. The mutation at
   line 684 runs only when that subset differs.

   Reproduced: changing only
   `spec.serverlessConfiguration.switchForce` from false to true, with an
   unchanged class, produces an update plan and a successful deployment with
   **zero ModifyDBInstanceSpec requests**. The pinned SDK exposes `switchForce`
   in both request and observed serverless configuration. `compressionMode`
   is another accepted observable property omitted from the comparison.

   Build explicit observed-to-desired mappings for every supported setting,
   following the per-property reconciliation in AWS DBInstance. Narrow or
   reject unsupported settings instead of presenting type acceptance as
   lifecycle support. Also define behavior for deferred changes: the accepted
   `effectiveTime: "ScheduleTime"` requires a future window, while the current
   waiter demands actual convergence within its normal readiness budget.

4. **P2 — ACK's raw request types bypass secret redaction.**

   [ManagedClusterCreateRequest](src/ack/managed-cluster.ts), line 35, retains
   SDK `loginPassword` fields. [NodePoolCreate](src/ack/node-pool.ts), line 30,
   and its `modify` input retain `scalingGroup.loginPassword` as a plain string.
   Bootstrap `userData` is also plain text. These values receive none of the
   typed redaction used by this package's RDS/Tair credentials and ECS user data.

   Follow [AWS DBInstance's secret input contract](../alchemy/packages/alchemy/src/AWS/RDS/DBInstance.ts)
   and the existing local credential pattern: omit raw secret fields, expose
   `Redacted` inputs, and unwrap only at the SDK boundary. Cover nested fields
   and diagnostic serialization. Redacted is a display/type boundary, not
   encryption of the state backend; this finding does not claim otherwise.

5. **P2 — Recovery lookup treats non-unique names as authoritative identity.**

   RDS `findByName` at line 246, ACK cluster `findByName` at line 286, and node
   pool `findByName` at line 192 select the first match. Their `observe` helpers
   also fall back to a namesake when a persisted ID disappears. Multiple
   matches are never rejected. Reconcile can then retag the selected resource.

   This differs from AWS RDS lookup by its unique DB instance identifier.
   Alibaba's DB description is not that identifier. Use generation/ownership
   evidence for recovery, reject ambiguous inventories, and avoid switching a
   persisted identity to a namesake. The newer local
   [ECS implementation](src/ecs/instance.ts), lines 152–163, already rejects
   ambiguity and treats a saved ID as authoritative. Extend the principle
   while preserving legitimate interrupted-create recovery.

6. **Consumer integration gap — Takdol does not yet consume this package.**

   Its [environment entrypoint](../takdol/infra/alchemy-alibaba/disposable-environment.alchemy.ts)
   imports `./index.ts`, and its [kubeconfig script](../takdol/scripts/fetch-alchemy-ack-kubeconfig.mjs)
   imports the embedded clients. Its [package.json](../takdol/package.json)
   pins Alchemy beta.72 rather than this package's exact beta.76 peer.
   Fixes here will not reach those paths automatically. Plan a package and
   Alchemy-version migration together, keeping logical IDs, type strings,
   physical identities and ownership checks intact. The final 0.2.0 input design does not promise state compatibility. Compare
   saved-state plans with synthetic fixtures before changing consumer wiring.

**Missing capabilities ranked by consumer value**

| Priority | Addition | Why it helps / reference to follow |
| --- | --- | --- |
| First | ACK `Kubernetes.Connection` and `ClusterAdapter` | Reuse Alchemy's existing `Kubernetes.Deployment`, `Job`, `Manifest`, and `HelmChart`; follow [EKS/KubernetesAdapter.ts](../alchemy/packages/alchemy/src/AWS/EKS/KubernetesAdapter.ts). Takdol already renders namespaces, service accounts, config maps, jobs, deployments, services, and network policies in [environment-kubernetes.mjs](../takdol/infra/environment-kubernetes.mjs). |
| First | Declarative Kubernetes Secret integration | Alchemy's generic `Kubernetes.Manifest` already supports `v1/Secret`; there is no dedicated exported `Kubernetes.Secret` in the reviewed checkout. Reuse that lifecycle, with explicit secret serialization/redaction handling and dependency references. Replace Takdol's separate [apply-environment-secrets.mjs](../takdol/scripts/apply-environment-secrets.mjs) orchestration for API, migration, seed, observability, and origin TLS secrets. |
| First | Explicit NAT gateway, EIP allocation/association, SNAT entry, and required route resources | Takdol asks ACK to create NAT/SNAT, while this package documents leftover network dependencies blocking teardown. Follow AWS [NatGateway](../alchemy/packages/alchemy/src/AWS/EC2/NatGateway.ts), route and association resources. Alibaba has a separate [SNAT entry API](https://www.alibabacloud.com/help/en/nat-gateway/developer-reference/api-vpc-2016-04-28-createsnatentry-natgws). Model only infrastructure this stack owns. |
| First for persistent databases | RDS backup policy, parameter configuration, maintenance settings, and a verified restore workflow | AWS [DBInstance](../alchemy/packages/alchemy/src/AWS/RDS/DBInstance.ts) owns backup/maintenance settings, with [DBParameterGroup](../alchemy/packages/alchemy/src/AWS/RDS/DBParameterGroup.ts) for reusable parameters. Start with instance-owned backup settings using Alibaba's [ModifyBackupPolicy](https://www.alibabacloud.com/help/en/rds/developer-reference/api-rds-2014-08-15-modifybackuppolicy); add separate resources only where Alibaba gives them independent identity/lifecycle. |
| Next | RAM Role, Policy, policy attachment, and ACK workload-identity integration | Follow AWS IAM resources and the identity hook of the EKS adapter. Takdol already enables RRSA, but this package cannot declare workload permissions. [ACK RRSA](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/use-rrsa-to-authorize-pods-to-access-different-cloud-services) uses RAM role trust and an OIDC provider; ACK creates the cluster OIDC provider when RRSA is enabled, so discover/reference that managed provider rather than creating a duplicate. |
| Next | ACR image build/push or mirror integration | Existing namespace/repository resources manage registry metadata only. Follow AWS [ECR/ImageSource.ts](../alchemy/packages/alchemy/src/AWS/ECR/ImageSource.ts) and the EKS registry adapter hook, emitting immutable image references. Takdol currently requires stage-approved image digests outside the resource graph. |
| Next for VM consumers | KeyPair, independent Disk and DiskAttachment, EIP, fuller ingress and egress rules | Follow AWS EC2 key pairs, volumes, attachments, and security-group patterns. These let rebuilds preserve intentional data/IP ownership and let policy identify source groups instead of only IPv4 CIDRs. Current ECS creates only an instance-owned system disk and inbound allow rules. |
| As required by the ingress design | ALB/NLB and listener/target resources, or Kubernetes-controller integration | Make API endpoint provisioning and DNS composition explicit. If a Kubernetes controller owns the load balancer, use that ownership boundary rather than also managing the same object as an independent cloud resource. Takdol currently supplies origin IP configuration separately. |
| Later, after a concrete workload needs it | RDS read replicas/proxy, KMS secrets, scheduled container jobs, ECI container groups | AWS RDS proxy and ECS Task/Service/Schedule provide useful patterns. [Alibaba ECI](https://www.alibabacloud.com/help/en/eci/product-overview/what-is-elastic-container-instance) is container compute and is a closer candidate for task-like use than the VM ECS API. It is not a drop-in AWS ECS Service equivalent. |

The Kubernetes adapter is an integration gap, not a reason to rebuild
Kubernetes resource providers here. Alchemy already supports a generic
kubeconfig connection, so Takdol can start using those resources before a
complete ACK adapter exists. The adapter adds cloud-aware credential refresh,
registry/identity composition, and reconnection during deletion.

Kubeconfig retrieval is specifically absent from this package: Takdol implements
`DescribeClusterUserKubeconfig` in its standalone
[fetch script](../takdol/scripts/fetch-alchemy-ack-kubeconfig.mjs). Alchemy's
`Kubernetes.KubeConfig({ path, context })` only describes an existing file; it
does not retrieve ACK credentials. Add an ACK credential-fetch helper and an
adapter that can obtain/refresh credentials when connecting, with endpoint
selection and expiration handling. Expose a serializable connection descriptor
on the cluster rather than making an expiring kubeconfig the permanent cluster
identity.

Kubernetes Secret support is a different gap: the cloud-neutral manifest CRUD
already exists, but Takdol's secret creation/rotation is outside the Alchemy
graph. Its workloads reference those secrets by name. Wire secret creation
before dependent workloads and deletion after them, and verify rotation and
diagnostic redaction. The upstream generic manifest client directly JSON
serializes object bodies; it does not itself provide a typed, Redacted-aware
Secret input contract. Do not assume passing `Redacted` values inside arbitrary
manifest data is sufficient. Resolve that at the shared Kubernetes integration
boundary, keeping the upstream lifecycle rather than inventing Alibaba-specific
Secret CRUD.

For Odin, the reviewed [business-process checklist](../ODIN/docs/BUSINESS-PROCESS-CHECKLIST.md)
explicitly says there is no backend/API and everything uses mock data. Its
current [surfaces](../ODIN/README.md) are Next.js and Expo prototypes. An image
deployment abstraction could help if Alibaba hosting is chosen; this checkout
does not yet justify an Odin-specific Kubernetes cluster, database proxy,
queue, or other backend resource inventory.

**Conventions to align after the lifecycle fixes**

- Use Alchemy's `diffTags`, retaining service-specific tag wire conversion.
  The [upstream convention](../alchemy/AGENTS.md) explicitly requires it; ACK,
  RDS, ECS and VPC currently duplicate map-diff implementations. Keep the
  existing internal tag keys and precedence stable.
- Split large reconcilers into named observe/ensure/sync helpers, using the
  [reconciler doctrine](../alchemy/AGENTS.md) and AWS DBInstance as references.
  API request types can inform the public contract without dictating its
  lifecycle shape. Give observable fields explicit comparisons rather than
  relying on generic `modelMatches` to silently skip unknown read-model keys.
- Add `session.note` progress for purchases, upgrades, resizing and long waits.
  AWS EKS reports these transitions; the Alibaba resource providers currently
  emit no session notes, even when consumers allow hour-long waits.
- Document each public property's update/replacement behavior and output
  meaning with JSDoc and small examples. PascalCase resource filenames and a
  separate test tree match upstream but are lower-value changes than lifecycle
  clarity. Preserve public import paths through any reorganization.
- Evolve the provider-wide client bundle toward resource-scoped environment
  resolution if multi-account/region composition is needed, following
  [AWSEnvironment](../alchemy/packages/alchemy/src/AWS/Environment.ts). The current
  region guard is useful, but capturing clients at provider construction is
  less composable than upstream's resource environment model.
- Keep the SDK boundary small. The promise-based Alibaba SDK and wire-model
  conversion are legitimate API/SDK differences. Prefer explicit operation
  error mappings at that boundary over expanding global text/status heuristics;
  callers should keep typed failures and idempotent recovery behavior.

Several foundations are already aligned: colocated Resource/Provider contracts,
ProviderCollection registration, dependency references, deterministic names,
ownership tags and `Unowned` on tagged resources, typed errors, observed tag
reconciliation, bounded waits, and real-SDK protocol tests with persisted state.
These should be retained.

Do not mechanically add an AWS-shaped DBSubnetGroup or Aurora DBCluster to
Alibaba RDS: the existing Alibaba VPC/vSwitch and instance/category APIs have
different resource boundaries. Likewise, keep separate Alibaba database/account
resources where those APIs exist. PostgreSQL's inability to revoke ordinary
account grants through `RevokeAccountPrivilege` is a real Alibaba difference,
documented in [LIVE-VALIDATION.md](LIVE-VALIDATION.md) and enforced in
[AccountPrivilege.delete](src/rds/account-privilege.ts). Address reversible SQL
ownership through an explicit database/migration workflow; do not hide the
limitation behind successful-looking delete behavior.

**Verification**

The baseline passed 171 tests in 19 files. The original four local probes exposed
three unsafe replacements and an ignored RDS setting. They have been converted
to permanent regression tests in `src/protocol/review-regressions.test.ts` and the
normal lifecycle suites. New tests use SDK fakes, loopback HTTP/HTTPS, a fake Docker
client and temporary synthetic Alchemy state. No connected operation was run
as part of this review or implementation. The final local provider gate passed typecheck, 188 tests in 26 files and build; existing live evidence in LIVE-VALIDATION.md applies only to its
historical scenarios.
