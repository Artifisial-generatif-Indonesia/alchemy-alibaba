import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Alibaba from "../src/index.ts";

// Supply a persistent state backend before provisioning real infrastructure.
export default Alchemy.Stack("ExampleRds", {
  providers: Alibaba.providersFromEnvironment(),
  state: Alchemy.inMemoryState(),
}, Effect.gen(function* () {
  const config = yield* Config.all({
    vpcId: Config.string("EXAMPLE_VPC_ID"),
    vSwitchId: Config.string("EXAMPLE_VSWITCH_ID"),
    zoneId: Config.string("EXAMPLE_ZONE_ID"),
    instanceClass: Config.string("EXAMPLE_RDS_CLASS"),
    engineVersion: Config.string("EXAMPLE_RDS_VERSION"),
    securityIPList: Config.string("EXAMPLE_RDS_ALLOWED_IPS"),
  });
  return yield* Alibaba.RDS.Instance("database", {
    deletionProtection: true,
    create: {
      engine: "PostgreSQL",
      engineVersion: config.engineVersion,
      DBInstanceClass: config.instanceClass,
      DBInstanceNetType: "Intranet",
      DBInstanceStorage: 40,
      payType: "Postpaid",
      VPCId: config.vpcId,
      vSwitchId: config.vSwitchId,
      zoneId: config.zoneId,
      securityIPList: config.securityIPList,
    },
  });
}));
