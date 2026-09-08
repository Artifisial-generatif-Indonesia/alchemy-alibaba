import type { ProtocolResponse, RpcParams } from "./world.ts";

const ok = (body: Record<string, unknown> = {}): ProtocolResponse => ({
  statusCode: 200,
  body: { RequestId: "protocol-child-request", ...body },
});
const missing = (code: string): ProtocolResponse => ({
  statusCode: 400,
  body: { Code: code, Message: code, RequestId: "protocol-child-request" },
});
interface Account {
  AccountName: string;
  AccountStatus: string;
  AccountType: string;
  AccountDescription?: string;
  AccountPrivilege?: string;
}
interface Database {
  DBName: string;
  DBStatus: string;
  CharacterSetName?: string;
  DBDescription?: string;
}
interface IpGroup {
  name: string;
  ips: string;
  attribute?: string;
}

/** Wire-shaped response fixtures. Passwords are never retained in simulator state. */
export class RpcResources {
  readonly accounts = new Map<string, Account>();
  readonly databases = new Map<string, Database>();
  readonly privileges = new Map<string, string>();
  readonly groups = new Map<string, IpGroup>();
  readonly namespaces = new Map<string, Record<string, unknown>>();
  readonly repositories = new Map<string, Record<string, unknown>>();
  readonly acls = new Map<string, { Entry: string; Comment?: string }>();
  passwordResets = 0;
  // Simulates an HTTP-200 ACR failure envelope, independently of transport errors.
  acrFailure?: { action: string; code: string };

  constructor(readonly engine: (id: string) => string | undefined) {}

