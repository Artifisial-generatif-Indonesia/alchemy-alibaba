import RDSClient, * as RDS from "@alicloud/rds20140815";
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
import {
  AccountPrivilege,
  AccountPrivilegeProvider,
} from "./account-privilege.ts";
import { Database, DatabaseProvider } from "./database.ts";
import { Instance, InstanceProvider } from "./instance.ts";
import {
  SecurityIpGroup,
  SecurityIpGroupProvider,
} from "./security-ip-group.ts";

class StatefulRDSClient extends RDSClient {
  readonly transientFailures = new TestTransientFailures();
  instance:
    | RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute
    | undefined;
  tags = new Map<string, string>();
  ssl = new RDS.DescribeDBInstanceSSLResponseBody({ SSLEnabled: "off" });
  network =
    new RDS.DescribeDBInstanceNetInfoResponseBodyDBInstanceNetInfosDBInstanceNetInfo(
      {
        connectionString: "rm-test.pg.rds.aliyuncs.com",
        connectionStringType: "Normal",
        IPAddress: "10.40.0.8",
        IPType: "Private",
        port: "5432",
      },
    );
  databases = new Map<
    string,
    RDS.DescribeDatabasesResponseBodyDatabasesDatabase
  >();
  accounts = new Map<
    string,
    RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount
  >();
  securityGroups = new Map<
    string,
    RDS.DescribeDBInstanceIPArrayListResponseBodyItemsDBInstanceIPArray
  >();
  instanceCreates = 0;
  instanceClientTokens: Array<string | undefined> = [];
  instanceCreateFailure:
    | { readonly accepted: boolean; readonly code: string }
    | undefined;
  instanceCreateStatus = "Running";
  instanceSpecModifies = 0;
  instanceDeletes = 0;
  instanceReadsUntilAbsent = 0;
  instanceReadsUntilRunning = 0;
  databaseCreates = 0;
  databaseReads = 0;
  databaseUpdates = 0;
  databaseDeletes = 0;
  accountCreates = 0;
  accountUpdates = 0;
  passwordResets = 0;
  accountDeletes = 0;
  privilegeGrants = 0;
  privilegeRevokes = 0;
  securityGroupModifies = 0;
  securityGroupParentMissing = false;

  constructor() {
    super(testConfig());
  }

