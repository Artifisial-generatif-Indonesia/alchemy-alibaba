import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Alibaba from "../src/index.ts";

// Run from a dedicated private working directory. Local state contains secrets.
process.umask(0o077);

export default Alchemy.Stack(
  "AlibabaRdsSmoke",
  {
    providers: Alibaba.providersFromEnvironment(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^test-rds-[a-z0-9-]+$/)),
    )(yield* Alchemy.Stage).pipe(Effect.orDie);
    const config = yield* Config.all({
      zoneId: Config.string("SMOKE_ZONE_ID"),
      instanceClass: Config.string("SMOKE_RDS_CLASS"),
      version: Config.string("SMOKE_RDS_VERSION"),
      storage: Config.number("SMOKE_RDS_STORAGE_GB"),
      storageType: Config.string("SMOKE_RDS_STORAGE_TYPE"),
      password: Config.redacted("SMOKE_RDS_PASSWORD"),
      sslEndpoint: Config.option(Config.string("SMOKE_SSL_ENDPOINT")),
      runnerIp: Config.option(Config.string("SMOKE_RUNNER_IPV4")),
      revision: Config.string("SMOKE_REVISION").pipe(
        Config.withDefault("baseline"),
      ),
      protection: Config.boolean("SMOKE_DELETION_PROTECTION").pipe(
        Config.withDefault(true),
      ),
    });
    const tags = { purpose: "provider-validation", revision: config.revision };
    const network = yield* Alibaba.VPC.Network("network", {
      name: `${stage}-vpc`,
      cidrBlock: "10.240.0.0/16",
      tags,
    });
    const subnet = yield* Alibaba.VPC.VSwitch("subnet", {
      name: `${stage}-vsw`,
      vpcId: network.vpcId,
      cidrBlock: "10.240.1.0/24",
      zoneId: config.zoneId,
      tags,
    });
    const instance = yield* Alibaba.RDS.Instance("instance", {
      name: `${stage}-db`,
      deletionProtection: config.protection,
      ssl:
        config.sslEndpoint._tag === "Some"
          ? {
              SSLEnabled: 1,
              CAType: "aliyun",
              connectionString: config.sslEndpoint.value,
            }
          : undefined,
      tags,
      create: {
        engine: "PostgreSQL",
        engineVersion: config.version,
        DBInstanceClass: config.instanceClass,
        DBInstanceStorage: config.storage,
        DBInstanceStorageType: config.storageType,
        DBInstanceNetType: "Intranet",
        category: "Basic",
        payType: "Postpaid",
        VPCId: network.vpcId,
        vSwitchId: subnet.vSwitchId,
        zoneId: config.zoneId,
        securityIPList: "127.0.0.1",
      },
    });
    const ipGroup =
      config.runnerIp._tag === "Some"
        ? yield* Alibaba.RDS.SecurityIpGroup("runner-access", {
            instanceId: instance.instanceId,
            name: "smoke_runner",
            securityIps: [
              `${yield* Schema.decodeUnknownEffect(
                Schema.String.check(
                  Schema.isPattern(
                    /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/,
                  ),
                ),
              )(config.runnerIp.value).pipe(Effect.orDie)}/32`,
            ],
          })
        : undefined;
    const account = yield* Alibaba.RDS.Account("account", {
      instanceId: instance.instanceId,
      password: config.password,
      description: `Disposable smoke account ${config.revision}`,
    });
    const database = yield* Alibaba.RDS.Database("database", {
      instanceId: instance.instanceId,
      accountNames: [account.name],
      securityGroupName: ipGroup?.name,
      name: "smoke_db",
      characterSetName: "UTF8",
      description: `Disposable smoke database ${config.revision}`,
    });
    yield* Alibaba.RDS.AccountPrivilege("privilege", {
      instanceId: instance.instanceId,
      accountName: account.name,
      databaseName: database.name,
      privilege: "DBOwner",
    });
    return {
      vpcId: network.vpcId,
      vSwitchId: subnet.vSwitchId,
      instanceId: instance.instanceId,
      accountName: account.name,
      databaseName: database.name,
    };
  }),
);