  dispatch(
    action: string,
    p: RpcParams,
    version?: string,
  ): ProtocolResponse | undefined {
    if (version === "2018-12-01") return this.acr(action, p);
    const rds = version === "2014-08-15";
    if (!rds && version !== "2015-01-01") return undefined;
    const id = p[rds ? "DBInstanceId" : "InstanceId"] ?? "";
    const prefix = `${version}/${id}/`;
    const name = p.AccountName ?? "";
    const key = prefix + name;
    const selected = [...this.accounts].filter(
      ([k, a]) => k.startsWith(prefix) && (!name || a.AccountName === name),
    );
    const dbKey = prefix + (p.DBName ?? "");
    const pg = rds && this.engine(id) === "PostgreSQL";
    switch (action) {
      case "DescribeAccounts": {
        const rows = selected.map(([, a]) => ({
          ...a,
          ...(rds
            ? {
                DatabasePrivileges: {
                  DatabasePrivilege: pg
                    ? []
                    : [...this.privileges]
                        .filter(([k]) =>
                          k.startsWith(`${prefix}${a.AccountName}/`),
                        )
                        .map(([k, v]) => ({
                          DBName: k.split("/").at(-1),
                          AccountPrivilege: v,
                        })),
                },
              }
            : {}),
        }));
        return ok({
          Accounts: rds ? { DBInstanceAccount: rows } : { Account: rows },
        });
      }
      case "CreateAccount":
        if (!id || !name || !(p.AccountPassword || p.Password))
          return missing("MissingParameter");
        if (this.accounts.has(key)) return missing("AccountAlreadyExists");
        this.accounts.set(key, {
          AccountName: name,
          AccountStatus: "Available",
          AccountType: p.AccountType ?? "Normal",
          AccountDescription: p.AccountDescription,
          AccountPrivilege: p.AccountPrivilege ?? "RoleReadWrite",
        });
        return ok();
      case "ModifyAccountDescription": {
        const account = this.accounts.get(key);
        if (!account) return missing("InvalidAccountName.NotFound");
        account.AccountDescription = p.AccountDescription;
        return ok();
      }
      case "ResetAccountPassword":
        if (!this.accounts.has(key) && (rds || name !== id))
          return missing("InvalidAccountName.NotFound");
        if (!(p.AccountPassword || p.Password))
          return missing("MissingParameter");
        this.passwordResets++;
        return ok();
      case "DeleteAccount":
        if ([...this.privileges.keys()].some((k) => k.startsWith(`${key}/`)))
          return missing("DependencyViolation");
        this.accounts.delete(key);
        return ok();
      case "CreateDatabase":
        if (!rds) return undefined;
        this.databases.set(dbKey, {
          DBName: p.DBName!,
          DBStatus: "Running",
          CharacterSetName: p.CharacterSetName,
          DBDescription: p.DBDescription,
        });
        return ok();
      case "DescribeDatabases":
        return ok({
          Databases: {
            Database: [...this.databases]
              .filter(
                ([k, d]) =>
                  k.startsWith(prefix) && (!p.DBName || d.DBName === p.DBName),
              )
              .map(([, d]) => ({
                ...d,
                Accounts: {
                  AccountPrivilegeInfo: [...this.privileges]
                    .filter(
                      ([k]) =>
                        k.startsWith(prefix) && k.endsWith(`/${d.DBName}`),
                    )
                    .map(([k, v]) => ({
                      Account: k.slice(prefix.length).split("/")[0],
                      AccountPrivilege: pg && v === "DBOwner" ? "ALL" : v,
                    })),
                },
              })),
          },
        });
      case "ModifyDBDescription": {
        const db = this.databases.get(dbKey);
        if (!db) return missing("InvalidDBName.NotFound");
        db.DBDescription = p.DBDescription;
        return ok();
      }
      case "DeleteDatabase":
        // Live PostgreSQL returned a timeout when deletion was repeated after absence.
        if (!this.databases.has(dbKey))
          return missing("InstanceConnectTimeoutFault");
        this.databases.delete(dbKey);
        for (const k of this.privileges.keys())
          if (k.startsWith(prefix) && k.endsWith(`/${p.DBName}`))
            this.privileges.delete(k);
        return ok();
      case "GrantAccountPrivilege":
        if (!this.accounts.has(key) || !this.databases.has(dbKey))
          return missing("InvalidDBName.NotFound");
        this.privileges.set(`${key}/${p.DBName}`, p.AccountPrivilege!);
        return ok();
      case "RevokeAccountPrivilege":
        // Live PostgreSQL accepted this unsupported operation without revoking ownership.
        if (!pg) this.privileges.delete(`${key}/${p.DBName}`);
        return ok();
      case "DescribeDBInstanceIPArrayList":
        return ok({
          Items: {
            DBInstanceIPArray: [...this.groups]
              .filter(([k]) => k.startsWith(prefix))
              .map(([, g]) => ({
                DBInstanceIPArrayName: g.name,
                SecurityIPList: g.ips,
                DBInstanceIPArrayAttribute: g.attribute,
              })),
          },
        });
      case "DescribeSecurityIps":
        return ok({
          SecurityIpGroups: {
            SecurityIpGroup: [...this.groups]
              .filter(([k]) => k.startsWith(prefix))
              .map(([, g]) => ({
                SecurityIpGroupName: g.name,
                SecurityIpList: g.ips,
                SecurityIpGroupAttribute: g.attribute,
              })),
          },
        });
      case "ModifySecurityIps": {
        const groupName =
          p[rds ? "DBInstanceIPArrayName" : "SecurityIpGroupName"] ?? "default";
        const groupKey = prefix + groupName;
        const old = this.groups.get(groupKey);
        let ips = p.SecurityIps ?? "";
        if (p.ModifyMode === "Delete")
          ips = (old?.ips ?? "")
            .split(",")
            .filter((ip) => !ips.split(",").includes(ip))
            .join(",");
        if (!rds && !ips && groupName !== "default")
          this.groups.delete(groupKey);
        else
          this.groups.set(groupKey, {
            name: groupName,
            ips,
            attribute:
              p[
                rds ? "DBInstanceIPArrayAttribute" : "SecurityIpGroupAttribute"
              ] ?? old?.attribute,
          });
        return ok();
      }
      default:
        return undefined;
    }
  }

