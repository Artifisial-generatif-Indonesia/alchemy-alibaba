# Disposable-stage validation

Status: prepared, not executed. Local tests cover SDK fakes and loopback only.
This runbook does not authorize cloud access, purchases, or data deletion.

## Inputs required before execution

Record these in the approved private task record, never in this repository:

- Disposable Alibaba account/profile, region, and `test-*` stack/stage name.
- Allowed products, engine/version and region-supported SKUs, maximum spend,
  and maximum test duration. Use pay-as-you-go resources, not subscriptions.
- Persistent state backend and recovery location, with restricted access.
- Approved synthetic data and private connectivity; no customer data or public
  database exposure. Credentials come from the official credential chain.
- Approval to create, update, release, and clean up only this stage's resources,
  including the intended treatment of retained backups and recycle-bin data.

`AGENTS.md` requires explicit approval for connected cloud operations. Resolve
these inputs before provisioning; do not infer a profile from ambient credentials.

## Local prerequisite

Run on Node 22.22.1 with npm 11.19.1:

```sh
npx --yes npm@11.19.1 ci
npm run check
npm run check:security
npm pack --dry-run
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
