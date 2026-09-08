import type { ProtocolResponse, RpcParams } from "./world.ts";
const ok = (body: Record<string, unknown> = {}): ProtocolResponse => ({
  statusCode: 200,
  body: { RequestId: "ecs-test-request", ...body },
});
const error = (code: string): ProtocolResponse => ({
  statusCode: 400,
  body: { Code: code, Message: code, RequestId: "ecs-test-request" },
});
interface Tags {
  Tag: { TagKey: string; TagValue: string }[];
}
interface Instance {
  InstanceId: string;
  InstanceName: string;
  ImageId: string;
  InstanceType: string;
  RegionId: string;
  InstanceChargeType: string;
  Status: string;
  Tags: Tags;
  VpcAttributes: {
    VpcId: string;
    VSwitchId: string;
    PrivateIpAddress: { IpAddress: string[] };
  };
  PublicIpAddress: { IpAddress: string[] };
  SecurityGroupIds: { SecurityGroupId: string[] };
  Description?: string;
  DeletionProtection: boolean;
  AutoReleaseTime?: string;
}
interface Group {
  SecurityGroupId: string;
  SecurityGroupName: string;
  VpcId: string;
  SecurityGroupType: string;
  Description?: string;
  Tags: Tags;
}
interface Rule {
  SecurityGroupRuleId: string;
  Direction: string;
  Policy: string;
  NicType: string;
  IpProtocol: string;
  PortRange: string;
  SourceCidrIp: string;
  Priority: string;
}
const tags = (p: RpcParams): Tags => ({
  Tag: Object.keys(p)
    .filter((k) => /^Tag\.\d+\.Key$/.test(k))
    .map((k) => ({ TagKey: p[k]!, TagValue: p[k.replace(/Key$/, "Value")]! })),
});
const values = (p: RpcParams, name: string) =>
  Object.keys(p)
    .filter((k) => new RegExp(`^${name}\\.\\d+$`).test(k))
    .map((k) => p[k]!);