  private acr(action: string, p: RpcParams): ProtocolResponse | undefined {
    if (this.acrFailure?.action === action) {
      const code = this.acrFailure.code;
      this.acrFailure = undefined;
      return ok({ IsSuccess: false, Code: code });
    }
    const success = (body: Record<string, unknown> = {}) =>
      ok({ IsSuccess: true, Code: "success", ...body });
    const absent = (code: string) => ok({ IsSuccess: false, Code: code });
    const ns = `${p.InstanceId}/${p.NamespaceName ?? p.RepoNamespaceName}`;
    const repoKey = `${ns}/${p.RepoName}`;
    switch (action) {
      case "GetNamespace":
        return this.namespaces.has(ns)
          ? success(this.namespaces.get(ns))
          : absent("NAMESPACE_NOT_EXIST");
      case "CreateNamespace":
      case "UpdateNamespace": {
        const old = this.namespaces.get(ns);
        this.namespaces.set(ns, {
          ...old,
          NamespaceId: old?.NamespaceId ?? `ns-${this.namespaces.size}`,
          NamespaceName: p.NamespaceName,
          NamespaceStatus: "NORMAL",
          AutoCreateRepo: p.AutoCreateRepo === "true",
          DefaultRepoType: p.DefaultRepoType,
          DefaultRepoConfiguration:
            p.DefaultRepoConfiguration === undefined
              ? old?.DefaultRepoConfiguration
              : JSON.parse(p.DefaultRepoConfiguration),
        });
        return success();
      }
      case "DeleteNamespace":
        if ([...this.repositories.keys()].some((k) => k.startsWith(`${ns}/`)))
          return absent("NAMESPACE_NOT_EMPTY");
        this.namespaces.delete(ns);
        return success();
      case "GetRepository":
        return this.repositories.has(repoKey)
          ? success(this.repositories.get(repoKey))
          : absent("REPO_NOT_EXIST");
      case "CreateRepository":
        if (!this.namespaces.has(ns)) return absent("NAMESPACE_NOT_EXIST");
        this.repositories.set(repoKey, {
          RepoId: `repo-${this.repositories.size}`,
          RepoName: p.RepoName,
          RepoNamespaceName: p.RepoNamespaceName,
          RepoStatus: "NORMAL",
          RepoType: p.RepoType,
          Summary: p.Summary,
          Detail: p.Detail,
          TagImmutability: p.TagImmutability === "true",
        });
        return success();
      case "UpdateRepository": {
        const entry = [...this.repositories].find(
          ([k, v]) => k.startsWith(`${p.InstanceId}/`) && v.RepoId === p.RepoId,
        );
        if (!entry) return absent("REPO_NOT_EXIST");
        Object.assign(entry[1], {
          RepoType: p.RepoType,
          Summary: p.Summary,
          Detail: p.Detail,
          TagImmutability: p.TagImmutability === "true",
        });
        return success();
      }
      case "DeleteRepository":
        for (const [k, v] of this.repositories)
          if (k.startsWith(`${p.InstanceId}/`) && v.RepoId === p.RepoId)
            this.repositories.delete(k);
        return success();
      case "GetInstanceEndpoint":
        return success({
          Enable: true,
          AclEnable: true,
          AclEntries: [...this.acls]
            .filter(([k]) =>
              k.startsWith(
                `${p.InstanceId}/${p.EndpointType}/${p.ModuleName}/`,
              ),
            )
            .map(([, v]) => v),
        });
      case "CreateInstanceEndpointAclPolicy":
      case "DeleteInstanceEndpointAclPolicy": {
        const entries = JSON.parse(p.Entries ?? "[]") as {
          Entry: string;
          Comment?: string;
        }[];
        if (entries.length !== 1 || !entries[0]?.Entry)
          return absent("InvalidEntries");
        const entry = entries[0];
        const key = `${p.InstanceId}/${p.EndpointType}/${p.ModuleName}/${entry.Entry}`;
        if (action === "CreateInstanceEndpointAclPolicy")
          this.acls.set(key, entry);
        else this.acls.delete(key);
        return success();
      }
      default:
        return undefined;
    }
  }
}
