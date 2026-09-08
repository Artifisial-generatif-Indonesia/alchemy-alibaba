# Alibaba provider specification and validation matrix

This document separates what can be established from public Alibaba artifacts
from behavior that must be proved against a disposable Alibaba Cloud stage.
It is the merge checklist for the custom Alchemy providers. The per-resource
implementation and verification status lives in
[SUPPORT-MATRIX.md](./SUPPORT-MATRIX.md).

## Public specification authority

The provider is compiled against Alibaba's generated TypeScript SDKs. Their
checked-in source contains the request and response models, required-field
annotations, wire names, endpoint operations, and documented status values:

- [Alibaba Cloud TypeScript SDK monorepo](https://github.com/aliyun/alibabacloud-typescript-sdk)
- [VPC `vpc-20160428`](https://github.com/aliyun/alibabacloud-typescript-sdk/tree/master/vpc-20160428)
- [ACK `cs-20151215`](https://github.com/aliyun/alibabacloud-typescript-sdk/tree/master/cs-20151215)
- [Alibaba Cloud TypeScript SDK samples](https://github.com/aliyun/alibabacloud-typescript-sdk-samples)
- [Darabonba OpenAPI runtime contract](https://github.com/aliyun/darabonba-openapi/blob/master/main.tea)
- [Darabonba OpenAPI utility contract](https://github.com/aliyun/darabonba-openapi/blob/master/utils.dara)

The exact versions pinned by this repository are:

| Service | Package | Version |
| --- | --- | --- |
| VPC | `@alicloud/vpc20160428` | `7.2.5` |
| ACK | `@alicloud/cs20151215` | `7.2.0` |
| ACR | `@alicloud/cr20181201` | `2.2.3` |
| RDS | `@alicloud/rds20140815` | `15.9.0` |
| Tair | `@alicloud/r-kvstore20150101` | `6.4.0` |

Generated properties are optional even when their documentation says
"required." The provider therefore encodes unconditional required inputs in
its own resource types and supplies the configured provider region when the
request omits `regionId`. Conditional product rules remain available through
the full generated request surface and must be validated by Alibaba.

## Lifecycle coverage

"Stateful" means the real provider implementation is exercised through its
Alchemy `read`, `diff`, `reconcile`, or `delete` entry points against a
stateful subclass of the pinned official SDK client. "Protocol" means the
same providers (or the SDK they wrap) run against a loopback HTTP simulator
using real request serialization. "Stack" means Alchemy deploy/destroy with
temporary persisted state. These tests assert idempotence and observed
convergence without credentials or cloud spend.

| Resource | Public operations encoded | Ownership | Stateful lifecycle | Connected lifecycle |
| --- | --- | --- | --- | --- |
| `VPC.Network` | create, describe/list, modify, tag/untag, delete | Alchemy tags | create/update/read/delete | Required |
| `VPC.VSwitch` | create, describe/list, modify, tag/untag, delete | Alchemy tags | create/update/read/delete | Required |
| `ACK.ManagedCluster` | create, describe/list, modify, upgrade, tag/untag, delete | Alchemy tags | create/update/upgrade/read/delete | Required |
| `ACK.NodePool` | create, describe/list, modify, delete | scaling-group Alchemy tags | create/update/delete | Required |
| `ACK.Addon` | install, describe, modify, upgrade, uninstall | compound identity | install/upgrade/configure/uninstall | Required |
| `ACR.InstanceReference` | get instance | retained reference | read/no-op delete | Read-only smoke required |
| `ACR.Namespace` | create, get, update, delete | compound identity | create/update/delete | Required |
| `ACR.Repository` | create, get, update, delete | compound identity | create/update/delete | Required |
| `ACR.EndpointAclEntry` | get endpoint, create/delete ACL policy | compound identity | create/comment replacement/delete | Required |
| `ACR.VpcEndpointLink` | get endpoint, create/delete linked VPC | compound identity | create/read/delete | Required |
| `RDS.Instance` | create, describe/list, describe network endpoints, resize, describe/modify SSL, protect, tag/untag, delete | Alchemy tags | create/read private endpoint/resize/SSL/protect/tag/delete | Required |
| `RDS.Database` | create, describe, modify description, delete | compound identity | create/update/delete | Required |
| `RDS.Account` | create, describe, modify description, reset password, delete | compound identity | create/update/rotate/delete | Required |
| `RDS.AccountPrivilege` | describe, grant/change, revoke | compound identity | grant/change/revoke | Required |
| `RDS.SecurityIpGroup` | describe, cover/reset | compound identity | create/update/reset | Required |
| `Tair.Instance` | create, describe/list/overview, resize, rotate the built-in account login value, describe/modify SSL, modify VPC login mode, protect, tag/untag, delete, recycle-bin destroy | Alchemy tags | create/rotate/resize/SSL/VPC-mode/protect/tag/delete/destroy; protocol+stack | Required |
| `Tair.Account` | create, describe, modify description, reset password, delete | compound identity | create/update/rotate/delete | Required |
| `Tair.SecurityIpGroup` | describe, cover/delete | compound identity | create/update/delete | Required |

## Shared lifecycle guarantees

- Safe reads and mutations use typed Alibaba errors. Error serialization keeps
  request objects and credentials out of state and logs. Arbitrary SDK and task
  messages are discarded because they can echo secrets; service, operation,
  validated error code, HTTP status, and request ID remain available.
- Safe retries are bounded, exponentially backed off, jittered, and honor the
  Darabonba `retryAfter` millisecond value. The whole safe-retry sequence has a
  60-second wall-clock budget so slow DNS resolution cannot bypass the SDK's
  socket timeouts. Idempotent ACR deletes use the same retry policy.
- Every generated SDK client has explicit 5-second connect and 10-second read
  timeouts; RDS uses its documented 20-second create-safe read timeout.
  Connection, DNS, and read timeouts are transient for bounded safe retries;
  tokenized VPC, vSwitch, and RDS creates derive their default client
  token from Alchemy's persisted physical instance ID. Retries within one
  generation reuse the token, while a fresh generation after teardown receives
  a new token and cannot resolve to a deleted generation's cached create result.
- VSwitch creation is serialized per VPC through readiness because Alibaba
  rejects simultaneous `CreateVSwitch` operations. Documented task conflicts
  remain retryable for contention with callers outside the provider process.
- An ambiguous RDS create response is recovered by bounded observation of the
  deterministic instance name. RDS deletion waits for the control plane to
  accept release, and vSwitch deletion allows up to ten minutes for a managed
  service ENI to drain; managed ENIs are never force-deleted by this provider.
- ACR's application-level `IsSuccess` envelope is validated even when the HTTP
  response is 200.
- Tair create uses `Token` derived from the Alchemy resource instance ID.
  `CanNotAcquireLock` is recovered by name observation, not by retrying
  create as a generic transient. Tair delete releases the instance, observes
  `DescribeInstancesOverview` for `Released`, then calls `DestroyInstance`
  and waits for permanent absence before vSwitch deletion.
- Creates that do not expose a provider idempotency token are not blindly
  retried. Reconciliation first observes the stable cloud identity.
- Create, update, and delete paths poll boundedly for their modeled readiness
  and convergence fields. SDK input availability does not imply that every
  optional field has an observable drift check. A timeout is a typed failure,
  not a claimed success.
- ACK operations that return a `task_id` also poll `DescribeTaskInfo`; a
  control-plane task failure surfaces its code and a generic message immediately
  instead of degrading into a generic resource-readiness timeout.
- Known identity defaults are normalized before replacement decisions: RDS
  account type `Normal`, Tair account privilege `RoleReadWrite`, and default
  RDS/Tair whitelist group names. Other optional SDK defaults are not inferred.
- A discovered compound-identity resource with incompatible immutable settings
  fails explicitly instead of being silently reported as reconciled.
- Passwords and private SSL material use `Redacted.Redacted<string>` and never
  appear in resource outputs.

## What public specs cannot prove

The generated models do not establish real control-plane timing, undocumented
status transitions, regional feature availability, billing constraints,
eventual-consistency windows, or whether every nominal update is truly
in-place for the selected product edition. Those are behavioral facts, not
request-shape facts.

Before production adoption, validate create, no-op reapply, supported updates,
and complete deletion in an explicitly approved isolated stage. Independently
verify that no disposable resources remain. Local tests do not establish
regional availability or full live lifecycle correctness.

## Reliability audit fixes

The local regression suite in `src/reliability.test.ts` and the compile-time
checks in `src/internal/model-input.test.ts` cover the audited failures:

- RDS purchases are restricted to one instance. Invalid batch requests fail
  before SDK calls; historical batch state also blocks deletion until its
  complete inventory is reconciled separately.
- Absence classification uses explicit resource-not-found codes per service.
  Generic HTTP 404s, credential errors, and missing-parameter errors propagate
  instead of reporting successful cleanup.
- RDS, VPC, and vSwitch name recovery is region-scoped and paginated. ACK,
  RDS, and Tair reject conflicting request or persisted regions.
- RDS observes serverless capacity and auto-pause, waits for resize convergence
  before SSL changes, and applies certificate and redacted key/password
  rotations. Secret inputs without SSL settings fail explicitly.
- New generated RDS/Tair account names use letters and digits. RDS names fit
  the conservative 16-character engine limit. Explicit and persisted names
  remain authoritative and are never silently renamed.
- SDK model index signatures are removed from request inputs while genuine
  dictionaries remain typed. Excluded raw secret fields cannot bypass the
  public input types through the SDK's inherited `any` index signature.
- RDS protection setters omit optional replay tokens. Tair resizes use a fresh
  token per reconciliation operation and reuse it for retries of that operation,
  so returning to a previous size does not replay an old purchase response.
  Explicit caller tokens remain caller-managed. Tokens are not persisted
  across a process restart; recovery observes current readiness/spec first.
- A pending vSwitch is no longer mistaken for an accepted deletion.
- ACR namespace configuration compares requested data fields without SDK
  prototypes. Omitted configuration fields remain unmanaged.
- ACK cluster and node-pool drift checks compare requested fields represented
  in their SDK read models, including cluster spec and node image. Fields not
  exposed by those read models cannot be continuously verified. Addon JSON
  configuration ignores object-key order and whitespace; omitted config is
  unmanaged.

Dependency remediation pins Alchemy `2.0.0-beta.76` while keeping Effect
`4.0.0-rc.112`. Alchemy supplies the patched browser and image dependencies;
root overrides pin Lodash `4.18.1`, Hono `4.13.7`, `@hono/node-server` `1.19.17`,
and Valibot `1.4.2`. The locked graph reports zero npm advisories at validation
time. CI checks advisories at moderate severity or above. Consumers must add
the overrides in their own root manifest; library overrides are not inherited.

RDS recycle-bin destruction remains intentionally unmodeled. The official
[DestroyDBInstance operation documentation](https://www.alibabacloud.com/help/en/rds/developer-reference/api-rds-2014-08-15-destroydbinstance)
marks it as phased out, although the API overview still lists it. The pinned
SDK repeats that warning. Adding it to teardown would change retention
semantics without a dependable observation contract for permanent absence.
The existing `DeleteDBInstance` release behavior and caller-selected backup
retention settings remain unchanged. A released instance disappearing from
normal reads does not prove its recycle-bin data or backups are gone.

The [live validation runbook](./LIVE-VALIDATION.md) records the remaining
approval inputs and acceptance checks. No connected cloud operations were run
for this audit remediation.
