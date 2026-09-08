import * as Output from "alchemy/Output";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Alibaba from "../src/index.ts";

// Keep this working directory and its secret-bearing state through teardown.
process.umask(0o077);
export default Alchemy.Stack(
  "AlibabaEcsDev",
  {
    providers: Alibaba.providersFromEnvironment(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^dev-ecs-[a-z0-9-]{1,20}$/)),
    )(yield* Alchemy.Stage).pipe(Effect.orDie);
    const config = yield* Config.all({
      vpcId: Config.string("DEV_VPC_ID"),
      vSwitchId: Config.string("DEV_VSWITCH_ID"),
      imageId: Config.string("DEV_ECS_IMAGE_ID"),
      instanceType: Config.string("DEV_ECS_TYPE"),
      keyPairName: Config.string("DEV_SSH_KEY_PAIR"),
      runnerCidr: Config.string("DEV_RUNNER_CIDR"),
      autoReleaseTime: Config.string("DEV_AUTO_RELEASE_TIME"),
      userData: Config.redacted("DEV_CLOUD_INIT"),
      rdsId: Config.string("DEV_RDS_INSTANCE_ID"),
      tairId: Config.string("DEV_TAIR_INSTANCE_ID"),
    });
    const group = yield* Alibaba.ECS.SecurityGroup("group", {
      name: `${stage}-sg`,
      vpcId: config.vpcId,
      tags: { purpose: "development" },
    });
    yield* Alibaba.ECS.SecurityGroupIngress("ssh", {
      securityGroupId: group.securityGroupId,
      ipProtocol: "tcp",
      portRange: "22/22",
      sourceCidrIp: config.runnerCidr,
    });
    const vm = yield* Alibaba.ECS.Instance("vm", {
      name: stage,
      imageId: config.imageId,
      instanceType: config.instanceType,
      vSwitchId: config.vSwitchId,
      securityGroupIds: [group.securityGroupId],
      keyPairName: config.keyPairName,
      userData: config.userData,
      internetMaxBandwidthOut: 1,
      autoReleaseTime: config.autoReleaseTime,
      deletionProtection: false,
      tags: { purpose: "development" },
    });
    // These existing databases must be non-production and in the same VPC.
    // The names must be unique to this stage so developers do not overwrite access.
    const groupName = stage.replaceAll("-", "_");
    const rdsAccess = yield* Alibaba.RDS.SecurityIpGroup("rds-access", {
      instanceId: config.rdsId,
      name: groupName,
      securityIps: [Output.interpolate`${vm.privateIp}/32`],
    });
    const tairAccess = yield* Alibaba.Tair.SecurityIpGroup("tair-access", {
      instanceId: config.tairId,
      name: groupName,
      securityIps: [Output.interpolate`${vm.privateIp}/32`],
    });
    return {
      instanceId: vm.instanceId,
      privateIp: vm.privateIp,
      publicIp: vm.publicIp,
      rdsAccess: rdsAccess.name,
      tairAccess: tairAccess.name,
    };
  }),
);
