import TairClient, * as Tair from "@alicloud/r-kvstore20150101";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { AlibabaClients } from "../clients.ts";
import {
  alchemyTestRuntime,
  resourceBase,
  testClientSet,
  testConfig,
  TestTransientFailures,
} from "../test-support.ts";
import { Account, AccountProvider } from "./account.ts";
import { Instance, InstanceProvider } from "./instance.ts";
import {
  SecurityIpGroup,
  SecurityIpGroupProvider,
} from "./security-ip-group.ts";
class StatefulTairClient extends TairClient {
  readonly transientFailures = new TestTransientFailures();
  instance:
    | Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute
    | undefined;
  ssl = new Tair.DescribeInstanceSSLResponseBody({ SSLEnabled: "Disable" });
  config = JSON.stringify({ EvictionPolicy: "volatile-lru" });
  accounts = new Map<
    string,
    Tair.DescribeAccountsResponseBodyAccountsAccount
  >();
  securityGroups = new Map<
    string,
    Tair.DescribeSecurityIpsResponseBodySecurityIpGroupsSecurityIpGroup
  >();
  instanceCreates = 0;
  instanceCreateTokens: Array<string | undefined> = [];
  instanceCreateErrors: Array<{
    readonly code: string;
    readonly message: string;
    readonly accepted: boolean;
  }> = [];
  instanceAttributeIdentityOmissions = 0;
  overviewOnly = false;
  instanceSpecModifies = 0;
  instanceSpecTokens: Array<string | undefined> = [];
  instanceConfigModifies = 0;
  vpcAuthModifies = 0;
  instanceDeletes = 0;
  instanceDestroys = 0;
  instanceReadsUntilAbsent = 0;
  accountCreates = 0;
  accountReads = 0;
  accountUpdates = 0;
  passwordResets = 0;
  lastPasswordResetAccount: string | undefined;
  accountDeletes = 0;
  securityGroupModifies = 0;
  constructor() {
    super(testConfig());
  }
  override async describeInstanceAttribute(
    request: Tair.DescribeInstanceAttributeRequest,
  ): Promise<Tair.DescribeInstanceAttributeResponse> {
    const instance =
      !this.overviewOnly && this.instance?.instanceId === request.instanceId
        ? this.instance
        : undefined;
    if (
      instance !== undefined &&
      instance.instanceStatus?.toLowerCase() === "released"
    ) {
      return new Tair.DescribeInstanceAttributeResponse({
        statusCode: 404,
        body: new Tair.DescribeInstanceAttributeResponseBody({
          instances: new Tair.DescribeInstanceAttributeResponseBodyInstances({
            DBInstanceAttribute: [],
          }),
        }),
      });
    }
    if (instance !== undefined && this.instanceReadsUntilAbsent > 0) {
      this.instanceReadsUntilAbsent -= 1;
      if (this.instanceReadsUntilAbsent === 0) this.instance = undefined;
    }
    const observedInstance =
      instance !== undefined && this.instanceAttributeIdentityOmissions > 0
        ? new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
            { ...instance, instanceId: undefined, instanceName: undefined },
          )
        : instance;
    if (instance !== undefined && this.instanceAttributeIdentityOmissions > 0) {
      this.instanceAttributeIdentityOmissions -= 1;
    }
    return new Tair.DescribeInstanceAttributeResponse({
      statusCode: instance === undefined ? 404 : 200,
      body: new Tair.DescribeInstanceAttributeResponseBody({
        instances: new Tair.DescribeInstanceAttributeResponseBodyInstances({
          DBInstanceAttribute:
            observedInstance === undefined ? [] : [observedInstance],
        }),
      }),
    });
  }
  override async describeInstances(
    _request: Tair.DescribeInstancesRequest,
  ): Promise<Tair.DescribeInstancesResponse> {
    const visible =
      this.overviewOnly ||
      this.instance === undefined ||
      this.instance.instanceStatus?.toLowerCase() === "released"
        ? undefined
        : this.instance;
    return new Tair.DescribeInstancesResponse({
      statusCode: 200,
      body: new Tair.DescribeInstancesResponseBody({
        instances: new Tair.DescribeInstancesResponseBodyInstances({
          KVStoreInstance:
            visible === undefined
              ? []
              : [
                  new Tair.DescribeInstancesResponseBodyInstancesKVStoreInstance(
                    {
                      instanceId: visible.instanceId,
                      instanceName: visible.instanceName,
                      instanceStatus: visible.instanceStatus,
                    },
                  ),
                ],
        }),
      }),
    });
  }
  override async describeInstancesOverview(
    request: Tair.DescribeInstancesOverviewRequest,
  ): Promise<Tair.DescribeInstancesOverviewResponse> {
    if (this.instance !== undefined && this.instanceReadsUntilAbsent > 0) {
      this.instanceReadsUntilAbsent -= 1;
      if (this.instanceReadsUntilAbsent === 0) this.instance = undefined;
    }
    const instance = this.instance;
    const matches =
      instance !== undefined &&
      instance.instanceStatus?.toLowerCase() !== "destroyed" &&
      (request.instanceIds === undefined ||
        request.instanceIds
          .split(",")
          .map((item) => item.trim())
          .includes(instance.instanceId ?? "")) &&
      (request.searchKey === undefined ||
        request.searchKey === instance.instanceName);
    return new Tair.DescribeInstancesOverviewResponse({
      statusCode: 200,
      body: new Tair.DescribeInstancesOverviewResponseBody({
        instances:
          matches && instance !== undefined
            ? [
                new Tair.DescribeInstancesOverviewResponseBodyInstances({
                  instanceId: instance.instanceId,
                  instanceName: instance.instanceName,
                  instanceStatus: instance.instanceStatus,
                  vpcId: instance.vpcId,
                  vSwitchId: instance.vSwitchId,
                }),
              ]
            : [],
      }),
    });
  }
  override async createInstance(
    request: Tair.CreateInstanceRequest,
  ): Promise<Tair.CreateInstanceResponse> {
    this.instanceCreates += 1;
    this.instanceCreateTokens.push(request.token);
    const createError = this.instanceCreateErrors.shift();
    if (createError?.accepted === false) {
      throw Object.assign(new Error(createError.message), {
        code: createError.code,
      });
    }
    this.instance =
      new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
        {
          instanceId: "r-test",
          instanceName: request.instanceName,
          instanceStatus: "Normal",
          instanceClass: request.instanceClass,
          instanceType: request.instanceType,
          engineVersion: request.engineVersion,
          connectionDomain: "r-test.redis.rds.aliyuncs.com",
          port: 6379,
          networkType: request.networkType,
          regionId: request.regionId ?? "ap-southeast-5",
          zoneId: request.zoneId,
          vpcId: request.vpcId,
          vSwitchId: request.vSwitchId,
          storage:
            request.storage === undefined ? undefined : String(request.storage),
          storageType: request.storageType,
          shardCount: request.shardCount,
          replicaCount: request.replicaCount,
          instanceReleaseProtection: false,
          createTime: "2026-08-31T00:00:00Z",
          tags: new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttributeTags(
            {
              tag: (request.tag ?? []).map(
                (tag) =>
                  new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttributeTagsTag(
                    { key: tag.key, value: tag.value },
                  ),
              ),
            },
          ),
        },
      );
    if (createError !== undefined) {
      throw Object.assign(new Error(createError.message), {
        code: createError.code,
      });
    }
    return new Tair.CreateInstanceResponse({
      statusCode: 200,
      body: new Tair.CreateInstanceResponseBody({ instanceId: "r-test" }),
    });
  }
  override async describeInstanceSSL(
    _request: Tair.DescribeInstanceSSLRequest,
  ): Promise<Tair.DescribeInstanceSSLResponse> {
    return new Tair.DescribeInstanceSSLResponse({
      statusCode: this.instance === undefined ? 404 : 200,
      body: this.instance === undefined ? undefined : this.ssl,
    });
  }
  override async describeInstanceConfig(
    _request: Tair.DescribeInstanceConfigRequest,
  ): Promise<Tair.DescribeInstanceConfigResponse> {
    return new Tair.DescribeInstanceConfigResponse({
      statusCode: this.instance === undefined ? 404 : 200,
      body:
        this.instance === undefined
          ? undefined
          : new Tair.DescribeInstanceConfigResponseBody({
              config: this.config,
            }),
    });
  }
  override async modifyInstanceConfig(
    request: Tair.ModifyInstanceConfigRequest,
  ): Promise<Tair.ModifyInstanceConfigResponse> {
    this.instanceConfigModifies += 1;
    const desired = JSON.parse(request.config ?? "{}")["maxmemory-policy"];
    this.config = JSON.stringify({ EvictionPolicy: desired });
    return new Tair.ModifyInstanceConfigResponse({ statusCode: 200 });
  }
  override async modifyInstanceAttribute(
    request: Tair.ModifyInstanceAttributeRequest,
  ): Promise<Tair.ModifyInstanceAttributeResponse> {
    this.transientFailures.throwIfPlanned("DisableReleaseProtection");
    if (this.instance !== undefined) {
      this.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          {
            ...this.instance,
            instanceName: request.instanceName ?? this.instance.instanceName,
            instanceReleaseProtection:
              request.instanceReleaseProtection ??
              this.instance.instanceReleaseProtection,
          },
        );
    }
    return new Tair.ModifyInstanceAttributeResponse({ statusCode: 200 });
  }
  override async modifyInstanceSpec(
    request: Tair.ModifyInstanceSpecRequest,
  ): Promise<Tair.ModifyInstanceSpecResponse> {
    this.instanceSpecModifies += 1;
    this.instanceSpecTokens.push(request.clientToken);
    if (this.instance !== undefined) {
      this.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          {
            ...this.instance,
            instanceClass: request.instanceClass ?? this.instance.instanceClass,
            engineVersion: request.majorVersion ?? this.instance.engineVersion,
            nodeType: request.nodeType ?? this.instance.nodeType,
            readOnlyCount: request.readOnlyCount ?? this.instance.readOnlyCount,
            replicaCount: request.replicaCount ?? this.instance.replicaCount,
            shardCount: request.shardCount ?? this.instance.shardCount,
            secondaryZoneId:
              request.secondaryZoneId ?? this.instance.secondaryZoneId,
            storage:
              request.storage === undefined
                ? this.instance.storage
                : String(request.storage),
            storageType: request.storageType ?? this.instance.storageType,
          },
        );
    }
    return new Tair.ModifyInstanceSpecResponse({ statusCode: 200 });
  }
  override async modifyInstanceSSL(
    request: Tair.ModifyInstanceSSLRequest,
  ): Promise<Tair.ModifyInstanceSSLResponse> {
    this.ssl = new Tair.DescribeInstanceSSLResponseBody({
      ...this.ssl,
      SSLEnabled: request.SSLEnabled,
    });
    return new Tair.ModifyInstanceSSLResponse({ statusCode: 200 });
  }
  override async modifyInstanceVpcAuthMode(
    request: Tair.ModifyInstanceVpcAuthModeRequest,
  ): Promise<Tair.ModifyInstanceVpcAuthModeResponse> {
    this.vpcAuthModifies += 1;
    if (this.instance !== undefined) {
      this.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          {
            ...this.instance,
            vpcAuthMode: request.vpcAuthMode,
          },
        );
    }
    return new Tair.ModifyInstanceVpcAuthModeResponse({ statusCode: 200 });
  }
  override async tagResources(
    request: Tair.TagResourcesRequest,
  ): Promise<Tair.TagResourcesResponse> {
    if (this.instance !== undefined) {
      const tags = new Map(
        (this.instance.tags?.tag ?? []).flatMap((tag) =>
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
      this.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          {
            ...this.instance,
            tags: new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttributeTags(
              {
                tag: [...tags].map(
                  ([key, value]) =>
                    new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttributeTagsTag(
                      { key, value },
                    ),
                ),
              },
            ),
          },
        );
    }
    return new Tair.TagResourcesResponse({ statusCode: 200 });
  }
  override async untagResources(
    request: Tair.UntagResourcesRequest,
  ): Promise<Tair.UntagResourcesResponse> {
    if (this.instance !== undefined) {
      const removed = new Set(request.tagKey ?? []);
      this.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          {
            ...this.instance,
            tags: new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttributeTags(
              {
                tag: (this.instance.tags?.tag ?? []).filter(
                  (tag) => tag.key === undefined || !removed.has(tag.key),
                ),
              },
            ),
          },
        );
    }
    return new Tair.UntagResourcesResponse({ statusCode: 200 });
  }
  override async deleteInstance(
    _request: Tair.DeleteInstanceRequest,
  ): Promise<Tair.DeleteInstanceResponse> {
    this.instanceDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteInstance");
    if (this.instance !== undefined) {
      this.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          { ...this.instance, instanceStatus: "Released" },
        );
    }
    return new Tair.DeleteInstanceResponse({ statusCode: 200 });
  }
  override async destroyInstance(
    _request: Tair.DestroyInstanceRequest,
  ): Promise<Tair.DestroyInstanceResponse> {
    this.instanceDestroys += 1;
    this.transientFailures.throwIfPlanned("DestroyInstance");
    this.instance = undefined;
    return new Tair.DestroyInstanceResponse({ statusCode: 200 });
  }
  override async describeAccounts(
    request: Tair.DescribeAccountsRequest,
  ): Promise<Tair.DescribeAccountsResponse> {
    this.accountReads += 1;
    const account =
      request.accountName === undefined
        ? undefined
        : this.accounts.get(request.accountName);
    return new Tair.DescribeAccountsResponse({
      statusCode: 200,
      body: new Tair.DescribeAccountsResponseBody({
        accounts: new Tair.DescribeAccountsResponseBodyAccounts({
          account: account === undefined ? [] : [account],
        }),
      }),
    });
  }
  override async createAccount(
    request: Tair.CreateAccountRequest,
  ): Promise<Tair.CreateAccountResponse> {
    this.accountCreates += 1;
    if (request.accountName !== undefined) {
      this.accounts.set(
        request.accountName,
        new Tair.DescribeAccountsResponseBodyAccountsAccount({
          accountName: request.accountName,
          accountStatus: "Available",
          accountType: request.accountType,
          accountDescription: request.accountDescription,
          parameters: request.parameters,
          databasePrivileges:
            new Tair.DescribeAccountsResponseBodyAccountsAccountDatabasePrivileges(
              {
                databasePrivilege: [
                  new Tair.DescribeAccountsResponseBodyAccountsAccountDatabasePrivilegesDatabasePrivilege(
                    { accountPrivilege: request.accountPrivilege },
                  ),
                ],
              },
            ),
        }),
      );
    }
    return new Tair.CreateAccountResponse({ statusCode: 200 });
  }
  override async modifyAccountDescription(
    request: Tair.ModifyAccountDescriptionRequest,
  ): Promise<Tair.ModifyAccountDescriptionResponse> {
    this.accountUpdates += 1;
    const current =
      request.accountName === undefined
        ? undefined
        : this.accounts.get(request.accountName);
    if (request.accountName !== undefined && current !== undefined) {
      this.accounts.set(
        request.accountName,
        new Tair.DescribeAccountsResponseBodyAccountsAccount({
          ...current,
          accountDescription: request.accountDescription,
        }),
      );
    }
    return new Tair.ModifyAccountDescriptionResponse({ statusCode: 200 });
  }
  override async resetAccountPassword(
    request: Tair.ResetAccountPasswordRequest,
  ): Promise<Tair.ResetAccountPasswordResponse> {
    this.passwordResets += 1;
    this.lastPasswordResetAccount = request.accountName;
    return new Tair.ResetAccountPasswordResponse({ statusCode: 200 });
  }
  override async deleteAccount(
    request: Tair.DeleteAccountRequest,
  ): Promise<Tair.DeleteAccountResponse> {
    this.accountDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteAccount");
    if (request.accountName !== undefined)
      this.accounts.delete(request.accountName);
    return new Tair.DeleteAccountResponse({ statusCode: 200 });
  }
  override async describeSecurityIps(
    _request: Tair.DescribeSecurityIpsRequest,
  ): Promise<Tair.DescribeSecurityIpsResponse> {
    return new Tair.DescribeSecurityIpsResponse({
      statusCode: 200,
      body: new Tair.DescribeSecurityIpsResponseBody({
        securityIpGroups:
          new Tair.DescribeSecurityIpsResponseBodySecurityIpGroups({
            securityIpGroup: [...this.securityGroups.values()],
          }),
      }),
    });
  }
  override async modifySecurityIps(
    request: Tair.ModifySecurityIpsRequest,
  ): Promise<Tair.ModifySecurityIpsResponse> {
    this.securityGroupModifies += 1;
    this.transientFailures.throwIfPlanned("DeleteSecurityIps");
    const name = request.securityIpGroupName ?? "default";
    const desired = (request.securityIps ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);
    if (request.modifyMode === "Delete") {
      const current = (this.securityGroups.get(name)?.securityIpList ?? "")
        .split(",")
        .filter((ip) => ip.length > 0 && !desired.includes(ip));
      if (current.length === 0) {
        this.securityGroups.delete(name);
      } else {
        this.securityGroups.set(
          name,
          new Tair.DescribeSecurityIpsResponseBodySecurityIpGroupsSecurityIpGroup(
            {
              ...this.securityGroups.get(name),
              securityIpList: current.join(","),
            },
          ),
        );
      }
    } else {
      this.securityGroups.set(
        name,
        new Tair.DescribeSecurityIpsResponseBodySecurityIpGroupsSecurityIpGroup(
          {
            securityIpGroupName: name,
            securityIpGroupAttribute: request.securityIpGroupAttribute,
            securityIpList: desired.join(","),
          },
        ),
      );
    }
    return new Tair.ModifySecurityIpsResponse({ statusCode: 200 });
  }
}
const providerLayer = (fake: StatefulTairClient) =>
  Layer.succeed(AlibabaClients, testClientSet({ tair: fake }));
