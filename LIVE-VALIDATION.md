# Disposable-stage validation

Status: disposable PostgreSQL/VPC/vSwitch and ACK smoke runs executed on
2026-09-09 (Jakarta), including a PostgreSQL rerun of candidate `9c68310`.
See the evidence and limitations below. The initial Kubernetes Secret attempt
was blocked by SLB ACL permissions; the permission-enabled follow-up passed
live TLS connection and Secret lifecycle checks. Later non-ACR loops covered MySQL and
Tair and found additional lifecycle bugs. A permission-enabled rerun subsequently
verified ECS and NAT lifecycle behavior and fixed ECS timestamp/resize defects.
MySQL was subsequently excluded from further tests by the user.
Other unlisted scenarios remain unverified.
This runbook does not authorize cloud access, purchases, or data deletion.

## Inputs required before execution

Record these in the approved private task record, never in this repository:

- Disposable Alibaba account/profile, region, and `test-*` stack/stage name.
- Allowed products, engine/version and region-supported SKUs, maximum spend,
  and maximum test duration. Use pay-as-you-go resources, not subscriptions.
- Persistent state backend and recovery location, with restricted access.
- Approved synthetic data and connectivity; no customer data. Temporary public
  access requires explicit approval, a dedicated runner IPv4 /32 whitelist,
  verified TLS, and tracked cleanup. Credentials use the official chain.
- Approval to create, update, release, and clean up only this stage's resources,
  including the intended treatment of retained backups and recycle-bin data.

`AGENTS.md` requires explicit approval for connected cloud operations. Resolve
these inputs before provisioning; do not infer a profile from ambient credentials.

## Local prerequisite

Run on Node 22.22.1 with pnpm:

```sh
pnpm install --frozen-lockfile
pnpm run release:prepare
```

The example RDS stack uses in-memory state for illustration. Do not run it
against the cloud until it uses the approved persistent backend. The protocol
harness uses test-only storage and endpoints; it is not a live deployment tool.
Prepare a separate stage configuration with the approved SKUs and settings,
review its resource plan and cost estimate, and retain the configuration and
state outside the repository. Never use account-wide `unsafe nuke` for cleanup.

## Acceptance sequence

1. Record the approved account/region and starting inventory. Deploy the
   disposable VPC/vSwitch and the selected service resources. Save returned
   IDs and ownership tags immediately in the private test record.
2. Reapply unchanged configuration. Require stable physical IDs, account names,
   ownership tags, and no repeated purchases or unnecessary mutations.
3. For RDS, test one-instance creation, serverless capacity/auto-pause where
   supported, SSL certificate and private-key rotation, and protection
   enabled → disabled → enabled. Confirm each change in independent read APIs.
4. For Tair, resize A → B → A and verify the final size, then exercise password,
   SSL and authentication updates. Confirm convergence before the next change.
5. For ACK, change an observable cluster setting and node-pool image, introduce
   controlled drift only in this stage, and reapply. Verify addon configuration
   equality despite JSON formatting changes and API-supplied defaults.
6. Verify ACR namespace configuration and generated RDS/Tair account names.
   Confirm explicit identity defaults do not replace existing resources.
7. Restart the runner using the same persistent state and reapply. Resource IDs
   must stay stable. Test an interrupted update only after recording its identity
   and confirming that the stage can be recovered safely.
8. Destroy through the saved dependency graph. Confirm child deletion completes
   before parent deletion. Preserve state and stop on unexpected API errors,
   ambiguous absence, budget exhaustion, or dependencies outside this stage.

## Independent cleanup evidence

Provider success alone is insufficient. Record account/region, timestamps,
resource IDs, relevant safe request IDs, and the result of independent inventory
checks for the approved stage only. Do not save credentials, request bodies,
private keys, passwords, or raw error dumps in the evidence.

- Tair: verify `DescribeInstancesOverview` has no row, including `Released`,
  after `DestroyInstance` completes.
- RDS: verify ordinary instance release, then separately inspect the recycle bin
  and retained backups. `DestroyDBInstance` is documented as phased out; do not
  automate it on the assumption that it is equivalent to Tair destruction.
  If permanent removal is required, use an explicitly approved supported
  console/support procedure. Track retained backups and their expiry separately.
- ACK/VPC: verify cluster/node-pool removal and inventory ENIs, NAT gateways,
  EIPs, security groups, vSwitches, and VPCs associated with the stage. Do not
  force-delete a managed attachment or an object with uncertain ownership.
- ACR: verify repositories/namespaces and endpoint links created by the test are
  removed. Retained instance references must remain intact.