export class EcsResources {
  readonly instances = new Map<string, Instance>();
  readonly groups = new Map<string, Group>();
  readonly rules = new Map<string, { group: string; rule: Rule }>();
  readonly tokens = new Map<string, string>();
  readonly requests: { action: string; params: RpcParams }[] = [];
  sequence = 0;
  pendingReads = 1;
  malformedInventory = false;
  permissionPageSize = 100;
  privateIp = "10.40.1.10";
  dispatch(action: string, p: RpcParams): ProtocolResponse {
    this.requests.push({ action, params: { ...p } }); // Server strips UserData and credentials first.
    const instance = this.instances.get(p.InstanceId ?? "");
    const group = this.groups.get(p.SecurityGroupId ?? "");
    switch (action) {
      case "RunInstances": {
        const existing = this.tokens.get(p.ClientToken ?? "");
        if (existing)
          return ok({ InstanceIdSets: { InstanceIdSet: [existing] } });
        const id = `i-ecs-${++this.sequence}`;
        this.instances.set(id, {
          InstanceId: id,
          InstanceName: p.InstanceName!,
          ImageId: p.ImageId!,
          InstanceType: p.InstanceType!,
          RegionId: p.RegionId!,
          InstanceChargeType: p.InstanceChargeType!,
          Status: "Pending",
          Tags: tags(p),
          VpcAttributes: {
            VpcId: "vpc-test",
            VSwitchId: p.VSwitchId!,
            PrivateIpAddress: { IpAddress: [this.privateIp] },
          },
          PublicIpAddress: {
            IpAddress:
              Number(p.InternetMaxBandwidthOut) > 0 ? ["192.0.2.10"] : [],
          },
          SecurityGroupIds: { SecurityGroupId: values(p, "SecurityGroupIds") },
          Description: p.Description,
          DeletionProtection: p.DeletionProtection === "true",
          AutoReleaseTime: p.AutoReleaseTime,
        });
        this.tokens.set(p.ClientToken!, id);
        return ok({ InstanceIdSets: { InstanceIdSet: [id] } });
      }
      case "DescribeInstances": {
        if (this.malformedInventory) return ok();
        const ids: string[] | undefined = p.InstanceIds
          ? JSON.parse(p.InstanceIds)
          : undefined;
        const all = [...this.instances.values()].filter(
          (i) =>
            (!ids || ids.includes(i.InstanceId)) &&
            (!p.InstanceName || p.InstanceName === i.InstanceName) &&
            p.RegionId === i.RegionId,
        );
        for (const i of all) {
          if (i.Status === "Pending" && this.pendingReads-- <= 0)
            i.Status = "Running";
          if (i.Status === "Stopping") i.Status = "Stopped";
        }
        const size = Number(p.PageSize ?? 50),
          page = Number(p.PageNumber ?? 1);
        return ok({
          Instances: { Instance: all.slice((page - 1) * size, page * size) },
          TotalCount: all.length,
        });
      }
      case "StartInstance":
        if (!instance) return error("InvalidInstanceId.NotFound");
        instance.Status = "Running";
        return ok();
      case "StopInstance":
        if (!instance) return error("InvalidInstanceId.NotFound");
        instance.Status = "Stopping";
        return ok();
      case "DeleteInstance":
        if (!instance) return error("InvalidInstanceId.NotFound");
        if (instance.DeletionProtection)
          return error("InvalidOperation.DeletionProtection");
        if (instance.Status !== "Stopped")
          return error("IncorrectInstanceStatus");
        this.instances.delete(instance.InstanceId);
        return ok();
      case "ModifyInstanceAttribute":
        if (!instance) return error("InvalidInstanceId.NotFound");
        if (p.Description !== undefined) instance.Description = p.Description;
        if (p.DeletionProtection !== undefined)
          instance.DeletionProtection = p.DeletionProtection === "true";
        return ok();
      case "ModifyInstanceAutoReleaseTime":
        if (!instance) return error("InvalidInstanceId.NotFound");
        instance.AutoReleaseTime = p.AutoReleaseTime ?? "";
        return ok();
      case "CreateSecurityGroup": {
        const id =
          this.tokens.get(p.ClientToken ?? "") ?? `sg-ecs-${++this.sequence}`;
        this.groups.set(id, {
          SecurityGroupId: id,
          SecurityGroupName: p.SecurityGroupName!,
          VpcId: p.VpcId!,
          SecurityGroupType: p.SecurityGroupType!,
          Description: p.Description,
          Tags: tags(p),
        });
        this.tokens.set(p.ClientToken!, id);
        return ok({ SecurityGroupId: id });
      }
      case "DescribeSecurityGroups": {
        const all = [...this.groups.values()].filter(
          (g) =>
            (!p.SecurityGroupId || p.SecurityGroupId === g.SecurityGroupId) &&
            (!p.SecurityGroupName ||
              p.SecurityGroupName === g.SecurityGroupName) &&
            (!p.VpcId || p.VpcId === g.VpcId),
        );
        const size = Number(p.PageSize ?? 50),
          page = Number(p.PageNumber ?? 1);
        return ok({
          SecurityGroups: {
            SecurityGroup: all.slice((page - 1) * size, page * size),
          },
          TotalCount: all.length,
        });
      }
      case "ModifySecurityGroupAttribute":
        if (!group) return error("InvalidSecurityGroupId.NotFound");
        group.Description = p.Description;
        return ok();
      case "DeleteSecurityGroup":
        if (!group) return error("InvalidSecurityGroupId.NotFound");
        if (
          [...this.instances.values()].some((i) =>
            i.SecurityGroupIds.SecurityGroupId.includes(group.SecurityGroupId),
          )
        )
          return error("DependencyViolation");
        this.groups.delete(group.SecurityGroupId);
        for (const [id, value] of this.rules)
          if (value.group === group.SecurityGroupId) this.rules.delete(id);
        return ok();
      case "TagResources":
      case "UntagResources": {
        const id = values(p, "ResourceId")[0]!;
        const resource =
          p.ResourceType === "instance"
            ? this.instances.get(id)
            : this.groups.get(id);
        if (!resource)
          return error(
            p.ResourceType === "instance"
              ? "InvalidInstanceId.NotFound"
              : "InvalidSecurityGroupId.NotFound",
          );
        const current = new Map(
          resource.Tags.Tag.map((t) => [t.TagKey, t.TagValue]),
        );
        if (action === "TagResources")
          for (const t of tags(p).Tag) current.set(t.TagKey, t.TagValue);
        else for (const key of values(p, "TagKey")) current.delete(key);
        resource.Tags = {
          Tag: [...current].map(([TagKey, TagValue]) => ({ TagKey, TagValue })),
        };
        return ok();
      }
      case "DescribeSecurityGroupAttribute": {
        if (!group) return error("InvalidSecurityGroupId.NotFound");
        const all = [...this.rules.values()]
          .filter((r) => r.group === group.SecurityGroupId)
          .map((r) => r.rule);
        const start = Number(p.NextToken ?? 0),
          end = start + this.permissionPageSize;
        return ok({
          SecurityGroupId: group.SecurityGroupId,
          Permissions: { Permission: all.slice(start, end) },
          NextToken: end < all.length ? String(end) : undefined,
        });
      }
      case "AuthorizeSecurityGroup": {
        if (!group) return error("InvalidSecurityGroupId.NotFound");
        const rule = {
          Direction: "ingress",
          Policy: "Accept",
          NicType: p.NicType!,
          IpProtocol: p.IpProtocol!,
          PortRange: p.PortRange!,
          SourceCidrIp: p.SourceCidrIp!,
          Priority: p.Priority!,
        };
        if (
          ![...this.rules.values()].some(
            (r) =>
              r.group === group.SecurityGroupId &&
              r.rule.SourceCidrIp === rule.SourceCidrIp &&
              r.rule.PortRange === rule.PortRange,
          )
        ) {
          const id = `sgr-${++this.sequence}`;
          this.rules.set(id, {
            group: group.SecurityGroupId,
            rule: { ...rule, SecurityGroupRuleId: id },
          });
        }
        return ok();
      }
      case "RevokeSecurityGroup":
        for (const id of values(p, "SecurityGroupRuleId"))
          this.rules.delete(id);
        return ok();
      default:
        return error("UnsupportedEcsProtocolAction");
    }
  }
}