describe("Tair provider lifecycles", () => {
  it("does not call Tair when an interrupted account has no instance identity", async () => {
    const fake = new StatefulTairClient();
    const layer = AccountProvider().pipe(Layer.provide(providerLayer(fake)));
    const program = Effect.gen(function* () {
      const provider = yield* Account.Provider;
      const read = provider.read;
      if (read === undefined) throw new Error("Account read is missing");
      return yield* read({
        ...resourceBase("interrupted-tair-account"),
        olds: {} as never,
        output: undefined,
      });
    });
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.accountReads).toBe(0);
  });
  it("creates, updates, and destroys an instance through transient teardown failures", async () => {
    const fake = new StatefulTairClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair");
    const initial = {
      name: "example-tair",
      password: Redacted.make("OldPassword1!"),
      instanceClass: "redis.master.small.default",
      engineVersion: "7.0",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
      tags: { environment: "dev" },
    };
    const changed = {
      ...initial,
      password: Redacted.make("NewPassword2!"),
      releaseProtection: true,
      storage: 40,
      ssl: "Enable" as const,
      evictionPolicy: "noeviction" as const,
      vpcAuthMode: "Open" as const,
      tags: { environment: "test" },
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
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
      fake.transientFailures.failNext("DisableReleaseProtection");
      fake.transientFailures.failNext("DeleteInstance");
      fake.transientFailures.failNext("DestroyInstance");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });
    const updated = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(updated).toMatchObject({
      instanceId: "r-test",
      storage: "40",
      connectionDomain: "r-test.redis.rds.aliyuncs.com",
      port: 6379,
      releaseProtection: true,
      ssl: "Enable",
      evictionPolicy: "noeviction",
      vpcAuthMode: "Open",
      tags: { environment: "test" },
    });
    expect(fake.instanceCreates).toBe(1);
    expect(fake.instanceCreateTokens).toEqual(["create-provider-test-tair"]);
    expect(fake.instanceSpecModifies).toBe(1);
    expect(fake.instanceSpecTokens[0]).toMatch(/^spec-[a-f0-9]{56}$/);
    expect(fake.instanceConfigModifies).toBe(1);
    expect(fake.vpcAuthModifies).toBe(1);
    expect(fake.passwordResets).toBe(1);
    expect(fake.lastPasswordResetAccount).toBe("r-test");
    expect(fake.instanceDeletes).toBe(2);
    expect(fake.instanceDestroys).toBe(2);
    expect(fake.instance).toBeUndefined();
  });
  it("uses a stable token per Tair spec request and rotates it for a later resize", async () => {
    const fake = new StatefulTairClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair-spec-token");
    const initial = {
      name: "example-tair-token",
      instanceClass: "redis.master.small.default",
      engineVersion: "7.0",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
    };
    const firstResize = { ...initial, storage: 40 };
    const secondResize = { ...initial, storage: 60 };
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        const created = yield* provider.reconcile({
          ...base,
          news: initial,
          olds: undefined,
          output: undefined,
        });
        const first = yield* provider.reconcile({
          ...base,
          news: firstResize,
          olds: initial,
          output: created,
        });
        yield* provider.reconcile({
          ...base,
          news: secondResize,
          olds: firstResize,
          output: first,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.instanceSpecTokens).toHaveLength(2);
    expect(fake.instanceSpecTokens[0]).toMatch(/^spec-[a-f0-9]{56}$/);
    expect(fake.instanceSpecTokens[1]).toMatch(/^spec-[a-f0-9]{56}$/);
    expect(fake.instanceSpecTokens[1]).not.toBe(fake.instanceSpecTokens[0]);
  });
  it("recovers a tokenized Tair create accepted behind an ambiguous response", async () => {
    const fake = new StatefulTairClient();
    fake.instanceCreateErrors.push({
      code: "InvalidConcurrentOperate",
      message: "A previous operation is still active",
      accepted: true,
    });
    const layer = InstanceProvider({
      wait: { attempts: 2, interval: 0 },
      createRecoveryWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("tair-ambiguous-create");
    const news = {
      name: "example-tair-ambiguous",
      instanceType: "Redis",
      engineVersion: "7.0",
      instanceClass: "redis.shard.small.2.ce",
      chargeType: "PostPaid",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
      zoneId: "ap-southeast-5b",
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      return yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
    });
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({ instanceId: "r-test", status: "Normal" });
    expect(fake.instanceCreates).toBe(1);
    expect(fake.instanceCreateTokens).toEqual([
      "create-provider-test-tair-ambiguous-create",
    ]);
  });
  it("recovers a Tair create accepted behind CanNotAcquireLock", async () => {
    const fake = new StatefulTairClient();
    fake.instanceCreateErrors.push({
      code: "CanNotAcquireLock",
      message: "Can't acquire lock for this operation.",
      accepted: true,
    });
    const layer = InstanceProvider({
      wait: { attempts: 2, interval: 0 },
      createRecoveryWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("tair-lock-create");
    const news = {
      name: "example-tair-lock",
      instanceType: "Redis",
      engineVersion: "7.0",
      instanceClass: "redis.shard.small.2.ce",
      chargeType: "PostPaid",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
      zoneId: "ap-southeast-5b",
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      return yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
    });
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({ instanceId: "r-test", status: "Normal" });
    expect(fake.instanceCreates).toBe(1);
  });
  it("preserves list identity when creating attributes are incomplete", async () => {
    const fake = new StatefulTairClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair-partial-identity");
    const news = {
      name: "example-tair-partial",
      instanceType: "Redis",
      engineVersion: "7.0",
      instanceClass: "redis.shard.small.2.ce",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
      fake.instanceAttributeIdentityOmissions = 1;
      const read = provider.read;
      if (read === undefined) throw new Error("Tair read is missing");
      return yield* read({ ...base, olds: news, output: created });
    });
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({
      instanceId: "r-test",
      name: "example-tair-partial",
    });
  });
  it("resumes an already-releasing Tair instance without another delete request", async () => {
    const fake = new StatefulTairClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair-resumed-delete");
    const news = {
      name: "example-tair",
      instanceType: "Redis",
      engineVersion: "7.0",
      instanceClass: "redis.master.small.default",
      chargeType: "PostPaid",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
      zoneId: "ap-southeast-5a",
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
      fake.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          { ...fake.instance, instanceStatus: "Releasing" },
        );
      fake.instanceReadsUntilAbsent = 1;
      yield* provider.delete({ ...base, olds: news, output: created });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.instanceDeletes).toBe(0);
    expect(fake.instanceDestroys).toBe(0);
    expect(fake.instance).toBeUndefined();
  });
  it("destroys a released Tair instance that normal inventory hides", async () => {
    const fake = new StatefulTairClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair-released");
    const news = {
      name: "example-tair-released",
      instanceType: "Redis",
      engineVersion: "7.0",
      instanceClass: "redis.master.small.default",
      chargeType: "PostPaid",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
      zoneId: "ap-southeast-5a",
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
      fake.instance =
        new Tair.DescribeInstanceAttributeResponseBodyInstancesDBInstanceAttribute(
          { ...fake.instance, instanceStatus: "Released" },
        );
      yield* provider.delete({ ...base, olds: news, output: created });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.instanceDeletes).toBe(0);
    expect(fake.instanceDestroys).toBe(1);
    expect(fake.instance).toBeUndefined();
  });
  it("refuses deletion while Tair inventory APIs remain contradictory", async () => {
    const fake = new StatefulTairClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair-observation-conflict");
    const news = {
      name: "example-tair-conflict",
      instanceType: "Redis",
      engineVersion: "7.0",
      instanceClass: "redis.master.small.default",
      chargeType: "PostPaid",
      networkType: "VPC",
      vpcId: "vpc-test",
      vSwitchId: "vsw-test",
      zoneId: "ap-southeast-5a",
    };
    const program = Effect.gen(function* () {
      const provider = yield* Instance.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
      fake.overviewOnly = true;
      yield* provider.delete({ ...base, olds: news, output: created });
    });
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaObservationConflictError",
      resourceType: "Alibaba.Tair.Instance",
      resourceId: "r-test",
      attempts: 2,
      observations: [
        "DescribeInstancesOverview:visible",
        "DescribeInstanceAttribute:absent",
        "DescribeInstances:absent",
      ],
    });
    expect(fake.instanceDeletes).toBe(0);
    expect(fake.instanceDestroys).toBe(0);
    expect(fake.instance).toBeDefined();
  });
  it("creates, updates, rotates, and deletes an account after a transient failure", async () => {
    const fake = new StatefulTairClient();
    const layer = AccountProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("tair-account");
    const initial = {
      instanceId: "r-test",
      name: "example_app",
      password: Redacted.make("OldPassword1!"),
      settings: {
        accountType: "Normal",
        accountPrivilege: "RoleReadWrite",
        accountDescription: "Example",
      },
    };
    const changed = {
      ...initial,
      password: Redacted.make("NewPassword2!"),
      settings: {
        ...initial.settings,
        accountDescription: "Example development",
      },
    };
    const program = Effect.gen(function* () {
      const provider = yield* Account.Provider;
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
      fake.transientFailures.failNext("DeleteAccount");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });
    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({ description: "Example development" });
    expect(fake.accountCreates).toBe(1);
    expect(fake.accountUpdates).toBe(1);
    expect(fake.passwordResets).toBe(1);
    expect(fake.lastPasswordResetAccount).toBe("example_app");
    expect(fake.accountDeletes).toBe(2);
  });
  it("covers and deletes a security IP group after a transient failure", async () => {
    const fake = new StatefulTairClient();
    const layer = SecurityIpGroupProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("tair-security-ips");
    const initial = {
      instanceId: "r-test",
      name: "application",
      securityIps: ["10.0.0.2", "10.0.0.1"],
      attribute: "private",
    };
    const changed = { ...initial, securityIps: ["10.0.0.3"] };
    const program = Effect.gen(function* () {
      const provider = yield* SecurityIpGroup.Provider;
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
      fake.transientFailures.failNext("DeleteSecurityIps");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });
    const updated = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(updated.securityIps).toEqual(["10.0.0.3"]);
    expect(fake.securityGroups.size).toBe(0);
    expect(fake.securityGroupModifies).toBe(4);
  });
  it("restores the immutable default security group before deletion", async () => {
    const fake = new StatefulTairClient();
    const layer = SecurityIpGroupProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("tair-default-security-ips");
    const news = {
      instanceId: "r-test",
      name: "default",
      securityIps: ["10.40.0.0/16"],
    };
    const program = Effect.gen(function* () {
      const provider = yield* SecurityIpGroup.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news,
        olds: undefined,
        output: undefined,
      });
      yield* provider.delete({ ...base, olds: news, output: created });
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.securityGroups.get("default")?.securityIpList).toBe(
      "127.0.0.1",
    );
    expect(fake.securityGroupModifies).toBe(2);
  });
});
