import VPCClient, * as VPC from "@alicloud/vpc20160428";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { AlibabaClients } from "../clients.ts";
import {
  alchemyTestRuntime,
  resourceBase,
  testClientSet,
  testConfig,
  TestTransientFailures,
} from "../test-support.ts";
import {
  ManagedCluster,
  ManagedClusterProvider,
} from "../ack/managed-cluster.ts";
import { NodePool, NodePoolProvider } from "../ack/node-pool.ts";
import {
  Instance as RDSInstance,
  InstanceProvider as RDSInstanceProvider,
} from "../rds/instance.ts";
import {
  Instance as TairInstance,
  InstanceProvider as TairInstanceProvider,
} from "../tair/instance.ts";
import { Network, NetworkProvider } from "./network.ts";
import { VSwitch, VSwitchProvider } from "./vswitch.ts";

const vpcTags = (tags: readonly { key?: string; value?: string }[]) =>
  new VPC.DescribeVpcsResponseBodyVpcsVpcTags({
    tag: tags.map((tag) => new VPC.DescribeVpcsResponseBodyVpcsVpcTagsTag(tag)),
  });

const vSwitchTags = (tags: readonly { key?: string; value?: string }[]) =>
  new VPC.DescribeVSwitchAttributesResponseBodyTags({
    tag: tags.map(
      (tag) => new VPC.DescribeVSwitchAttributesResponseBodyTagsTag(tag),
    ),
  });

class StatefulVPCClient extends VPCClient {
  readonly transientFailures = new TestTransientFailures();
  network: VPC.DescribeVpcsResponseBodyVpcsVpc | undefined;
  vSwitch: VPC.DescribeVSwitchAttributesResponseBody | undefined;
  networkCreates = 0;
  networkCreateErrors: string[] = [];
  networkClientTokens: Array<string | undefined> = [];
  networkModifies = 0;
  networkDeletes = 0;
  networkDeleteErrors: string[] = [];
  networkDeleteRequestIds: Array<string | undefined> = [];
  networkReadsUntilAbsent = 0;
  /**
   * Fails the Nth (1-based) `describeVpcs` call with the given code. Indexing
   * by call lets a test target a read *inside* a readiness wait rather than
   * the bare observation reconcile makes before it.
   */
  networkReadFailures = new Map<number, string>();
  networkReadCalls = 0;
  /** Extra VPCs visible only to unfiltered inventory reads (`list`). */
  inventory: VPC.DescribeVpcsResponseBodyVpcsVpc[] = [];
  vSwitchCreates = 0;
  vSwitchClientTokens: Array<string | undefined> = [];
  vSwitchCreateDelayMs = 0;
  vSwitchCreatesInFlight = 0;
  vSwitchMaxConcurrentCreates = 0;
  vSwitchReads = 0;
  vSwitchModifies = 0;
  vSwitchDeletes = 0;
  vSwitchDeleteErrors: string[] = [];
  vSwitchDeleteRequestIds: string[] = [];
  vSwitchReadsUntilAbsent = 0;

  constructor() {
    super(testConfig());
  }

  override async describeVpcs(
    request: VPC.DescribeVpcsRequest,
  ): Promise<VPC.DescribeVpcsResponse> {
    this.networkReadCalls += 1;
    // No `statusCode` is attached, so `isTransient` is false and the error
    // escapes `retryingSdkCall`'s own per-call retry — precisely the case the
    // observation loop has to survive (`SafeRetryBudgetExceeded`) or refuse
    // to (`Forbidden`).
    const readError = this.networkReadFailures.get(this.networkReadCalls);
    if (readError !== undefined) {
      throw Object.assign(new Error(`${readError}: describeVpcs failed`), {
        code: readError,
      });
    }
    // Unfiltered requests are inventory reads (`list`): answer from the full
    // set, paginated, with a reported total.
    if (request.vpcId === undefined && request.vpcName === undefined) {
      const all = [
        ...this.inventory,
        ...(this.network === undefined ? [] : [this.network]),
      ];
      const pageSize = request.pageSize ?? 50;
      const start = ((request.pageNumber ?? 1) - 1) * pageSize;
      return new VPC.DescribeVpcsResponse({
        statusCode: 200,
        body: new VPC.DescribeVpcsResponseBody({
          totalCount: all.length,
          pageNumber: request.pageNumber,
          pageSize,
          vpcs: new VPC.DescribeVpcsResponseBodyVpcs({
            vpc: all.slice(start, start + pageSize),
          }),
        }),
      });
    }
    const matches =
      this.network !== undefined &&
      (request.vpcId === undefined || request.vpcId === this.network.vpcId) &&
      (request.vpcName === undefined ||
        request.vpcName === this.network.vpcName);
    const network = matches ? this.network : undefined;
    if (network !== undefined && this.networkReadsUntilAbsent > 0) {
      this.networkReadsUntilAbsent -= 1;
      if (this.networkReadsUntilAbsent === 0) this.network = undefined;
    }
    return new VPC.DescribeVpcsResponse({
      statusCode: 200,
      body: new VPC.DescribeVpcsResponseBody({
        vpcs: new VPC.DescribeVpcsResponseBodyVpcs({
          vpc: network === undefined ? [] : [network],
        }),
      }),
    });
  }

