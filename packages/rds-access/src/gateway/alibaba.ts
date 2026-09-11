import CredentialImport, { CLIProfileCredentialsProvider } from "@alicloud/credentials";
import EcsClientImport, * as ECS from "@alicloud/ecs20140526";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import RdsClientImport, * as RDS from "@alicloud/rds20140815";
import VpcClientImport, * as VPC from "@alicloud/vpc20160428";
import VpcPeerClientImport, * as VpcPeer from "@alicloud/vpcpeer20220101";
import { Context, Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { AccessError, Group } from "../model.ts";
import type {
  GatewayInstanceInfo,
  GatewayTopology,
  PeerConnectionInfo,
  RdsInstanceInfo,
  RouteEntryInfo,
  RoutePlan,
  VpcInfo,
  VSwitchInfo,
} from "./model.ts";

// Native ESM sees the generated SDKs' CommonJS default as a nested export.
const interopDefault = <T>(value: T | { readonly default: T }): T =>
  typeof value === "object" && value !== null && "default" in value ? value.default : value;
const RdsClient = interopDefault(RdsClientImport);
const EcsClient = interopDefault(EcsClientImport);
const VpcClient = interopDefault(VpcClientImport);
const VpcPeerClient = interopDefault(VpcPeerClientImport);
const Credential = interopDefault(CredentialImport);

/** Narrow SDK surface so tests can simulate Alibaba responses without a network. */
export interface GatewaySdk {
  describeDBInstanceAttribute(request: RDS.DescribeDBInstanceAttributeRequest): Promise<unknown>;
  describeDBInstanceNetInfo(request: RDS.DescribeDBInstanceNetInfoRequest): Promise<unknown>;
  describeDatabases(request: RDS.DescribeDatabasesRequest): Promise<unknown>;
  describeAccounts(request: RDS.DescribeAccountsRequest): Promise<unknown>;
  describeDBInstanceIPArrayList(
    request: RDS.DescribeDBInstanceIPArrayListRequest,
  ): Promise<unknown>;
  createAccount(request: RDS.CreateAccountRequest): Promise<unknown>;
  modifySecurityIps(request: RDS.ModifySecurityIpsRequest): Promise<unknown>;
  describeInstances(request: ECS.DescribeInstancesRequest): Promise<unknown>;
  describeVSwitchAttributes(request: VPC.DescribeVSwitchAttributesRequest): Promise<unknown>;
  describeVpcs(request: VPC.DescribeVpcsRequest): Promise<unknown>;
  describeRouteEntryList(request: VPC.DescribeRouteEntryListRequest): Promise<unknown>;
  createRouteEntry(request: VPC.CreateRouteEntryRequest): Promise<unknown>;
  listVpcPeerConnections(request: VpcPeer.ListVpcPeerConnectionsRequest): Promise<unknown>;
  createVpcPeerConnection(request: VpcPeer.CreateVpcPeerConnectionRequest): Promise<unknown>;
  acceptVpcPeerConnection(request: VpcPeer.AcceptVpcPeerConnectionRequest): Promise<unknown>;
}

const InstanceResponse = Schema.Struct({
  body: Schema.Struct({
    items: Schema.Struct({
      DBInstanceAttribute: Schema.Array(
        Schema.Struct({
          DBInstanceId: Schema.String,
          regionId: Schema.String,
          engine: Schema.optional(Schema.String),
          engineVersion: Schema.optional(Schema.String),
          vpcId: Schema.optional(Schema.String),
          vSwitchId: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});

const EndpointResponse = Schema.Struct({
  body: Schema.Struct({
    DBInstanceNetInfos: Schema.Struct({
      DBInstanceNetInfo: Schema.Array(
        Schema.Struct({
          connectionStringType: Schema.optional(Schema.String),
          IPType: Schema.optional(Schema.String),
          connectionString: Schema.optional(Schema.String),
          IPAddress: Schema.optional(Schema.String),
          port: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});

const DatabasesResponse = Schema.Struct({
  body: Schema.Struct({
    databases: Schema.Struct({
      Database: Schema.Array(Schema.Struct({ DBName: Schema.optional(Schema.String) })),
    }),
  }),
});

const AccountsResponse = Schema.Struct({
  body: Schema.Struct({
    accounts: Schema.Struct({
      DBInstanceAccount: Schema.Array(
        Schema.Struct({
          accountName: Schema.optional(Schema.String),
          accountType: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});

const GroupsResponse = Schema.Struct({
  body: Schema.Struct({
    items: Schema.Struct({ DBInstanceIPArray: Schema.Array(Group) }),
  }),
});

const InstancesResponse = Schema.Struct({
  body: Schema.Struct({
    instances: Schema.Struct({
      instance: Schema.Array(
        Schema.Struct({
          instanceId: Schema.String,
          status: Schema.optional(Schema.String),
          vpcAttributes: Schema.optional(
            Schema.Struct({
              vpcId: Schema.optional(Schema.String),
              vSwitchId: Schema.optional(Schema.String),
              privateIpAddress: Schema.optional(
                Schema.Struct({ ipAddress: Schema.optional(Schema.Array(Schema.String)) }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
});

const VpcResponse = Schema.Struct({
  body: Schema.Struct({
    vpcs: Schema.Struct({
      vpc: Schema.Array(
        Schema.Struct({
          vpcId: Schema.optional(Schema.String),
          cidrBlock: Schema.optional(Schema.String),
          regionId: Schema.optional(Schema.String),
          ownerId: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
        }),
      ),
    }),
  }),
});

const VSwitchResponse = Schema.Struct({
  body: Schema.Struct({
    vSwitchId: Schema.optional(Schema.String),
    vpcId: Schema.optional(Schema.String),
    routeTable: Schema.optional(Schema.Struct({ routeTableId: Schema.optional(Schema.String) })),
  }),
});

const RoutesResponse = Schema.Struct({
  body: Schema.Struct({
    routeEntrys: Schema.optional(
      Schema.Struct({
        routeEntry: Schema.optional(
          Schema.Array(
            Schema.Struct({
              routeEntryId: Schema.optional(Schema.String),
              destinationCidrBlock: Schema.optional(Schema.String),
              status: Schema.optional(Schema.String),
              nextHops: Schema.optional(
                Schema.Struct({
                  nextHop: Schema.optional(
                    Schema.Array(
                      Schema.Struct({
                        nextHopId: Schema.optional(Schema.String),
                        nextHopType: Schema.optional(Schema.String),
                      }),
                    ),
                  ),
                }),
              ),
            }),
          ),
        ),
      }),
    ),
  }),
});

const PeeringsResponse = Schema.Struct({
  body: Schema.Struct({
    vpcPeerConnects: Schema.optional(
      Schema.Array(
        Schema.Struct({
          instanceId: Schema.String,
          name: Schema.optional(Schema.String),
          status: Schema.optional(Schema.String),
          acceptingRegionId: Schema.optional(Schema.String),
          acceptingOwnerUid: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
          vpc: Schema.optional(
            Schema.Struct({
              vpcId: Schema.optional(Schema.String),
              ipv4Cidrs: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
          acceptingVpc: Schema.optional(
            Schema.Struct({
              vpcId: Schema.optional(Schema.String),
              ipv4Cidrs: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
        }),
      ),
    ),
  }),
});

const CreatePeeringResponse = Schema.Struct({
  body: Schema.Struct({ instanceId: Schema.optional(Schema.String) }),
});

const decodeResponse = <A>(
  schema: Schema.Decoder<A>,
  operation: string,
  message: string,
): ((input: unknown) => Effect.Effect<A, AccessError>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (input) =>
    decode(input).pipe(Effect.mapError(() => new AccessError({ operation, message })));
};

const sdkCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => {
      const candidate = Predicate.isObject(cause) ? cause.code : undefined;
      const code =
        typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(candidate)
          ? candidate
          : undefined;
      return new AccessError({
        operation,
        code,
        message:
          `${operation} failed${code ? ` (${code})` : ""}. ` +
          "Check the Alibaba profile permissions and the gateway topology.",
      });
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: "25 seconds",
      orElse: () =>
        Effect.fail(
          new AccessError({
            operation,
            message: `${operation} timed out. Inspect the current state before retrying.`,
          }),
        ),
    }),
  );

export interface WhitelistGroups {
  readonly all: ReadonlyArray<Group>;
  readonly network: ReadonlyArray<Group>;
}

export class GatewayApi extends Context.Service<
  GatewayApi,
  {
    readonly instance: (instanceId: string) => Effect.Effect<RdsInstanceInfo, AccessError>;
    readonly groups: (
      instanceId: string,
      networkType: string,
    ) => Effect.Effect<WhitelistGroups, AccessError>;
    readonly topology: (
      gatewayInstanceId?: string,
    ) => Effect.Effect<GatewayTopology, AccessError>;
    readonly vpc: (vpcId: string) => Effect.Effect<VpcInfo, AccessError>;
    readonly vSwitch: (vSwitchId: string) => Effect.Effect<VSwitchInfo, AccessError>;
    readonly peerings: (vpcIds: ReadonlyArray<string>) => Effect.Effect<
      ReadonlyArray<PeerConnectionInfo>,
      AccessError
    >;
    readonly routes: (
      routeTableId: string,
    ) => Effect.Effect<ReadonlyArray<RouteEntryInfo>, AccessError>;
    readonly createPeering: (options: {
      readonly name: string;
      readonly gatewayVpcId: string;
      readonly rdsVpcId: string;
      readonly acceptingAliUid: number | undefined;
    }) => Effect.Effect<string, AccessError>;
    readonly acceptPeering: (peeringId: string) => Effect.Effect<void, AccessError>;
    readonly createRoute: (route: RoutePlan) => Effect.Effect<void, AccessError>;
    readonly setWhitelistGroup: (options: {
      readonly instanceId: string;
      readonly groupName: string;
      readonly ip: string;
      readonly networkType: string;
    }) => Effect.Effect<void, AccessError>;
    readonly createAccount: (options: {
      readonly instanceId: string;
      readonly accountName: string;
      readonly password: Redacted.Redacted<string>;
    }) => Effect.Effect<void, AccessError>;
  }
>()("alibaba-rds-access/GatewayApi") {}

const asNumber = (value: number | string | undefined): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
};

const makeSdk = (options: { readonly regionId: string; readonly profile?: string }): GatewaySdk => {
  const credential =
    options.profile === undefined
      ? new Credential()
      : new Credential(
          null,
          CLIProfileCredentialsProvider.builder().withProfileName(options.profile).build(),
        );
  const config = new $OpenApiUtil.Config({
    regionId: options.regionId,
    credential,
    connectTimeout: 5_000,
    readTimeout: 20_000,
    userAgent: "alibaba-rds-access/0.1.0",
  });
  const rds = new RdsClient(config);
  const ecs = new EcsClient(config);
  const vpc = new VpcClient(config);
  const vpcPeer = new VpcPeerClient(config);
  return {
    describeDBInstanceAttribute: (request) => rds.describeDBInstanceAttribute(request),
    describeDBInstanceNetInfo: (request) => rds.describeDBInstanceNetInfo(request),
    describeDatabases: (request) => rds.describeDatabases(request),
    describeAccounts: (request) => rds.describeAccounts(request),
    describeDBInstanceIPArrayList: (request) => rds.describeDBInstanceIPArrayList(request),
    createAccount: (request) => rds.createAccount(request),
    modifySecurityIps: (request) => rds.modifySecurityIps(request),
    describeInstances: (request) => ecs.describeInstances(request),
    describeVSwitchAttributes: (request) => vpc.describeVSwitchAttributes(request),
    describeVpcs: (request) => vpc.describeVpcs(request),
    describeRouteEntryList: (request) => vpc.describeRouteEntryList(request),
    createRouteEntry: (request) => vpc.createRouteEntry(request),
    listVpcPeerConnections: (request) => vpcPeer.listVpcPeerConnections(request),
    createVpcPeerConnection: (request) => vpcPeer.createVpcPeerConnection(request),
    acceptVpcPeerConnection: (request) => vpcPeer.acceptVpcPeerConnection(request),
  };
};

export const gatewayApiLayer = (options: {
  readonly regionId: string;
  readonly profile?: string;
  readonly sdk?: GatewaySdk;
}) =>
  Layer.effect(
    GatewayApi,
    Effect.gen(function* () {
      const sdk =
        options.sdk ??
        (yield* Effect.try({
          try: () => makeSdk(options),
          catch: () =>
            new AccessError({
              message:
                "Could not load Alibaba credentials. Check ALIBABA_CLOUD_PROFILE or --profile.",
            }),
        }));

      const vpcInfo = Effect.fn("GatewayApi.vpc")(function* (vpcId: string) {
        const response = yield* sdkCall("DescribeVpcs", () =>
          sdk.describeVpcs(new VPC.DescribeVpcsRequest({ regionId: options.regionId, vpcId })),
        );
        const decoded = yield* decodeResponse(
          VpcResponse,
          "DescribeVpcs",
          "VPC returned incomplete details; nothing was changed.",
        )(response);
        const found = decoded.body.vpcs.vpc.filter((item) => item.vpcId === vpcId);
        if (found.length !== 1 || found[0].cidrBlock === undefined) {
          return yield* new AccessError({
            message: `Could not read VPC ${vpcId} in ${options.regionId}.`,
          });
        }
        return {
          vpcId,
          cidrBlock: found[0].cidrBlock,
          regionId: found[0].regionId ?? options.regionId,
          ownerId: asNumber(found[0].ownerId),
        } satisfies VpcInfo;
      });

      const switchInfo = Effect.fn("GatewayApi.vSwitch")(function* (vSwitchId: string) {
        const response = yield* sdkCall("DescribeVSwitchAttributes", () =>
          sdk.describeVSwitchAttributes(
            new VPC.DescribeVSwitchAttributesRequest({
              regionId: options.regionId,
              vSwitchId,
            }),
          ),
        );
        const decoded = yield* decodeResponse(
          VSwitchResponse,
          "DescribeVSwitchAttributes",
          "VPC returned incomplete vSwitch details; nothing was changed.",
        )(response);
        const body = decoded.body;
        if (
          body.vSwitchId !== vSwitchId ||
          body.vpcId === undefined ||
          body.routeTable?.routeTableId === undefined
        ) {
          return yield* new AccessError({
            message: `Could not resolve the route table for vSwitch ${vSwitchId}.`,
          });
        }
        return {
          vSwitchId,
          vpcId: body.vpcId,
          routeTableId: body.routeTable.routeTableId,
        } satisfies VSwitchInfo;
      });

      const instance = Effect.fn("GatewayApi.instance")(function* (instanceId: string) {
        const attributes = yield* sdkCall("DescribeDBInstanceAttribute", () =>
          sdk.describeDBInstanceAttribute(
            new RDS.DescribeDBInstanceAttributeRequest({ DBInstanceId: instanceId }),
          ),
        );
        const decoded = yield* decodeResponse(
          InstanceResponse,
          "DescribeDBInstanceAttribute",
          "RDS returned incomplete instance details; nothing was changed.",
        )(attributes);
        const found = decoded.body.items.DBInstanceAttribute;
        if (
          found.length !== 1 ||
          found[0].DBInstanceId !== instanceId ||
          found[0].regionId !== options.regionId
        ) {
          return yield* new AccessError({
            message: "RDS instance identity or region did not match; nothing was changed.",
          });
        }
        const attribute = found[0];
        if (attribute.vpcId === undefined || attribute.vSwitchId === undefined) {
          return yield* new AccessError({
            message:
              `Instance ${instanceId} has no VPC or vSwitch; only VPC deployments are supported.`,
          });
        }

        const [networks, databases, accounts] = yield* Effect.all([
          sdkCall("DescribeDBInstanceNetInfo", () =>
            sdk.describeDBInstanceNetInfo(
              new RDS.DescribeDBInstanceNetInfoRequest({ DBInstanceId: instanceId }),
            ),
          ),
          sdkCall("DescribeDatabases", () =>
            sdk.describeDatabases(
              new RDS.DescribeDatabasesRequest({ DBInstanceId: instanceId, pageSize: 100 }),
            ),
          ),
          sdkCall("DescribeAccounts", () =>
            sdk.describeAccounts(
              new RDS.DescribeAccountsRequest({ DBInstanceId: instanceId, pageSize: 100 }),
            ),
          ),
        ]);
        const decodedNetworks = yield* decodeResponse(
          EndpointResponse,
          "DescribeDBInstanceNetInfo",
          "RDS returned incomplete endpoint details; nothing was changed.",
        )(networks);
        const endpoints = decodedNetworks.body.DBInstanceNetInfos.DBInstanceNetInfo;
        const endpoint =
          endpoints.find(
            (item) => item.connectionStringType === "Normal" && item.IPType === "Private",
          ) ??
          endpoints.find(
            (item) => item.connectionStringType === "Normal" && item.IPType === "Inner",
          );
        if (
          endpoint === undefined ||
          endpoint.connectionString === undefined ||
          endpoint.IPAddress === undefined
        ) {
          return yield* new AccessError({
            message:
              `Instance ${instanceId} has no private endpoint; a private VPC endpoint is required.`,
          });
        }
        const decodedDatabases = yield* decodeResponse(
          DatabasesResponse,
          "DescribeDatabases",
          "RDS returned an incomplete database list; nothing was changed.",
        )(databases);
        const decodedAccounts = yield* decodeResponse(
          AccountsResponse,
          "DescribeAccounts",
          "RDS returned an incomplete account list; nothing was changed.",
        )(accounts);
        return {
          instanceId,
          regionId: options.regionId,
          engine: attribute.engine ?? "PostgreSQL",
          engineVersion: attribute.engineVersion,
          vpcId: attribute.vpcId,
          vSwitchId: attribute.vSwitchId,
          endpoint: {
            host: endpoint.connectionString,
            port: Number(endpoint.port ?? "5432"),
            ipAddress: endpoint.IPAddress,
          },
          databases: decodedDatabases.body.databases.Database.flatMap((item) =>
            item.DBName === undefined ? [] : [item.DBName],
          ),
          accounts: decodedAccounts.body.accounts.DBInstanceAccount.flatMap((item) =>
            item.accountName === undefined
              ? []
              : [{ name: item.accountName, type: item.accountType }],
          ),
        } satisfies RdsInstanceInfo;
      });

      const groups = Effect.fn("GatewayApi.groups")(function* (
        instanceId: string,
        networkType: string,
      ) {
        const all = yield* sdkCall("DescribeDBInstanceIPArrayList", () =>
          sdk.describeDBInstanceIPArrayList(
            new RDS.DescribeDBInstanceIPArrayListRequest({ DBInstanceId: instanceId }),
          ),
        );
        const network = yield* sdkCall("DescribeDBInstanceIPArrayList", () =>
          sdk.describeDBInstanceIPArrayList(
            new RDS.DescribeDBInstanceIPArrayListRequest({
              DBInstanceId: instanceId,
              whitelistNetworkType: networkType,
            }),
          ),
        );
        const allGroups = yield* decodeResponse(
          GroupsResponse,
          "DescribeDBInstanceIPArrayList",
          "RDS returned an incomplete allowlist; nothing was changed by this read.",
        )(all);
        const networkGroups = yield* decodeResponse(
          GroupsResponse,
          "DescribeDBInstanceIPArrayList",
          "RDS returned an incomplete allowlist; nothing was changed by this read.",
        )(network);
        return {
          all: allGroups.body.items.DBInstanceIPArray,
          network: networkGroups.body.items.DBInstanceIPArray,
        } satisfies WhitelistGroups;
      });

      const topology = Effect.fn("GatewayApi.topology")(function* (
        gatewayInstanceId?: string,
      ) {
        const instances = yield* sdkCall("DescribeInstances", () =>
          sdk.describeInstances(
            new ECS.DescribeInstancesRequest({
              regionId: options.regionId,
              ...(gatewayInstanceId === undefined
                ? {
                    tag: [
                      new ECS.DescribeInstancesRequestTag({
                        key: "application",
                        value: "agia-rds-gateway",
                      }),
                    ],
                    status: "Running",
                  }
                : { instanceIds: JSON.stringify([gatewayInstanceId]) }),
            }),
          ),
        );
        const decoded = yield* decodeResponse(
          InstancesResponse,
          "DescribeInstances",
          "ECS returned an incomplete instance list; nothing was changed.",
        )(instances);
        const found = decoded.body.instances.instance;
        if (found.length === 0) {
          return yield* new AccessError({
            message:
              gatewayInstanceId === undefined
                ? "No running gateway appliance found (tag application=agia-rds-gateway). Pass --gateway-instance-id."
                : `Gateway instance ${gatewayInstanceId} was not found in ${options.regionId}.`,
          });
        }
        if (found.length > 1) {
          return yield* new AccessError({
            message:
              `Found ${found.length} gateway appliances; pass --gateway-instance-id to disambiguate.`,
          });
        }
        const element = found[0];
        const vpcId = element.vpcAttributes?.vpcId;
        const vSwitchId = element.vpcAttributes?.vSwitchId;
        const privateIp = element.vpcAttributes?.privateIpAddress?.ipAddress?.[0];
        if (vpcId === undefined || vSwitchId === undefined || privateIp === undefined) {
          return yield* new AccessError({
            message: `Gateway instance ${element.instanceId} has no VPC private address.`,
          });
        }
        const gateway: GatewayInstanceInfo = {
          instanceId: element.instanceId,
          privateIp,
          vpcId,
          vSwitchId,
          status: element.status ?? "Unknown",
        };
        const [vpc, vSwitch] = yield* Effect.all([
          vpcInfo(vpcId),
          switchInfo(vSwitchId),
        ]);
        return { instance: gateway, vpc, vSwitch } satisfies GatewayTopology;
      });

      const peerings = Effect.fn("GatewayApi.peerings")(function* (
        vpcIds: ReadonlyArray<string>,
      ) {
        const response = yield* sdkCall("ListVpcPeerConnections", () =>
          sdk.listVpcPeerConnections(
            new VpcPeer.ListVpcPeerConnectionsRequest({
              regionId: options.regionId,
              vpcId: [...vpcIds],
            }),
          ),
        );
        const decoded = yield* decodeResponse(
          PeeringsResponse,
          "ListVpcPeerConnections",
          "VPC peering returned incomplete details; nothing was changed.",
        )(response);
        return (decoded.body.vpcPeerConnects ?? []).map(
          (peering) =>
            ({
              peeringId: peering.instanceId,
              name: peering.name,
              status: peering.status ?? "Unknown",
              requesterVpcId: peering.vpc?.vpcId ?? "",
              acceptingVpcId: peering.acceptingVpc?.vpcId ?? "",
              acceptingRegionId: peering.acceptingRegionId,
              acceptingOwnerUid: asNumber(peering.acceptingOwnerUid),
              requesterCidrs: peering.vpc?.ipv4Cidrs ?? [],
              acceptingCidrs: peering.acceptingVpc?.ipv4Cidrs ?? [],
            }) satisfies PeerConnectionInfo,
        );
      });

      const routes = Effect.fn("GatewayApi.routes")(function* (routeTableId: string) {
        const response = yield* sdkCall("DescribeRouteEntryList", () =>
          sdk.describeRouteEntryList(
            new VPC.DescribeRouteEntryListRequest({
              regionId: options.regionId,
              routeTableId,
              maxResult: 100,
            }),
          ),
        );
        const decoded = yield* decodeResponse(
          RoutesResponse,
          "DescribeRouteEntryList",
          "VPC returned an incomplete route table; nothing was changed.",
        )(response);
        return (decoded.body.routeEntrys?.routeEntry ?? []).flatMap((route) => {
          if (route.destinationCidrBlock === undefined) return [];
          const hop = route.nextHops?.nextHop?.[0];
          return [
            {
              routeEntryId: route.routeEntryId,
              destinationCidrBlock: route.destinationCidrBlock,
              nextHopId: hop?.nextHopId,
              nextHopType: hop?.nextHopType,
              status: route.status,
            } satisfies RouteEntryInfo,
          ];
        });
      });

      const createPeering = Effect.fn("GatewayApi.createPeering")(function* (input: {
        readonly name: string;
        readonly gatewayVpcId: string;
        readonly rdsVpcId: string;
        readonly acceptingAliUid: number | undefined;
      }) {
        const response = yield* sdkCall("CreateVpcPeerConnection", () =>
          sdk.createVpcPeerConnection(
            new VpcPeer.CreateVpcPeerConnectionRequest({
              regionId: options.regionId,
              vpcId: input.gatewayVpcId,
              acceptingVpcId: input.rdsVpcId,
              acceptingRegionId: options.regionId,
              ...(input.acceptingAliUid === undefined
                ? {}
                : { acceptingAliUid: input.acceptingAliUid }),
              name: input.name,
            }),
          ),
        );
        const decoded = yield* decodeResponse(
          CreatePeeringResponse,
          "CreateVpcPeerConnection",
          "VPC peering was created but its identifier was not returned; inspect the console.",
        )(response);
        if (decoded.body.instanceId === undefined) {
          return yield* new AccessError({
            message:
              "VPC peering was created but its identifier was not returned; inspect the console.",
          });
        }
        return decoded.body.instanceId;
      });

      const acceptPeering = Effect.fn("GatewayApi.acceptPeering")(function* (peeringId: string) {
        yield* sdkCall("AcceptVpcPeerConnection", () =>
          sdk.acceptVpcPeerConnection(
            new VpcPeer.AcceptVpcPeerConnectionRequest({
              regionId: options.regionId,
              instanceId: peeringId,
            }),
          ),
        );
      });

      const createRoute = Effect.fn("GatewayApi.createRoute")(function* (route: RoutePlan) {
        yield* sdkCall("CreateRouteEntry", () =>
          sdk.createRouteEntry(
            new VPC.CreateRouteEntryRequest({
              regionId: options.regionId,
              routeTableId: route.routeTableId,
              destinationCidrBlock: route.destinationCidrBlock,
              nextHopId: route.nextHopId,
              nextHopType: route.nextHopType,
              description: route.description,
            }),
          ),
        );
      });

      const setWhitelistGroup = Effect.fn("GatewayApi.setWhitelistGroup")(function* (input: {
        readonly instanceId: string;
        readonly groupName: string;
        readonly ip: string;
        readonly networkType: string;
      }) {
        yield* sdkCall("ModifySecurityIps", () =>
          sdk.modifySecurityIps(
            new RDS.ModifySecurityIpsRequest({
              DBInstanceId: input.instanceId,
              DBInstanceIPArrayName: input.groupName,
              securityIps: input.ip,
              modifyMode: "Cover",
              securityIPType: "IPv4",
              whitelistNetworkType: input.networkType,
            }),
          ),
        );
      });

      const createAccount = Effect.fn("GatewayApi.createAccount")(function* (input: {
        readonly instanceId: string;
        readonly accountName: string;
        readonly password: Redacted.Redacted<string>;
      }) {
        yield* sdkCall("CreateAccount", () =>
          sdk.createAccount(
            new RDS.CreateAccountRequest({
              DBInstanceId: input.instanceId,
              accountName: input.accountName,
              accountPassword: Redacted.value(input.password),
              accountType: "Normal",
            }),
          ),
        );
      });

      return GatewayApi.of({
        instance,
        groups,
        topology,
        vpc: vpcInfo,
        vSwitch: switchInfo,
        peerings,
        routes,
        createPeering,
        acceptPeering,
        createRoute,
        setWhitelistGroup,
        createAccount,
      });
    }),
  );
