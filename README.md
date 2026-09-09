# Alibaba Cloud providers for Alchemy v2

Reusable ECS, VPC, ACK, ACR, RDS, Tair, RAM and Kubernetes resources using the official Alibaba SDKs and Effect. This is an independent community provider, not an official Alibaba or Alchemy package.

**Release:** `0.2.0` is prepared for npm's `latest` channel. Read the
[release notes](CHANGELOG.md) and [validation limits](#validation-limits) before
adoption. This release includes the review fixes and new resources described in
[COMPOSITION.md](COMPOSITION.md), and intentionally breaks the 0.1.0 input API.
Publishing instructions are in [RELEASE.md](RELEASE.md).

The implementation follows Alchemy's unified lifecycle: read live state,
adopt only according to each API's ownership capabilities, reconcile from the
observed resource, and make deletion idempotent. Calls that are safe to repeat
use bounded Effect schedules; creates are observed by stable identity instead
of blindly retried.

Lifecycle control flow is modeled with Effect tagged states rather than
boolean flag combinations. Bounded observation absorbs a failed read as one
spent attempt — a readiness wait may run for the better part of an hour, and
must not be destroyed by an API blip that outlives a single call's retry
budget — while a rejected request still aborts at once. It preserves the final
state and fails with typed errors:

- `AlibabaProviderError` for a rejected SDK operation, including safe Alibaba
  error codes and request IDs;
- `AlibabaWaitTimeoutError` for an expected state that never arrived;
- `AlibabaObservationConflictError` when independent Alibaba inventories remain
  contradictory; and
- `AlibabaDependencyBlockedError` when an opaque managed-service attachment
  prevents parent deletion.

These failures remain in the Effect error channel, so Alchemy does not advance
or discard the resource graph. In particular, absence from Tair's public APIs
is not treated as proof that Alibaba has detached its hidden vSwitch relation.

## Resource coverage

| Service | Resource            | Supported lifecycle and features                                                                                                                                                                             |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ECS | `Instance` | One pay-as-you-go VM, system disk, cloud-init, private/optional public IP, metadata/protection/expiry updates, graceful teardown |
| ECS | `SecurityGroup` | Tagged normal VPC security group, description and tag updates, dependency-aware deletion |
| ECS | `SecurityGroupIngress` | One IPv4/IPv6/security-group inbound rule, accept/drop, paginated observation and deletion by rule ID |
| ECS | `SecurityGroupEgress`, `KeyPair`, `Disk`, `DiskAttachment` | Outbound rules, public-key import, independent growable data disks and retained attachments |
| VPC | `Eip`, `EipAssociation`, `NatGateway`, `SnatEntry` | Explicit outbound ownership, bandwidth/IP updates, dependency-aware replacement and deletion |
| RAM | `Role`, `Policy`, `RolePolicyAttachment` | Tagged roles/custom policies, version rotation and scoped permissions; ACK RRSA helpers |
| Kubernetes | `Secret` | Redacted inputs over upstream Manifest lifecycle; ACK adapter supports upstream workloads |
| ACR | `Image` | Upstream Docker builds/pushes with temporary ACR credentials and registry-observed digest outputs |
| VPC     | `Network`           | create/read/update/delete, complete create/modify request inputs, deterministic naming, ownership tags, tag drift, idempotency tokens, readiness and deletion waits                                          |
| VPC     | `VSwitch`           | create/read/update/delete, complete create/modify request inputs, immutable network/zone/CIDR identity, ownership tags, tag drift, idempotency tokens, readiness and deletion waits                          |
| ACK     | `ManagedCluster`    | create/read/update/upgrade/delete, desired cluster settings and upgrade/deletion policies, deterministic naming, ownership tags, tag drift, deletion protection, retained-resource delete options, readiness waits |
| ACK     | `NodePool`          | create/read/update/delete, desired pool settings, in-place scaling/image changes, scaling-group ownership tags, stable name lookup, readiness waits                                                                       |
| ACK     | `Addon`             | install/read/configure/upgrade/uninstall, version and config drift, cleanup options                                                                                                                          |
| ACR     | `InstanceReference` | read/retain an existing paid Enterprise registry instance; excluded from nuke because the ACR API exposes no purchase/delete lifecycle                                                                       |
| ACR     | `Namespace`         | create/read/update/delete, auto-create and default repository configuration                                                                                                                                  |
| ACR     | `Repository`        | create/read/update/delete, visibility, metadata, and immutable-tag settings                                                                                                                                  |
| ACR     | `EndpointAclEntry`  | create/read/update/delete Internet registry or chart ACL entries                                                                                                                                             |
| ACR     | `VpcEndpointLink`   | create/read/delete Registry or Chart VPC/vSwitch links, optional PrivateZone record, readiness waits                                                                                                         |
| Tair    | `Instance`          | create/read/resize/delete, desired instance settings and deletion options, redacted default-account password rotation, SSL, VPC authentication mode, release protection, ownership tags, tag drift, readiness waits  |
| Tair    | `Account`           | create/read/update/delete, redacted password rotation, description, type and privilege creation settings                                                                                                     |
| Tair    | `SecurityIpGroup`   | read/cover/delete named whitelist entries and attributes                                                                                                                                                     |
| RDS     | `Instance`          | create/read/resize/delete, desired inputs, supported resize fields, backup/parameters/maintenance, restore to a new instance, private normal endpoint/IP discovery, SSL and certificate controls, deletion protection, ownership tags, tag drift, readiness waits       |
| RDS     | `Database`          | create/read/update/delete, charset, description, and full create request extras                                                                                                                              |
| RDS     | `Account`           | create/read/update/delete, redacted password rotation, account type, policy and description                                                                                                                  |
| RDS     | `AccountPrivilege`  | observe/grant/change privileges; PostgreSQL revoke unsupported (see LIVE-VALIDATION.md)                                                                                                                                                          |
| RDS     | `SecurityIpGroup`   | read/cover/reset named IP arrays, enhanced whitelist settings                                                                                                                                                |

The generated Alibaba SDK models are converted to plain structural input types
by `ModelInput<T>`. Callers do not instantiate Darabonba model classes.
Desired ACK/RDS inputs route internally to create or update operations, with
no public request-phase bags or compatibility aliases. Supported RDS resize fields are
explicitly narrowed to settings with reconciliation support. Because generated model
properties remain optional even when Alibaba documents them as required, the
provider resource types additionally encode unconditional required inputs.
See [SPEC-COVERAGE.md](./SPEC-COVERAGE.md) and
[SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md) for the exact SDK authority,
implemented lifecycle, protocol tests, and connected merge bar.

## Credentials and endpoints

`providersFromEnvironment()` uses the official Alibaba credential provider
chain. The provider itself reads only configuration through Effect:

- `ALIBABA_CLOUD_REGION` is required;
- `ALIBABA_CLOUD_ECS_ENDPOINT`, `ALIBABA_CLOUD_VPC_ENDPOINT`, `ALIBABA_CLOUD_ACK_ENDPOINT`,
  `ALIBABA_CLOUD_ACR_ENDPOINT`, `ALIBABA_CLOUD_TAIR_ENDPOINT`, and
  `ALIBABA_CLOUD_RDS_ENDPOINT`, and `ALIBABA_CLOUD_RAM_ENDPOINT` are optional;
- access keys, STS, OIDC/RAM roles, ECS roles, CLI profiles, and URI credentials
  remain the responsibility of `@alicloud/credentials`.

The configured region is also the default `regionId` for VPC, ACK, RDS, and
Tair create requests. ACK, RDS, and Tair reject an explicit or persisted region
that differs from the configured provider region before making API calls.
Use a separate `AlibabaClients` layer for each region.

For tests or explicit composition, use `providers(clientOptions)` or provide an
`AlibabaClients` layer to `resourceProviders()`. Credentials are never included
in resource attributes or error serialization.

```ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Alibaba from "alchemy-alibaba";

export default Alchemy.Stack(
  "Example",
  {
    providers: Alibaba.providersFromEnvironment(),
    state: Alchemy.inMemoryState(),
  },
  Effect.gen(function* () {
    const registry = yield* Alibaba.ACR.InstanceReference("registry", {
      instanceId: "cri-existing-enterprise-instance",
    });

    const namespace = yield* Alibaba.ACR.Namespace("namespace", {
      instanceId: registry.instanceId,
      name: "example",
      settings: { autoCreateRepo: false, defaultRepoType: "PRIVATE" },
    });

    return { registry, namespace };
  }),
);
```

Secrets accepted by Tair and RDS account resources, ACK bootstrap credentials
and user data (including nested fields), Kubernetes Secrets, and private SSL key
material use `Redacted.Redacted<string>`. Create them with
`Redacted.make(value)` instead of passing plain strings.

## Adoption and deletion semantics

ECS instances/security groups, VPC networks/vSwitches, ACK clusters/node pools,
and Tair/RDS instances carry
`alchemy::stack`, `alchemy::stage`, and `alchemy::id` ownership tags. A matching
physical resource without those tags is reported as unowned, so Alchemy's
normal `adopt` policy decides whether takeover is allowed.

ACK addons, ACR namespaces/repositories, Tair/RDS accounts, databases,
privileges, ECS ingress rules, and whitelist groups do not expose safe ownership metadata. They
are silently adoptable by their compound cloud identity, matching Alchemy's
policy for APIs without ownership primitives.

ACR Enterprise instances are retained references. RDS requires every IP array
to retain at least one address, so destroying an `RDS.SecurityIpGroup` resets it
to `127.0.0.1` by default; set `resetTo` when another safe baseline is needed.

An ordinary `destroy` is planned from persisted state, so losing a resource's
state row leaves nothing for that destroy to tear down. Tagged resources with account-wide inventory
implement `list` as documented in SUPPORT-MATRIX.md — the one observation path that needs no state, and
so the only way to find an orphan whose state row is gone.

Account-wide `list` enumerates all resources of a type in the configured region,
including resources outside the current stack. Do not use `alchemy unsafe nuke`
as a stack-scoped cleanup command. Recover orphaned resources only with verified
ownership tags and an independently reviewed inventory.

## Verification

The suite runs every real provider lifecycle through stateful subclasses of the
pinned official Alibaba SDK clients, plus a loopback protocol simulator that
drives those same clients over HTTP. Protocol tests fail if a request leaves
loopback. Stack tests persist Alchemy state in a temporary directory.

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:security
```

The [live validation runbook](LIVE-VALIDATION.md) specifies the disposable-stage
acceptance checks and cleanup evidence. No connected apply/delete test is part of the repository gate. Such a test must
use an explicitly approved non-production stage and namespaced synthetic
fixtures. The advertised resource matrix is in
[SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md).


## Install and runtime requirements

The prepared npm release is `0.2.0`. Once it is published to `latest`,
install the exact version below. Set the root overrides in the next section
**before installing**, then commit the application's lockfile.

```sh
pnpm add --save-exact alchemy-alibaba@0.2.0 alchemy@2.0.0-beta.76 effect@4.0.0-rc.112
```

Until publication, install the locally prepared tarball or pin a reviewed full
GitHub commit. The existing `v0.1.0` Git tag predates these fixes and peer pins.
The `latest` channel may advance; the exact version above makes adoption explicit.

Development and CI use Node 22.22.1 and pnpm. The `packageManager` field selects
pnpm 11.25.0, matching upstream Alchemy; release scripts do not require an exact
pnpm patch version. Node 22.12.0 or newer is required by the Alchemy browser tooling.

Alchemy 2.0.0-beta.76 replaces the vulnerable browser extraction and image
libraries. The remaining upstream pins need these overrides in the **consumer
application's root** `pnpm-workspace.yaml`, as well as this repository's root:

```yaml
overrides:
  lodash: "4.18.1"
  hono: "4.13.7"
  "@hono/node-server": "1.19.17"
  valibot: "1.4.2"

allowBuilds:
  "@alicloud/openapi-core": false # Its hook only handles Node 10/12.
  esbuild: true
  msgpackr-extract: true
  sharp: true
  workerd: true
```

Merge these build-script settings with any existing application settings.
For npm consumers, the same overrides mapping belongs in the root `package.json` under
`overrides`. Consumers can use either package manager.

Overrides in a library are not inherited by consumers. Set them before
installing, commit the application's lockfile, and run `pnpm audit` there too.
The repository's locked graph reports zero advisories at validation time;
that result does not cover arbitrary consumer dependency combinations.

Alchemy and Effect are exact peer dependencies because both APIs are prerelease.
The package ships compiled ESM and declarations; Git installs build them with
`prepare` using pnpm.
Node 22 is the supported development runtime. Consumers choose their own state
backend and credentials. In-memory state above is illustrative only: use a
persistent, appropriately protected backend for resources you intend to manage.
`Redacted` prevents accidental display; it does not encrypt persisted state.

`ALIBABA_CLOUD_PROFILE` optionally selects an Alibaba CLI profile. No account,
region, endpoint, state backend or deployment approval policy is embedded in
the provider. Applications supply all environment-specific configuration.
See [examples/rds.alchemy.ts](examples/rds.alchemy.ts) for a configurable RDS stack.

## Validation limits

Local lifecycle and protocol tests do not establish every live cloud behavior.
The disposable PostgreSQL/VPC/vSwitch run passed provisioning, updates, TLS SQL,
and final active-resource cleanup, with manual intervention for unsupported
PostgreSQL ownership revocation. `AccountPrivilege` is not a fully reversible
PostgreSQL permission manager. RDS permanent recycle-bin removal remains unverified.

ACK/ACR lack complete live lifecycle validation; Tair evidence remains partial.
Review the [support matrix](SUPPORT-MATRIX.md) and [live evidence](LIVE-VALIDATION.md)
for the intended configuration before production adoption. Installation performs
no cloud deployment.

## Disposable ECS environments

See [ECS.md](ECS.md) for the supported VM lifecycle, networking, disk retention,
and [the private RDS/Tair access example](examples/ecs.alchemy.ts). ECS has local
SDK protocol coverage and disposable live SSH, resize, disk-retention and
cleanup evidence; private database connectivity remains unverified. Custom
`AlibabaClientSet` implementations need both `ecs` and `ram` SDK clients.
See [COMPOSITION.md](COMPOSITION.md) for Kubernetes, explicit networking, RRSA, images
and database operation settings. No automatic 0.1.0 state migration is provided.