  override async createVpc(
    request: VPC.CreateVpcRequest,
  ): Promise<VPC.CreateVpcResponse> {
    this.networkCreates += 1;
    this.networkClientTokens.push(request.clientToken);
    const code = this.networkCreateErrors.shift();
    if (code !== undefined) {
      throw Object.assign(
        new Error("ConnectTimeout: Connect HTTPS://vpc.example failed"),
        { code },
      );
    }
    this.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
      cidrBlock: request.cidrBlock,
      creationTime: "2026-08-31T00:00:00Z",
      description: request.description,
      dnsHostnameStatus: request.enableDnsHostname ? "Enabled" : "Disabled",
      enabledIpv6: request.enableIpv6 ?? false,
      regionId: request.regionId,
      status: "Available",
      tags: vpcTags(request.tag ?? []),
      VRouterId: "vrt-test",
      vpcId: "vpc-test",
      vpcName: request.vpcName,
    });
    return new VPC.CreateVpcResponse({
      statusCode: 200,
      body: new VPC.CreateVpcResponseBody({ vpcId: "vpc-test" }),
    });
  }

  override async modifyVpcAttribute(
    request: VPC.ModifyVpcAttributeRequest,
  ): Promise<VPC.ModifyVpcAttributeResponse> {
    this.networkModifies += 1;
    if (this.network !== undefined) {
      this.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
        ...this.network,
        description: request.description ?? this.network.description,
        dnsHostnameStatus:
          request.enableDnsHostname === undefined
            ? this.network.dnsHostnameStatus
            : request.enableDnsHostname
              ? "Enabled"
              : "Disabled",
        enabledIpv6: request.enableIPv6 ?? this.network.enabledIpv6,
      });
    }
    return new VPC.ModifyVpcAttributeResponse({ statusCode: 200 });
  }

  override async describeVSwitches(
    request: VPC.DescribeVSwitchesRequest,
  ): Promise<VPC.DescribeVSwitchesResponse> {
    this.vSwitchReads += 1;
    const matches =
      this.vSwitch !== undefined &&
      (request.vpcId === undefined || request.vpcId === this.vSwitch.vpcId) &&
      (request.vSwitchName === undefined ||
        request.vSwitchName === this.vSwitch.vSwitchName);
    const values = matches
      ? [
          new VPC.DescribeVSwitchesResponseBodyVSwitchesVSwitch({
            ...this.vSwitch,
          }),
        ]
      : [];
    return new VPC.DescribeVSwitchesResponse({
      statusCode: 200,
      body: new VPC.DescribeVSwitchesResponseBody({
        vSwitches: new VPC.DescribeVSwitchesResponseBodyVSwitches({
          vSwitch: values,
        }),
      }),
    });
  }

  override async describeVSwitchAttributes(
    request: VPC.DescribeVSwitchAttributesRequest,
  ): Promise<VPC.DescribeVSwitchAttributesResponse> {
    const found = this.vSwitch?.vSwitchId === request.vSwitchId;
    const body = found
      ? this.vSwitch
      : new VPC.DescribeVSwitchAttributesResponseBody({});
    if (found && this.vSwitchReadsUntilAbsent > 0) {
      this.vSwitchReadsUntilAbsent -= 1;
      if (this.vSwitchReadsUntilAbsent === 0) this.vSwitch = undefined;
    }
    return new VPC.DescribeVSwitchAttributesResponse({
      // The real API returns a 200 tombstone with empty identity after delete.
      statusCode: 200,
      body,
    });
  }

  override async createVSwitch(
    request: VPC.CreateVSwitchRequest,
  ): Promise<VPC.CreateVSwitchResponse> {
    this.vSwitchCreates += 1;
    this.vSwitchClientTokens.push(request.clientToken);
    this.vSwitchCreatesInFlight += 1;
    this.vSwitchMaxConcurrentCreates = Math.max(
      this.vSwitchMaxConcurrentCreates,
      this.vSwitchCreatesInFlight,
    );
    try {
      if (this.vSwitchCreateDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.vSwitchCreateDelayMs),
        );
      }
      this.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
        availableIpAddressCount: 250,
        cidrBlock: request.cidrBlock,
        creationTime: "2026-08-31T00:00:00Z",
        description: request.description,
        enabledIpv6: request.ipv6CidrBlock !== undefined,
        status: "Available",
        tags: vSwitchTags(request.tag ?? []),
        vSwitchId: "vsw-test",
        vSwitchName: request.vSwitchName,
        vpcId: request.vpcId,
        zoneId: request.zoneId,
      });
      return new VPC.CreateVSwitchResponse({
        statusCode: 200,
        body: new VPC.CreateVSwitchResponseBody({ vSwitchId: "vsw-test" }),
      });
    } finally {
      this.vSwitchCreatesInFlight -= 1;
    }
  }

  override async modifyVSwitchAttribute(
    request: VPC.ModifyVSwitchAttributeRequest,
  ): Promise<VPC.ModifyVSwitchAttributeResponse> {
    this.vSwitchModifies += 1;
    if (this.vSwitch !== undefined) {
      this.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
        ...this.vSwitch,
        description: request.description ?? this.vSwitch.description,
        enabledIpv6: request.enableIPv6 ?? this.vSwitch.enabledIpv6,
      });
    }
    return new VPC.ModifyVSwitchAttributeResponse({ statusCode: 200 });
  }

  override async tagResources(
    request: VPC.TagResourcesRequest,
  ): Promise<VPC.TagResourcesResponse> {
    if (request.resourceType === "VPC" && this.network !== undefined) {
      const tags = new Map(
        (this.network.tags?.tag ?? []).flatMap((tag) =>
          tag.key === undefined || tag.value === undefined
            ? []
            : [[tag.key, tag.value] as const],
        ),
      );
      for (const tag of request.tag ?? []) {
        if (tag.key !== undefined && tag.value !== undefined) {
          tags.set(tag.key, tag.value);
        }
      }
      this.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
        ...this.network,
        tags: vpcTags([...tags].map(([key, value]) => ({ key, value }))),
      });
    }
    if (request.resourceType === "VSWITCH" && this.vSwitch !== undefined) {
      const tags = new Map(
        (this.vSwitch.tags?.tag ?? []).flatMap((tag) =>
          tag.key === undefined || tag.value === undefined
            ? []
            : [[tag.key, tag.value] as const],
        ),
      );
      for (const tag of request.tag ?? []) {
        if (tag.key !== undefined && tag.value !== undefined) {
          tags.set(tag.key, tag.value);
        }
      }
      this.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
        ...this.vSwitch,
        tags: vSwitchTags([...tags].map(([key, value]) => ({ key, value }))),
      });
    }
    return new VPC.TagResourcesResponse({ statusCode: 200 });
  }

  override async unTagResources(
    request: VPC.UnTagResourcesRequest,
  ): Promise<VPC.UnTagResourcesResponse> {
    const removed = new Set(request.tagKey ?? []);
    if (request.resourceType === "VPC" && this.network !== undefined) {
      this.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
        ...this.network,
        tags: vpcTags(
          (this.network.tags?.tag ?? []).filter(
            (tag) => tag.key === undefined || !removed.has(tag.key),
          ),
        ),
      });
    }
    if (request.resourceType === "VSWITCH" && this.vSwitch !== undefined) {
      this.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
        ...this.vSwitch,
        tags: vSwitchTags(
          (this.vSwitch.tags?.tag ?? []).filter(
            (tag) => tag.key === undefined || !removed.has(tag.key),
          ),
        ),
      });
    }
    return new VPC.UnTagResourcesResponse({ statusCode: 200 });
  }

  override async deleteVSwitch(
    _request: VPC.DeleteVSwitchRequest,
  ): Promise<VPC.DeleteVSwitchResponse> {
    this.vSwitchDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteVSwitch");
    const code = this.vSwitchDeleteErrors.shift();
    if (code !== undefined) {
      const requestId = this.vSwitchDeleteRequestIds.shift();
      throw Object.assign(
        new Error("vSwitch still has a managed network interface"),
        {
          code,
          requestId,
          statusCode: 400,
        },
      );
    }
    this.vSwitch = undefined;
    return new VPC.DeleteVSwitchResponse({ statusCode: 200 });
  }

  override async deleteVpc(
    _request: VPC.DeleteVpcRequest,
  ): Promise<VPC.DeleteVpcResponse> {
    this.networkDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteVpc");
    const code = this.networkDeleteErrors.shift();
    if (code !== undefined) {
      const requestId = this.networkDeleteRequestIds.shift();
      throw Object.assign(
        new Error("VPC still holds a managed dependency"),
        { code, requestId, statusCode: 400 },
      );
    }
    this.network = undefined;
    return new VPC.DeleteVpcResponse({ statusCode: 200 });
  }
}