  override async describeDBInstanceAttribute(
    request: RDS.DescribeDBInstanceAttributeRequest,
  ): Promise<RDS.DescribeDBInstanceAttributeResponse> {
    const instance =
      this.instance?.DBInstanceId === request.DBInstanceId
        ? this.instance
        : undefined;
    if (instance !== undefined && this.instanceReadsUntilRunning > 0) {
      this.instanceReadsUntilRunning -= 1;
      if (this.instanceReadsUntilRunning === 0) {
        this.instance =
          new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
            {
              ...this.instance,
              DBInstanceStatus: "Running",
            },
          );
      }
    }
    if (instance !== undefined && this.instanceReadsUntilAbsent > 0) {
      this.instanceReadsUntilAbsent -= 1;
      if (this.instanceReadsUntilAbsent === 0) this.instance = undefined;
    }
    return new RDS.DescribeDBInstanceAttributeResponse({
      statusCode: instance === undefined ? 404 : 200,
      body: new RDS.DescribeDBInstanceAttributeResponseBody({
        items: new RDS.DescribeDBInstanceAttributeResponseBodyItems({
          DBInstanceAttribute: instance === undefined ? [] : [instance],
        }),
      }),
    });
  }

  override async describeDBInstances(
    _request: RDS.DescribeDBInstancesRequest,
  ): Promise<RDS.DescribeDBInstancesResponse> {
    return new RDS.DescribeDBInstancesResponse({
      statusCode: 200,
      body: new RDS.DescribeDBInstancesResponseBody({
        items: new RDS.DescribeDBInstancesResponseBodyItems({
          DBInstance:
            this.instance === undefined
              ? []
              : [
                  new RDS.DescribeDBInstancesResponseBodyItemsDBInstance({
                    DBInstanceId: this.instance.DBInstanceId,
                    DBInstanceDescription: this.instance.DBInstanceDescription,
                    DBInstanceStatus: this.instance.DBInstanceStatus,
                  }),
                ],
        }),
      }),
    });
  }

  override async createDBInstance(
    request: RDS.CreateDBInstanceRequest,
  ): Promise<RDS.CreateDBInstanceResponse> {
    this.instanceCreates += 1;
    this.instanceClientTokens.push(request.clientToken);
    const failure = this.instanceCreateFailure;
    this.instanceCreateFailure = undefined;
    const fail = () => {
      throw Object.assign(new Error("Concurrent operation is detected."), {
        code: failure?.code,
        statusCode: 400,
      });
    };
    if (failure !== undefined && !failure.accepted) fail();
    this.instance =
      new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute({
        DBInstanceId: "rm-test",
        DBInstanceDescription: request.DBInstanceDescription,
        DBInstanceStatus: this.instanceCreateStatus,
        DBInstanceClass: request.DBInstanceClass,
        DBInstanceStorage: request.DBInstanceStorage,
        DBInstanceStorageType: request.DBInstanceStorageType,
        engine: request.engine,
        engineVersion: request.engineVersion,
        category: request.category,
        deletionProtection: false,
        regionId: request.regionId ?? "ap-southeast-5",
        creationTime: "2026-08-31T00:00:00Z",
      });
    this.tags = new Map(
      (request.tag ?? []).flatMap((tag) =>
        tag.key === undefined || tag.value === undefined
          ? []
          : [[tag.key, tag.value] as const],
      ),
    );
    if (failure !== undefined) fail();
    return new RDS.CreateDBInstanceResponse({
      statusCode: 200,
      body: new RDS.CreateDBInstanceResponseBody({ DBInstanceId: "rm-test" }),
    });
  }

  override async listTagResources(
    _request: RDS.ListTagResourcesRequest,
  ): Promise<RDS.ListTagResourcesResponse> {
    return new RDS.ListTagResourcesResponse({
      statusCode: 200,
      body: new RDS.ListTagResourcesResponseBody({
        tagResources: new RDS.ListTagResourcesResponseBodyTagResources({
          tagResource: [...this.tags].map(
            ([tagKey, tagValue]) =>
              new RDS.ListTagResourcesResponseBodyTagResourcesTagResource({
                tagKey,
                tagValue,
                resourceId: "rm-test",
              }),
          ),
        }),
      }),
    });
  }

  override async tagResources(
    request: RDS.TagResourcesRequest,
  ): Promise<RDS.TagResourcesResponse> {
    for (const tag of request.tag ?? []) {
      if (tag.key !== undefined && tag.value !== undefined) {
        this.tags.set(tag.key, tag.value);
      }
    }
    return new RDS.TagResourcesResponse({ statusCode: 200 });
  }

  override async untagResources(
    request: RDS.UntagResourcesRequest,
  ): Promise<RDS.UntagResourcesResponse> {
    for (const key of request.tagKey ?? []) this.tags.delete(key);
    return new RDS.UntagResourcesResponse({ statusCode: 200 });
  }

  override async describeDBInstanceSSL(
    _request: RDS.DescribeDBInstanceSSLRequest,
  ): Promise<RDS.DescribeDBInstanceSSLResponse> {
    return new RDS.DescribeDBInstanceSSLResponse({
      statusCode: this.instance === undefined ? 404 : 200,
      body: this.instance === undefined ? undefined : this.ssl,
    });
  }

  override async describeDBInstanceNetInfo(
    _request: RDS.DescribeDBInstanceNetInfoRequest,
  ): Promise<RDS.DescribeDBInstanceNetInfoResponse> {
    return new RDS.DescribeDBInstanceNetInfoResponse({
      statusCode: this.instance === undefined ? 404 : 200,
      body:
        this.instance === undefined
          ? undefined
          : new RDS.DescribeDBInstanceNetInfoResponseBody({
              DBInstanceNetInfos:
                new RDS.DescribeDBInstanceNetInfoResponseBodyDBInstanceNetInfos(
                  { DBInstanceNetInfo: [this.network] },
                ),
            }),
    });
  }

  override async modifyDBInstanceDescription(
    request: RDS.ModifyDBInstanceDescriptionRequest,
  ): Promise<RDS.ModifyDBInstanceDescriptionResponse> {
    if (this.instance !== undefined) {
      this.instance =
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            ...this.instance,
            DBInstanceDescription: request.DBInstanceDescription,
          },
        );
    }
    return new RDS.ModifyDBInstanceDescriptionResponse({ statusCode: 200 });
  }

  override async modifyDBInstanceDeletionProtection(
    request: RDS.ModifyDBInstanceDeletionProtectionRequest,
  ): Promise<RDS.ModifyDBInstanceDeletionProtectionResponse> {
    this.transientFailures.throwIfPlanned("DisableDeletionProtection");
    if (this.instance !== undefined) {
      this.instance =
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            ...this.instance,
            deletionProtection: request.deletionProtection,
          },
        );
    }
    return new RDS.ModifyDBInstanceDeletionProtectionResponse({
      statusCode: 200,
    });
  }

  override async modifyDBInstanceSpec(
    request: RDS.ModifyDBInstanceSpecRequest,
  ): Promise<RDS.ModifyDBInstanceSpecResponse> {
    this.instanceSpecModifies += 1;
    if (this.instance !== undefined) {
      this.instance =
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            ...this.instance,
            DBInstanceClass:
              request.DBInstanceClass ?? this.instance.DBInstanceClass,
            DBInstanceStorage:
              request.DBInstanceStorage ?? this.instance.DBInstanceStorage,
            DBInstanceStorageType:
              request.DBInstanceStorageType ??
              this.instance.DBInstanceStorageType,
            engineVersion: request.engineVersion ?? this.instance.engineVersion,
            category: request.category ?? this.instance.category,
          },
        );
    }
    return new RDS.ModifyDBInstanceSpecResponse({ statusCode: 200 });
  }

  override async modifyDBInstanceSSL(
    request: RDS.ModifyDBInstanceSSLRequest,
  ): Promise<RDS.ModifyDBInstanceSSLResponse> {
    if (request.SSLEnabled === 1 && request.connectionString === undefined) {
      throw new Error("RDS requires a connection string when enabling SSL");
    }
    this.ssl = new RDS.DescribeDBInstanceSSLResponseBody({
      ...this.ssl,
      SSLEnabled:
        request.SSLEnabled === undefined
          ? this.ssl.SSLEnabled
          : request.SSLEnabled === 1
            ? "on"
            : "off",
      connectionString: request.connectionString,
      CAType: request.CAType,
      tlsVersion: request.tlsVersion,
    });
    return new RDS.ModifyDBInstanceSSLResponse({ statusCode: 200 });
  }

  override async deleteDBInstance(
    _request: RDS.DeleteDBInstanceRequest,
  ): Promise<RDS.DeleteDBInstanceResponse> {
    if (this.instance?.DBInstanceStatus === "Creating") {
      throw Object.assign(
        new Error("Current DB instance state does not support this operation."),
        { code: "IncorrectDBInstanceState", statusCode: 403 },
      );
    }
    this.instanceDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteDBInstance");
    this.instance = undefined;
    return new RDS.DeleteDBInstanceResponse({ statusCode: 200 });
  }

  override async describeDatabases(
    request: RDS.DescribeDatabasesRequest,
  ): Promise<RDS.DescribeDatabasesResponse> {
    this.databaseReads += 1;
    const database =
      request.DBName === undefined
        ? undefined
        : this.databases.get(request.DBName);
    return new RDS.DescribeDatabasesResponse({
      statusCode: 200,
      body: new RDS.DescribeDatabasesResponseBody({
        databases: new RDS.DescribeDatabasesResponseBodyDatabases({
          database: database === undefined ? [] : [database],
        }),
      }),
    });
  }

  override async createDatabase(
    request: RDS.CreateDatabaseRequest,
  ): Promise<RDS.CreateDatabaseResponse> {
    this.databaseCreates += 1;
    if (request.DBName !== undefined) {
      const [characterSetName, collate, ctype] =
        request.characterSetName?.split(",") ?? [];
      this.databases.set(
        request.DBName,
        new RDS.DescribeDatabasesResponseBodyDatabasesDatabase({
          DBName: request.DBName,
          DBStatus: "Running",
          characterSetName,
          collate,
          ctype,
          DBDescription: request.DBDescription,
        }),
      );
    }
    return new RDS.CreateDatabaseResponse({ statusCode: 200 });
  }

  override async modifyDBDescription(
    request: RDS.ModifyDBDescriptionRequest,
  ): Promise<RDS.ModifyDBDescriptionResponse> {
    this.databaseUpdates += 1;
    const current =
      request.DBName === undefined
        ? undefined
        : this.databases.get(request.DBName);
    if (request.DBName !== undefined && current !== undefined) {
      this.databases.set(
        request.DBName,
        new RDS.DescribeDatabasesResponseBodyDatabasesDatabase({
          ...current,
          DBDescription: request.DBDescription,
        }),
      );
    }
    return new RDS.ModifyDBDescriptionResponse({ statusCode: 200 });
  }

  override async deleteDatabase(
    request: RDS.DeleteDatabaseRequest,
  ): Promise<RDS.DeleteDatabaseResponse> {
    this.databaseDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteDatabase");
    if (request.DBName !== undefined) this.databases.delete(request.DBName);
    return new RDS.DeleteDatabaseResponse({ statusCode: 200 });
  }

  override async describeAccounts(
    request: RDS.DescribeAccountsRequest,
  ): Promise<RDS.DescribeAccountsResponse> {
    const account =
      request.accountName === undefined
        ? undefined
        : this.accounts.get(request.accountName);
    return new RDS.DescribeAccountsResponse({
      statusCode: 200,
      body: new RDS.DescribeAccountsResponseBody({
        accounts: new RDS.DescribeAccountsResponseBodyAccounts({
          DBInstanceAccount: account === undefined ? [] : [account],
        }),
      }),
    });
  }

  override async createAccount(
    request: RDS.CreateAccountRequest,
  ): Promise<RDS.CreateAccountResponse> {
    this.accountCreates += 1;
    if (request.accountName !== undefined) {
      this.accounts.set(
        request.accountName,
        new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
          accountName: request.accountName,
          accountStatus: "Available",
          accountType: request.accountType,
          accountDescription: request.accountDescription,
          checkPolicy: request.checkPolicy,
          databasePrivileges:
            new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivileges(
              { databasePrivilege: [] },
            ),
        }),
      );
    }
    return new RDS.CreateAccountResponse({ statusCode: 200 });
  }

  override async modifyAccountDescription(
    request: RDS.ModifyAccountDescriptionRequest,
  ): Promise<RDS.ModifyAccountDescriptionResponse> {
    this.accountUpdates += 1;
    const current =
      request.accountName === undefined
        ? undefined
        : this.accounts.get(request.accountName);
    if (request.accountName !== undefined && current !== undefined) {
      this.accounts.set(
        request.accountName,
        new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
          ...current,
          accountDescription: request.accountDescription,
        }),
      );
    }
    return new RDS.ModifyAccountDescriptionResponse({ statusCode: 200 });
  }

  override async resetAccountPassword(
    _request: RDS.ResetAccountPasswordRequest,
  ): Promise<RDS.ResetAccountPasswordResponse> {
    this.passwordResets += 1;
    return new RDS.ResetAccountPasswordResponse({ statusCode: 200 });
  }

  override async deleteAccount(
    request: RDS.DeleteAccountRequest,
  ): Promise<RDS.DeleteAccountResponse> {
    this.accountDeletes += 1;
    this.transientFailures.throwIfPlanned("DeleteAccount");
    if (request.accountName !== undefined)
      this.accounts.delete(request.accountName);
    return new RDS.DeleteAccountResponse({ statusCode: 200 });
  }

  override async grantAccountPrivilege(
    request: RDS.GrantAccountPrivilegeRequest,
  ): Promise<RDS.GrantAccountPrivilegeResponse> {
    this.privilegeGrants += 1;
    const account =
      request.accountName === undefined
        ? undefined
        : this.accounts.get(request.accountName);
    if (request.accountName !== undefined && account !== undefined) {
      const other = (
        account.databasePrivileges?.databasePrivilege ?? []
      ).filter((item) => item.DBName !== request.DBName);
      this.accounts.set(
        request.accountName,
        new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
          ...account,
          databasePrivileges:
            new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivileges(
              {
                databasePrivilege: [
                  ...other,
                  new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivilegesDatabasePrivilege(
                    {
                      DBName: request.DBName,
                      accountPrivilege: request.accountPrivilege,
                    },
                  ),
                ],
              },
            ),
        }),
      );
    }
    return new RDS.GrantAccountPrivilegeResponse({ statusCode: 200 });
  }

  override async revokeAccountPrivilege(
    request: RDS.RevokeAccountPrivilegeRequest,
  ): Promise<RDS.RevokeAccountPrivilegeResponse> {
    this.privilegeRevokes += 1;
    this.transientFailures.throwIfPlanned("RevokeAccountPrivilege");
    const account =
      request.accountName === undefined
        ? undefined
        : this.accounts.get(request.accountName);
    if (request.accountName !== undefined && account !== undefined) {
      this.accounts.set(
        request.accountName,
        new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
          ...account,
          databasePrivileges:
            new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivileges(
              {
                databasePrivilege: (
                  account.databasePrivileges?.databasePrivilege ?? []
                ).filter((item) => item.DBName !== request.DBName),
              },
            ),
        }),
      );
    }
    return new RDS.RevokeAccountPrivilegeResponse({ statusCode: 200 });
  }

  override async describeDBInstanceIPArrayList(
    _request: RDS.DescribeDBInstanceIPArrayListRequest,
  ): Promise<RDS.DescribeDBInstanceIPArrayListResponse> {
    if (this.securityGroupParentMissing) {
      return new RDS.DescribeDBInstanceIPArrayListResponse({ statusCode: 404 });
    }
    return new RDS.DescribeDBInstanceIPArrayListResponse({
      statusCode: 200,
      body: new RDS.DescribeDBInstanceIPArrayListResponseBody({
        items: new RDS.DescribeDBInstanceIPArrayListResponseBodyItems({
          DBInstanceIPArray: [...this.securityGroups.values()],
        }),
      }),
    });
  }

  override async modifySecurityIps(
    request: RDS.ModifySecurityIpsRequest,
  ): Promise<RDS.ModifySecurityIpsResponse> {
    this.securityGroupModifies += 1;
    this.transientFailures.throwIfPlanned("ResetSecurityIps");
    if (this.securityGroupParentMissing) {
      throw Object.assign(new Error("DB instance not found"), {
        code: "InvalidDBInstanceId.NotFound",
        statusCode: 404,
      });
    }
    const name = request.DBInstanceIPArrayName ?? "Default";
    this.securityGroups.set(
      name,
      new RDS.DescribeDBInstanceIPArrayListResponseBodyItemsDBInstanceIPArray({
        DBInstanceIPArrayName: name,
        DBInstanceIPArrayAttribute: request.DBInstanceIPArrayAttribute,
        securityIPList: request.securityIps,
        securityIPType: request.securityIPType,
      }),
    );
    return new RDS.ModifySecurityIpsResponse({ statusCode: 200 });
  }
}

