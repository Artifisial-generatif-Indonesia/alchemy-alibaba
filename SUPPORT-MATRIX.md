# Alibaba Alchemy provider support matrix

This matrix records what the custom providers **actually implement and
verify**, not every field on a generated Alibaba request type. A property
existing on an SDK input is not support.

Verification layers:

- **Subclass**: stateful SDK-client subclasses, no HTTP.
- **Protocol**: real Alibaba SDK clients against a loopback simulator.
- **Stack**: Alchemy `deploy`/`destroy` with temporary persisted state.
- **Live**: disposable `test-*` Alibaba stage. Not part of the repository gate.

Candidate `9c68310` repeated the PostgreSQL/VPC smoke on 2026-09-09, completing
deployment through independently verified cleanup in 10 minutes 58 seconds.
The known PostgreSQL ownership cleanup intervention remains necessary. See
[candidate rerun evidence](./LIVE-VALIDATION.md#020-candidate-rerun-2026-09-09-jakarta);
Later ACK and non-ACR loops are recorded separately in the same evidence.
The latter found recovery, Tair request/name, and MySQL parameter-observation
bugs. A later permission-enabled ECS/NAT rerun passed lifecycle checks and
verified cleanup, finding two additional ECS defects that were fixed. The ACK
Secret follow-up passed and exposed an additional pool-absence code during
cleanup; this is now recognized. Final-node disruption budgets required an
explicit test-only cleanup intervention.

Bindings: Consumers pass typed attributes (`vpcId`, `vSwitchId`,
`instanceId`, kubeconfig/env outputs). No Alchemy `Binding` types are
registered. Do not add them speculatively.

## Resource relationships

| Parent | Child | Graph mechanism | Protocol | Live |
| --- | --- | --- | --- | --- |
| VPC Network | vSwitch | `vpcId` attribute | Yes | PostgreSQL, MySQL and current Tair smoke passed |
| vSwitch | ACK cluster | `vswitchIds` | Create/delete + ENI hold | ACK smoke; see LIVE-VALIDATION.md |
| vSwitch | RDS instance | `vSwitchId` | Create/delete + ENI hold | PostgreSQL and MySQL smoke: instance and delayed attachment cleanup verified |
| vSwitch | Tair instance | `vSwitchId` | Yes, including delayed `DependencyViolation.Kvstore` | Current Redis 7 smoke: instance, recycle-bin entry, ENIs, vSwitch and VPC absent |
| vSwitch | ACR VPC endpoint | `vswitchId` | Yes | Not connected |
| ACK cluster | Addon | `clusterId` | Install/configure/upgrade/uninstall + task waits | Not connected |
| ACK cluster | Node pool | `clusterId` | Create/image update/delete + failed task recovery | ACK smoke: scaling and stable identities; image update not run |
| ACR instance | Namespace / repository | `instanceId` | Persisted lifecycle + failure envelope | Read-only smoke for instance reference |
| ACR instance | VPC endpoint | `instanceId` + VPC/vSwitch | Yes | Not connected |
| RDS instance | Database / accounts / privileges / IP group | `instanceId` | Persisted lifecycle + blocked PostgreSQL revoke | PostgreSQL DBOwner revoke unsupported; MySQL grant/change/revoke and child deletion passed |
| Tair instance | Account / IP group | `instanceId` | RPC child lifecycle, including busy-parent retries | Redis 7 create/update/delete and overlapping updates passed |
| Tair instance | SSL / VPC auth / eviction | same resource mutations | Protocol + stack | Current Redis 7 API readback passed; client TLS/authentication not tested |
| Provider outputs | env / kubeconfig | attributes, not bindings | n/a | ACK temporary credentials and fetch-on-connect verified; live Kubernetes mTLS and Secret lifecycle passed |

## Resource matrix

Legend: **Y** implemented and tested at that layer; **P** partial; **N** not
implemented or not verified; **—** not applicable.

| Resource | Create | Read | Update | Replace | Delete | Permanent destroy | Adopt / ownership | Idempotency token | Ambiguous create recovery | Pagination / name lookup | Partial responses | Transitional states | Restart / recovery | Tags | Secrets | Tests | Live | Known gaps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `VPC.Network` | Y | Y | Y (name/description) | Y if create identity changes | Y | `DeleteVpc` after bounded dependency wait (NAT/EIP/security-group/ENI stragglers) | Alchemy tags; unowned without them | `ClientToken` from Alchemy instance id | Observe by name; tokenized retry | DescribeVpcs pages | N | Pending (configuring), Available, Deleting | Persisted redeploy | Y | — | Subclass + protocol + stack | PostgreSQL, MySQL, ACK and current Tair smoke create/update/delete passed | No extra optional VPC features (IPv6, DNS, route tables) |
| `VPC.VSwitch` | Y | Y | Y (name/description) | Y if vpc/zone/cidr change | Y | `DeleteVSwitch` after bounded ENI/Kvstore/RDS wait | Alchemy tags | `ClientToken` | Concurrent create is transient (`IncorrectVSwitchStatus`) | Describe by VPC/name | N | Pending/Available | Persisted redeploy | Y | — | Subclass + protocol + stack | PostgreSQL, MySQL, ACK and current Tair smoke passed; delayed service attachment release observed | Waiter is a safety net, not a substitute for Tair recycle-bin absence |
| `ACK.ManagedCluster` | Y | Y | Modify/upgrade | Y if create identity changes | Y | `DeleteCluster` + task wait; ENIs can remain | Alchemy tags | None; observe by name | Accepted-create error recovered by v1 name inventory | `DescribeClustersV1`, region-scoped + paged | N | creating/running/deleting via task | Persisted redeploy/recovery | Y | kubeconfig not stored | Subclass + protocol + stack | Partial: ACK smoke: create, no-op, protection updates/drift, tags; see LIVE-VALIDATION.md | Upgrades/advanced policies unverified; follow-up Kubernetes HTTPS/Secret lifecycle passed |
| `ACK.NodePool` | Y | Y | Y | scaling-group identity | Y | Delete + task wait | Scaling-group Alchemy tags | None | N | Name lookup within the cluster | N | Task wait | Persisted redeploy/recovery | Y | — | Subclass + protocol + stack | Partial: ACK smoke: create, no-op, scaling 1 → 2 → 1; see LIVE-VALIDATION.md | Final-node drain incomplete; cleanup required cluster-level deletion; live image/advanced rollout unverified |
| `ACK.Addon` | Y (install) | Y | Configure/upgrade | Compound identity | Y (uninstall) | Uninstall + task | Compound identity; silent adopt | None | N | Cluster/name | N | Task wait | Persisted redeploy | — | Config JSON | Subclass + protocol + stack | Not connected | Canary policies and component-specific configuration unverified |
| `ACR.InstanceReference` | N (retained) | Y | N | N | No-op; nuke skip | Never deletes the paid instance | Retained reference | — | — | Get by id | N | RUNNING | Subclass + protocol read | Observed | — | Subclass + protocol | Read-only plan smoke | Purchase/delete is out of scope |
| `ACR.Namespace` | Y | Y | Y | Compound identity | Y | Delete namespace | Compound identity; silent adopt | None | N | Get by instance+name | ACR `IsSuccess` envelope | NORMAL | Persisted redeploy | — | — | Subclass + protocol + stack | Not connected | Live behavior unverified |
| `ACR.Repository` | Y | Y | Y | Compound identity | Y | Delete repo | Compound identity; silent adopt | None | N | Get | Envelope | — | Persisted redeploy | — | — | Subclass + protocol + stack | Not connected | Live behavior unverified |
| `ACR.EndpointAclEntry` | Y | Y | Comment replacement | Compound identity | Y | Delete ACL entry | Compound identity | None | N | Get endpoint | Envelope | — | Persisted redeploy | — | — | Subclass + protocol + stack | Not connected | Live endpoint enablement and shared access behavior unverified |
| `ACR.VpcEndpointLink` | Y | Y | N | Compound identity | Y | Unlink VPC | Compound identity | None | N | Get endpoint links | Envelope | RUNNING wait | Subclass + protocol stack | — | — | Subclass + protocol | Not connected | PrivateZone request flag verified; DNS side effects require live validation |
| `RDS.Instance` | Y | Y | Resize/SSL/protect/tags | Y if create identity changes | Y | `DeleteDBInstance` after not-Creating | Alchemy tags | `ClientToken` | Ambiguous create by name | Region-scoped SearchKey/name pages | Private endpoint wait | Creating/Running; resize wait; SSL setting/success/failed | Persisted redeploy | Y | SSL key material redacted | Subclass + protocol + stack | Partial: PostgreSQL smoke; see LIVE-VALIDATION.md | Recycle-bin / permanent RDS destroy not modeled; ENIs after delete |
| `RDS.Database` | Y | Y | Description | Compound identity | Y | Delete database | Compound identity | None | N | Describe | N | — | Persisted redeploy | — | — | Subclass + protocol + stack | Partial: PostgreSQL smoke; see LIVE-VALIDATION.md | Engine-specific database options not exhaustively simulated |
| `RDS.Account` | Y | Y | Description/password | Compound identity | Y | Delete account | Compound identity | None | Accepted-create error recovered by account read | Describe | N | — | Persisted redeploy/recovery | — | Password redacted | Subclass + protocol + stack | Partial: PostgreSQL smoke; see LIVE-VALIDATION.md | Engine-specific account policies not exhaustively simulated |
| `RDS.AccountPrivilege` | Y | Y | Grant/change | Compound identity | P (engine-dependent revoke) | PostgreSQL revoke unsupported | Compound identity | None | N | Describe | N | — | Persisted redeploy | — | — | Subclass + protocol + stack | PostgreSQL grant/read passed; teardown required database cleanup | PostgreSQL ordinary bindings fail deletion explicitly |
| `RDS.SecurityIpGroup` | Y | Y | Cover | Compound identity | Reset, not empty | Reset to `127.0.0.1` by default | Compound identity | None | N | Describe | N | — | Persisted redeploy | — | — | Subclass + protocol + stack | Partial: PostgreSQL smoke; see LIVE-VALIDATION.md | Destroy cannot remove the last IP |
| `Tair.Instance` | Y | Y | Spec/SSL/auth/config/protect/tags/password | Y if name/create identity changes | Y | `DeleteInstance` → `Released` (hidden from `DescribeInstances`) → `DestroyInstance` → overview absence | Alchemy tags | Create **`Token`** from Alchemy instance id; spec `ClientToken` from generation + desired-spec hash + operation nonce | `CanNotAcquireLock` and other ambiguous creates recover by name; lock is **not** a generic retry | `DescribeInstances` pages; overview for recycle bin | Creating attributes can omit id/name; list supplies identity | Creating → Normal; Normal can still reject mutations; Released ≠ absent | Unpersisted-create recovery + persisted redeploy | Y | Password redacted; never snapshotted on the wire | Subclass + protocol + stack | Current Redis 7 smoke: A→B→A, SSL/auth/config/protection/password APIs, no-op, release/purge and delayed subnet cleanup passed | Client TLS/authentication/data survival and engine upgrades not tested; backup/restore outside modeled lifecycle |
| `Tair.Account` | Y | Y | Description/password | Compound identity | Y | Delete account | Compound identity | None | N | Describe | N | Available | Persisted redeploy | — | Password redacted | Subclass + protocol + stack | Generated 32-character name, description/password APIs and delete passed | Longer generated names rejected on the tested Redis 7 variant; client authentication not tested |
| `Tair.SecurityIpGroup` | Y | Y | Cover | Compound identity | Y | Delete group | Compound identity | None | N | Describe | N | — | Persisted redeploy | — | — | Subclass + protocol + stack | Named group create/cover/delete passed, including overlap with parent updates | Default-group fallback remains subclass-tested |

## Protocol regression coverage

The remaining resource types now run through real pinned SDK clients against
loopback HTTP, with Alchemy state persisted between deploy/update/destroy calls:

- `src/protocol/children.test.ts`: RDS and Tair account/password/IP group flows,
  RDS database and MySQL privilege changes, PostgreSQL `ALL` ownership and
  unsupported revocation, ACR nested namespace settings/repositories/ACL arrays,
  HTTP authorization failures, ACR HTTP-200 failure envelopes, accepted-create
  recovery, and child failures preventing parent teardown.
- `src/protocol/ack-children.test.ts`: ROA paths and snake_case fields, addon
  array payloads, node image/tag changes, addon config/version changes, cluster
  upgrade/protection, separate edition/configuration mutations and protection drift,
  delayed and failed tasks, persisted recovery, regional v1
  inventory and child-before-parent deletion.
- `src/protocol/instance-updates.test.ts`: RDS resize/serverless observations,
  private endpoint selection with a public endpoint present, SSL completion and
  explicit failure, secret rotation without capture,
  protection cycles, MySQL user connection limits, and Tair A→B→A resize
  tokens/default password rotation with distinct node-type read/write vocabularies.
- `src/protocol/wire.test.ts`: RDS regional/paginated inventory and distinct
  tokenless creates, alongside existing identity/token/error serialization checks.
- `src/protocol/relationships.test.ts`: the ACR PrivateZone request flag in
  addition to the existing VPC/service attachment and delayed ENI cleanup tests.

RPC routing distinguishes API versions for shared action names. Unknown ROA
routes fail loudly instead of masquerading as missing resources. Captures omit
credential values; RPC secrets are replaced before simulator dispatch, and ROA
bodies are redacted. SDK transport stays under the loopback guard.

These checks cover implemented lifecycle paths, not every generated SDK option,
real SQL execution, regional availability, or live asynchronous timing. The
simulator is a regression model, not an Alibaba service emulator. Subclass-only
edge cases and product-specific live validation remain separate evidence.

## Account-wide enumeration (`list`) and teardown order

`Plan.destroy` deploys an empty desired graph, so an ordinary destroy is driven
entirely by the dependency edges recorded in Alchemy state. `list` is the only
observation path that does not need that state, and so the only way to find a
resource whose state row was lost. It is a read; the danger is in what consumes
it — see the warning below before reaching for `alchemy unsafe nuke`.

| Resource | `list` | Source API | `nuke.dependsOn` |
| --- | --- | --- | --- |
| `VPC.Network` | Y | `DescribeVpcs`, region + paged | — (deleted last) |
| `VPC.VSwitch` | Y | `DescribeVSwitches`, region + paged, then detail read | `Alibaba.VPC.Network` |
| `ACK.ManagedCluster` | Y | `DescribeClustersV1`, region + paged, then detail read | `Alibaba.VPC.*` |
| `ACK.NodePool` | Y | Region clusters, then each cluster's pools | `Alibaba.ACK.ManagedCluster`, `Alibaba.VPC.*` |
| `RDS.Instance` | Y | `DescribeDBInstances`, region + paged, then detail read | `Alibaba.VPC.*` |
| `Tair.Instance` | Y | `DescribeInstances`, region + paged, then detail read | `Alibaba.VPC.*` |
| Everything else | N (empty) | Keyed entirely by a parent | — |

`nuke.dependsOn` reads "every resource of *this* type must be gone before any
listed type starts deleting", so the child names the parent that has to outlive
it. The resulting order is:

```
ACK.NodePool → {ACK.ManagedCluster, RDS.Instance, Tair.Instance} → VPC.VSwitch → VPC.Network
```

Sub-resources (databases, accounts, privileges, whitelist groups, ACR
namespaces/repositories, ACK addons) deliberately return no items: they have no
account-wide inventory API and are removed with the parent they are keyed by.

### `alchemy unsafe nuke` is not a supported reclamation path here

These `list` implementations enumerate every resource of their type in the
configured region, including other stacks. Orphan reclamation must check
ownership tags and use provider deletion in dependency order. The caller owns
the approval policy and inventory; this package provides no account-wide
cleanup command.

## Lifecycle rules that tests must keep true

1. Create identity is observed by stable name/id before a second create.
2. Tair `CreateInstance` uses `Token`; VPC/RDS use `ClientToken`.
3. `CanNotAcquireLock` is ambiguous acceptance, not a generic transient retry of create.
4. `Normal` is not sufficient to start the next Tair mutation; `IncorrectDBInstanceState` is retried per operation.
5. Tair delete is not complete until `DescribeInstancesOverview` no longer shows the instance, including `Released`.
6. vSwitch deletion may still see `DependencyViolation.Kvstore` or `DependencyViolation.Rds` after the database is absent; wait, then fail with the last provider error.
7. Parent teardown must not proceed when a child delete fails; Alchemy state is preserved.
8. Protocol tests fail if HTTP leaves loopback.
9. A live overview row with temporarily missing detail reads is still present;
   bounded inconsistency fails teardown instead of being reported as absence.
10. VPC deletion is subject to the same rule as vSwitch: ACK leaves a NAT
    gateway, EIP and managed security groups behind, so `DependencyViolation`
    is retried within a bounded budget and then reported as
    `AlibabaDependencyBlockedError` naming the blocking dependency.
11. A **read** failure inside a bounded observation costs one attempt, not the
    whole wait — readiness waits run for up to an hour and must survive an API
    blip that outlives one call's retry budget. Only transport/throttling
    failures and an exhausted budget qualify (`isRetryableObservation`); a
    rejected request still aborts immediately, because repeating it cannot
    change the answer. Exhausting the budget while still failing reports the
    provider error, not a generic readiness timeout.
12. Name lookup must be region-scoped and must paginate. Reaching the bounded
    page limit without a short page or the reported total fails closed rather
    than returning a partial inventory. Name lookup is the sole recovery path
    for resources with no idempotency token (both ACK creates), and a truncated
    or account-wide inventory would either miss an orphan or adopt a same-named
    resource from another region.

## Formal Alchemy bindings

None. Environment and Kubernetes consumers read resource attributes
(`connectionDomain`, `port`, kubeconfig fetch scripts, ACR instance id).
Adding `Binding` types would be speculative.

## ECS additions for 0.2.0

| Resource | Supported behavior | Local evidence | Live |
| --- | --- | --- | --- |
| `ECS.Instance` | One PostPaid VM; create/read, metadata/tags/protection/expiry updates, restart stopped VM, replacement for immutable settings, graceful stop/delete | Pinned SDK loopback with persisted Alchemy state, failures and recovery | Passed create, SSH/bootstrap, size/group/protection/tag updates, no-op and destroy; interrupted create required replacement |
| `ECS.SecurityGroup` | Normal VPC group; create/read, description/tags, replacement, bounded dependency-aware delete | SDK loopback and persisted lifecycle | Passed create/update/delete and attached-VM cleanup |
| `ECS.SecurityGroupIngress` | One adoptable IPv4 inbound allow tuple; create/read, replace, delete by observed rule ID | SDK loopback, permission pagination, preservation of unrelated rule ownership | Runner-only SSH rule create/connect/delete passed |

Instances depend on security groups and VPC/vSwitches. RDS/Tair named IP groups
can depend on `Instance.privateIp` using `Output.interpolate`, ordering access
cleanup before instance deletion. ECS instance and group inventory is regional
and paginated, and ambiguous names fail explicitly. ECS adds two tagged resource
types to the enumeration table above; ingress is parent-keyed and has no regional
list. See [ECS.md](ECS.md) for adoption, replacement, shutdown, auto-expiry,
bootstrap and retention boundaries. Standalone disks, EIPs and IPv6/egress rules are included in the 0.2.0
additions below. Cloud-init completion remains outside infrastructure readiness.

## 0.2.0 additions from the Alchemy comparison

| Capability | Implemented behavior | Local evidence | Connected evidence |
| --- | --- | --- | --- |
| ACK connection/kubeconfig | Temporary redacted kubeconfig; serializable connection, private/public endpoint; upstream Kubernetes adapter with token or mTLS | `kubernetes/integration.test.ts` SDK fake + loopback HTTPS | Temporary private credentials and fetch-on-connect verified; public adapter mTLS and server certificate verification passed |
| Kubernetes Secret | Redacted UTF-8 data, base64 at apply, sanitized diagnostics; delegates upstream Manifest | Local HTTPS create/read/rotation/delete + error echo regression | Passed live create/read, rotation preserving UID, no-op, deletion/404 and log/attribute redaction checks |
| Desired resource inputs | Flat desired fields without 0.1.0 aliases, mutable changes in place, explicit-name replacement guard, authoritative saved IDs, ambiguous-name rejection | `protocol/review-regressions.test.ts`, ACK lifecycle tests, secret-input test | PostgreSQL rerun and ACK smoke cover the recorded desired-state transitions |
| VPC EIP/NAT/SNAT | Tagged EIP/NAT, association and source-switch SNAT, bandwidth/tag drift; replacement preserves one final graph | `protocol/connectivity.test.ts` persisted stack with actual SDK wire | Passed NAT/EIP/SNAT create/update/no-op/delete; independent cleanup verified; outbound SNAT traffic untested |
| RAM Role/Policy/Attachment + RRSA | Scoped OIDC trust, role policy, custom default policy versions, version-limit rotation, drift repair, ordered delete | `protocol/ram.test.ts` persisted stack with RAM wire format | None |
| ACR Image | Upstream Docker build/push, temporary credentials, registry-observed digest; remote tags retained | `acr/image.test.ts` fake Docker and SDK | None |
| RDS backup/parameters/maintenance/restore | Instance-owned configuration, pending-restart reporting, separate clone target | `protocol/instance-updates.test.ts` persisted state, actual SDK requests | MySQL parameters/backup schedule/maintenance passed; restore not run |
| ECS mutable size/groups + full rules | Graceful resize, join before leave; IPv4/IPv6/group ingress and egress | `protocol/ecs.test.ts` | VM resize and group membership passed; full IPv6/egress live coverage pending |
| ECS KeyPair/Disk/Attachment | Public-key import, independent growable disk, retain across VM replacement | `protocol/ecs.test.ts` persisted replacement/reattachment | Passed key import, attach, 20→50 GiB growth with data retained, and cleanup |

New account-wide enumeration is implemented for EIP, NAT, disk, key pair and
RAM role. RAM policy and relationship resources return no account-wide items.
Do not infer nuke support from creation support. Deletion is state-driven, with
attribute dependencies ordering children before parents. No resource here
force-detaches unrelated bindings or changes account-level ownership policy.

Enhanced Internet NAT owns its automatically created default VPC route; a
separate Route resource would duplicate that ownership in the current topology.
RRSA uses the OIDC provider created by ACK. RDS backup/parameters are settings
on the instance rather than AWS-shaped child resources. Other Kubernetes kinds
use upstream providers, as documented in COMPOSITION.md.
