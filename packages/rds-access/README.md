# alibaba-rds-access

Manage a developer laptop's Alibaba Cloud RDS IP allowlist from the terminal.
Run `rds-access refresh` before migrations, database tooling, or debugging;
run `rds-access revoke` when finished. Refresh replaces your previous IP when
you change networks.

This is an independently versioned workspace package in the `alchemy-alibaba`
repository. It uses the official Alibaba RDS and credentials SDKs with Effect;
it has no dependency on Alchemy, Cloudflare, or an application's migration tool.
Version `0.1.0` is a local candidate and has not been published by this change.

## Use from this checkout

Use Node 22.12+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm --filter alibaba-rds-access build
node packages/rds-access/dist/bin.js --help
```

To try it in another project before publication, pack this subpackage and install
the resulting tarball as a development dependency. From the repository root:

```sh
pnpm --filter alibaba-rds-access pack --pack-destination ../../artifacts/rds-access
```

Then, from your application checkout, substitute the actual tarball path:

```sh
pnpm add -D /path/to/alchemy-alibaba/artifacts/rds-access/alibaba-rds-access-0.1.0.tgz
pnpm exec rds-access --help
```

With pnpm 11, merge these build settings into the application's
`pnpm-workspace.yaml` if it does not already configure them:

```yaml
allowBuilds:
  "@alicloud/openapi-core": false
  "msgpackr-extract": false
```

The SDK's script only selects legacy Node 10/12 dependencies. The optional
MessagePack native extension can use its JavaScript fallback. Both can be
disabled for this CLI; keep an application's existing approval if it already
uses the native extension.

## Configure once per developer and project

Use an existing named `aliyun configure` profile. Export these values in your
shell or load them through your project's existing environment loader:

```sh
export ALIBABA_CLOUD_PROFILE=development
export ALIBABA_CLOUD_REGION=ap-southeast-5
export RDS_ACCESS_INSTANCE_ID=pgm-yourinstance
export RDS_ACCESS_DEVELOPER=alice@example.com
```

The CLI also accepts `--profile`, `--region`, `--instance`, and `--developer`.
Flags take precedence over environment variables. Without a named profile, the
official SDK credential chain is used. No keys or SQL passwords are written to
project files. The CLI does not automatically load `.env` files; Node's
`--env-file` or your existing environment loader can do that.

Use a stable, unique personal ID. Case is ignored. Two laptops sharing the same
ID share one entry; use distinct IDs such as `alice+laptop@example.com` when
both need access simultaneously. Keep each ID consistent across refresh/revoke.

## Daily workflow

Once installed in the application:

```sh
pnpm exec rds-access plan
pnpm exec rds-access refresh
pnpm db:migrate
pnpm exec rds-access revoke
```

Replace `pnpm db:migrate` with that application's migration command. To make
refresh automatic, use a project script such as:

```json
{
  "scripts": {
    "db:access": "rds-access refresh",
    "db:revoke": "rds-access revoke",
    "db:migrate:remote": "rds-access refresh && pnpm db:migrate"
  }
}
```

`refresh` queries [ipify's IPv4 API](https://www.ipify.org/) over HTTPS and stores
one host address, equivalent to `/32`. Explicit IPs skip detection:

```sh
pnpm exec rds-access refresh --ip 203.0.113.10
pnpm exec rds-access plan --revoke
pnpm exec rds-access plan --json
```

If a VPN, proxy, split route, or SSH tunnel makes database traffic use a different
source address, supply that address with `--ip`. Private IPv4 hosts are supported;
subnets, lists, IPv6, loopback, and allow-all addresses are rejected.

The DB must already have an endpoint reachable from the laptop: an existing
public endpoint, or a private route such as a VPN. This helper changes only an
IP allowlist. It does not allocate endpoints, configure TLS, create accounts,
or run migrations. Continue to use the application's migration credentials and
TLS configuration. RDS control-plane confirmation does not prove that a SQL
connection works; network propagation can take additional time.

## How entries are managed

Each developer gets a deterministic `dev_<hash>_<network>` group, exactly
32 characters long. The hash retains 96 bits of the case-insensitive developer
identity; network suffixes are `mix`, `vpc`, and `cls` (Classic).
Only that group is changed. Application/VPC/Hyperdrive groups and other
developers' groups remain intact. Reserve the `dev_` namespace for this helper
and do not manage its groups in your IaC stack.

Refresh overwrites the developer group's previous address and waits for RDS to
report the new entry. Repeating it with the same IP makes no write. Concurrent
refreshes of the same developer ID have last-writer-wins semantics; different
developer IDs use different groups.

RDS requires at least one entry per group. Revoke replaces its address with
`127.0.0.1`; it does not create a group if one is absent. Other allowlists can
still grant access to that IP. Revocation does not promise to terminate existing
database sessions. Entries do not expire automatically: revoke explicitly when
finished. Empty/retired developer groups still count toward RDS's group limit.
See Alibaba's [ModifySecurityIps reference](https://www.alibabacloud.com/help/en/rds/developer-reference/api-rds-2014-08-15-modifysecurityips).

The default whitelist network type is `MIX`. This is required for PostgreSQL
on cloud disks. For an instance using enhanced whitelists, select
`--network-type VPC` or `--network-type Classic` consistently for all commands.
The helper refuses to overwrite a hidden group, a mismatched network type,
or duplicate group identities. It verifies network membership using a filtered
RDS query, including when confirming updates.

Writes are sent once. If a request times out, use `plan` to inspect the result
before retrying; Alibaba may have accepted the request despite the timeout.
No live cloud operations are part of this package's automated tests.

## Profile permissions

An administrator grants these actions to each developer's RAM user/role,
scoped to the intended instance(s). This is a one-time setup:

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "rds:DescribeDBInstanceAttribute",
      "rds:DescribeDBInstanceIPArrayList",
      "rds:ModifySecurityIps"
    ],
    "Resource": "acs:rds:ap-southeast-5:<ACCOUNT_ID>:dbinstance/<INSTANCE_ID>"
  }]
}
```

