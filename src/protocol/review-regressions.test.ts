import { expect, it } from "vitest";
import * as RDS from "../rds/index.ts";
import * as ACK from "../ack/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import { deployProtocol, protocolMakeOptions, protocolStack } from "./stack.ts";
it("resizes a named RDS instance in place", { timeout: 30000 }, async () => {
  await withTempDir((directory) =>
    withProtocolHarness(async ({ server, world }) => {
      const options = protocolMakeOptions(server.host, directory);
      const stack = (storage: number) =>
        protocolStack(
          "ReviewRds",
          options,
          RDS.Instance("db", {
            name: "review-db",
            engine: "PostgreSQL",
            engineVersion: "16.0",
            DBInstanceClass: "class-a",
            DBInstanceStorage: storage,
            DBInstanceNetType: "Intranet",
            payType: "Postpaid",
            securityIPList: "127.0.0.1",
          }),
        );
      const first = await deployProtocol(options, stack(20));
      const second = await deployProtocol(options, stack(40));
      expect({
        sameId: first.instanceId === second.instanceId,
        remaining: world.rds.size,
        storage: second.storage,
      }).toEqual({ sameId: true, remaining: 1, storage: 40 });
    }),
  );
});
it("scales a named node pool in place", { timeout: 30000 }, async () => {
  await withTempDir((directory) =>
    withProtocolHarness(async ({ server, world }) => {
      const options = protocolMakeOptions(server.host, directory);
      const stack = (desiredSize: number) =>
        protocolStack(
          "ReviewPool",
          options,
          Effect.gen(function* () {
            const cluster = yield* ACK.ManagedCluster("cluster", {
              name: "review-pool-cluster",
              clusterType: "ManagedKubernetes",
              profile: "Default",
              clusterSpec: "ack.standard",
              addons: [{ name: "flannel" }],
              vpcid: "vpc-test",
              vswitchIds: ["vsw-test"],
              serviceCidr: "172.21.0.0/20",
              containerCidr: "172.20.0.0/16",
            });
            return yield* ACK.NodePool("pool", {
              clusterId: cluster.clusterId,
              name: "review-workers",
              scalingGroup: {
                instanceChargeType: "PostPaid",
                instanceTypes: ["ecs.test"],
                vswitchIds: ["vsw-test"],
                desiredSize,
              },
            });
          }),
        );
      const first = await deployProtocol(options, stack(1));
      const second = await deployProtocol(options, stack(2));
      expect({
        sameId: first.nodepoolId === second.nodepoolId,
        remaining: world.roa.pools.size,
      }).toEqual({ sameId: true, remaining: 1 });
    }),
  );
});
it(
  "reconciles serverless force scaling without another purchase",
  { timeout: 30000 },
  async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (switchForce: boolean) =>
          protocolStack(
            "ReviewSpec",
            options,
            RDS.Instance("db", {
              name: "review-spec",
              engine: "PostgreSQL",
              engineVersion: "16.0",
              DBInstanceClass: "class-a",
              DBInstanceStorage: 20,
              DBInstanceNetType: "Intranet",
              payType: "Serverless",
              securityIPList: "127.0.0.1",
              serverlessConfig: { switchForce },
            }),
          );
        await deployProtocol(options, stack(false));
        const initial = world
          .actions()
          .filter((action) => action === "ModifyDBInstanceSpec").length;
        await deployProtocol(options, stack(true));
        expect(
          world.actions().filter((action) => action === "ModifyDBInstanceSpec"),
        ).toHaveLength(initial + 1);
        expect([...world.rds.values()][0]?.serverless?.SwitchForce).toBe(true);
      }),
    );
  },
);
it(
  "rejects an immutable named cluster change before touching the cloud",
  { timeout: 30000 },
  async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (cidr: string) =>
          protocolStack(
            "ReviewAck",
            options,
            ACK.ManagedCluster("cluster", {
              name: "review-ack",
              clusterType: "ManagedKubernetes",
              profile: "Default",
              clusterSpec: "ack.standard",
              addons: [{ name: "flannel" }],
              vpcid: "vpc-test",
              vswitchIds: ["vsw-test"],
              serviceCidr: "172.21.0.0/20",
              containerCidr: cidr,
            }),
          );
        const first = await deployProtocol(options, stack("172.20.0.0/16"));
        const actions = [...world.actions()];
        await expect(
          deployProtocol(options, stack("172.22.0.0/16")),
        ).rejects.toThrow("same explicit name");
        expect(world.ack.size).toBe(1);
        expect([...world.ack.keys()]).toEqual([first.clusterId]);
        expect(
          world
            .actions()
            .filter(
              (action) =>
                !action.startsWith("Describe") && !action.startsWith("List"),
            ),
        ).toEqual(
          actions.filter(
            (action) =>
              !action.startsWith("Describe") && !action.startsWith("List"),
          ),
        );
      }),
    );
  },
);
import * as Effect from "effect/Effect";
