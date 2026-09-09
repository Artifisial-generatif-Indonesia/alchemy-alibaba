import * as AckSdk from "@alicloud/cs20151215";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import * as ACK from "../ack/index.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";
import { assertNoSecrets } from "./redaction.ts";
const clusterProps = {
  name: "protocol-ack-children",
  clusterType: "ManagedKubernetes" as const,
  clusterSpec: "ack.pro.small" as const,
  profile: "Default" as const,
  addons: [{ name: "flannel" }],
  vpcid: "vpc-protocol",
  vswitchIds: ["vsw-protocol"],
  containerCidr: "172.20.0.0/16",
  serviceCidr: "172.21.0.0/20",
};
const poolCreate = {
  scalingGroup: {
    instanceChargeType: "PostPaid" as const,
    instanceTypes: ["ecs.test"],
    vswitchIds: ["vsw-protocol"],
    imageId: "image-1",
  },
};
describe("ACK child ROA protocol", { timeout: 30000 }, () => {
  it("persists node pools and addons, changes image/config/version, and deletes children before the cluster", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = (revision: number) =>
          protocolStack(
            "AckChildLifecycle",
            options,
            Effect.gen(function* () {
              const cluster = yield* ACK.ManagedCluster("cluster", {
                ...clusterProps,
                deletionProtection: revision !== 1,
                kubernetesVersion:
                  revision > 1 ? "1.33.1-aliyun.1" : "1.32.1-aliyun.1",
              });
              const pool = yield* ACK.NodePool("pool", {
                clusterId: cluster.clusterId,
                name: "workers",
                ...poolCreate,
                scalingGroup: {
                  ...poolCreate.scalingGroup,
                  imageId: revision ? "image-2" : "image-1",
                },
                tags: { revision: String(revision) },
                delete: { force: false },
              });
              const addon = yield* ACK.Addon("addon", {
                clusterId: cluster.clusterId,
                name: "example-addon",
                version: revision > 1 ? "2.0" : "1.0",
                config: JSON.stringify({ replicas: revision + 1 }),
              });
              return {
                clusterId: cluster.clusterId,
                poolId: pool.nodepoolId,
                addon: addon.name,
              };
            }),
          );
        const initial = await deployProtocol(options, stack(0));
        expect(await deployProtocol(options, stack(0))).toEqual(initial);
        const creates = world.roa.requests.filter(
          (x) => x.method === "POST" && x.path.endsWith("/nodepools"),
        );
        expect(creates).toHaveLength(1);
        expect(creates[0]?.body).toMatchObject({
          nodepool_info: { name: "workers" },
          scaling_group: {
            instance_types: ["ecs.test"],
            vswitch_ids: ["vsw-protocol"],
            instance_charge_type: "PostPaid",
            image_id: "image-1",
            tags: expect.arrayContaining([
              expect.objectContaining({ key: "revision", value: "0" }),
            ]),
          },
        });
        expect(await deployProtocol(options, stack(1))).toEqual(initial);
        expect([...world.roa.pools.values()][0]?.scaling_group.image_id).toBe(
          "image-2",
        );
        expect([...world.roa.addons.values()][0]?.config).toBe(
          '{"replicas":2}',
        );
        expect(
          world.roa.requests.some(
            (x) => x.method === "POST" && x.path.endsWith("/config"),
          ),
        ).toBe(true);
        expect(await deployProtocol(options, stack(2))).toEqual(initial);
        expect([...world.roa.addons.values()][0]?.version).toBe("2.0");
        expect(
          world.roa.requests.find((x) => x.path.endsWith("/install"))?.body,
        ).toEqual([
          { name: "example-addon", version: "1.0", config: '{"replicas":1}' },
        ]);
        expect(
          world.roa.requests.find((x) => x.path.endsWith("/upgrade"))?.body,
        ).toEqual([
          {
            component_name: "example-addon",
            next_version: "2.0",
            config: '{"replicas":3}',
          },
        ]);
        expect([...world.ack.values()][0]).toMatchObject({
          currentVersion: "1.33.1-aliyun.1",
          deletionProtection: true,
        });
        expect(
          world.captured.filter((x) => x.action === "UpgradeCluster"),
        ).toHaveLength(1);
        await destroyProtocol(options, stack(2));
        expect(world.roa.pools.size).toBe(0);
        expect(world.roa.addons.size).toBe(0);
        expect(world.ack.size).toBe(0);
        expect([...world.roa.tasks.values()].every((t) => t.reads >= 2)).toBe(
          true,
        );
        expect(
          world.roa.requests.find((x) => x.method === "DELETE")?.query.force,
        ).toBe("false");
        const requests = world.captured;
        const parentDelete = requests.findIndex(
          (x) =>
            x.method === "DELETE" &&
            x.pathname === `/clusters/${initial.clusterId}`,
        );
        expect(
          requests.findIndex(
            (x) => x.method === "DELETE" && x.pathname.includes("/nodepools/"),
          ),
        ).toBeLessThan(parentDelete);
        expect(
          requests.findIndex((x) => x.pathname.endsWith("/uninstall")),
        ).toBeLessThan(parentDelete);
        assertNoSecrets(world.captured);
        assertNoSecrets(world.roa.requests);
      }),
    );
  });
  it("recovers a cluster accepted before an error through the region-scoped v1 inventory", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world, clients }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "AckAmbiguousWire",
          options,
          Effect.gen(function* () {
            const cluster = yield* ACK.ManagedCluster("cluster", clusterProps);
            return { id: cluster.clusterId };
          }),
        );
        world.script({
          action: "CreateCluster",
          code: "AcceptedResponseLost",
          accept: true,
        });
        await expect(deployProtocol(options, stack)).rejects.toThrow();
        const id = [...world.ack.keys()][0];
        expect(await deployProtocol(options, stack)).toEqual({ id });
        expect(
          world.captured.filter((x) => x.action === "CreateCluster"),
        ).toHaveLength(1);
        const listed = await clients.ack.describeClustersV1(
          new AckSdk.DescribeClustersV1Request({
            regionId: "ap-southeast-5",
            pageNumber: 2,
            pageSize: 1,
          }),
        );
        expect(listed.body?.pageInfo?.totalCount).toBe(1);
        expect(listed.body?.clusters).toEqual([]);
        const otherRegion = await clients.ack.describeClustersV1(
          new AckSdk.DescribeClustersV1Request({
            regionId: "cn-hangzhou",
            pageNumber: 1,
            pageSize: 1,
          }),
        );
        expect(otherRegion.body?.clusters).toEqual([]);
        await destroyProtocol(options, stack);
      }),
    );
  });
  it("preserves the cluster and state when a child delete task fails, then resumes after recovery", async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const stack = protocolStack(
          "AckFailedTask",
          options,
          Effect.gen(function* () {
            const cluster = yield* ACK.ManagedCluster("cluster", clusterProps);
            yield* ACK.NodePool("pool", {
              clusterId: cluster.clusterId,
              name: "workers",
              ...poolCreate,
            });
            return { id: cluster.clusterId };
          }),
        );
        const created = await deployProtocol(options, stack);
        world.roa.failNextTask = true;
        await expect(destroyProtocol(options, stack)).rejects.toThrow(
          "ACK asynchronous task failed",
        );
        expect(world.ack.has(created.id)).toBe(true);
        expect(world.roa.pools.size).toBe(1);
        expect(
          world.captured.some(
            (x) =>
              x.method === "DELETE" && x.pathname === `/clusters/${created.id}`,
          ),
        ).toBe(false);
        // Simulate operator/service recovery of the failed deletion, then reuse persisted state.
        for (const task of world.roa.tasks.values())
          if (task.fail) task.finish();
        await destroyProtocol(options, stack);
        expect(world.ack.size).toBe(0);
        expect(
          world.roa.requests.filter((x) => x.method === "DELETE"),
        ).toHaveLength(1);
      }),
    );
  });
});
