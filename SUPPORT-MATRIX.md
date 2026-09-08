# Alibaba Alchemy provider support matrix

This matrix records what the custom providers **actually implement and
verify**, not every field on a generated Alibaba request type. A property
existing on an SDK input is not support.

Verification layers:

- **Subclass**: stateful SDK-client subclasses, no HTTP.
- **Protocol**: real Alibaba SDK clients against a loopback simulator.
- **Stack**: Alchemy `deploy`/`destroy` with temporary persisted state.
- **Live**: disposable `test-*` Alibaba stage. Not part of the repository gate.

Bindings: Consumers pass typed attributes (`vpcId`, `vSwitchId`,
`instanceId`, kubeconfig/env outputs). No Alchemy `Binding` types are
registered. Do not add them speculatively.

## Resource relationships

| Parent | Child | Graph mechanism | Protocol | Live |
| --- | --- | --- | --- | --- |
| VPC Network | vSwitch | `vpcId` attribute | Yes | PostgreSQL smoke passed; older Tair leftovers tracked separately |
| vSwitch | ACK cluster | `vswitchIds` | Create/delete + ENI hold | Not connected |
| vSwitch | RDS instance | `vSwitchId` | Create/delete + ENI hold | PostgreSQL smoke: release and delayed ENI cleanup verified |
| vSwitch | Tair instance | `vSwitchId` | Yes, including delayed `DependencyViolation.Kvstore` | Partial: Tair purged; vSwitch/VPC still held |
| vSwitch | ACR VPC endpoint | `vswitchId` | Yes | Not connected |
| ACK cluster | Addon | `clusterId` | Install/configure/upgrade/uninstall + task waits | Not connected |
| ACK cluster | Node pool | `clusterId` | Create/image update/delete + failed task recovery | Not connected |
| ACR instance | Namespace / repository | `instanceId` | Persisted lifecycle + failure envelope | Read-only smoke for instance reference |
| ACR instance | VPC endpoint | `instanceId` + VPC/vSwitch | Yes | Not connected |
| RDS instance | Database / accounts / privileges / IP group | `instanceId` | Persisted lifecycle + blocked PostgreSQL revoke | Partial: PostgreSQL smoke; grant revocation unsupported |
| Tair instance | Account / IP group | `instanceId` | RPC child lifecycle (parent ID supplied) | Not connected |
| Tair instance | SSL / VPC auth / eviction | same resource mutations | Protocol + stack | Failed on first configure deploy |
| Provider outputs | env / kubeconfig | attributes, not bindings | n/a | Not connected |

## Resource matrix

Legend: **Y** implemented and tested at that layer; **P** partial; **N** not
implemented or not verified; **—** not applicable.

| Resource | Create | Read | Update | Replace | Delete | Permanent destroy | Adopt / ownership | Idempotency token | Ambiguous create recovery | Pagination / name lookup | Partial responses | Transitional states | Restart / recovery | Tags | Secrets | Tests | Live | Known gaps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `VPC.Network` | Y | Y | Y (name/description) | Y if create identity changes | Y | `DeleteVpc` after bounded dependency wait (NAT/EIP/security-group/ENI stragglers) | Alchemy tags; unowned without them | `ClientToken` from Alchemy instance id | Observe by name; tokenized retry | DescribeVpcs pages | N | Pending (configuring), Available, Deleting | Persisted redeploy | Y | — | Subclass + protocol + stack | PostgreSQL smoke create/update/delete passed | No extra optional VPC features (IPv6, DNS, route tables) |
| `VPC.VSwitch` | Y | Y | Y (name/description) | Y if vpc/zone/cidr change | Y | `DeleteVSwitch` after bounded ENI/Kvstore wait | Alchemy tags | `ClientToken` | Concurrent create is transient (`IncorrectVSwitchStatus`) | Describe by VPC/name | N | Pending/Available | Persisted redeploy | Y | — | Subclass + protocol + stack | PostgreSQL smoke passed; older Tair smoke reported Kvstore hold | Waiter is a safety net, not a substitute for Tair recycle-bin absence |
| `ACK.ManagedCluster` | Y | Y | Modify/upgrade | Y if create identity changes | Y | `DeleteCluster` + task wait; ENIs can remain | Alchemy tags | None; observe by name | Accepted-create error recovered by v1 name inventory | `DescribeClustersV1`, region-scoped + paged | N | creating/running/deleting via task | Persisted redeploy/recovery | Y | kubeconfig not stored | Subclass + protocol + stack | Not connected | Advanced upgrade policies and live deletion-protection races unverified |
| `ACK.NodePool` | Y | Y | Y | scaling-group identity | Y | Delete + task wait | Scaling-group Alchemy tags | None | N | Name lookup within the cluster | N | Task wait | Persisted redeploy/recovery | Y | — | Subclass + protocol + stack | Not connected | Advanced scaling/rollout controls not exhaustively simulated |
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
| `Tair.Instance` | Y | Y | Spec/SSL/auth/config/protect/tags/password | Y if name/create identity changes | Y | `DeleteInstance` → `Released` (hidden from `DescribeInstances`) → `DestroyInstance` → overview absence | Alchemy tags | Create **`Token`** from Alchemy instance id; spec `ClientToken` from generation + desired-spec hash + operation nonce | `CanNotAcquireLock` and other ambiguous creates recover by name; lock is **not** a generic retry | `DescribeInstances` pages; overview for recycle bin | Creating attributes can omit id/name; list supplies identity | Creating → Normal; Normal can still reject mutations; Released ≠ absent | Unpersisted-create recovery + persisted redeploy | Y | Password redacted; never snapshotted on the wire | Subclass + protocol + stack | Tair smoke: create/lock/Normal/SSL/`IncorrectDBInstanceState`; delete required DestroyInstance; Kvstore hold outlived destroy | Mutation completion is per-operation; backup/restore are outside the modeled lifecycle |
| `Tair.Account` | Y | Y | Description/password | Compound identity | Y | Delete account | Compound identity | None | N | Describe | N | Available | Persisted redeploy | — | Password redacted | Subclass + protocol + stack | Not connected | Live behavior unverified |
| `Tair.SecurityIpGroup` | Y | Y | Cover | Compound identity | Y | Delete group | Compound identity | None | N | Describe | N | — | Persisted redeploy | — | — | Subclass + protocol + stack | Not connected | Default-group fallback remains subclass-tested |

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
  upgrade/protection, delayed and failed tasks, persisted recovery, regional v1
  inventory and child-before-parent deletion.
- `src/protocol/instance-updates.test.ts`: RDS resize/serverless observations,
  private endpoint selection with a public endpoint present, SSL completion and
  explicit failure, secret rotation without capture,
  protection cycles, and Tair A→B→A resize tokens/default password rotation.
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
6. vSwitch deletion may still see `DependencyViolation.Kvstore` after Tair is absent; wait, then fail with that last provider error.
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