const providerLayer = (fake: StatefulRDSClient) =>
  Layer.succeed(AlibabaClients, testClientSet({ rds: fake }));

describe("RDS provider lifecycles", () => {
  it("does not call RDS when an interrupted database has no instance identity", async () => {
    const fake = new StatefulRDSClient();
    const layer = DatabaseProvider().pipe(Layer.provide(providerLayer(fake)));
    const program = Effect.gen(function* () {
      const provider = yield* Database.Provider;
      const read = provider.read;
      if (read === undefined) throw new Error("Database read is missing");
      return yield* read({
        ...resourceBase("interrupted-database"),
        olds: {} as never,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.databaseReads).toBe(0);
  });

  it("creates, updates, and deletes an instance through transient teardown failures", async () => {
    const fake = new StatefulRDSClient();
    const layer = InstanceProvider({
      wait: { attempts: 2, interval: 0 },
      deleteRequestWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("rds");
    const initial = {
      name: "example-rds",
      create: {
        engine: "MySQL" as const,
        engineVersion: "8.0",
        DBInstanceClass: "mysql.n2.medium.1",
        DBInstanceNetType: "Intranet" as const,
        DBInstanceStorage: 20,
        payType: "Postpaid" as const,
        securityIPList: "127.0.0.1",
      },
      tags: { environment: "dev" },
    };
    const changed = {
      ...initial,
      deletionProtection: true,
      spec: { DBInstanceStorage: 40 },
      ssl: { SSLEnabled: 1 },
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
      fake.transientFailures.failNext("DisableDeletionProtection");
      fake.transientFailures.failNext("DeleteDBInstance");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    const updated = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(updated).toMatchObject({
      instanceId: "rm-test",
      storage: 40,
      connectionString: "rm-test.pg.rds.aliyuncs.com",
      privateIp: "10.40.0.8",
      port: "5432",
      deletionProtection: true,
      sslEnabled: "on",
      tags: { environment: "test" },
    });
    expect(fake.instanceCreates).toBe(1);
    expect(fake.instanceClientTokens).toEqual([`create-${base.instanceId}`]);
    expect(fake.instanceSpecModifies).toBe(1);
    expect(fake.instanceDeletes).toBe(2);
    expect(fake.instance).toBeUndefined();
  });

  it("resumes an already-deleting RDS instance without another delete request", async () => {
    const fake = new StatefulRDSClient();
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("rds-resumed-delete");
    const news = {
      name: "example-rds",
      create: {
        engine: "PostgreSQL" as const,
        engineVersion: "18.0",
        DBInstanceClass: "pg.n2.medium.1",
        DBInstanceNetType: "Intranet" as const,
        DBInstanceStorage: 20,
        payType: "Postpaid" as const,
        securityIPList: "127.0.0.1",
      },
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
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          { ...fake.instance, DBInstanceStatus: "Deleting" },
        );
      fake.instanceReadsUntilAbsent = 1;
      yield* provider.delete({ ...base, olds: news, output: created });
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.instanceDeletes).toBe(0);
    expect(fake.instance).toBeUndefined();
  });

  it("recovers an accepted RDS create after a concurrent-operation response", async () => {
    const fake = new StatefulRDSClient();
    fake.instanceCreateFailure = {
      accepted: true,
      code: "InvalidConcurrentOperate",
    };
    fake.instanceCreateStatus = "Creating";
    fake.instanceReadsUntilRunning = 2;
    const layer = InstanceProvider({
      wait: { attempts: 2, interval: 0 },
      createRecoveryWait: { attempts: 1, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("rds-ambiguous-create");

    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        return yield* provider.reconcile({
          ...base,
          news: {
            name: "example-rds",
            create: {
              engine: "PostgreSQL",
              engineVersion: "18.0",
              DBInstanceClass: "pg.n2.medium.1",
              DBInstanceNetType: "Intranet",
              DBInstanceStorage: 20,
              payType: "Postpaid",
              securityIPList: "127.0.0.1",
            },
          },
          olds: undefined,
          output: undefined,
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );

    expect(created.instanceId).toBe("rm-test");
    expect(fake.instanceCreates).toBe(1);
  });

  it("preserves an ambiguous RDS create error when no instance appears", async () => {
    const fake = new StatefulRDSClient();
    fake.instanceCreateFailure = {
      accepted: false,
      code: "InvalidConcurrentOperate",
    };
    const layer = InstanceProvider({
      wait: { attempts: 1, interval: 0 },
      createRecoveryWait: { attempts: 1, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("rds-unaccepted-create");
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const provider = yield* Instance.Provider;
          return yield* provider.reconcile({
            ...base,
            news: {
              name: "example-rds",
              create: {
                engine: "PostgreSQL",
                engineVersion: "18.0",
                DBInstanceClass: "pg.n2.medium.1",
                DBInstanceNetType: "Intranet",
                DBInstanceStorage: 20,
                payType: "Postpaid",
                securityIPList: "127.0.0.1",
              },
            },
            olds: undefined,
            output: undefined,
          });
        }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    );

    expect(error).toMatchObject({
      _tag: "AlibabaProviderError",
      code: "InvalidConcurrentOperate",
    });
  });

  it("waits for a creating RDS instance before requesting deletion", async () => {
    const fake = new StatefulRDSClient();
    const layer = InstanceProvider({
      wait: { attempts: 2, interval: 0 },
      deleteRequestWait: { attempts: 4, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("rds-creating-delete");
    const news = {
      name: "example-rds",
      create: {
        engine: "PostgreSQL" as const,
        engineVersion: "18.0",
        DBInstanceClass: "pg.n2.medium.1",
        DBInstanceNetType: "Intranet" as const,
        DBInstanceStorage: 20,
        payType: "Postpaid" as const,
        securityIPList: "127.0.0.1",
      },
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
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            ...fake.instance,
            DBInstanceStatus: "Creating",
          },
        );
      fake.instanceReadsUntilRunning = 2;
      yield* provider.delete({ ...base, olds: news, output: created });
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.instanceDeletes).toBe(1);
    expect(fake.instance).toBeUndefined();
  });

  it("fails closed with the final RDS state when deletion never becomes valid", async () => {
    const fake = new StatefulRDSClient();
    const layer = InstanceProvider({
      wait: { attempts: 1, interval: 0 },
      deleteRequestWait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("rds-delete-state-timeout");
    const news = {
      name: "example-rds",
      create: {
        engine: "PostgreSQL" as const,
        engineVersion: "18.0",
        DBInstanceClass: "pg.n2.medium.1",
        DBInstanceNetType: "Intranet" as const,
        DBInstanceStorage: 20,
        payType: "Postpaid" as const,
        securityIPList: "127.0.0.1",
      },
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
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            ...fake.instance,
            DBInstanceStatus: "Creating",
          },
        );
      yield* provider.delete({ ...base, olds: news, output: created });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).rejects.toMatchObject({
      _tag: "AlibabaWaitTimeoutError",
      resourceType: "Alibaba.RDS.Instance",
      operation: "RequestDeleteDBInstance",
      attempts: 2,
      lastObservation: "status:Creating",
    });
    expect(fake.instanceDeletes).toBe(0);
    expect(fake.instance).toBeDefined();
  });

  it("finishes instance deletion when RDS reports InvalidDBInstanceName.NotFound", async () => {
    const fake = new StatefulRDSClient();
    fake.describeDBInstanceAttribute = async () => {
      throw { code: "InvalidDBInstanceName.NotFound", statusCode: 400 };
    };
    const layer = InstanceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Instance.Provider;
        yield* provider.delete({
          ...resourceBase("released-rds"),
          olds: {
            create: {
              engine: "PostgreSQL",
              engineVersion: "16.0",
              DBInstanceClass: "test",
              DBInstanceNetType: "Intranet",
              DBInstanceStorage: 20,
              payType: "Postpaid",
              securityIPList: "127.0.0.1",
            },
          },
          output: {
            instanceId: "rm-test",
            name: "example",
            status: "Running",
            deletionProtection: false,
            tags: {},
          },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.instanceDeletes).toBe(0);
  });

  it("does not repeat DeleteDatabase after the database is already absent", async () => {
    const fake = new StatefulRDSClient();
    fake.transientFailures.failNext("DeleteDatabase");
    const layer = DatabaseProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const props = {
      instanceId: "rm-test",
      name: "example",
      characterSetName: "UTF8",
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Database.Provider;
        yield* provider.delete({
          ...resourceBase("absent-db"),
          olds: props,
          output: { ...props, status: "Running" },
        });
      }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(fake.databaseDeletes).toBe(0);
  });

  it("creates, updates, and deletes a database after a transient failure", async () => {
    const fake = new StatefulRDSClient();
    const layer = DatabaseProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("database");
    const initial = {
      instanceId: "rm-test",
      name: "example",
      characterSetName: "UTF8,C,en_US.utf8",
      description: "Example",
    };
    const changed = { ...initial, description: "Example development" };
    const program = Effect.gen(function* () {
      const provider = yield* Database.Provider;
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
      fake.transientFailures.failNext("DeleteDatabase");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({ description: "Example development" });
    expect(fake.databaseCreates).toBe(1);
    expect(fake.databaseUpdates).toBe(1);
    expect(fake.databaseDeletes).toBe(2);
    expect(fake.databases.size).toBe(0);
  });

  it("creates, updates, rotates, and deletes an account after a transient failure", async () => {
    const fake = new StatefulRDSClient();
    const layer = AccountProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(providerLayer(fake)),
    );
    const base = resourceBase("account");
    const initial = {
      instanceId: "rm-test",
      name: "example_app",
      password: Redacted.make("OldPassword1!"),
      description: "Example",
      settings: { accountType: "Normal" },
    };
    const changed = {
      ...initial,
      password: Redacted.make("NewPassword2!"),
      description: "Example development",
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
    expect(fake.accountDeletes).toBe(2);
  });

  it("grants, changes, and revokes a privilege after a transient failure", async () => {
    const fake = new StatefulRDSClient();
    fake.accounts.set(
      "example_app",
      new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
        accountName: "example_app",
        accountStatus: "Available",
        databasePrivileges:
          new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivileges(
            { databasePrivilege: [] },
          ),
      }),
    );
    const layer = AccountPrivilegeProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("privilege");
    const initial = {
      instanceId: "rm-test",
      accountName: "example_app",
      databaseName: "example",
      privilege: "ReadOnly" as const,
    };
    const changed = { ...initial, privilege: "ReadWrite" as const };
    const program = Effect.gen(function* () {
      const provider = yield* AccountPrivilege.Provider;
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
      fake.transientFailures.failNext("RevokeAccountPrivilege");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({ privilege: "ReadWrite" });
    expect(fake.privilegeGrants).toBe(2);
    expect(fake.privilegeRevokes).toBe(2);
  });

  it("normalizes PostgreSQL DBOwner from the database read model", async () => {
    const fake = new StatefulRDSClient();
    fake.accounts.set(
      "example_owner",
      new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
        accountName: "example_owner",
        accountStatus: "Available",
        databasePrivileges:
          new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivileges(
            { databasePrivilege: [] },
          ),
      }),
    );
    fake.databases.set(
      "example",
      new RDS.DescribeDatabasesResponseBodyDatabasesDatabase({
        DBName: "example",
        DBStatus: "Running",
        accounts:
          new RDS.DescribeDatabasesResponseBodyDatabasesDatabaseAccounts({
            accountPrivilegeInfo: [
              new RDS.DescribeDatabasesResponseBodyDatabasesDatabaseAccountsAccountPrivilegeInfo(
                {
                  account: "example_owner",
                  accountPrivilege: "ALL",
                  accountPrivilegeDetail: "ALL",
                },
              ),
            ],
          }),
      }),
    );
    const layer = AccountPrivilegeProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("postgresql-owner");
    const props = {
      instanceId: "rm-test",
      accountName: "example_owner",
      databaseName: "example",
      privilege: "DBOwner" as const,
    };
    const program = Effect.gen(function* () {
      const provider = yield* AccountPrivilege.Provider;
      return yield* provider.reconcile({
        ...base,
        news: props,
        olds: props,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject(props);
    expect(fake.privilegeGrants).toBe(0);
  });

  it.each([true, false])(
    "handles PostgreSQL privilege deletion with binding present=%s",
    async (present) => {
      const fake = new StatefulRDSClient();
      fake.instance =
        new RDS.DescribeDBInstanceAttributeResponseBodyItemsDBInstanceAttribute(
          {
            DBInstanceId: "rm-test",
            engine: "PostgreSQL",
          },
        );
      fake.accounts.set(
        "owner",
        new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
          accountName: "owner",
          accountType: "Normal",
        }),
      );
      if (present)
        fake.databases.set(
          "example",
          new RDS.DescribeDatabasesResponseBodyDatabasesDatabase({
            DBName: "example",
            accounts:
              new RDS.DescribeDatabasesResponseBodyDatabasesDatabaseAccounts({
                accountPrivilegeInfo: [
                  new RDS.DescribeDatabasesResponseBodyDatabasesDatabaseAccountsAccountPrivilegeInfo(
                    {
                      account: "owner",
                      accountPrivilege: "ALL",
                    },
                  ),
                ],
              }),
          }),
        );
      const props = {
        instanceId: "rm-test",
        accountName: "owner",
        databaseName: "example",
        privilege: "DBOwner" as const,
      };
      const layer = AccountPrivilegeProvider({
        wait: { attempts: 2, interval: 0 },
      }).pipe(Layer.provide(providerLayer(fake)));
      const result = Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* AccountPrivilege.Provider;
          return yield* provider.delete({
            ...resourceBase("pg-delete"),
            olds: props,
            output: props,
          });
        }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      );
      if (present)
        await expect(result).rejects.toThrow(
          "PostgreSQL does not support RevokeAccountPrivilege",
        );
      else await expect(result).resolves.toBeUndefined();
      expect(fake.privilegeRevokes).toBe(0);
      expect(fake.databaseDeletes).toBe(0);
      expect(fake.accountDeletes).toBe(0);
    },
  );

  it("does not revoke implicit access from a PostgreSQL privileged account", async () => {
    const fake = new StatefulRDSClient();
    fake.accounts.set(
      "example_super",
      new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount({
        accountName: "example_super",
        accountStatus: "Available",
        accountType: "Super",
        databasePrivileges:
          new RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccountDatabasePrivileges(
            { databasePrivilege: [] },
          ),
      }),
    );
    fake.databases.set(
      "example",
      new RDS.DescribeDatabasesResponseBodyDatabasesDatabase({
        DBName: "example",
        DBStatus: "Running",
        accounts:
          new RDS.DescribeDatabasesResponseBodyDatabasesDatabaseAccounts({
            accountPrivilegeInfo: [
              new RDS.DescribeDatabasesResponseBodyDatabasesDatabaseAccountsAccountPrivilegeInfo(
                {
                  account: "example_super",
                  accountPrivilege: "ALL",
                },
              ),
            ],
          }),
      }),
    );
    const layer = AccountPrivilegeProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("privileged-account");

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* AccountPrivilege.Provider;
          yield* provider.delete({
            ...base,
            olds: {
              instanceId: "rm-test",
              accountName: "example_super",
              databaseName: "example",
              privilege: "DBOwner",
            },
            output: {
              instanceId: "rm-test",
              accountName: "example_super",
              databaseName: "example",
              privilege: "DBOwner",
            },
          });
        }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.privilegeRevokes).toBe(0);
  });

  it("covers and resets a security IP group after a transient failure", async () => {
    const fake = new StatefulRDSClient();
    const layer = SecurityIpGroupProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("security-ips");
    const initial = {
      instanceId: "rm-test",
      name: "application",
      securityIps: ["10.0.0.2", "10.0.0.1"],
      settings: { DBInstanceIPArrayAttribute: "private" },
      resetTo: ["127.0.0.1"],
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
      fake.transientFailures.failNext("ResetSecurityIps");
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    const updated = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(updated.securityIps).toEqual(["10.0.0.3"]);
    expect(fake.securityGroups.get("application")?.securityIPList).toBe(
      "127.0.0.1",
    );
    expect(fake.securityGroupModifies).toBe(4);
  });

  it("finishes security IP group cleanup when the parent instance is gone", async () => {
    const fake = new StatefulRDSClient();
    fake.securityGroupParentMissing = true;
    const layer = SecurityIpGroupProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(Layer.provide(providerLayer(fake)));
    const base = resourceBase("orphaned-security-ips");
    const olds = {
      instanceId: "rm-gone",
      name: "application",
      securityIps: ["10.0.0.0/16"],
      resetTo: ["127.0.0.1"],
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* SecurityIpGroup.Provider;
          yield* provider.delete({
            ...base,
            olds,
            output: {
              instanceId: "rm-gone",
              name: "application",
              securityIps: ["10.0.0.0/16"],
            },
          });
        }).pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.securityGroupModifies).toBe(1);
  });
});