const providerLayer = (client: StatefulVPCClient) =>
  Layer.succeed(AlibabaClients, testClientSet({ vpc: client }));

describe("VPC provider lifecycles", () => {
  it("does not call VPC when an interrupted vSwitch has no VPC identity", async () => {
    const fake = new StatefulVPCClient();
    const layer = VSwitchProvider().pipe(Layer.provide(providerLayer(fake)));
    const program = Effect.gen(function* () {
      const provider = yield* VSwitch.Provider;
      const read = provider.read;
      if (read === undefined) throw new Error("VSwitch read is missing");
      return yield* read({
        ...resourceBase("interrupted-vswitch"),
        olds: {} as never,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.vSwitchReads).toBe(0);
  });

  it("creates, updates, and deletes a network after a transient failure", async () => {
    const fake = new StatefulVPCClient();
    const layer = NetworkProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("vpc");
    const initial = {
      name: "example-vpc",
      cidrBlock: "10.0.0.0/16",
      modify: { description: "Example dev", enableDnsHostname: true },
      tags: { environment: "dev" },
    };
    const changed = {
      ...initial,
      modify: {
        description: "Example disposable test",
        enableDnsHostname: true,
      },
      tags: { environment: "test" },
    };
    const program = Effect.gen(function* () {
      const provider = yield* Network.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: created,
      });
      const read = provider.read;
      if (read === undefined) throw new Error("Network read is missing");
      const observed = yield* read({ ...base, olds: changed, output: updated });
      fake.transientFailures.failNext("DeleteVpc");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return { updated, observed };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(result.updated).toMatchObject({
      vpcId: "vpc-test",
      cidrBlock: "10.0.0.0/16",
      description: "Example disposable test",
      dnsHostnameStatus: "Enabled",
      tags: { environment: "test" },
    });
    expect(result.observed).toEqual(result.updated);
    expect(fake.networkCreates).toBe(1);
    expect(fake.networkModifies).toBe(2);
    expect(fake.networkDeletes).toBe(2);
    expect(fake.network).toBeUndefined();
  });

  it("retries a tokenized VPC create after a connection timeout", async () => {
    const fake = new StatefulVPCClient();
    fake.networkCreateErrors.push("ConnectTimeout");
    const layer = NetworkProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("vpc-transient-create");

    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        return yield* provider.reconcile({
          ...base,
          news: {
            name: "example-vpc",
            cidrBlock: "10.0.0.0/16",
            tags: { environment: "test" },
          },
          olds: undefined,
          output: undefined,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(created.vpcId).toBe("vpc-test");
    expect(fake.networkCreates).toBe(2);
    expect(fake.networkClientTokens).toEqual([
      `create-${base.instanceId}`,
      `create-${base.instanceId}`,
    ]);

    fake.network = undefined;
    const replacementBase = {
      ...base,
      instanceId: "provider-test-vpc-replacement-generation",
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        return yield* provider.reconcile({
          ...replacementBase,
          news: {
            name: "example-vpc",
            cidrBlock: "10.0.0.0/16",
            tags: { environment: "test" },
          },
          olds: undefined,
          output: undefined,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.networkClientTokens.at(-1)).toBe(
      `create-${replacementBase.instanceId}`,
    );
    expect(fake.networkClientTokens.at(-1)).not.toBe(
      fake.networkClientTokens[0],
    );
  });

  it("does not mistake a configuring VPC for an in-flight delete", async () => {
    const fake = new StatefulVPCClient();
    fake.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
      cidrBlock: "10.0.0.0/16",
      status: "Pending",
      vpcId: "vpc-test",
      vpcName: "example-vpc",
    });
    const layer = NetworkProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("vpc-pending-delete");
    const olds = { name: "example-vpc", cidrBlock: "10.0.0.0/16" };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            vpcId: "vpc-test",
            name: "example-vpc",
            cidrBlock: "10.0.0.0/16",
            status: "Pending",
            ipv6Enabled: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.networkDeletes).toBe(1);
    expect(fake.network).toBeUndefined();
  });

  it("resumes an already-deleting VPC without issuing delete again", async () => {
    const fake = new StatefulVPCClient();
    fake.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
      cidrBlock: "10.0.0.0/16",
      status: "Deleting",
      vpcId: "vpc-test",
      vpcName: "example-vpc",
    });
    fake.networkReadsUntilAbsent = 1;
    const layer = NetworkProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("vpc-deleting-delete");

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        yield* provider.delete({
          ...base,
          olds: { name: "example-vpc", cidrBlock: "10.0.0.0/16" },
          output: {
            vpcId: "vpc-test",
            name: "example-vpc",
            cidrBlock: "10.0.0.0/16",
            status: "Deleting",
            ipv6Enabled: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.networkDeletes).toBe(0);
  });

  it("enumerates every VPC across pages for account-wide teardown", async () => {
    const fake = new StatefulVPCClient();
    // 120 VPCs across a 50-per-page inventory: a provider that reads only the
    // first page would report an orphan as absent.
    fake.inventory = Array.from(
      { length: 120 },
      (_, index) =>
        new VPC.DescribeVpcsResponseBodyVpcsVpc({
          cidrBlock: "10.0.0.0/16",
          status: "Available",
          vpcId: `vpc-${index}`,
          vpcName: `example-vpc-${index}`,
          tags: vpcTags([{ key: "alchemy::stage", value: "test-alchemy" }]),
        }),
    );
    const layer = NetworkProvider().pipe(Layer.provide(providerLayer(fake)));

    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        return yield* provider.list();
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(listed).toHaveLength(120);
    expect(listed.map((network) => network.vpcId)).toContain("vpc-119");
    // Attributes are the same shape `read` emits, so each item is directly
    // usable with `delete` — including the ownership tags nuke filters on.
    expect(listed[0]).toMatchObject({
      vpcId: "vpc-0",
      name: "example-vpc-0",
      cidrBlock: "10.0.0.0/16",
      status: "Available",
    });
  });

  it("orders account-wide teardown so a VPC outlives everything inside it", async () => {
    const fake = new StatefulVPCClient();
    const layer = Layer.mergeAll(
      NetworkProvider(),
      VSwitchProvider(),
    ).pipe(Layer.provide(providerLayer(fake)));

    const { network, vswitch } = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          network: yield* Network.Provider,
          vswitch: yield* VSwitch.Provider,
        };
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    // `A.dependsOn = [B]` means every A is gone before any B deletes, so the
    // *child* names the parent it needs to outlive it.
    expect(vswitch.nuke?.dependsOn).toEqual(["Alibaba.VPC.Network"]);
    // The VPC goes last and consumes nothing, so it declares nothing. Naming
    // its children here would invert teardown and delete the VPC first.
    expect(network.nuke?.dependsOn ?? []).toEqual([]);
  });

  it("orders in-VPC services ahead of both the subnet and the VPC", async () => {
    // Each service's teardown needs its network to still be there, so all of
    // them declare the whole VPC namespace. Asserted here rather than in each
    // service's own suite so the region-wide ordering stays legible in one
    // place: NodePool -> {cluster, RDS, Tair} -> vSwitch -> VPC.
    const layers = Layer.mergeAll(
      ManagedClusterProvider(),
      NodePoolProvider(),
      RDSInstanceProvider(),
      TairInstanceProvider(),
    ).pipe(Layer.provide(providerLayer(new StatefulVPCClient())));

    const providers = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          cluster: yield* ManagedCluster.Provider,
          nodePool: yield* NodePool.Provider,
          rds: yield* RDSInstance.Provider,
          tair: yield* TairInstance.Provider,
        };
      }).pipe(Effect.provide(layers), Effect.provide(alchemyTestRuntime)),
    );

    expect(providers.cluster.nuke?.dependsOn).toEqual(["Alibaba.VPC.*"]);
    expect(providers.rds.nuke?.dependsOn).toEqual(["Alibaba.VPC.*"]);
    expect(providers.tair.nuke?.dependsOn).toEqual(["Alibaba.VPC.*"]);
    // Node pools additionally have to clear before their cluster.
    expect(providers.nodePool.nuke?.dependsOn).toEqual([
      "Alibaba.ACK.ManagedCluster",
      "Alibaba.VPC.*",
    ]);
  });

  it("deletes a VPC through managed dependency failures left by ACK", async () => {
    const fake = new StatefulVPCClient();
    fake.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
      cidrBlock: "10.0.0.0/16",
      status: "Available",
      vpcId: "vpc-test",
      vpcName: "example-vpc",
    });
    // ACK's NAT gateway, security groups and ENIs outlive the cluster, so the
    // first DeleteVpc attempts are rejected until Alibaba releases them.
    fake.networkDeleteErrors = [
      "DependencyViolation.SecurityGroup",
      "DependencyViolation",
      "IncorrectRouteEntryStatus",
    ];
    const layer = NetworkProvider({
      wait: { attempts: 3, interval: 0 },
      deleteDependencyWait: { attempts: 8, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vpc-dependency-delete");

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        yield* provider.delete({
          ...base,
          olds: { name: "example-vpc", cidrBlock: "10.0.0.0/16" },
          output: {
            vpcId: "vpc-test",
            name: "example-vpc",
            cidrBlock: "10.0.0.0/16",
            status: "Available",
            ipv6Enabled: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    // Three rejections then success, and the VPC is actually gone.
    expect(fake.networkDeletes).toBe(4);
    expect(fake.network).toBeUndefined();
  });

  it("reports the blocking dependency when a VPC never becomes deletable", async () => {
    const fake = new StatefulVPCClient();
    fake.network = new VPC.DescribeVpcsResponseBodyVpcsVpc({
      cidrBlock: "10.0.0.0/16",
      status: "Available",
      vpcId: "vpc-test",
      vpcName: "example-vpc",
    });
    fake.networkDeleteErrors = Array.from(
      { length: 10 },
      () => "DependencyViolation.NetworkInterface",
    );
    fake.networkDeleteRequestIds = Array.from({ length: 10 }, () => "req-eni");
    const layer = NetworkProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 3, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vpc-dependency-blocked");

    const program = Effect.gen(function* () {
      const provider = yield* Network.Provider;
      yield* provider.delete({
        ...base,
        olds: { name: "example-vpc", cidrBlock: "10.0.0.0/16" },
        output: {
          vpcId: "vpc-test",
          name: "example-vpc",
          cidrBlock: "10.0.0.0/16",
          status: "Available",
          ipv6Enabled: false,
          tags: {},
        },
      });
    });

    // The named dependency is reported, not a bare readiness timeout.
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaDependencyBlockedError",
      dependency: "NetworkInterface",
      providerCode: "DependencyViolation.NetworkInterface",
      resourceId: "vpc-test",
    });
    // State is retained: the VPC is still there to retry against.
    expect(fake.network).toBeDefined();
  });

  it("rides out a readiness read that outlived the per-call retry budget", async () => {
    const fake = new StatefulVPCClient();
    // Call 1 is reconcile's bare pre-create observation; the create then
    // lands and call 2 is the first read inside the readiness wait. Fail
    // that one, plus a later one, to prove the wait absorbs both.
    fake.networkReadFailures.set(2, "SafeRetryBudgetExceeded");
    fake.networkReadFailures.set(3, "SafeRetryBudgetExceeded");
    const layer = NetworkProvider({
      wait: { attempts: 6, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vpc-read-blip");

    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Network.Provider;
        return yield* provider.reconcile({
          ...base,
          news: { name: "example-vpc", cidrBlock: "10.0.0.0/16" },
          olds: undefined,
          output: undefined,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    // The blips cost observation attempts, not the whole deploy — and no
    // second VPC was built.
    expect(created.vpcId).toBe("vpc-test");
    expect(fake.networkCreates).toBe(1);
    expect(fake.networkReadCalls).toBeGreaterThan(3);
  });

  it("aborts a readiness wait when the read is rejected outright", async () => {
    const fake = new StatefulVPCClient();
    // A rejected read inside the readiness wait; repeating it cannot change
    // the answer, so the wait must not burn its remaining 19 attempts.
    fake.networkReadFailures.set(2, "Forbidden");
    const layer = NetworkProvider({
      wait: { attempts: 20, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vpc-read-rejected");
    const program = Effect.gen(function* () {
      const provider = yield* Network.Provider;
      return yield* provider.reconcile({
        ...base,
        news: { name: "example-vpc", cidrBlock: "10.0.0.0/16" },
        olds: undefined,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaProviderError",
      code: "Forbidden",
    });
    expect(fake.networkReadCalls).toBe(2);
  });

  it("deletes a vSwitch through transient and managed dependency failures", async () => {
    const fake = new StatefulVPCClient();
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vswitch");
    const initial = {
      vpcId: "vpc-test",
      name: "example-vswitch-a",
      cidrBlock: "10.0.0.0/24",
      zoneId: "ap-southeast-5a",
      modify: { description: "Example dev" },
      tags: { environment: "dev" },
    };
    const changed = {
      ...initial,
      modify: { description: "Example disposable test" },
      tags: { environment: "test" },
    };
    const program = Effect.gen(function* () {
      const provider = yield* VSwitch.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: created,
      });
      const read = provider.read;
      if (read === undefined) throw new Error("VSwitch read is missing");
      const observed = yield* read({ ...base, olds: changed, output: updated });
      fake.transientFailures.failNext("DeleteVSwitch");
      fake.vSwitchDeleteErrors.push("DependencyViolation.NetworkInterface");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return { updated, observed };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(result.updated).toMatchObject({
      vSwitchId: "vsw-test",
      vpcId: "vpc-test",
      cidrBlock: "10.0.0.0/24",
      description: "Example disposable test",
      tags: { environment: "test" },
    });
    expect(result.observed).toEqual(result.updated);
    expect(fake.vSwitchCreates).toBe(1);
    expect(fake.vSwitchClientTokens).toEqual([`create-${base.instanceId}`]);
    expect(fake.vSwitchModifies).toBe(2);
    expect(fake.vSwitchDeletes).toBe(3);
    expect(fake.vSwitch).toBeUndefined();
  });

  it("serializes concurrent vSwitch creates within one VPC", async () => {
    const fake = new StatefulVPCClient();
    fake.vSwitchCreateDelayMs = 20;
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const input = (
      id: string,
      name: string,
      cidrBlock: string,
      zoneId: string,
    ) => ({
      ...resourceBase(id),
      news: {
        vpcId: "vpc-test",
        name,
        cidrBlock,
        zoneId,
      },
      olds: undefined,
      output: undefined,
    });
    const program = Effect.gen(function* () {
      const provider = yield* VSwitch.Provider;
      return yield* Effect.all(
        [
          provider.reconcile(
            input(
              "vswitch-a",
              "example-vswitch-a",
              "10.0.0.0/24",
              "ap-southeast-5a",
            ),
          ),
          provider.reconcile(
            input(
              "vswitch-b",
              "example-vswitch-b",
              "10.0.1.0/24",
              "ap-southeast-5b",
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.vSwitchCreates).toBe(2);
    expect(fake.vSwitchMaxConcurrentCreates).toBe(1);
  });

  it("retries the documented bare dependency violation", async () => {
    const fake = new StatefulVPCClient();
    fake.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
      cidrBlock: "10.0.0.0/24",
      status: "Available",
      vSwitchId: "vsw-test",
      vSwitchName: "example-vswitch-a",
      vpcId: "vpc-test",
      zoneId: "ap-southeast-5a",
    });
    fake.vSwitchDeleteErrors.push("DependencyViolation");
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vswitch-bare-dependency");
    const olds = {
      vpcId: "vpc-test",
      name: "example-vswitch-a",
      cidrBlock: "10.0.0.0/24",
      zoneId: "ap-southeast-5a",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* VSwitch.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            ...olds,
            vSwitchId: "vsw-test",
            status: "Available",
            ipv6Enabled: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(fake.vSwitchDeletes).toBe(2);
    expect(fake.vSwitch).toBeUndefined();
  });

  it("waits for a deleted Tair instance to release its vSwitch", async () => {
    const fake = new StatefulVPCClient();
    fake.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
      cidrBlock: "10.0.0.0/24",
      status: "Available",
      vSwitchId: "vsw-test",
      vSwitchName: "example-vswitch-b",
      vpcId: "vpc-test",
      zoneId: "ap-southeast-5b",
    });
    fake.vSwitchDeleteErrors.push("DependencyViolation.Kvstore");
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vswitch-kvstore-dependency");
    const olds = {
      vpcId: "vpc-test",
      name: "example-vswitch-b",
      cidrBlock: "10.0.0.0/24",
      zoneId: "ap-southeast-5b",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* VSwitch.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            ...olds,
            vSwitchId: "vsw-test",
            status: "Available",
            ipv6Enabled: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(fake.vSwitchDeletes).toBe(2);
    expect(fake.vSwitch).toBeUndefined();
  });

  it("does not retry a permanent vSwitch dependency", async () => {
    const fake = new StatefulVPCClient();
    fake.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
      cidrBlock: "10.0.0.0/24",
      status: "Available",
      vSwitchId: "vsw-test",
      vSwitchName: "example-vswitch-a",
      vpcId: "vpc-test",
      zoneId: "ap-southeast-5a",
    });
    fake.vSwitchDeleteErrors.push("DependencyViolation.NetworkAcl");
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vswitch-permanent-dependency");
    const olds = {
      vpcId: "vpc-test",
      name: "example-vswitch-a",
      cidrBlock: "10.0.0.0/24",
      zoneId: "ap-southeast-5a",
    };
    const program = Effect.gen(function* () {
      const provider = yield* VSwitch.Provider;
      yield* provider.delete({
        ...base,
        olds,
        output: {
          ...olds,
          vSwitchId: "vsw-test",
          status: "Available",
          ipv6Enabled: false,
          tags: {},
        },
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaProviderError",
      code: "DependencyViolation.NetworkAcl",
    });
    expect(fake.vSwitchDeletes).toBe(1);
  });

  it("reports the last retryable vSwitch dependency when the wait expires", async () => {
    const fake = new StatefulVPCClient();
    fake.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
      cidrBlock: "10.0.0.0/24",
      status: "Available",
      vSwitchId: "vsw-test",
      vSwitchName: "example-vswitch-a",
      vpcId: "vpc-test",
      zoneId: "ap-southeast-5a",
    });
    fake.vSwitchDeleteErrors.push(
      "DependencyViolation",
      "DependencyViolation.NetworkInterface",
    );
    fake.vSwitchDeleteRequestIds.push("dependency-1", "dependency-2");
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vswitch-expired-dependency-wait");
    const olds = {
      vpcId: "vpc-test",
      name: "example-vswitch-a",
      cidrBlock: "10.0.0.0/24",
      zoneId: "ap-southeast-5a",
    };
    const program = Effect.gen(function* () {
      const provider = yield* VSwitch.Provider;
      yield* provider.delete({
        ...base,
        olds,
        output: {
          ...olds,
          vSwitchId: "vsw-test",
          status: "Available",
          ipv6Enabled: false,
          tags: {},
        },
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaDependencyBlockedError",
      resourceType: "Alibaba.VPC.VSwitch",
      resourceId: "vsw-test",
      dependency: "NetworkInterface",
      attempts: 2,
      providerCode: "DependencyViolation.NetworkInterface",
      requestId: "dependency-2",
    });
    expect(fake.vSwitchDeletes).toBe(2);
  });

  it("resumes an already-pending vSwitch delete without issuing it again", async () => {
    const fake = new StatefulVPCClient();
    fake.vSwitch = new VPC.DescribeVSwitchAttributesResponseBody({
      cidrBlock: "10.0.0.0/24",
      status: "Pending",
      vSwitchId: "vsw-test",
      vSwitchName: "example-vswitch-a",
      vpcId: "vpc-test",
      zoneId: "ap-southeast-5a",
    });
    fake.vSwitchReadsUntilAbsent = 1;
    const layer = VSwitchProvider({
      wait: { attempts: 2, interval: 0 },
      deleteDependencyWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("vswitch-pending-delete");
    const olds = {
      vpcId: "vpc-test",
      name: "example-vswitch-a",
      cidrBlock: "10.0.0.0/24",
      zoneId: "ap-southeast-5a",
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* VSwitch.Provider;
        yield* provider.delete({
          ...base,
          olds,
          output: {
            ...olds,
            vSwitchId: "vsw-test",
            status: "Pending",
            ipv6Enabled: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(fake.vSwitchDeletes).toBe(0);
  });
});
