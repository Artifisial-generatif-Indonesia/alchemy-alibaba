import { EcsResources } from "./ecs-resources.ts";
import { RoaResources, type RoaBody } from "./roa-resources.ts";
import { RpcResources } from "./rpc-resources.ts";
export type RpcParams = Record<string, string>;

export interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly host: string;
  readonly action?: string;
  readonly version?: string;
  readonly regionId?: string;
  readonly vpcId?: string;
  readonly vSwitchId?: string;
  readonly instanceId?: string;
  readonly instanceName?: string;
  readonly dbInstanceDescription?: string;
  readonly token?: string;
  readonly clientToken?: string;
  readonly hasPassword: boolean;
  readonly tagKeys: readonly string[];
  readonly pageNumber?: string;
  readonly pageSize?: string;
  readonly sslEnabled?: string;
  readonly hasServerKey?: boolean;
  readonly connectionString?: string;
  readonly deletionProtection?: string;
  readonly enablePrivateZoneRecord?: string;
}

export interface ScriptedFault {
  readonly action: string;
  readonly code: string;
  readonly statusCode?: number;
  readonly times?: number;
  readonly accept?: boolean;
  readonly omitIdentity?: boolean;
}

export interface ProtocolResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown> | readonly Record<string, unknown>[];
}

type TairStatus = "Creating" | "Normal" | "Released" | "Destroyed";
type VSwitchStatus = "Pending" | "Available";
type RdsStatus = "Creating" | "Running" | "Deleting" | "Modifying";
type AckState = "creating" | "running" | "deleting";

interface TairRecord {
  instanceClass: string;
  instanceId: string;
  name: string;
  status: TairStatus;
  token?: string;
  vpcId?: string;
  vSwitchId?: string;
  regionId: string;
  ssl: "Enable" | "Disable";
  vpcAuthMode: string;
  evictionPolicy: string;
  tags: Record<string, string>;
  releaseProtection: boolean;
  connectionDomain: string;
  port: number;
  describes: number;
}

interface NetworkRecord {
  vpcId: string;
  name: string;
  cidrBlock: string;
  status: string;
  regionId: string;
  tags: Record<string, string>;
  routerId: string;
}

interface VSwitchRecord {
  vSwitchId: string;
  vpcId: string;
  name: string;
  cidrBlock: string;
  zoneId: string;
  status: VSwitchStatus;
  tags: Record<string, string>;
}

interface RdsRecord {
  regionId: string;
  engine: string;
  instanceClass: string;
  storage: number;
  storageType?: string;
  engineVersion?: string;
  category?: string;
  serverless?: { ScaleMin: number; ScaleMax: number; AutoPause: boolean };
  deletionProtection: boolean;
  ssl: Record<string, unknown>;
  sslReads: number;
  pendingSpec?: () => void;
  instanceId: string;
  name: string;
  status: RdsStatus;
  clientToken?: string;
  vpcId?: string;
  vSwitchId?: string;
  tags: Record<string, string>;
  describes: number;
}

interface AckRecord {
  clusterId: string;
  name: string;
  state: AckState;
  vpcId?: string;
  vSwitchIds: string[];
  tags: Record<string, string>;
  currentVersion: string;
  deletionProtection: boolean;
}

interface AcrLink {
  instanceId: string;
  vpcId: string;
  vswitchId: string;
  status: string;
}

interface EniRecord {
  id: string;
  vSwitchId: string;
  reason: "kvstore" | "rds" | "ack";
}

const requestId = () =>
  "00000000-0000-4000-8000-000000000000".replace(/0/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );

export const param = (params: RpcParams, name: string): string | undefined => {
  const match = Object.entries(params).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
};

export const tagKeysFrom = (params: RpcParams): string[] =>
  Object.entries(params)
    .filter(([key]) => /^Tag\.\d+\.Key$/i.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);

const tagsFrom = (params: RpcParams): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const match = key.match(/^Tag\.(\d+)\.Key$/i);
    if (match === null) continue;
    const tagValue = param(params, `Tag.${match[1]}.Value`);
    if (tagValue !== undefined) tags[value] = tagValue;
  }
  return tags;
};

const errorBody = (code: string, message: string): ProtocolResponse => ({
  statusCode: 400,
  body: {
    Code: code,
    Message: message,
    RequestId: requestId(),
    HostId: "127.0.0.1",
  },
});

const ok = (body: Record<string, unknown>): ProtocolResponse => ({
  statusCode: 200,
  body: { RequestId: requestId(), ...body },
});

export interface ProtocolWorldOptions {
  readonly regionId?: string;
  readonly tairDescribesUntilNormal?: number;
  readonly tairSslRejects?: number;
  readonly tairKvstoreHoldAfterDestroy?: number;
  readonly rdsDescribesUntilRunning?: number;
  readonly omitCreatingIdentityReads?: number;
  readonly tairDetailReadOmissions?: number;
  readonly eniHoldAfterDelete?: number;
}

export class ProtocolWorld {
  readonly regionId: string;
  readonly captured: CapturedRequest[] = [];
  readonly faults: ScriptedFault[] = [];
  tairDescribesUntilNormal: number;
  tairSslRejects: number;
  tairKvstoreHoldAfterDestroy: number;
  rdsDescribesUntilRunning: number;
  omitCreatingIdentityReads: number;
  tairDetailReadOmissions: number;
  eniHoldAfterDelete: number;
  createVSwitchBusy = false;
  rdsSslFailure = false;
  rdsPublicEndpoint = false;
  eniDependencyRejections = 0;