- Check subsequent billing records for this inventory and record any retained
  billable objects. Report unresolved objects with IDs and a cleanup owner;
  do not mark the stage fully reclaimed until they are resolved.

## References

- [RDS release behavior](https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-mysql/release-or-unsubscribe-from-an-instance)
- [RDS DestroyDBInstance: phased-out operation](https://www.alibabacloud.com/help/en/rds/developer-reference/api-rds-2014-08-15-destroydbinstance)
- [Per-resource verification and known gaps](SUPPORT-MATRIX.md)

## First RDS smoke stack

**Known PostgreSQL limitation:** the separate DBOwner grant cannot be revoked
through the RDS API. This example currently needs reviewed ownership cleanup
before ordinary destroy; see the observed workaround below. Do not assume the
six-resource example has an unattended end-to-end deletion lifecycle.

[`examples/live-rds.alchemy.ts`](examples/live-rds.alchemy.ts) declares
six base resources: a VPC, vSwitch, PostgreSQL Basic instance, generated account,
database, and database-owner grant. It accepts only `test-rds-*` stages and uses
Alchemy's persistent local state with an owner-only process umask. Run every
command from the same dedicated private directory and retain that directory
through cleanup; do not use an ephemeral checkout as the state location.

The private environment file supplies `ALIBABA_CLOUD_PROFILE`,
`ALIBABA_CLOUD_REGION`, `SMOKE_ZONE_ID`, `SMOKE_RDS_CLASS`, `SMOKE_RDS_VERSION`,
`SMOKE_RDS_STORAGE_GB`, `SMOKE_RDS_STORAGE_TYPE`, and a generated
`SMOKE_RDS_PASSWORD`. `SMOKE_REVISION` and `SMOKE_DELETION_PROTECTION` allow
controlled in-place updates. Keep the synthetic password out of shell arguments
and logs. Confirm current availability and quote the selected SKU before apply.

Use the Alchemy `plan` command with the absolute stack path, the `test-rds-*`
stage, and `--env-file` pointing to that private file. The initial plan must show
only these six creates. After spending approval, use `deploy`, unchanged
reapply, controlled updates, and `destroy` with the same paths and stage.

The stack initially allows only `127.0.0.1` and creates no public endpoint.
A real SQL test additionally needs a separately tracked temporary public
connection, a dedicated allowlist group restricted to the runner's current
public IPv4 `/32`, and SSL with certificate verification. `SMOKE_SSL_ENDPOINT` configures the approved protected hostname and
`SMOKE_RUNNER_IPV4` adds a seventh resource for the dedicated /32 group.
Release the public connection and reset the group to loopback before teardown. Do not change the create-time whitelist
input to run this check: create identity changes can replace the instance.


## PostgreSQL smoke evidence (2026-09-09 Jakarta)

The approved disposable run used PostgreSQL 16 Basic, 20 GB ESSD, in Jakarta.
Resource IDs, credentials, state, and raw operational evidence remain outside
this repository in the private test record.

Passed against live APIs and PostgreSQL:

- VPC, vSwitch, RDS, account, database, and DBOwner grant creation.
- Fresh-process unchanged redeploys with stable physical IDs and no-op plans.
- Descriptions/tags, password rotation, and deletion protection off/on updates.
- Temporary public connectivity restricted to one IPv4 /32, Alibaba CA and
  hostname verification, and TLS 1.3 SQL connections.
- Table creation and committed data, persistence after provider updates,
  transactional DDL/data rollback, new-password login and old-password rejection.
- Public endpoint release and whitelist reset to loopback, independently read
  back before instance release.

The first teardown did **not** succeed unassisted. PostgreSQL's ordinary account
ownership was reported as `ALL` by DescribeDatabases, and a successful
RevokeAccountPrivilege response did not remove it. The official API explicitly
excludes PostgreSQL. The provider now fails immediately for an observed ordinary
PostgreSQL binding; it does not silently retain it or delete its database/account.
Such bindings require reviewed SQL ownership/permission changes before deletion.
Do not use this resource as a fully reversible PostgreSQL permission manager.

For this synthetic test only, the database was explicitly deleted to remove the
binding before resuming the saved Alchemy destroy. That recovery exposed two
additional issues now covered by regression tests: DeleteDatabase must first
observe already-absent databases, and RDS instance absence can be returned as
`InvalidDBInstanceName.NotFound`.

Final cleanup: saved-state destroy completed, and independent RDS detail/list,
vSwitch detail, and VPC list queries confirmed absence. No resource state rows
remain. One service-managed ENI delayed vSwitch deletion for several minutes;
the existing bounded dependency waiter completed without force-deleting it.
DescribeDetachedBackups reported zero records. This does not establish permanent
recycle-bin removal or final billing. Local verification passed 146 tests across
15 files, TypeScript checking, and the build.

Not covered: ACK, RDS resize/serverless, custom certificate rotation, production
migrations, or guaranteed permanent removal of recycle-bin data/retained backups.
The quoted instance rate was USD 0.0914/hour; subsequent billing is not verified.

Reference: [RevokeAccountPrivilege engine support](https://www.alibabacloud.com/help/en/rds/developer-reference/api-rds-2014-08-15-revokeaccountprivilege).

## 0.2.0 candidate rerun (2026-09-09 Jakarta)

Candidate `9c68310` was tested with the direct desired-state inputs in
`examples/live-rds.alchemy.ts`, Node 22.22.1, and persistent private local state.
The run reused the earlier region and configuration: PostgreSQL 16 Basic,
2 vCPU / 4 GB, 20 GB PL1 ESSD, Jakarta zone A. All resources and data were
disposable; account configuration, credentials, resource IDs, and raw logs remain
outside this repository. The earlier test's active resources were independently
confirmed absent before this run.

The measured deployment-to-verified-cleanup window was **10 minutes 58 seconds**
(00:52:42–01:03:40 UTC), including the interventions and time between commands.
Private test preparation through cleanup took **12 minutes 7 seconds**.

| Operation | Measured duration | Outcome |
| --- | --- | --- |
| Initial deployment | 208 seconds | VPC, vSwitch and RDS created; account rejected an overlong synthetic password |
| Resume after correcting test password | 8 seconds | Remaining resources created; existing instance/network reused |
| Unchanged redeploys in fresh processes | 4 seconds each | Six baseline resources, then seven with runner access, all no-op |
| Enable SSL and restricted runner access | 87 seconds | Waited for SSL completion; verified TLS 1.3 SQL subsequently passed |
| Password, tags/descriptions and protection update | 7 seconds | Stable IDs; independent API readback passed |
| Re-enable protection | 6 seconds | Independent API readback passed |
| Close public access | 9 seconds | Endpoint absent; runner whitelist reset to loopback |
| Prepare destruction | 6 seconds | Protection disabled and temporary IP-group resource removed |
| Initial destruction | 5 seconds | Explicitly rejected unsupported PostgreSQL ordinary ownership revocation |
| Delete this run's synthetic database | 2 seconds | Scoped, journaled intervention for the known limitation |
| Resume destruction | 100 seconds | Saved-state destroy completed, including delayed network cleanup |

SQL checks verified committed data survived the updates, the new password worked,
the old password was rejected, and transactional schema/data changes rolled back.
The CA download was unavailable while SSL reported `setting`; it succeeded after
the provider completed its readiness wait. The first account error was caused by
the test harness generating a password longer than the API's 32-character maximum;
the corrected password met the documented constraints. No provider source changes
were required by this rerun. PostgreSQL privilege deletion still required the
documented intervention, so this was not an unattended teardown pass.

Independent final reads confirmed the RDS instance, VPC and vSwitch absent,
zero network interfaces in the test network, zero detached backups, and zero
remaining resource state rows. One service-managed ENI was observed during cleanup
and disappeared without force deletion. Permanent recycle-bin removal and final
billing remain unverified.

The fresh `DescribePrice` quote was **USD 0.0914/hour**, including instance and
storage. An allowance for two hourly database charges is **USD 0.1828**, before
tax or any separately billed retained objects; this is not an observed bill.
The authorized validation budget was USD 30. This run supports a minutes-scale
estimate for this specific RDS/VPC smoke, not an estimate for the full provider
matrix. ECS, ACK, Kubernetes, ACR, RAM, Tair, NAT, resize and restore were not
exercised by this rerun.

## 0.2.0 ACK smoke (2026-09-09 Jakarta)

Starting from candidate `744fdc7`, the disposable stage used ACK Pro
(`ack.pro.small`), Kubernetes `1.36.2-aliyun.1`, Flannel, containerd `2.3.4`,
and an Alibaba Linux 3 container-optimized image in Jakarta zone A. A dedicated
VPC/vSwitch held an ACK-managed NAT gateway, EIP, private API load balancer,
security group, and worker role. Workers were PostPaid `ecs.u1-c1m2.large`
(2 vCPU / 4 GB), each with a 40 GB PL1 ESSD. State and synthetic credentials
stayed in a private persistent directory outside this repository.

| Operation | Measured duration | Outcome |
| --- | --- | --- |
| Initial cluster and one-worker deployment | 304 seconds | Four Alchemy resources created |
| Unchanged redeploys in fresh processes | About 4 seconds | No mutations; stable IDs |
| Scale 1 → 2 and change tags | 67 seconds | Two healthy workers reported by ACK; stable cluster/pool IDs |
| Scale 2 → 1 | 107 seconds | One healthy worker reported by ACK |
| Protection on/off after provider fix | 4.8 / 4.3 seconds | Independent API and state readback matched |
| Repair controlled protection drift | 4.6 seconds | Reapply restored declared protection without replacement |
| Scale final worker to zero | Interrupted after 434 seconds | Still in `DrainNodes`; not a pass |
| Scoped cluster deletion through ACK | 347 seconds to observed absence | Cleanup intervention after drain/cancellation/pool-deletion limitations |
| Resume Alchemy destroy | 15 seconds | Reconciled absent cluster/pool, deleted vSwitch/VPC, cleared resource state |

The original protection update sent the unchanged `clusterSpec` alongside
`deletionProtection: false`. ACK reported a successful asynchronous task but
kept protection enabled. A scoped diagnostic request containing only the
protection field succeeded, allowing the original waiter to finish after
397 seconds. That assisted operation is **not** counted as a provider pass.
The provider now separates edition and configuration updates and waits for each
to converge, following the category-based approach in upstream EKS. A loopback
regression reproduces the ignored field and covers simultaneous edition/protection
changes, unchanged redeploys, and observed protection drift. The corrected
protection lifecycle and drift repair then passed on this live cluster.

Temporary private kubeconfig retrieval returned redacted credentials with a
future expiration. Two upstream-adapter connections fetched fresh credentials
twice; their certificate/key pairs matched. No password or kubeconfig private key
appeared in inspected logs or resource attributes. This verifies credential
acquisition and adapter preparation, **not** a live Kubernetes HTTPS handshake.

The runner could read the SLB listener but `slb:CreateAccessControlList` returned
HTTP 403 `Forbidden`. The API endpoint therefore remained private, and no public
API EIP or ACL was created. Kubernetes API readiness, Namespace/Secret
create/read/rotation/delete, and verified mTLS requests were **not run**. Those
checks require runner connectivity, such as a private runner or permission to
configure the dedicated load balancer's runner-/32 whitelist before public access.
Node image changes, addon configuration/version changes, Kubernetes upgrades,
RRSA, and advanced rollout controls also remain unverified live.

The attempt to scale the final worker to zero remained in `DrainNodes`.
The local waiter was interrupted after 434 seconds with state preserved; zero
workers was not verified. ACK rejected cancellation (`ErrPauseTask` /
`TaskOperationNotSupported`) and forced pool deletion while the pool was
`removing_nodes` (`InvalidNodePoolStatus.Forbidden`). Worker-side diagnosis via
ECS Cloud Assistant was also denied (`Forbidden.RAM`). Cleanup therefore used a
scoped cluster-level `DeleteCluster`, with deletion protection disabled and the
same declared managed-resource deletion policy. This was an explicit teardown
intervention, not an unattended child-first Alchemy destroy pass.

ACK documents a graceful drain window of up to 30 minutes. The shared 20-minute
wait was too short for that documented window, so ACK asynchronous tasks now
allow approximately 40 minutes by default, with explicit `wait` overrides
preserved. Local tests cover a task completing after the old observation budget
and an explicitly shorter timeout. This run did not establish that the live
drain would have completed on its own. System-pod disruption constraints are a possible
cause, but were not verified because Kubernetes access was unavailable.
Reference: [ACK node removal and drain behavior](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/remove-a-node-11).

By **02:41:28 UTC**, independent inventory confirmed the cluster, node pool,
scaling group, both worker instances and disks, ENIs, NAT gateway, EIP, security
group, load balancer, vSwitch, and VPC absent, with zero remaining resource state
rows. Final inspection of 20 test logs found no synthetic secrets or private keys.
The full deployment-to-inventory window was **42 minutes 35 seconds**, including
debugging, local fixes/checks, permission diagnosis, and the cleanup intervention;
it is not a normal deploy/destroy benchmark.

Worker RAM-role removal could **not** be independently verified: both `GetRole`
and `ListRoles` returned HTTP 403 `NoPermission`. Its identity remains in the
private cleanup record for follow-up by an authorized operator. ACK reported
successful cluster deletion, but that is not proof that the role was removed.
Final billing remains unverified.

The live ECS quote was **USD 0.084028 per worker-hour**, including its system
disk. ACK management and managed NAT/EIP/load-balancer/network charges are
additional. The private plan reserved USD 8 within the user's USD 30 validation
budget and capped this stage at four hours; this is a spending allowance, not a
measured bill. The short second-worker interval and hourly rounding must be
included when reviewing subsequent billing.

## 0.2.0 non-ACR live loops (2026-09-09, Jakarta)

These disposable stages exercised `c0e16a6` and the lifecycle corrections
committed as `7c2b4de`, under the existing USD 30 validation budget. ACR was explicitly
excluded. Private credentials, state, inventory identifiers, and logs remain
outside the repository. The ECS and NAT results below are permission-blocked
creation attempts, not successful VM or gateway lifecycle coverage.

### ECS and NAT partial-deployment recovery

ECS `ImportKeyPair`, `CreateDisk`, and `CreateSecurityGroup` returned
`Forbidden.RAM`. No VM, data disk, key pair, or security group was created.
The independent VPC, vSwitch, and EIP did provision. Initial creation failed after
25 seconds. Cleanup exposed unresolved parent identities in ECS rule and disk
attachment reads and EIP association reads. The provider now waits for the
required identities before reading, and explicitly handles absent observations.
The loopback simulator now reproduces the real missing-security-group-ID error;
a persisted-stack regression verifies cleanup after denied parent creation and
rejects unscoped disk observations.

Resuming the original saved state with the fix completed cleanup in 4.7 seconds,
without editing state or manually deleting the remaining VPC. Independent API
reads confirmed no tracked VM, disk, key, security group, EIP, ENI, vSwitch, or
VPC remained, and resource state was empty. VM bootstrap, SSH, replacement,
resize, disk attachment, and security-group membership changes remain untested.

NAT `CreateNatGateway` also returned `Forbidden.RAM`; its VPC, vSwitch, and EIP
had provisioned. Creation failed after 25 seconds, and ordinary Alchemy cleanup
with the fixed provider took 15 seconds. Independent name-filtered API reads
confirmed that no stage VPC, EIP, or NAT remained. NAT/SNAT updates and traffic
were not tested. These denials need an authorized operator to adjust the test
profile before another connected attempt; the provider did not change IAM.

### MySQL lifecycle and settings

A disposable MySQL 8.0 Basic instance with 20 GB ESSD storage deployed with its
VPC/vSwitch, generated account, database, and `ReadWrite` binding in **120 seconds**.
The initial unchanged deploy took four seconds. A tracked temporary public
endpoint and runner-only IPv4 /32 group enabled hostname-verified TLS 1.2 SQL
checks using the Alibaba CA chain downloaded during the preceding PostgreSQL
run. The MySQL SSL API did not return its own CA download URL.

Passed: synthetic table writes/reads and DML rollback; `ReadWrite` → `ReadOnly`
(six seconds, writes denied and reads preserved); password rotation and return
to `ReadWrite` (nine seconds, old password rejected); metadata/tags and deletion
protection update; in-place `mysql.n2.medium.1` → `mysql.n4.medium.1` resize with
20 → 30 GB storage (**6 minutes 45 seconds**), stable instance identity, and data
survival. Supported parameter, backup scheduling, and maintenance-window
changes then converged, followed by an unchanged seven-resource no-op.

The `max_connections: "128"` test exposed an Alibaba-specific read mismatch.
Change history reported `Applied`, while `DescribeParameters` and SQL reported
648 because that running value includes reserved management connections.
`DescribeDBInstanceAttribute.MaxConnections` correctly reported 128. The provider
now uses the user connection limit for MySQL's parameter comparison; it does not
subtract a hard-coded reservation. A regression also verifies no-op, drift
repair, and a second limit change. See Alibaba's
[maximum connection guidance](https://www.alibabacloud.com/help/zh/doc-detail/469562.html).
Two observation-only applies were interrupted during diagnosis; the corrected
saved-state apply completed in ten seconds, without recreating the database.

Removing the independent privilege resource took seven seconds, and a fresh
`DescribeAccounts` read confirmed that the database binding was absent. This
engine required no PostgreSQL ownership workaround. Public endpoint release
first returned `IncorrectDBSslStatus`; removing runner access and disabling SSL
through Alchemy allowed its release. Ordinary database/account/instance deletion
then succeeded. vSwitch deletion initially returned `DependencyViolation.Rds`,
which the provider now retries alongside delayed ENI and Kvstore detachment.
Resuming saved-state cleanup with that fix took 45 seconds. Independent API reads
confirmed no instance, vSwitch, VPC, ENI, or resource state remained, and detached
backup enumeration returned zero. Permanent recycle-bin removal and the final
bill remain unverified.

The live instance quotes were USD 0.0914/hour initially and USD 0.1141/hour for
the resized instance with 30 GB storage. This diagnostic loop lasted roughly
32 minutes through verified cleanup, including investigation and retries, within
its USD 4 spending reserve. The reserve is not a measured bill.

### Tair findings

A disposable cloud-native Redis 7.0 stage exposed three Alibaba-specific
mismatches. `CreateInstance` accepts `nodeType: "MASTER_SLAVE"`, while the detail
API returns `double`. Comparison now recognizes the equivalent node-type
vocabularies and preserves the requested form on the wire. See Alibaba's
[instance detail API](https://www.alibabacloud.com/help/doc-detail/473779.html).
A later size change rejected the unchanged `MajorVersion: "7.0"` field with
`InvalidParameter`; resize requests now omit the engine version when it already
matches. Separate protocol regressions prove alias comparison, real node-type
drift, and A → B → A resizing without an unnecessary engine-upgrade request.
The corrected live 1 → 2 GB resize plus SSL enablement completed in 6 minutes
12 seconds. Task history reported resize success before all detail reads had
converged; the provider continued waiting for the actual requested state.

`CreateAccount` repeatedly returned HTTP 500 `InternalFailure` for the generated
65-character name. Isolated account probes accepted 32 and 33 characters and
rejected 63 and 64; this does not establish the exact service limit. The provider
now generates 32-character names, and a new generated account succeeded live.
Explicit and saved account names remain authoritative. The probes were confined
to the disposable instance and removed through Alchemy. This is a measured
workaround for this Redis 7 cloud-native variant, not a claim that the API's
documented 100-character allowance is universally wrong.

The return resize and default-account password rotation completed, but concurrent
account-password and allowlist changes were rejected with
`IncorrectDBInstanceState`. Child idempotent mutations now use the same bounded
acceptance wait as the parent, including safe retries during deletion. Protocol
coverage injects the state error into description/password/allowlist updates and
account/group deletion. Resuming the two failed children from saved state passed.
A subsequent overlapping default/child-password, metadata, and allowlist apply
passed in **1 minute 50 seconds**, and the final fresh-process apply was a
six-resource no-op in four seconds. Independent reads confirmed the original
instance ID across **1 → 2 → 1 GB**, SSL enabled, VPC authentication enabled,
`maxmemory-policy: noeviction`, the desired named allowlist and account settings,
and release protection disabled for cleanup. These are control-plane checks;
Redis client TLS, authentication rejection, and data survival were not tested.
No Tair public endpoint was created.

Ordinary Alchemy teardown removed the accounts and allowlist before releasing
and destroying the instance, then waited for `DependencyViolation.Kvstore` to
clear before removing the subnet and VPC. It completed in **4 minutes 52 seconds**
without an out-of-band cleanup or state edit. Independent detail and overview
reads confirmed instance absence, including no `Released` entry; vSwitch, VPC,
ENI inventory and resource state were also empty. The complete diagnostic stage
lasted **41 minutes 46 seconds**, including failed attempts, fixes, probes, and
cleanup. Quotes were USD 0.0378887043/hour at 1 GB and USD 0.0616597615/hour at
2 GB, within the USD 4 stage reserve. Final billing remains unverified.


## 0.2.0 complete live validation plan

Run this after the local release gate passes, against the exact candidate commit.
“Complete” means the supported lifecycle for each resource below, with optional
features tested only on an edition/engine that supports them. Record each case
as passed, failed, API-unsupported, or not run; an unsupported result needs a
service reference and the observed safe error code. Never count not-run cases
as passes. The candidate rerun above covers only the listed PostgreSQL/VPC smoke
operations; it does not satisfy the broader matrix below.

| Stage | Resources and checks | Completion evidence |
| --- | --- | --- |
| ECS + private databases | VM, system disk, security group and SSH rule; same-VPC RDS/Tair /32 groups; no-op, metadata/tags/protection, bootstrap, replacement and expiry | Verify real TLS SQL/Tair access, changed IP allowlists, graceful stop/delete, and independent disk/IP/group cleanup; app readiness is separate from Running |
| PostgreSQL + VPC | Network/vSwitch, instance, database, account, DBOwner binding, dedicated IP group; unchanged reapply, metadata, password rotation, SSL completion, protection cycle, runner restart, TLS SQL and transaction rollback | Stable IDs, old password rejected, supported updates independently observed; ordinary PostgreSQL binding deletion reports the documented limitation and preserves state |
| PostgreSQL recovery | Review synthetic ownership/permission cleanup separately, close public access, resume saved-state destroy | Record the intervention explicitly; instance, managed attachments, vSwitch and VPC absent; backups/recycle-bin disposition recorded separately |
| RDS MySQL | Database/account/privilege/IP group lifecycle; grant, change, revoke, password rotation, supported resize and protection changes | Independent reads prove privilege removal; child-before-parent destroy succeeds without the PostgreSQL workaround |
| Tair + VPC | Instance/account/IP group; resize A → B → A, password rotation, SSL, VPC authentication, eviction configuration and protection changes | Each mutation converges, restart/reapply preserves IDs, release then recycle-bin destruction observed, vSwitch/VPC dependencies clear |
| ACK + VPC | Managed cluster/node pool/addon; observable cluster update, node image change, addon config/version change, harmless stage-only drift and recovery | Tasks complete; unchanged deploy produces no mutations; child deletion precedes cluster/network deletion; associated NAT/EIP/ENI/security-group inventory reconciled |
| ACR retained instance | Read reference; isolated namespace/repository, Internet ACL entry and VPC endpoint link; namespace settings, repository visibility, ACL comment replacement | Nested settings converge; only test children and links removed; paid reference remains unchanged |
| Optional RDS variants | Serverless capacity/auto-pause and custom SSL certificate/key rotation where supported | Separate approved SKU and certificate setup; otherwise explicitly not run, with no broader coverage claim |

Each stage includes creation, independent readback, an unchanged reapply, supported
updates, a fresh-process reapply, saved-state destruction, and independent cleanup.
Keep failure injection in loopback unless a specific live interruption is approved.
For SQL checks, use synthetic data, hostname-verified TLS, and the existing
tracked temporary /32 access flow. Record and close access even if a query fails.

Before starting each stage, record its current quote, spending ceiling, time
limit, private state location, starting inventory, and teardown owner. Stop new
provisioning when a stage fails or reaches its budget; retain evidence and state
for recovery. ACR needs an approved existing Enterprise instance; ACK and Tair
need separate region-supported SKUs. Earlier RDS spending approval does not
supply those choices. Reconcile any older test leftovers before starting another
stage in the same network.

After the run, update this evidence and the support matrix with the candidate
commit, actual outcomes, interventions, residual resources, and billing follow-up.
A normal `0.2.0` version does not turn an untested optional feature into a verified
one. Release only the scope the recorded results support.

## Permission-enabled ECS and NAT rerun (2026-09-09)

After the test identity's ECS, NAT, SLB and RAM-read policies were updated,
new isolated stages reran the blocked scenarios. RAM inventory also independently
confirmed that the worker role from the earlier ACK smoke had been removed.
ACR and further MySQL tests remained excluded.

### ECS

The stage created an imported SSH public key, two security groups, a runner-only
SSH rule, VPC/vSwitch, pay-as-you-go VM, independent ESSD data disk, EIP and both
attachments. SSH used a pinned host key. The guest bootstrap marker and a
synthetic data-disk write/read passed.

Two provider defects were reproduced and fixed:

- ECS accepts seconds in `AutoReleaseTime` but returns minute precision. Exact
  string comparison left a running VM waiting for the original
  timestamp until the wait bound. Compare at minute precision in diff, mutation and readiness checks.
  The protocol simulator now returns the live representation; creation, no-op
  and schedule clearing are covered locally.
- Online disk expansion returned `OperationDenied` while concurrent VM resizing
  restarted its attached instance. Retrying after the VM returned to Running
  succeeded. A bounded, operation-local retry now handles that conflict and the
  explicit instance-state codes. Permanent failures retain their original error;
  permission denials are not retried. The local test exercises busy responses,
  denial and saved-state recovery. A live concurrent resize then passed in
  **38.59 seconds**, including actual state-conflict retries.

Live readbacks verified VM resize from 2 vCPU/4 GiB to 4 vCPU/8 GiB and back,
security-group membership changes, deletion protection on/off, descriptions,
tags, EIP bandwidth and data-disk expansion from 20 to 30, 40 and 50 GiB.
The final concurrency check returned to 4 vCPU/8 GiB. VM, disk and EIP IDs stayed
stable through these completed updates, and the guest data survived each resize.
Fresh-process unchanged applies took about four seconds and produced only no-ops.

Recovery limitation: the initial timestamp wait was interrupted after 209 seconds.
Alchemy's saved creating state still lacked resolved subnet/key references, so
resuming planned a delete-first VM replacement. It completed in 47 seconds;
this is **not** evidence of same-VM recovery from that interrupted create.
Both VM generations and all associated disks were tracked for cleanup.
No state files were edited to complete recovery or teardown.

Ordinary Alchemy destroy took **56.07 seconds**. Independent inventory checks
verified both tracked VMs, all three tracked disks (two system disks and the
independent data disk), EIP, key pair, groups, ENIs, vSwitch and VPC absent,
and the resource state empty. This run did not test private database access,
IPv6 traffic, guest filesystem expansion, or automatic expiry actually firing.

### NAT

The six-resource VPC/vSwitch/NAT/EIP/association/SNAT graph deployed in
**78.84 seconds**. Independent API readbacks verified the available NAT and
SNAT entry, EIP association, metadata/tags and bandwidth. Metadata, SNAT name
and bandwidth updates passed in **6.35 seconds**, preserving NAT, EIP and SNAT
IDs. Unchanged applies produced six no-ops.

Ordinary destroy took **66.37 seconds**. Independent inventory found no stage
NAT, EIP or VPC remaining. This is control-plane lifecycle evidence; outbound
traffic through SNAT was not tested.

The current ECS quotes remained USD 0.084028/hour and USD 0.158028/hour for the
two VM sizes including their system disk, excluding data disk and networking.
Private records reserved USD 1 each for this ECS and NAT rerun and USD 5 for the
ACK follow-up. Combined with earlier conservative allowances, that is USD
29.1828 of the approved USD 30 budget; these are allowances, not verified bills.

### ACK Kubernetes connection and Secret

A new one-worker ACK Pro cluster deployed in **304.98 seconds**. The private
adapter again fetched temporary credentials on both connections and verified
that each certificate matched its private key. The test then created an SLB
whitelist for the runner IPv4 /32 and the disposable cluster's internal ranges
before enabling public access.

`apiServerEip: true` alone was rejected with `InvalidParameter.ApiServerEipId`.
The harness was corrected to declare a separate `VPC.Eip` and supply its
allocation ID through `apiServerEipId`. That update passed in **128.86 seconds**.
Independent readback verified that the EIP was attached to the load balancer
whose API listener still had the expected whitelist enabled. No provider
change was needed for this missing harness input.

Live Kubernetes HTTPS then verified:

- Server certificate validation and client-certificate authentication through
  the provider's upstream Alchemy adapter, using temporary 30-minute credentials.
- Kubernetes v1.36.2-aliyun.1 and one Ready worker.
- Namespace and Secret creation through Alchemy in **4.28 seconds**; a direct
  Kubernetes API read matched the synthetic Secret value and label.
- Seven-resource no-op in **4.03 seconds**.
- Secret rotation plus stage metadata updates in **15.93 seconds**; independent
  API reads matched the new value, preserved the Secret UID, and showed a changed
  resource version. A subsequent apply produced seven no-ops in **4.17 seconds**.
- Secret and Namespace deletion in **4.25 seconds**, followed by a live Secret
  read returning HTTP 404 while the cluster remained accessible.
- Neither original nor rotated secret values, their base64 representations,
  nor private keys appeared in the checked logs. Secret attributes were also
  checked for secret data; cluster/pool attributes contained no credentials.

The test used existing provider code for kubeconfig, Kubernetes Manifest and
Secret; no changes to those implementations were required. The disposable node
pool explicitly configured `delete: { force: true }`, after the test workload
was removed. ACK nevertheless started a node-drain task. Live Kubernetes
inspection identified the blocker: `coredns-pdb` allowed zero disruptions while
only one Ready worker remained. The test-only CoreDNS and CSI provisioner
budgets were deleted with UID preconditions after verifying that the cluster
matched the disposable stage, the pool was already deleting, and no application
pods remained. This is an explicit cleanup intervention, not automatic provider
behavior or proof that force deletion bypasses disruption budgets. Production
availability budgets must remain under the application's control.


After the disruption budgets were removed, ACK reported the node-removal task
successful. The next deletion read returned `ErrorNodePoolNotFound`, revealing
an omitted ACK absence code. Adding that explicit code to the service-scoped
absence set let the unchanged saved-state destroy finish the pool step and
continue to the cluster. The ACK protocol simulator now emits this live error
for a missing pool, exercising the existing persisted lifecycle tests. Generic
HTTP 404s and authorization failures still do not prove resource absence.


The resumed destroy completed in **287.44 seconds**. Independent reads verified
cluster, node pool, scaling group, worker, disk, ENIs, VPC/vSwitch, worker RAM
role, managed NAT/EIPs/security group/load balancer, and the separately managed
API EIP absent; local resource state was empty. The separately journaled SLB ACL
was then deleted and independently verified absent. Final redaction checks
passed across 12 log files. Total cluster deploy start to cloud/state cleanup
verification was about **21.6 minutes**, including endpoint setup,
Secret tests, diagnosis, local fixes and cleanup. No active resources from this
permission-enabled ECS/NAT/ACK round remain. Final billing is still unverified.
