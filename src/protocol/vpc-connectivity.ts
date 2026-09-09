import type { ProtocolResponse, RpcParams } from "./world.ts";
const ok = (body: Record<string, unknown> = {}): ProtocolResponse => ({
  statusCode: 200,
  body: { RequestId: "vpc-test", ...body },
});
const error = (code: string): ProtocolResponse => ({
  statusCode: 400,
  body: { Code: code, Message: code },
});
interface Eip {
  AllocationId: string;
  IpAddress: string;
  Name: string;
  Bandwidth: string;
  Status: string;
  InstanceId?: string;
  InstanceType?: string;
  Description?: string;
  Tags: { Tag: { Key: string; Value: string }[] };
}
interface Nat {
  NatGatewayId: string;
  VpcId: string;
  Name: string;
  Status: string;
  Description?: string;
  NatGatewayPrivateInfo: { VswitchId: string };
  SnatTableIds: { SnatTableId: string[] };
  Tags: { Tag: { TagKey: string; TagValue: string }[] };
}
interface Snat {
  SnatEntryId: string;
  SnatTableId: string;
  SourceVSwitchId: string;
  SnatIp: string;
  SnatEntryName: string;
  Status: string;
}
const tags = (params: RpcParams) =>
  Object.keys(params)
    .filter((key) => /^Tag\.\d+\.Key$/.test(key))
    .map((key) => ({
      Key: params[key]!,
      Value: params[key.replace(/Key$/, "Value")]!,
    }));
const page = <T>(items: T[], params: RpcParams, outer: string, inner: string) =>
  ok({
    [outer]: {
      [inner]: items.slice(
        (Number(params.PageNumber ?? 1) - 1) * Number(params.PageSize ?? 50),
        Number(params.PageNumber ?? 1) * Number(params.PageSize ?? 50),
      ),
    },
    TotalCount: items.length,
  });

