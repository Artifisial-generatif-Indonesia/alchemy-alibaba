# Disposable-stage validation

Status: a disposable PostgreSQL/VPC/vSwitch smoke run executed on 2026-09-09
(Jakarta). See the evidence and limitations below. Other scenarios remain
unverified against live infrastructure.
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

Run on Node 22.22.1 with npm 11.19.1:

```sh
npx --yes npm@11.19.1 ci
npx --yes npm@11.19.1 run release:prepare
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

## 0.2.0 complete live validation plan

Run this after the local release gate passes, against the exact candidate commit.
“Complete” means the supported lifecycle for each resource below, with optional
features tested only on an edition/engine that supports them. Record each case
as passed, failed, API-unsupported, or not run; an unsupported result needs a
service reference and the observed safe error code. Never count not-run cases
as passes. The PostgreSQL smoke above is historical evidence, not a rerun of
this candidate.

| Stage | Resources and checks | Completion evidence |
| --- | --- | --- |
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
