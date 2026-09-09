import type { ProtocolResponse, RpcParams } from "./world.ts";
const ok = (body: Record<string, unknown> = {}): ProtocolResponse => ({
  statusCode: 200,
  body: { RequestId: "ram-test", ...body },
});
const error = (code: string): ProtocolResponse => ({
  statusCode: 404,
  body: { Code: code, Message: code },
});
const tags = (p: RpcParams): Record<string, string> =>
  p.Tag
    ? Object.fromEntries(
        JSON.parse(p.Tag).map((t: { Key: string; Value: string }) => [
          t.Key,
          t.Value,
        ]),
      )
    : Object.fromEntries(
        Object.keys(p)
          .filter((key) => /^Tag\.\d+\.Key$/.test(key))
          .map((key) => [p[key], p[key.replace(/Key$/, "Value")]]),
      );
interface Role {
  RoleName: string;
  RoleId: string;
  Arn: string;
  AssumeRolePolicyDocument: string;
  Description?: string;
  MaxSessionDuration: number;
}
interface Policy {
  PolicyName: string;
  PolicyType: string;
  Description?: string;
  DefaultVersion: string;
  document: string;
  versions: {
    VersionId: string;
    IsDefaultVersion: boolean;
    PolicyDocument: string;
  }[];
}
export class RamResources {
  readonly roles = new Map<string, Role>();
  readonly policies = new Map<string, Policy>();
  readonly attachments = new Map<
    string,
    { RoleName: string; PolicyName: string; PolicyType: string }
  >();
  readonly tags = new Map<string, Record<string, string>>();
  readonly actions: string[] = [];
  sequence = 0;
  dispatch(action: string, p: RpcParams): ProtocolResponse {
    this.actions.push(action);
    const role = this.roles.get(p.RoleName!),
      policy = this.policies.get(p.PolicyName!);
    const attachmentId = `${p.RoleName}/${p.PolicyType}/${p.PolicyName}`;
    switch (action) {
      case "GetRole":
        return role ? ok({ Role: role }) : error("EntityNotExist.Role");
      case "ListRoles":
        return ok({
          Roles: { Role: [...this.roles.values()] },
          IsTruncated: false,
        });
      case "CreateRole": {
        if (role) return error("EntityAlreadyExists.Role");
        const id = `role-${++this.sequence}`;
        this.roles.set(p.RoleName!, {
          RoleName: p.RoleName!,
          RoleId: id,
          Arn: `acs:ram::123456789:role/${p.RoleName}`,
          AssumeRolePolicyDocument: p.AssumeRolePolicyDocument!,
          Description: p.Description,
          MaxSessionDuration: Number(p.MaxSessionDuration),
        });
        this.tags.set(`role/${p.RoleName}`, tags(p));
        return ok();
      }
      case "UpdateRole": {
        if (!role) return error("EntityNotExist.Role");
        role.AssumeRolePolicyDocument =
          p.NewAssumeRolePolicyDocument ?? role.AssumeRolePolicyDocument;
        role.Description = p.NewDescription ?? role.Description;
        role.MaxSessionDuration = Number(
          p.NewMaxSessionDuration ?? role.MaxSessionDuration,
        );
        return ok();
      }
      case "DeleteRole": {
        if (
          [...this.attachments.values()].some((a) => a.RoleName === p.RoleName)
        )
          return error("DeleteConflict.Role.Policy");
        this.roles.delete(p.RoleName!);
        this.tags.delete(`role/${p.RoleName}`);
        return ok();
      }
      case "GetPolicy":
        return policy
          ? ok({
              Policy: policy,
              DefaultPolicyVersion: { PolicyDocument: policy.document },
            })
          : error("EntityNotExist.Policy");
      case "ListPolicies":
        return ok({
          Policies: { Policy: [...this.policies.values()] },
          IsTruncated: false,
        });
      case "CreatePolicy": {
        if (policy) return error("EntityAlreadyExists.Policy");
        this.policies.set(p.PolicyName!, {
          PolicyName: p.PolicyName!,
          PolicyType: "Custom",
          Description: p.Description,
          DefaultVersion: "v1",
          document: p.PolicyDocument!,
          versions: [
            {
              VersionId: "v1",
              IsDefaultVersion: true,
              PolicyDocument: p.PolicyDocument!,
            },
          ],
        });
        this.tags.set(`policy/${p.PolicyName}`, tags(p));
        return ok();
      }
      case "CreatePolicyVersion": {
        if (!policy) return error("EntityNotExist.Policy");
        const id = `v${Number(policy.DefaultVersion.slice(1)) + 1}`;
        if (policy.versions.length === 5) {
          if (
            p.RotateStrategy !==
            "DeleteOldestNonDefaultVersionWhenLimitExceeded"
          )
            return error("LimitExceeded.Policy.Version");
          const first = policy.versions.findIndex((v) => !v.IsDefaultVersion);
          policy.versions.splice(first, 1);
        }
        for (const v of policy.versions) v.IsDefaultVersion = false;
        policy.versions.push({
          VersionId: id,
          IsDefaultVersion: true,
          PolicyDocument: p.PolicyDocument!,
        });
        policy.DefaultVersion = id;
        policy.document = p.PolicyDocument!;
        return ok();
      }
      case "UpdatePolicyDescription":
        if (policy) policy.Description = p.NewDescription;
        return ok();
      case "ListPolicyVersions":
        return policy
          ? ok({ PolicyVersions: { PolicyVersion: policy.versions } })
          : error("EntityNotExist.Policy");
      case "DeletePolicyVersion":
        if (policy)
          policy.versions = policy.versions.filter(
            (v) => v.VersionId !== p.VersionId,
          );
        return ok();
      case "DeletePolicy": {
        if (
          [...this.attachments.values()].some(
            (a) => a.PolicyName === p.PolicyName,
          )
        )
          return error("DeleteConflict.Policy");
        if (policy && policy.versions.length > 1)
          return error("DeleteConflict.Policy.Version");
        this.policies.delete(p.PolicyName!);
        this.tags.delete(`policy/${p.PolicyName}`);
        return ok();
      }
      case "ListPoliciesForRole":
        return role
          ? ok({
              Policies: {
                Policy: [...this.attachments.values()].filter(
                  (a) => a.RoleName === p.RoleName,
                ),
              },
            })
          : error("EntityNotExist.Role");
      case "AttachPolicyToRole": {
        if (!role || (p.PolicyType === "Custom" && !policy))
          return error("EntityNotExist.Policy");
        this.attachments.set(attachmentId, {
          RoleName: p.RoleName!,
          PolicyName: p.PolicyName!,
          PolicyType: p.PolicyType!,
        });
        return ok();
      }
      case "DetachPolicyFromRole":
        this.attachments.delete(attachmentId);
        return ok();
      case "ListTagResources":
        return ok({
          TagResources: Object.entries(
            this.tags.get(
              `${p.ResourceType}/${JSON.parse(p.ResourceNames ?? "[]")[0]}`,
            ) ?? {},
          ).map(([TagKey, TagValue]) => ({
            TagKey,
            TagValue,
            ResourceName: JSON.parse(p.ResourceNames ?? "[]")[0],
            ResourceType: p.ResourceType,
          })),
        });
      case "TagResources": {
        const key = `${p.ResourceType}/${JSON.parse(p.ResourceNames ?? "[]")[0]}`;
        this.tags.set(key, { ...this.tags.get(key), ...tags(p) });
        return ok();
      }
      case "UntagResources": {
        const current = this.tags.get(
          `${p.ResourceType}/${JSON.parse(p.ResourceNames ?? "[]")[0]}`,
        );
        if (current)
          for (const key of JSON.parse(p.TagKeys ?? "[]")) delete current[key];
        return ok();
      }
      default:
        return error("UnsupportedRamProtocolAction");
    }
  }
}