`plan` needs only the two read actions. Credentials that assume a role also
need the corresponding role trust/assumption setup. Database SQL permissions
are separate.

Alibaba authorizes these APIs at the instance level, so the RAM grant permits
whitelist changes anywhere on that instance. The CLI's per-developer naming
is an operational convention, not a RAM permission boundary. See the
[RDS authorization reference](https://www.alibabacloud.com/help/zh/doc-detail/2631988.html)
and [instance-read authorization](https://help.aliyun.com/en/rds/developer-reference/api-rds-2014-08-15-describedbinstanceattribute).

## Effect API

```ts
import { Effect } from "effect";
import { refreshAccess, rdsApiLayer } from "alibaba-rds-access";

const target = {
  instanceId: "pgm-yourinstance",
  regionId: "ap-southeast-5",
  developer: "alice@example.com",
  networkType: "MIX" as const,
};

await Effect.runPromise(
  refreshAccess(target, "203.0.113.10").pipe(
    Effect.provide(rdsApiLayer({ regionId: target.regionId, profile: "development" })),
  ),
);
```

`planAccess(target, ip)` previews refresh; `planAccess(target)` previews revoke.
`revokeAccess(target)` revokes. `detectIPv4(url)` uses an injected Effect
`HttpClient`, allowing callers to choose their own IP detection service.

## Package maintenance

From the repository root:

```sh
pnpm --filter alibaba-rds-access check
pnpm --filter alibaba-rds-access check:package
```

`check:package` builds and packs the helper, installs its tarball in a temporary
consumer, and checks the executable, exports, TypeScript API and absence of an
Alchemy dependency. It saves the verified tarball under `artifacts/rds-access`.

The root `pnpm check` also checks this subpackage. Its version, npm artifact,
and release are independent of `alchemy-alibaba`; the root provider's
`release:publish` command publishes only the provider.

Publish this subpackage from a clean, committed checkout with one command:

```sh
pnpm --filter alibaba-rds-access publish:package
```

Log in first with `pnpm login --registry=https://registry.npmjs.org/`; the
command's login/2FA prompts use your terminal. It runs the full source checks
and package verification, requires a clean checkout, verifies the tarball's
SHA-256 and npm integrity against `artifacts/rds-access/verification.json`,
publishes that exact tarball publicly to `latest`, and confirms the published
integrity and tag. It stops on failure and never retries publication
automatically. To exercise everything except publication and the npm login:

```sh
pnpm --filter alibaba-rds-access publish:package --dry-run
```

Establish npm name ownership before the first publication of a reviewed
artifact. Packing and testing do not publish or modify RDS.