  readonly networks = new Map<string, NetworkRecord>();
  readonly vswitches = new Map<string, VSwitchRecord>();
  readonly tair = new Map<string, TairRecord>();
  readonly rds = new Map<string, RdsRecord>();
  readonly ecs = new EcsResources();
  readonly resources = new RpcResources((id) => this.rds.get(id)?.engine);
  readonly roa = new RoaResources();
  readonly ack = new Map<string, AckRecord>();
  readonly acrLinks: AcrLink[] = [];
  readonly enis: EniRecord[] = [];
  private ids = 0;
  kvstoreHolds = new Map<string, number>();
  eniHolds = new Map<string, number>();

  constructor(options: ProtocolWorldOptions = {}) {
    this.regionId = options.regionId ?? "ap-southeast-5";
    this.tairDescribesUntilNormal = options.tairDescribesUntilNormal ?? 1;
    this.tairSslRejects = options.tairSslRejects ?? 0;
    this.tairKvstoreHoldAfterDestroy = options.tairKvstoreHoldAfterDestroy ?? 0;
    this.rdsDescribesUntilRunning = options.rdsDescribesUntilRunning ?? 1;
    this.omitCreatingIdentityReads = options.omitCreatingIdentityReads ?? 0;
    this.tairDetailReadOmissions = options.tairDetailReadOmissions ?? 0;
    this.eniHoldAfterDelete = options.eniHoldAfterDelete ?? 1;
  }

  script(fault: ScriptedFault): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  consumeFault(action: string): ScriptedFault | undefined {
    const index = this.faults.findIndex((fault) => fault.action === action);
    if (index < 0) return undefined;
    const fault = this.faults[index];
    const remaining = (fault.times ?? 1) - 1;
    if (remaining <= 0) this.faults.splice(index, 1);
    else this.faults[index] = { ...fault, times: remaining };
    return fault;
  }

  nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}${this.ids.toString().padStart(4, "0")}`;
  }

  tairCreates(): number {
    return this.captured.filter((item) => item.action === "CreateInstance")
      .length;
  }

  actions(): string[] {
    return this.captured.flatMap((item) =>
      item.action === undefined ? [] : [item.action],
    );
  }

  activeTair(): TairRecord[] {
    return [...this.tair.values()].filter(
      (item) => item.status !== "Destroyed",
    );
  }

  capture(request: CapturedRequest): void {
    this.captured.push(request);
  }

  dispatchRpc(
    action: string,
    params: RpcParams,
    version?: string,
  ): ProtocolResponse {
    const fault = this.consumeFault(action);
    if (fault?.omitIdentity !== true && fault && fault.accept !== true) {
      return {
        ...errorBody(fault.code, fault.code),
        statusCode: fault.statusCode ?? 400,
      };
    }

    const child = version === "2014-05-26" ? this.ecs.dispatch(action, params) : this.resources.dispatch(action, params, version);
    if (child)
      return fault?.accept
        ? {
            ...errorBody(fault.code, fault.code),
            statusCode: fault.statusCode ?? 400,
          }
        : child;

    switch (action) {
      case "CreateVpc":
        return this.createVpc(params);
      case "DescribeVpcs":
        return this.describeVpcs(params);
      case "ModifyVpcAttribute":
        return ok({});
      case "DeleteVpc":
        return this.deleteVpc(params);
      case "CreateVSwitch":
        return this.createVSwitch(params);
      case "DescribeVSwitches":
        return this.describeVSwitches(params);
      case "DescribeVSwitchAttributes":
        return this.describeVSwitchAttributes(params);
      case "ModifyVSwitchAttribute":
        return ok({});
      case "DeleteVSwitch":
        return this.deleteVSwitch(params);
      case "TagResources":
        return this.tagResources(params, false);
      case "UnTagResources":
      case "UntagResources":
        return this.tagResources(params, true);
      case "CreateInstance":
        return this.createTair(params, fault);
      case "DescribeInstances":
        return this.describeTair(params, false);
      case "DescribeInstancesOverview":
        return this.describeTair(params, true);
      case "DescribeInstanceAttribute":
        return this.describeTairAttribute(params, fault);
      case "DescribeInstanceSSL":
        return this.describeTairSsl(params);
      case "DescribeInstanceConfig":
        return this.describeTairConfig(params);
      case "ModifyInstanceSSL":
        return this.modifyTairSsl(params);
      case "ModifyInstanceVpcAuthMode":
        return this.modifyTairAuth(params);
      case "ModifyInstanceConfig":
        return this.modifyTairConfig(params);
      case "ModifyInstanceAttribute":
        return this.modifyTairAttribute(params);
      case "ModifyInstanceSpec": {
        const record = this.tair.get(params.InstanceId ?? "");
        if (!record) return errorBody("InvalidInstanceId.NotFound", "absent");
        record.instanceClass = params.InstanceClass ?? record.instanceClass;
        return ok({});
      }
      case "ResetAccountPassword":
        return ok({});
      case "DeleteInstance":
        return this.deleteTair(params);
      case "DestroyInstance":
        return this.destroyTair(params);
      case "CreateDBInstance":
        return this.createRds(params, fault);
      case "DescribeDBInstances":
        return this.describeRds(params);
      case "DescribeDBInstanceAttribute":
        return this.describeRdsAttribute(params);
      case "DescribeDBInstanceSSL": {
        const record = this.rds.get(params.DBInstanceId ?? "");
        if (!record)
          return errorBody("InvalidDBInstanceName.NotFound", "absent");
        if (record.sslReads > 0 && --record.sslReads === 0)
          record.ssl.LastModifyStatus = this.rdsSslFailure
            ? "failed"
            : "success";
        return ok(record.ssl);
      }
      case "ModifyDBInstanceSSL": {
        const record = this.rds.get(params.DBInstanceId ?? "");
        if (!record)
          return errorBody("InvalidDBInstanceName.NotFound", "absent");
        if (record.status !== "Running")
          return errorBody("IncorrectDBInstanceState", "resize pending");
        record.ssl = Object.fromEntries(
          ["CAType", "ConnectionString", "TlsVersion", "ServerCert"].flatMap(
            (key) => (params[key] === undefined ? [] : [[key, params[key]]]),
          ),
        );
        record.ssl.SSLEnabled = params.SSLEnabled === "1" ? "on" : "off";
        record.ssl.LastModifyStatus = "setting";
        record.sslReads = 3;
        return ok({});
      }
      case "ModifyDBInstanceSpec": {
        const record = this.rds.get(params.DBInstanceId ?? "");
        if (!record)
          return errorBody("InvalidDBInstanceName.NotFound", "absent");
        record.status = "Modifying";
        record.describes = 0;
        record.pendingSpec = () => {
          record.instanceClass = params.DBInstanceClass ?? record.instanceClass;
          record.storage = Number(params.DBInstanceStorage ?? record.storage);
          record.storageType =
            params.DBInstanceStorageType ?? record.storageType;
          if (params.ServerlessConfiguration !== undefined) {
            const config = JSON.parse(params.ServerlessConfiguration);
            record.serverless = {
              ScaleMin: config.MinCapacity,
              ScaleMax: config.MaxCapacity,
              AutoPause: config.AutoPause,
            };
          }
        };
        return ok({});
      }
      case "ModifyDBInstanceDescription": {
        const record = this.rds.get(params.DBInstanceId ?? "");
        if (record) record.name = params.DBInstanceDescription!;
        return ok({});
      }
      case "DescribeDBInstanceNetInfo":
        return this.describeRdsNet(params);
      case "ListTagResources":
        return this.listTagResources(params);
      case "DeleteDBInstance":
        return this.deleteRds(params);
      case "ModifyDBInstanceDeletionProtection": {
        const record = this.rds.get(params.DBInstanceId ?? "");
        if (record)
          record.deletionProtection = params.DeletionProtection === "true";
        return ok({});
      }
      case "GetInstance":
        return ok({
          IsSuccess: true,
          Code: "success",
          InstanceId: param(params, "InstanceId") ?? "cri-retained",
          InstanceStatus: "RUNNING",
        });
      case "GetInstanceVpcEndpoint":
        return this.getAcrLinks(params);
      case "CreateInstanceVpcEndpointLinkedVpc":
        return this.createAcrLink(params);
      case "DeleteInstanceVpcEndpointLinkedVpc":
        return this.deleteAcrLink(params);
      default:
        return errorBody(
          "InvalidAction",
          `Unsupported protocol action ${action}`,
        );
    }
  }

  dispatchRoa(
    method: string,
    pathname: string,
    input: RoaBody,
    query: RpcParams = {},
    action?: string,
  ): ProtocolResponse {
    const fault = action ? this.consumeFault(action) : undefined;
    const faultResponse = fault
      ? {
          statusCode: fault.statusCode ?? 400,
          body: {
            code: fault.code,
            message: fault.code,
            request_id: requestId(),
          },
        }
      : undefined;
    if (faultResponse && !fault?.accept) return faultResponse;
    const child = this.roa.dispatch(method, pathname, input, query);
    if (child) return faultResponse ?? child;
    const body = Array.isArray(input) ? {} : input;
    if (method === "POST" && pathname === "/clusters") {
      const response = this.createAck(body);
      return faultResponse ?? response;
    }
    if (method === "GET" && pathname === "/api/v1/clusters") {
      const clusters = [...this.ack.values()].filter(
        (c) =>
          (!query.name || c.name === query.name) &&
          (!query.region_id || query.region_id === this.regionId),
      );
      const page = Number(query.page_number ?? 1);
      const size = Number(query.page_size ?? 50);
      return ok({
        clusters: clusters
          .slice((page - 1) * size, page * size)
          .map((c) => this.ackBody(c)),
        page_info: {
          page_number: page,
          page_size: size,
          total_count: clusters.length,
        },
      });
    }
    const upgradeMatch = pathname.match(
      /^\/api\/v2\/clusters\/([^/]+)\/upgrade$/,
    );
    if (upgradeMatch && method === "POST") {
      const cluster = this.ack.get(upgradeMatch[1]!);
      if (!cluster)
        return { statusCode: 404, body: { code: "ErrorClusterNotFound" } };
      return this.roa.task(() => {
        cluster.currentVersion = String(body.next_version);
      });
    }
    const clusterMatch = pathname.match(/^\/clusters\/([^/]+)$/);
    if (clusterMatch && method === "GET") {
      return this.describeAck(clusterMatch[1]);
    }
    const modifyMatch = pathname.match(/^\/api\/v2\/clusters\/([^/]+)$/);
    if (modifyMatch && method === "PUT") {
      return this.modifyAck(modifyMatch[1]!, body);
    }
    if (clusterMatch && method === "DELETE") {
      return this.deleteAck(clusterMatch[1]);
    }
    if (method === "GET" && pathname === "/clusters") {
      return {
        statusCode: 200,
        body: [...this.ack.values()].map((cluster) => this.ackBody(cluster)),
      };
    }
    if ((method === "PUT" || method === "DELETE") && pathname === "/tags") {
      return this.tagAck(body, method === "DELETE");
    }
    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && method === "GET") {
      return {
        statusCode: 200,
        body: { task_id: taskMatch[1], state: "success" },
      };
    }
    return {
      statusCode: 400,
      body: {
        code: "UnsupportedProtocolRoute",
        message: pathname,
        request_id: requestId(),
      },
    };
  }

  private createVpc(params: RpcParams): ProtocolResponse {
    const vpcId = this.nextId("vpc-test");
    const network: NetworkRecord = {
      vpcId,
      name: param(params, "VpcName") ?? vpcId,
      cidrBlock: param(params, "CidrBlock") ?? "10.0.0.0/16",
      status: "Available",
      regionId: param(params, "RegionId") ?? this.regionId,
      tags: tagsFrom(params),
      routerId: this.nextId("vrt-test"),
    };
    this.networks.set(vpcId, network);
    return ok({ VpcId: vpcId, VRouterId: network.routerId });
  }

  private describeVpcs(params: RpcParams): ProtocolResponse {
    const vpcId = param(params, "VpcId");
    const name = param(params, "VpcName");
    const pageNumber = Number(param(params, "PageNumber") ?? "1");
    const pageSize = Number(param(params, "PageSize") ?? "50");
    const items = [...this.networks.values()].filter(
      (item) =>
        (vpcId === undefined || item.vpcId === vpcId) &&
        (name === undefined || item.name === name),
    );
    const start = (pageNumber - 1) * pageSize;
    const page = items.slice(start, start + pageSize);
    return ok({
      TotalCount: items.length,
      PageNumber: pageNumber,
      PageSize: pageSize,
      Vpcs: {
        Vpc: page.map((item) => ({
          VpcId: item.vpcId,
          VpcName: item.name,
          CidrBlock: item.cidrBlock,
          Status: item.status,
          RegionId: item.regionId,
          VRouterId: item.routerId,
          CreationTime: "2026-09-02T00:00:00Z",
          Tags: {
            Tag: Object.entries(item.tags).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          },
        })),
      },
    });
  }

  private deleteVpc(params: RpcParams): ProtocolResponse {
    const vpcId = param(params, "VpcId");
    if (vpcId === undefined) return errorBody("MissingParameter", "VpcId");
    const children = [...this.vswitches.values()].filter(
      (item) => item.vpcId === vpcId,
    );
    if (children.length > 0) {
      return errorBody(
        "DependencyViolation.VSwitch",
        "The VPC still contains vSwitches",
      );
    }
    this.networks.delete(vpcId);
    return ok({});
  }

  private createVSwitch(params: RpcParams): ProtocolResponse {
    const vpcId = param(params, "VpcId");
    if (vpcId === undefined) return errorBody("MissingParameter", "VpcId");
    const pending = [...this.vswitches.values()].some(
      (item) => item.vpcId === vpcId && item.status === "Pending",
    );
    if (this.createVSwitchBusy || pending) {
      return errorBody(
        "IncorrectVSwitchStatus",
        "VSwitch creation simultaneously is not supported.",
      );
    }
    const vSwitchId = this.nextId("vsw-test");
    this.vswitches.set(vSwitchId, {
      vSwitchId,
      vpcId,
      name: param(params, "VSwitchName") ?? vSwitchId,
      cidrBlock: param(params, "CidrBlock") ?? "10.0.0.0/24",
      zoneId: param(params, "ZoneId") ?? `${this.regionId}a`,
      status: "Available",
      tags: tagsFrom(params),
    });
    return ok({ VSwitchId: vSwitchId });
  }

  private describeVSwitches(params: RpcParams): ProtocolResponse {
    const vpcId = param(params, "VpcId");
    const name = param(params, "VSwitchName");
    const items = [...this.vswitches.values()].filter(
      (item) =>
        (vpcId === undefined || item.vpcId === vpcId) &&
        (name === undefined || item.name === name),
    );
    return ok({
      TotalCount: items.length,
      VSwitches: {
        VSwitch: items.map((item) => ({
          VSwitchId: item.vSwitchId,
          VSwitchName: item.name,
          VpcId: item.vpcId,
          CidrBlock: item.cidrBlock,
          ZoneId: item.zoneId,
          Status: item.status,
        })),
      },
    });
  }

  private describeVSwitchAttributes(params: RpcParams): ProtocolResponse {
    const vSwitchId = param(params, "VSwitchId");
    const item =
      vSwitchId === undefined ? undefined : this.vswitches.get(vSwitchId);
    if (item === undefined) return ok({});
    return ok({
      VSwitchId: item.vSwitchId,
      VSwitchName: item.name,
      VpcId: item.vpcId,
      CidrBlock: item.cidrBlock,
      ZoneId: item.zoneId,
      Status: item.status,
      AvailableIpAddressCount: 4092,
      CreationTime: "2026-09-02T00:00:00Z",
      Tags: {
        Tag: Object.entries(item.tags).map(([Key, Value]) => ({ Key, Value })),
      },
    });
  }

  private deleteVSwitch(params: RpcParams): ProtocolResponse {
    const vSwitchId = param(params, "VSwitchId");
    if (vSwitchId === undefined)
      return errorBody("MissingParameter", "VSwitchId");
    const liveTair = [...this.tair.values()].some(
      (item) => item.vSwitchId === vSwitchId && item.status !== "Destroyed",
    );
    const hold = this.kvstoreHolds.get(vSwitchId) ?? 0;
    if (liveTair || hold > 0) {
      if (!liveTair && hold > 0) this.kvstoreHolds.set(vSwitchId, hold - 1);
      return errorBody(
        "DependencyViolation.Kvstore",
        `The specified resource of [${vSwitchId}] depends on [kvstore], so the operation cannot be completed.`,
      );
    }
    const eni = this.enis.find((item) => item.vSwitchId === vSwitchId);
    if (eni !== undefined) {
      const hold = this.eniHolds.get(vSwitchId) ?? this.eniHoldAfterDelete;
      if (hold > 0) {
        this.eniHolds.set(vSwitchId, hold - 1);
        if (hold - 1 <= 0) {
          this.enis.splice(
            0,
            this.enis.length,
            ...this.enis.filter((item) => item.vSwitchId !== vSwitchId),
          );
        }
        this.eniDependencyRejections += 1;
        return errorBody(
          "DependencyViolation.NetworkInterface",
          `The specified resource of [${vSwitchId}] depends on network interfaces.`,
        );
      }
    }
    this.vswitches.delete(vSwitchId);
    return ok({});
  }

  private findTairByToken(token: string | undefined): TairRecord | undefined {
    if (token === undefined) return undefined;
    return [...this.tair.values()].find((item) => item.token === token);
  }

  private findTairByName(name: string | undefined): TairRecord | undefined {
    if (name === undefined) return undefined;
    return [...this.tair.values()].find(
      (item) => item.name === name && item.status !== "Destroyed",
    );
  }

  private createTair(
    params: RpcParams,
    fault?: ScriptedFault,
  ): ProtocolResponse {
    const token = param(params, "Token");
    const existing =
      this.findTairByToken(token) ??
      this.findTairByName(param(params, "InstanceName"));
    if (existing !== undefined && existing.status !== "Destroyed") {
      if (fault?.code === "CanNotAcquireLock") {
        return errorBody(
          "CanNotAcquireLock",
          "Can't acquire lock for this operation.",
        );
      }
      return ok({
        InstanceId: existing.instanceId,
        InstanceName: existing.name,
        InstanceStatus: existing.status,
      });
    }
    const instanceId = this.nextId("r-test");
    const name = param(params, "InstanceName") ?? instanceId;
    const vSwitchId = param(params, "VSwitchId");
    const record: TairRecord = {
      instanceClass: param(params, "InstanceClass") ?? "redis.test",
      instanceId,
      name,
      status: "Creating",
      token,
      vpcId: param(params, "VpcId"),
      vSwitchId,
      regionId: param(params, "RegionId") ?? this.regionId,
      ssl: "Disable",
      vpcAuthMode: "Close",
      evictionPolicy: "volatile-lru",
      tags: tagsFrom(params),
      releaseProtection: false,
      connectionDomain: `${instanceId}.redis.rds.aliyuncs.com`,
      port: 6379,
      describes: 0,
    };
    this.tair.set(instanceId, record);
    if (vSwitchId !== undefined) {
      this.kvstoreHolds.set(vSwitchId, this.tairKvstoreHoldAfterDestroy);
    }
    if (fault?.code === "CanNotAcquireLock" && fault.accept !== false) {
      return errorBody(
        "CanNotAcquireLock",
        "Can't acquire lock for this operation.",
      );
    }
    return ok({
      InstanceId: instanceId,
      InstanceName: name,
      InstanceStatus: "Creating",
      ConnectionDomain: record.connectionDomain,
      Port: record.port,
      VpcId: record.vpcId,
      VSwitchId: record.vSwitchId,
      RegionId: record.regionId,
    });
  }

  private promoteTair(record: TairRecord): void {
    if (record.status !== "Creating") return;
    record.describes += 1;
    if (record.describes >= this.tairDescribesUntilNormal) {
      record.status = "Normal";
    }
  }

  private describeTair(params: RpcParams, overview: boolean): ProtocolResponse {
    const instanceIds = (param(params, "InstanceIds") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const search = param(params, "InstanceName") ?? param(params, "SearchKey");
    const pageNumber = Number(param(params, "PageNumber") ?? "1");
    const pageSize = Number(param(params, "PageSize") ?? "50");
    if (!overview && this.tairDetailReadOmissions > 0) {
      this.tairDetailReadOmissions -= 1;
      return ok({
        Instances: { KVStoreInstance: [] },
        TotalCount: 0,
        PageNumber: pageNumber,
        PageSize: pageSize,
      });
    }
    const visible = [...this.tair.values()].filter((item) => {
      if (item.status === "Destroyed") return false;
      if (!overview && item.status === "Released") return false;
      if (instanceIds.length > 0 && !instanceIds.includes(item.instanceId)) {
        return false;
      }
      if (search !== undefined && item.name !== search) return false;
      return true;
    });
    const start = (pageNumber - 1) * pageSize;
    const page = visible.slice(start, start + pageSize);
    const rows = page.map((item) => {
      this.promoteTair(item);
      return {
        InstanceId: item.instanceId,
        InstanceName: item.name,
        InstanceStatus: item.status,
        VpcId: item.vpcId,
        VSwitchId: item.vSwitchId,
        RegionId: item.regionId,
        ConnectionDomain: item.connectionDomain,
        Port: item.port,
        VpcAuthMode: item.vpcAuthMode,
      };
    });
    if (overview) {
      return ok({ Instances: rows, TotalCount: visible.length });
    }
    return ok({
      Instances: { KVStoreInstance: rows },
      TotalCount: visible.length,
      PageNumber: pageNumber,
      PageSize: pageSize,
    });
  }

  private describeTairAttribute(
    params: RpcParams,
    fault?: ScriptedFault,
  ): ProtocolResponse {
    const instanceId = param(params, "InstanceId");
    const record =
      instanceId === undefined ? undefined : this.tair.get(instanceId);
    if (
      record !== undefined &&
      record.status !== "Released" &&
      record.status !== "Destroyed" &&
      this.tairDetailReadOmissions > 0
    ) {
      this.tairDetailReadOmissions -= 1;
      return {
        statusCode: 404,
        body: {
          Code: "InvalidInstanceId.NotFound",
          RequestId: requestId(),
        },
      };
    }
    if (
      record === undefined ||
      record.status === "Released" ||
      record.status === "Destroyed"
    ) {
      return {
        statusCode: 404,
        body: { Code: "InvalidInstanceId.NotFound", RequestId: requestId() },
      };
    }
    this.promoteTair(record);
    const omitIdentity =
      fault?.omitIdentity === true ||
      (record.status === "Creating" && this.omitCreatingIdentityReads > 0);
    if (record.status === "Creating" && this.omitCreatingIdentityReads > 0) {
      this.omitCreatingIdentityReads -= 1;
    }
    return ok({
      Instances: {
        DBInstanceAttribute: [
          {
            ...(omitIdentity
              ? {}
              : { InstanceId: record.instanceId, InstanceName: record.name }),
            InstanceClass: record.instanceClass,
            InstanceStatus: record.status,
            VpcId: record.vpcId,
            VSwitchId: record.vSwitchId,
            RegionId: record.regionId,
            ConnectionDomain: record.connectionDomain,
            Port: record.port,
            VpcAuthMode: record.vpcAuthMode,
            InstanceReleaseProtection: record.releaseProtection,
            CreateTime: "2026-09-02T00:00:00Z",
            Tags: {
              Tag: Object.entries(record.tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            },
          },
        ],
      },
    });
  }

  private describeTairSsl(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    return ok({
      InstanceId: record?.instanceId,
      SSLEnabled: record?.ssl ?? "Disable",
    });
  }

  private describeTairConfig(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    return ok({
      Config: JSON.stringify({
        EvictionPolicy: record?.evictionPolicy ?? "volatile-lru",
      }),
    });
  }

  private modifyTairSsl(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    if (record === undefined) {
      return errorBody("InvalidInstanceId.NotFound", "Instance not found");
    }
    if (this.tairSslRejects > 0) {
      this.tairSslRejects -= 1;
      return errorBody(
        "IncorrectDBInstanceState",
        "The instance is not in a ready state for SSL modification.",
      );
    }
    record.ssl =
      param(params, "SSLEnabled") === "Enable" ? "Enable" : "Disable";
    return ok({});
  }

  private modifyTairAuth(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    if (record === undefined) {
      return errorBody("InvalidInstanceId.NotFound", "Instance not found");
    }
    if (record.status !== "Normal") {
      return errorBody("IncorrectDBInstanceState", "Instance is not ready");
    }
    record.vpcAuthMode = param(params, "VpcAuthMode") ?? record.vpcAuthMode;
    return ok({});
  }

  private modifyTairConfig(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    if (record === undefined) {
      return errorBody("InvalidInstanceId.NotFound", "Instance not found");
    }
    if (record.status !== "Normal") {
      return errorBody("IncorrectDBInstanceState", "Instance is not ready");
    }
    const raw = param(params, "Config");
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const policy = parsed["maxmemory-policy"] ?? parsed.EvictionPolicy;
        if (typeof policy === "string") record.evictionPolicy = policy;
      } catch {
        return errorBody("InvalidParameter", "Config");
      }
    }
    return ok({});
  }

  private modifyTairAttribute(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    if (record === undefined) {
      return errorBody("InvalidInstanceId.NotFound", "Instance not found");
    }
    const name = param(params, "InstanceName");
    if (name !== undefined) record.name = name;
    const protection = param(params, "InstanceReleaseProtection");
    if (protection !== undefined)
      record.releaseProtection = protection === "true";
    return ok({});
  }

  private deleteTair(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    if (record === undefined || record.status === "Destroyed") {
      return errorBody("InvalidInstanceId.NotFound", "Instance not found");
    }
    record.status = "Released";
    return ok({});
  }

  private destroyTair(params: RpcParams): ProtocolResponse {
    const record = this.tair.get(param(params, "InstanceId") ?? "");
    if (record === undefined || record.status === "Destroyed") {
      return errorBody("InvalidInstanceId.NotFound", "Instance not found");
    }
    if (record.status !== "Released") {
      return errorBody(
        "IncorrectInstanceStatus",
        "DestroyInstance requires a recycle-bin instance",
      );
    }
    record.status = "Destroyed";
    return ok({});
  }

  private listTagResources(params: RpcParams): ProtocolResponse {
    const resourceId =
      param(params, "ResourceId.1") ?? param(params, "ResourceId");
    const rds = resourceId === undefined ? undefined : this.rds.get(resourceId);
    const tair =
      resourceId === undefined ? undefined : this.tair.get(resourceId);
    const tags = rds?.tags ?? tair?.tags ?? {};
    return ok({
      TagResources: {
        TagResource: Object.entries(tags).map(([TagKey, TagValue]) => ({
          TagKey,
          TagValue,
          ResourceId: resourceId,
        })),
      },
    });
  }

  private tagResources(params: RpcParams, remove: boolean): ProtocolResponse {
    const resourceId =
      param(params, "ResourceId.1") ??
      param(params, "ResourceIds.1") ??
      param(params, "ResourceId");
    const next = remove ? {} : tagsFrom(params);
    const removedKeys = Object.entries(params)
      .filter(
        ([key]) => /^TagKey\.\d+$/i.test(key) || /^TagKeys\.\d+$/i.test(key),
      )
      .map(([, value]) => value);
    const apply = (tags: Record<string, string>) => {
      if (remove) {
        for (const key of removedKeys) delete tags[key];
        return;
      }
      Object.assign(tags, next);
    };
    if (resourceId !== undefined && this.tair.has(resourceId)) {
      apply(this.tair.get(resourceId)!.tags);
    }
    if (resourceId !== undefined && this.rds.has(resourceId)) {
      apply(this.rds.get(resourceId)!.tags);
    }
    if (resourceId !== undefined && this.networks.has(resourceId)) {
      apply(this.networks.get(resourceId)!.tags);
    }
    if (resourceId !== undefined && this.vswitches.has(resourceId)) {
      apply(this.vswitches.get(resourceId)!.tags);
    }
    return ok({});
  }

  private createRds(
    params: RpcParams,
    fault?: ScriptedFault,
  ): ProtocolResponse {
    const clientToken = param(params, "ClientToken");
    const existing = [...this.rds.values()].find(
      (item) =>
        clientToken !== undefined &&
        item.clientToken === clientToken &&
        item.regionId === (params.RegionId ?? this.regionId),
    );
    if (existing !== undefined) {
      return ok({ DBInstanceId: existing.instanceId });
    }
    const instanceId = this.nextId("rm-test");
    const vSwitchId = param(params, "VSwitchId") ?? param(params, "VSwitchIds");
    this.rds.set(instanceId, {
      regionId: params.RegionId ?? this.regionId,
      engine: param(params, "Engine") ?? "PostgreSQL",
      engineVersion: params.EngineVersion,
      instanceClass: params.DBInstanceClass ?? "pg.test",
      storage: Number(params.DBInstanceStorage ?? 20),
      storageType: params.DBInstanceStorageType,
      category: params.Category,
      deletionProtection: false,
      ssl: { SSLEnabled: "off" },
      sslReads: 0,
      instanceId,
      name: param(params, "DBInstanceDescription") ?? instanceId,
      status: "Creating",
      clientToken,
      vpcId: param(params, "VPCId") ?? param(params, "VpcId"),
      vSwitchId,
      tags: tagsFrom(params),
      describes: 0,
    });
    if (fault?.accept === true) {
      return {
        ...errorBody(fault.code, fault.code),
        statusCode: fault.statusCode ?? 400,
      };
    }
    return ok({ DBInstanceId: instanceId });
  }

  private promoteRds(record: RdsRecord): void {
    if (record.status === "Modifying") {
      if (++record.describes >= 3) {
        record.pendingSpec?.();
        record.pendingSpec = undefined;
        record.status = "Running";
      }
      return;
    }
    if (record.status !== "Creating") return;
    record.describes += 1;
    if (record.describes >= this.rdsDescribesUntilRunning)
      record.status = "Running";
  }

  private describeRds(params: RpcParams): ProtocolResponse {
    const search = param(params, "SearchKey");
    const items = [...this.rds.values()].filter(
      (item) =>
        item.status !== "Deleting" &&
        (!params.RegionId || item.regionId === params.RegionId) &&
        (!params.DBInstanceId || item.instanceId === params.DBInstanceId) &&
        (search === undefined || item.name === search),
    );
    const pageNumber = Number(params.PageNumber ?? 1);
    const pageSize = Number(params.PageSize ?? 100);
    return ok({
      TotalRecordCount: items.length,
      PageNumber: pageNumber,
      PageRecordCount: pageSize,
      Items: {
        DBInstance: items
          .slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
          .map((item) => {
            this.promoteRds(item);
            return {
              DBInstanceId: item.instanceId,
              DBInstanceDescription: item.name,
              DBInstanceStatus: item.status,
            };
          }),
      },
    });
  }

  private describeRdsAttribute(params: RpcParams): ProtocolResponse {
    const record = this.rds.get(param(params, "DBInstanceId") ?? "");
    if (record === undefined) {
      return {
        statusCode: 404,
        body: {
          Code: "InvalidDBInstanceName.NotFound",
          RequestId: requestId(),
        },
      };
    }
    this.promoteRds(record);
    return ok({
      Items: {
        DBInstanceAttribute: [
          {
            RegionId: record.regionId,
            DBInstanceClass: record.instanceClass,
            DBInstanceStorage: record.storage,
            DBInstanceStorageType: record.storageType,
            EngineVersion: record.engineVersion,
            Category: record.category,
            ServerlessConfig: record.serverless,
            Engine: record.engine,
            DBInstanceId: record.instanceId,
            DBInstanceDescription: record.name,
            DBInstanceStatus: record.status,
            VpcId: record.vpcId,
            VSwitchId: record.vSwitchId,
            DeletionProtection: record.deletionProtection,
          },
        ],
      },
    });
  }

  private describeRdsNet(params: RpcParams): ProtocolResponse {
    const record = this.rds.get(param(params, "DBInstanceId") ?? "");
    if (record === undefined)
      return ok({ DBInstanceNetInfos: { DBInstanceNetInfo: [] } });
    return ok({
      DBInstanceNetInfos: {
        DBInstanceNetInfo: [
          ...(this.rdsPublicEndpoint
            ? [
                {
                  ConnectionString: `${record.instanceId}.public.rds.aliyuncs.com`,
                  ConnectionStringType: "Normal",
                  IPType: "Public",
                  IPAddress: "192.0.2.1",
                  Port: "5432",
                },
              ]
            : []),
          {
            ConnectionString: `${record.instanceId}.pg.rds.aliyuncs.com`,
            ConnectionStringType: "Normal",
            IPAddress: "10.40.0.8",
            IPType: "Private",
            Port: "5432",
          },
        ],
      },
    });
  }

  private deleteRds(params: RpcParams): ProtocolResponse {
    const record = this.rds.get(param(params, "DBInstanceId") ?? "");
    if (record === undefined) {
      return errorBody("InvalidDBInstanceId.NotFound", "Instance not found");
    }
    if (record.deletionProtection)
      return errorBody("DeletionProtection", "protected");
    if (record.status === "Creating") {
      return errorBody(
        "IncorrectDBInstanceState",
        "The instance is still Creating.",
      );
    }
    if (record.vSwitchId !== undefined) {
      this.enis.push({
        id: this.nextId("eni-test"),
        vSwitchId: record.vSwitchId,
        reason: "rds",
      });
    }
    this.rds.delete(record.instanceId);
    return ok({});
  }

  private ackTags(body: Record<string, unknown>): Record<string, string> {
    if (!Array.isArray(body.tags)) return {};
    return Object.fromEntries(
      body.tags.flatMap((item) => {
        if (item === null || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const key = record.key ?? record.Key;
        const value = record.value ?? record.Value;
        return typeof key === "string" && typeof value === "string"
          ? [[key, value] as const]
          : [];
      }),
    );
  }

  private ackBody(cluster: AckRecord): Record<string, unknown> {
    return {
      cluster_id: cluster.clusterId,
      name: cluster.name,
      state: cluster.state,
      vpc_id: cluster.vpcId,
      vswitch_id: cluster.vSwitchIds.join(","),
      current_version: cluster.currentVersion,
      deletion_protection: cluster.deletionProtection,
      tags: Object.entries(cluster.tags).map(([key, value]) => ({
        key,
        value,
      })),
    };
  }

  private createAck(body: Record<string, unknown>): ProtocolResponse {
    const clusterId = this.nextId("c-test");
    const vswitchIds = Array.isArray(body.vswitch_ids)
      ? body.vswitch_ids.map(String)
      : [];
    this.ack.set(clusterId, {
      clusterId,
      name: String(body.name ?? clusterId),
      state: "running",
      vpcId: typeof body.vpcid === "string" ? body.vpcid : undefined,
      vSwitchIds: vswitchIds,
      tags: this.ackTags(body),
      currentVersion:
        typeof body.kubernetes_version === "string"
          ? body.kubernetes_version
          : "1.32.1-aliyun.1",
      deletionProtection: body.deletion_protection === true,
    });
    return {
      statusCode: 200,
      body: {
        cluster_id: clusterId,
        task_id: this.nextId("T-test"),
        request_id: requestId(),
      },
    };
  }

  private describeAck(clusterId: string): ProtocolResponse {
    const cluster = this.ack.get(clusterId);
    if (cluster === undefined) {
      return {
        statusCode: 404,
        body: { code: "ErrorClusterNotFound", request_id: requestId() },
      };
    }
    return { statusCode: 200, body: this.ackBody(cluster) };
  }

  private modifyAck(
    clusterId: string,
    body: Record<string, unknown>,
  ): ProtocolResponse {
    const cluster = this.ack.get(clusterId);
    if (cluster === undefined) {
      return {
        statusCode: 404,
        body: { code: "ErrorClusterNotFound", request_id: requestId() },
      };
    }
    return this.roa.task(() => {
      if (typeof body.deletion_protection === "boolean")
        cluster.deletionProtection = body.deletion_protection;
    });
  }

  private tagAck(
    body: Record<string, unknown>,
    remove: boolean,
  ): ProtocolResponse {
    const ids = Array.isArray(body.resource_ids)
      ? body.resource_ids.map(String)
      : [];
    const next = this.ackTags(body);
    const removed = Array.isArray(body.tag_keys)
      ? body.tag_keys.map(String)
      : [];
    for (const clusterId of ids) {
      const cluster = this.ack.get(clusterId);
      if (cluster === undefined) continue;
      if (remove) {
        for (const key of removed) delete cluster.tags[key];
      } else {
        Object.assign(cluster.tags, next);
      }
    }
    return { statusCode: 200, body: { request_id: requestId() } };
  }

  private deleteAck(clusterId: string): ProtocolResponse {
    const cluster = this.ack.get(clusterId);
    if (cluster === undefined) {
      return {
        statusCode: 404,
        body: { code: "ErrorClusterNotFound", request_id: requestId() },
      };
    }
    if (cluster.deletionProtection)
      return { statusCode: 400, body: { code: "DeletionProtection" } };
    for (const vSwitchId of cluster.vSwitchIds) {
      this.enis.push({
        id: this.nextId("eni-test"),
        vSwitchId,
        reason: "ack",
      });
    }
    this.ack.delete(clusterId);
    return { statusCode: 200, body: { request_id: requestId() } };
  }

  drainEnis(reason?: EniRecord["reason"]): void {
    if (reason === undefined) {
      this.enis.length = 0;
      return;
    }
    for (let index = this.enis.length - 1; index >= 0; index -= 1) {
      if (this.enis[index]?.reason === reason) this.enis.splice(index, 1);
    }
  }

  private getAcrLinks(params: RpcParams): ProtocolResponse {
    const instanceId = param(params, "InstanceId");
    const links = this.acrLinks.filter(
      (item) => item.instanceId === instanceId,
    );
    return ok({
      IsSuccess: true,
      Code: "success",
      LinkedVpcs: links.map((item) => ({
        VpcId: item.vpcId,
        VswitchId: item.vswitchId,
        Status: item.status,
        DefaultAccess: false,
        Ip: "10.40.0.20",
      })),
      Domains: [`${instanceId}.registry.aliyuncs.com`],
    });
  }

  private createAcrLink(params: RpcParams): ProtocolResponse {
    this.acrLinks.push({
      instanceId: param(params, "InstanceId") ?? "cri-retained",
      vpcId: param(params, "VpcId") ?? "",
      vswitchId: param(params, "VswitchId") ?? param(params, "VSwitchId") ?? "",
      status: "RUNNING",
    });
    return ok({ IsSuccess: true, Code: "success" });
  }

  private deleteAcrLink(params: RpcParams): ProtocolResponse {
    const instanceId = param(params, "InstanceId");
    const vpcId = param(params, "VpcId");
    const vswitchId = param(params, "VswitchId") ?? param(params, "VSwitchId");
    const index = this.acrLinks.findIndex(
      (item) =>
        item.instanceId === instanceId &&
        item.vpcId === vpcId &&
        item.vswitchId === vswitchId,
    );
    if (index >= 0) this.acrLinks.splice(index, 1);
    return ok({ IsSuccess: true, Code: "success" });
  }
}