export class VpcConnectivity {
  readonly eips = new Map<string, Eip>();
  readonly nats = new Map<string, Nat>();
  readonly snats = new Map<string, Snat>();
  readonly tokens = new Map<string, string>();
  readonly requests: { action: string; params: RpcParams }[] = [];
  sequence = 0;
  dispatch(action: string, p: RpcParams): ProtocolResponse | undefined {
    if (
      !/Eip|NatGateway|Snat/.test(action) &&
      !(
        (action === "TagResources" || action === "UnTagResources") &&
        ["EIP", "NATGATEWAY"].includes(p.ResourceType ?? "")
      )
    )
      return;
    this.requests.push({ action, params: { ...p } });
    switch (action) {
      case "AllocateEipAddress": {
        const previous = this.tokens.get(p.ClientToken!);
        if (previous) return ok({ AllocationId: previous });
        const id = `eip-test-${++this.sequence}`;
        this.eips.set(id, {
          AllocationId: id,
          IpAddress: `192.0.2.${this.sequence}`,
          Name: p.Name!,
          Bandwidth: p.Bandwidth!,
          Status: "Available",
          Description: p.Description,
          Tags: { Tag: tags(p) },
        });
        this.tokens.set(p.ClientToken!, id);
        return ok({ AllocationId: id });
      }
      case "DescribeEipAddresses":
        return page(
          [...this.eips.values()].filter(
            (v) =>
              (!p.AllocationId || v.AllocationId === p.AllocationId) &&
              (!p.EipName || v.Name === p.EipName),
          ),
          p,
          "EipAddresses",
          "EipAddress",
        );
      case "ModifyEipAddressAttribute": {
        const v = this.eips.get(p.AllocationId!);
        if (!v) return error("InvalidAllocationId.NotFound");
        v.Bandwidth = p.Bandwidth ?? v.Bandwidth;
        v.Name = p.Name ?? v.Name;
        v.Description = p.Description ?? v.Description;
        return ok();
      }
      case "AssociateEipAddress": {
        const v = this.eips.get(p.AllocationId!);
        if (!v) return error("InvalidAllocationId.NotFound");
        if (v.InstanceId && v.InstanceId !== p.InstanceId)
          return error("IncorrectEipStatus");
        if (p.InstanceType === "Nat" && !this.nats.has(p.InstanceId!))
          return error("InvalidNatGatewayId.NotFound");
        v.InstanceId = p.InstanceId;
        v.InstanceType = p.InstanceType;
        v.Status = "InUse";
        return ok();
      }
      case "UnassociateEipAddress": {
        const v = this.eips.get(p.AllocationId!);
        if (!v) return error("InvalidAllocationId.NotFound");
        if ([...this.snats.values()].some((s) => s.SnatIp === v.IpAddress))
          return error("DependencyViolation.Snat");
        v.InstanceId = undefined;
        v.InstanceType = undefined;
        v.Status = "Available";
        return ok();
      }
      case "ReleaseEipAddress": {
        const v = this.eips.get(p.AllocationId!);
        if (v?.InstanceId) return error("IncorrectEipStatus");
        this.eips.delete(p.AllocationId!);
        return ok();
      }
      case "CreateNatGateway": {
        const previous = this.tokens.get(p.ClientToken!);
        if (previous) return ok({ NatGatewayId: previous });
        const id = `nat-test-${++this.sequence}`;
        this.nats.set(id, {
          NatGatewayId: id,
          VpcId: p.VpcId!,
          Name: p.Name!,
          Status: "Available",
          Description: p.Description,
          NatGatewayPrivateInfo: { VswitchId: p.VSwitchId! },
          SnatTableIds: { SnatTableId: [`snat-table-${id}`] },
          Tags: {
            Tag: tags(p).map(({ Key, Value }) => ({
              TagKey: Key,
              TagValue: Value,
            })),
          },
        });
        this.tokens.set(p.ClientToken!, id);
        return ok({ NatGatewayId: id });
      }
      case "DescribeNatGateways":
        return page(
          [...this.nats.values()].filter(
            (v) =>
              (!p.NatGatewayId || v.NatGatewayId === p.NatGatewayId) &&
              (!p.Name || v.Name === p.Name),
          ),
          p,
          "NatGateways",
          "NatGateway",
        );
      case "ModifyNatGatewayAttribute": {
        const v = this.nats.get(p.NatGatewayId!);
        if (!v) return error("InvalidNatGatewayId.NotFound");
        v.Name = p.Name ?? v.Name;
        v.Description = p.Description ?? v.Description;
        return ok();
      }
      case "DeleteNatGateway": {
        if (
          [...this.eips.values()].some((v) => v.InstanceId === p.NatGatewayId)
        )
          return error("DependencyViolation.Eip");
        this.nats.delete(p.NatGatewayId!);
        return ok();
      }
      case "CreateSnatEntry": {
        const gateway = [...this.nats.values()].find((v) =>
          v.SnatTableIds.SnatTableId.includes(p.SnatTableId!),
        );
        if (
          !gateway ||
          ![...this.eips.values()].some(
            (v) =>
              v.InstanceId === gateway.NatGatewayId && v.IpAddress === p.SnatIp,
          )
        )
          return error("InvalidSnatIp");
        const previous = this.tokens.get(p.ClientToken!);
        if (previous) return ok({ SnatEntryId: previous });
        const id = `snat-test-${++this.sequence}`;
        this.snats.set(id, {
          SnatEntryId: id,
          SnatTableId: p.SnatTableId!,
          SourceVSwitchId: p.SourceVSwitchId!,
          SnatIp: p.SnatIp!,
          SnatEntryName: p.SnatEntryName!,
          Status: "Available",
        });
        this.tokens.set(p.ClientToken!, id);
        return ok({ SnatEntryId: id });
      }
      case "DescribeSnatTableEntries":
        return page(
          [...this.snats.values()].filter(
            (v) =>
              v.SnatTableId === p.SnatTableId &&
              (!p.SnatEntryId || v.SnatEntryId === p.SnatEntryId) &&
              (!p.SourceVSwitchId || v.SourceVSwitchId === p.SourceVSwitchId),
          ),
          p,
          "SnatTableEntries",
          "SnatTableEntry",
        );
      case "ModifySnatEntry": {
        const v = this.snats.get(p.SnatEntryId!);
        if (!v) return error("InvalidSnatEntryId.NotFound");
        v.SnatIp = p.SnatIp ?? v.SnatIp;
        v.SnatEntryName = p.SnatEntryName ?? v.SnatEntryName;
        return ok();
      }
      case "DeleteSnatEntry":
        this.snats.delete(p.SnatEntryId!);
        return ok();
      case "TagResources":
      case "UnTagResources": {
        const id = p["ResourceId.1"]!;
        const eip = this.eips.get(id),
          nat = this.nats.get(id);
        const current = Object.fromEntries(
          eip
            ? eip.Tags.Tag.map((t) => [t.Key, t.Value])
            : (nat?.Tags.Tag.map((t) => [t.TagKey, t.TagValue]) ?? []),
        );
        if (action === "TagResources")
          for (const t of tags(p)) current[t.Key] = t.Value;
        else
          for (const key of Object.keys(p).filter((k) =>
            /^TagKey\.\d+$/.test(k),
          ))
            delete current[p[key]!];
        if (eip)
          eip.Tags.Tag = Object.entries(current).map(([Key, Value]) => ({
            Key,
            Value,
          }));
        if (nat)
          nat.Tags.Tag = Object.entries(current).map(([TagKey, TagValue]) => ({
            TagKey,
            TagValue,
          }));
        return ok();
      }
      default:
        return error("UnsupportedConnectivityAction");
    }
  }
}
