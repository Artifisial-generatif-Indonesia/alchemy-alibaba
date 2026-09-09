# Changelog

## 0.2.0

Prepared for npm's `latest` channel and a matching GitHub release. This is an
independent community provider for Alchemy v2. Broad production readiness is
not claimed.

### Changes

- Fix named ACK/RDS replacement identity, ambiguous recovery and saved-ID lookup.
  Mutable ACK/RDS desired fields and ECS size/group changes update in place.
- Add redacted ACK credentials, temporary kubeconfig/connection support, and
  Kubernetes Secret over upstream Manifest. Upstream Kubernetes resources can
  connect to ACK without application-owned SDK authentication code.
- Add explicit EIP/NAT/SNAT ownership, RAM roles/policies/RRSA helpers, ACR Image
  over upstream Docker, and independent ECS keys/disks/attachments/full rules.
- Add RDS backup policy, parameters, maintenance and restore-to-new-instance;
  reconcile serverless force/compression settings and narrow unsupported spec fields.
- Reuse Alchemy tag diffing and add lifecycle progress. Remove request-phase
  input bags and legacy normalization; 0.2.0 uses one desired-state contract.
- Document resource composition in COMPOSITION.md. New lifecycle evidence is
  local only; publishing and connected acceptance remain separate.

- Add ECS instances, security groups, and IPv4 ingress rules, plus a persistent
  dev-stage example wiring private RDS/Tair allowlists to the VM IP. ECS uses
  one pay-as-you-go instance, explicit replacement for immutable settings,
  graceful deletion, and optional absolute auto-release scheduling. VM type and
  security-group membership changes update in place. See ECS.md.
- Custom `AlibabaClientSet` implementations must supply both `ecs` and `ram` clients.

- Fix lifecycle reliability across Alibaba VPC, RDS, Tair, ACK, and ACR:
  bounded observation/retry, explicit absence errors, regional/paginated
  recovery, stable identities, ownership checks, and child-first teardown.
- Add real SDK loopback coverage for RDS/Tair accounts and IP groups, RDS
  databases/privileges, ACR namespaces/repositories/ACLs, ACK node pools/addons,
  asynchronous tasks, updates, failures, and recovery using persisted state.
- Fix premature RDS SSL success: PostgreSQL configuration waits for `success`
  when `LastModifyStatus` is reported and fails explicitly on `failed`.
- Handle already-absent databases and RDS's `InvalidDBInstanceName.NotFound`
  response during teardown. PostgreSQL privilege revocation now fails promptly
  when the binding remains, rather than waiting for an unsupported operation.
- Update exact peers to Alchemy `2.0.0-beta.76` and Effect `4.0.0-rc.112`.
  Add dependency remediation, security checks, and consumer package validation.

### Validation

188 tests across 26 files, TypeScript checking, and build pass. Package validation
checks the exact file list, all twelve public imports, consumer TypeScript usage,
and a fresh consumer audit with the documented dependency overrides.

A disposable PostgreSQL 16/VPC/vSwitch run verified provisioning, unchanged
redeploys, stable IDs, tags/descriptions, password rotation, protection changes,
verified TLS SQL, transactional rollback, and final active-resource removal.
Teardown required a scoped synthetic database cleanup for the unsupported
PostgreSQL ownership-revocation case; it was not an unattended success.
Candidate `9c68310` repeated these checks with the 0.2.0 desired-state inputs:
deployment through verified cleanup took 10 minutes 58 seconds, with the same
documented ownership-cleanup intervention. See LIVE-VALIDATION.md for timings,
the corrected test-password input, and the quote versus final-billing distinction.

### Compatibility and limitations

- Use Node 22 (at least 22.12.0) and npm 11.19.1; release validation uses
  Node 22.22.1. Alchemy and Effect remain prerelease dependencies.
- Set the root dependency overrides in README before installing. Library
  overrides are not inherited by applications. Commit and audit your lockfile.
- PostgreSQL `AccountPrivilege` cannot revoke ordinary ownership through the
  RDS API. Reviewed SQL ownership/permission changes are needed before removing
  that binding. The provider will not drop a database or account to revoke it.
- RDS recycle-bin destruction is not modeled; ordinary release does not prove
  permanent data removal. Final billing and recycle-bin cleanup remain unverified.
- ECS has no connected validation yet; application/bootstrap readiness, expiry,
  disk/IP release, and real database connectivity still need live checks.
- ACK/ACR do not yet have complete live lifecycle validation. Tair live evidence
  remains partial. Optional engine, scaling, rollout, and component controls are
  not exhaustively simulated. See SUPPORT-MATRIX.md and LIVE-VALIDATION.md.
- Persist state outside ephemeral worktrees. Redacted inputs prevent accidental
  display; they do not encrypt persisted state. No credentials or project-specific
  account configuration are included in this package.

### Breaking input API from v0.1.0

0.2.0 prioritizes the desired-state API over compatibility with 0.1.0. Declare
resource properties directly; `create`, `modify`, `spec` and cluster `upgrade`
bags are not supported. Use `kubernetesVersion` with optional `upgradePolicy`,
and one set of instance sizing values. No compatibility aliases or automatic
state migration are provided. Follow COMPOSITION.md and the 0.2.0 declarations.
Installation performs no cloud deployment.
