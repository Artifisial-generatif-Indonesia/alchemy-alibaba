# Standalone ECS environments

`ECS.Instance`, `ECS.SecurityGroup`, and `ECS.SecurityGroupIngress` provide a
small pay-as-you-go VM lifecycle for development and staging. Kubernetes is
not required. SDK: `@alicloud/ecs20140526` 7.11.2. Import from `alchemy-alibaba/ecs`
or use `Alibaba.ECS` from the root package.

## Instance contract

One resource creates exactly one `PostPaid` VPC instance through `RunInstances`.
It waits for Running and a private IPv4 address; that is infrastructure readiness,
not proof that cloud-init, Docker, SQL connections, or the application succeeded.
Use application health checks and retry database connections during boot: the
instance IP must exist before the dependent RDS/Tair allowlists can be created.

Required inputs are image ID, instance type, vSwitch ID, and security group IDs.
Image availability and architecture must match the selected region and SKU.
The system disk defaults to 40 GiB ESSD. Select an image-supported disk size.
Key-pair names refer to existing regional SSH keys; the provider never creates
or returns a private key. RAM role names refer to existing instance roles.

`userData` is a redacted UTF-8 cloud-init document or script. The provider
Base64-encodes it for the API. Do not supply already-encoded content. Redaction
prevents accidental display, not persistence: keep state private and avoid
embedding long-lived application credentials in bootstrap data.

Changes to image, VM size, vSwitch, security-group membership, system-disk
settings, key pair, RAM role, public bandwidth, name, or user data replace the
instance. Replacement deletes the old VM and its system disk before creating
the new one; keep anything that must persist in external storage. This version does not resize a running VM or rerun cloud-init in place.
Description, tags, deletion protection, and auto-release schedule update in place.
A stopped VM is restarted on reapply. A Running status does not establish
application health, and this is not a continuously running recovery controller.

`autoReleaseTime` is an absolute UTC time supported by ECS. Set an empty string
to cancel it; omission leaves an existing schedule unmanaged. Automatic expiry
only releases the VM, not the full Alchemy stage: run saved-state destroy to
remove its security group and database allowlists. After expiry, a deploy may
create a new VM; choose a new future expiry before doing so.

## Networking and database access

Use the same VPC for the ECS VM and the non-production RDS/Tair instances. They
may use different vSwitches. `privateIp` is suitable for a dedicated `/32`
allowlist. Compose it as an Alchemy output, not a JavaScript string coercion:

```ts
import * as Output from "alchemy/Output";

const access = yield* Alibaba.RDS.SecurityIpGroup("dev-access", {
  instanceId: database.instanceId,
  name: "unique_dev_stage",
  securityIps: [Output.interpolate`${vm.privateIp}/32`],
});
```

Tair uses the same pattern with `Tair.SecurityIpGroup`. Give each developer/stage
its own group name. These references order ordinary teardown so access cleanup
precedes VM deletion. RDS resets the group to loopback; Tair removes the named
non-default group. Neither operation deletes the referenced database instance.
Database users, credentials, TLS, and application connection strings are separate
from network access. An IP allowlist is not authentication.

`internetMaxBandwidthOut` defaults to zero, creating no public IP. Setting a
positive bandwidth limit requests an instance-bound public IPv4 address with
pay-by-traffic billing. Security-group ingress rules still determine access.
A private-only VM needs an existing private management path; Internet downloads
need existing outbound networking or an explicit public bandwidth setting.

Security groups are normal VPC groups with Alibaba's default policies. The
provider does not claim deny-all egress or isolation among members of the same
group. `SecurityGroupIngress` manages one IPv4 inbound allow rule with protocol,
port range, CIDR and priority. Other rules remain unmanaged. It adopts identical
rules by their compound identity and deletes the observed rule ID. Do not share
ownership of the same rule between stacks. External edits to a saved rule fail
explicitly; restore or remove it before reapplying to avoid leaving unintended
access. This version has no custom egress, IPv6 or source-group rule resource.

## Teardown and retention

Deletion refuses protected or subscription instances. Disable protection through
a reviewed deployment first. It waits through transitional states, requests a
graceful stop, then deletes without forced shutdown and waits for instance absence.
A stuck shutdown fails within the wait budget; state is retained for recovery.
The instance-created system disk and instance-bound public IP follow ECS release
semantics. This provider does not create independent EIPs, extra data disks,
ENIs, snapshots, or backup policies, and does not delete externally attached
resources. Inventory those separately if someone adds them to a managed VM.
Never interpret instance absence as proof that every account-side charge stopped.

Persist state outside an ephemeral worktree. The tagged resources support regional
inventory for review; account-wide `unsafe nuke` remains unsupported. Resource
ownership and VPC dependencies follow the existing provider conventions.

## Example and validation

[examples/ecs.alchemy.ts](examples/ecs.alchemy.ts) uses a persistent local state,
a unique `dev-ecs-*` stage, existing VPC/vSwitch, existing non-production RDS/Tair,
a regional SSH key, and a caller-selected cloud-init script. It creates a VM,
security group, SSH rule, and per-stage database IP groups. Run plan/deploy/destroy
from the same private directory. Shared network and database lifecycles remain
outside that stage. Review the exact plan, pricing, runner CIDR and expiry first.

Local tests exercise the pinned SDK against loopback HTTP, including saved-state
create/update/destroy, tokens, failure recovery, private allowlist dependencies,
protection, and rule pagination. No ECS live test has been run. The connected
acceptance run must additionally verify cloud-init/app readiness, real TLS SQL
and Tair connections, old-IP access removal after replacement, automatic expiry,
and independent disk/public-IP/security-group cleanup and billing.

References: [RunInstances](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-runinstances),
[DeleteInstance](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-deleteinstance),
[AuthorizeSecurityGroup](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-authorizesecuritygroup).
