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
  InternetMaxBandwidthOut?: number;
}
interface Disk {
  DiskId: string;
  DiskName: string;
  ZoneId: string;
  RegionId: string;
  Size: number;
  Status: string;
  InstanceId?: string;
  Device?: string;
  DeleteWithInstance: boolean;
  Tags: Tags;
  Description?: string;
}
interface KeyPair {
  KeyPairName: string;
  KeyPairFingerPrint: string;
  PublicKey: string;
  Tags: Tags;
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
  SourceCidrIp?: string;
  Ipv6SourceCidrIp?: string;
  SourceGroupId?: string;
  DestCidrIp?: string;
  Ipv6DestCidrIp?: string;
  DestGroupId?: string;
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
  readonly disks = new Map<string, Disk>();
  readonly keyPairs = new Map<string, KeyPair>();
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
      case "CreateDisk": {
        const previous = this.tokens.get(p.ClientToken!);
        if (previous) return ok({ DiskId: previous });
        const id = `disk-test-${++this.sequence}`;
        this.disks.set(id, {
          DiskId: id,
          DiskName: p.DiskName!,
          ZoneId: p.ZoneId!,
          RegionId: p.RegionId!,
          Size: Number(p.Size),
          Status: "Available",
          DeleteWithInstance: false,
          Tags: tags(p),
          Description: p.Description,
        });
        this.tokens.set(p.ClientToken!, id);
        return ok({ DiskId: id });
      }
      case "DescribeDisks": {
        const ids = p.DiskIds ? JSON.parse(p.DiskIds) : undefined;
        const all = [...this.disks.values()].filter(
          (v) =>
            (!ids || ids.includes(v.DiskId)) &&
            (!p.DiskName || v.DiskName === p.DiskName),
        );
        const size = Number(p.PageSize ?? 50),
          start = (Number(p.PageNumber ?? 1) - 1) * size;
        return ok({
          Disks: { Disk: all.slice(start, start + size) },
          TotalCount: all.length,
        });
      }
      case "ResizeDisk": {
        const v = this.disks.get(p.DiskId!);
        if (!v) return error("InvalidDiskId.NotFound");
        if (Number(p.NewSize) <= v.Size)
          return error("InvalidParameter.NewSize");
        v.Size = Number(p.NewSize);
        return ok();
      }
      case "ModifyDiskAttribute": {
        const v = this.disks.get(p.DiskId!);
        if (!v) return error("InvalidDiskId.NotFound");
        v.DiskName = p.DiskName ?? v.DiskName;
        v.Description = p.Description ?? v.Description;
        if (p.DeleteWithInstance !== undefined)
          v.DeleteWithInstance = p.DeleteWithInstance === "true";
        return ok();
      }
      case "AttachDisk": {
        const v = this.disks.get(p.DiskId!);
        if (!v) return error("InvalidDiskId.NotFound");
        if (v.InstanceId || !this.instances.has(p.InstanceId!))
          return error("IncorrectDiskStatus");
        v.InstanceId = p.InstanceId;
        v.Status = "In_use";
        v.Device = "/dev/vdb";
        v.DeleteWithInstance = p.DeleteWithInstance === "true";
        return ok();
      }
      case "DetachDisk": {
        const v = this.disks.get(p.DiskId!);
        if (!v) return error("InvalidDiskId.NotFound");
        v.InstanceId = undefined;
        v.Status = "Available";
        return ok();
      }
      case "DeleteDisk": {
        const v = this.disks.get(p.DiskId!);
        if (v?.InstanceId) return error("IncorrectDiskStatus");
        this.disks.delete(p.DiskId!);
        return ok();
      }
      case "ImportKeyPair": {
        if (this.keyPairs.has(p.KeyPairName!))
          return error("InvalidKeyPair.Duplicate");
        this.keyPairs.set(p.KeyPairName!, {
          KeyPairName: p.KeyPairName!,
          KeyPairFingerPrint: `fingerprint-${++this.sequence}`,
          PublicKey: p.PublicKeyBody!,
          Tags: tags(p),
        });
        return ok();
      }
      case "DescribeKeyPairs": {
        const all = [...this.keyPairs.values()].filter(
          (v) => !p.KeyPairName || v.KeyPairName === p.KeyPairName,
        );
        return ok({ KeyPairs: { KeyPair: all }, TotalCount: all.length });
      }
      case "DeleteKeyPairs":
        for (const name of JSON.parse(p.KeyPairNames ?? "[]"))
          this.keyPairs.delete(name);
        return ok();
      case "RunInstances": {
        const existing = this.tokens.get(p.ClientToken ?? "");
        if (existing)
          return ok({ InstanceIdSets: { InstanceIdSet: [existing] } });
        const id = `i-ecs-${++this.sequence}`;
        this.instances.set(id, {
          InstanceId: id,
          InstanceName: p.InstanceName!,
          ImageId: p.ImageId!,
          InternetMaxBandwidthOut: Number(p.InternetMaxBandwidthOut ?? 0),
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
          AutoReleaseTime: p.AutoReleaseTime?.replace(/:\d{2}Z$/, "Z"),
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
        for (const [id, disk] of this.disks)
          if (disk.InstanceId === instance.InstanceId) {
            if (disk.DeleteWithInstance) this.disks.delete(id);
            else {
              disk.InstanceId = undefined;
              disk.Status = "Available";
            }
          }
        return ok();
      case "ModifyInstanceSpec":
        if (!instance) return error("InvalidInstanceId.NotFound");
        if (p.InstanceType !== undefined) {
          if (instance.Status !== "Stopped")
            return error("InvalidInstanceStatus.NotStopped");
          instance.InstanceType = p.InstanceType;
        }
        if (p.InternetMaxBandwidthOut !== undefined)
          instance.InternetMaxBandwidthOut = Number(p.InternetMaxBandwidthOut);
        return ok();
      case "JoinSecurityGroup":
        if (!instance) return error("InvalidInstanceId.NotFound");
        if (
          !instance.SecurityGroupIds.SecurityGroupId.includes(
            p.SecurityGroupId!,
          )
        )
          instance.SecurityGroupIds.SecurityGroupId.push(p.SecurityGroupId!);
        return ok();
      case "LeaveSecurityGroup":
        if (!instance) return error("InvalidInstanceId.NotFound");
        instance.SecurityGroupIds.SecurityGroupId =
          instance.SecurityGroupIds.SecurityGroupId.filter(
            (id) => id !== p.SecurityGroupId,
          );
        return ok();
      case "ModifyInstanceAttribute":
        if (!instance) return error("InvalidInstanceId.NotFound");
        if (p.Description !== undefined) instance.Description = p.Description;
        if (p.DeletionProtection !== undefined)
          instance.DeletionProtection = p.DeletionProtection === "true";
        return ok();
      case "ModifyInstanceAutoReleaseTime":
        if (!instance) return error("InvalidInstanceId.NotFound");
        instance.AutoReleaseTime =
          p.AutoReleaseTime?.replace(/:\d{2}Z$/, "Z") ?? "";
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
            : p.ResourceType === "disk"
              ? this.disks.get(id)
              : p.ResourceType === "keypair"
                ? this.keyPairs.get(id)
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
        if (!p.SecurityGroupId) return error("MissingParameter");
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
      case "AuthorizeSecurityGroupEgress":
      case "AuthorizeSecurityGroup": {
        if (!group) return error("InvalidSecurityGroupId.NotFound");
        const rule = {
          Direction: action.endsWith("Egress") ? "egress" : "ingress",
          Policy: "Accept",
          NicType: p.NicType!,
          IpProtocol: p.IpProtocol!,
          PortRange: p.PortRange!,
          SourceCidrIp: p.SourceCidrIp,
          Ipv6SourceCidrIp: p.Ipv6SourceCidrIp,
          SourceGroupId: p.SourceGroupId,
          DestCidrIp: p.DestCidrIp,
          Ipv6DestCidrIp: p.Ipv6DestCidrIp,
          DestGroupId: p.DestGroupId,
          Priority: p.Priority!,
        };
        if (
          ![...this.rules.values()].some(
            (r) =>
              r.group === group.SecurityGroupId &&
              r.rule.Direction === rule.Direction &&
              r.rule.SourceCidrIp === rule.SourceCidrIp &&
              r.rule.Ipv6SourceCidrIp === rule.Ipv6SourceCidrIp &&
              r.rule.SourceGroupId === rule.SourceGroupId &&
              r.rule.DestCidrIp === rule.DestCidrIp &&
              r.rule.Ipv6DestCidrIp === rule.Ipv6DestCidrIp &&
              r.rule.DestGroupId === rule.DestGroupId &&
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
      case "RevokeSecurityGroupEgress":
      case "RevokeSecurityGroup":
        for (const id of values(p, "SecurityGroupRuleId"))
          this.rules.delete(id);
        return ok();
      default:
        return error("UnsupportedEcsProtocolAction");
    }
  }
}
