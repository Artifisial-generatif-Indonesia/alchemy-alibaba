# Changelog

## 0.2.0

Prepared for npm's `latest` channel and a matching GitHub release. This is an
independent community provider for Alchemy v2. Broad production readiness is
not claimed.

### Changes

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

158 tests across 18 files, TypeScript checking, and build pass. Package validation
checks the exact file list, all nine public imports, consumer TypeScript usage,
and a fresh consumer audit with the documented dependency overrides.

A disposable PostgreSQL 16/VPC/vSwitch run verified provisioning, unchanged
redeploys, stable IDs, tags/descriptions, password rotation, protection changes,
verified TLS SQL, transactional rollback, and final active-resource removal.
Teardown required a scoped synthetic database cleanup for the unsupported
PostgreSQL ownership-revocation case; it was not an unattended success.

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
- ACK/ACR do not yet have complete live lifecycle validation. Tair live evidence
  remains partial. Optional engine, scaling, rollout, and component controls are
  not exhaustively simulated. See SUPPORT-MATRIX.md and LIVE-VALIDATION.md.
- Persist state outside ephemeral worktrees. Redacted inputs prevent accidental
  display; they do not encrypt persisted state. No credentials or project-specific
  account configuration are included in this package.

### Upgrade from v0.1.0

The existing `v0.1.0` Git tag predates these fixes and dependency pins. Install
this exact version, set the documented root overrides, and review a
plan against existing persistent state before applying. Resource type names,
physical naming conventions, and ownership tags remain stable. No automatic
state migration or cloud deployment is performed by installation.
