import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import type { ManagedClusterProps } from "../ack/managed-cluster.ts";
import type { NodePoolProps } from "../ack/node-pool.ts";
import type { InstanceProps as RdsProps } from "../rds/instance.ts";
import type { InstanceProps as TairProps } from "../tair/instance.ts";
import type { NetworkProps } from "../vpc/network.ts";
import type { VSwitchProps } from "../vpc/vswitch.ts";
import type { DatabaseProps } from "../rds/database.ts";
import { validateDesiredInput } from "./desired-input.ts";

type Phases = "create" | "modify" | "spec" | "upgrade";
type NoPhaseBags<T> = Extract<keyof T, Phases> extends never ? true : false;
// This also fails compilation if an alias is restored to any public contract.
const directContracts: [
  NoPhaseBags<ManagedClusterProps>,
  NoPhaseBags<NodePoolProps>,
  NoPhaseBags<RdsProps>,
  NoPhaseBags<TairProps>,
  NoPhaseBags<NetworkProps>,
  NoPhaseBags<VSwitchProps>,
  NoPhaseBags<DatabaseProps>,
] = [true, true, true, true, true, true, true];

it("exposes one desired input contract and rejects phase bags without echoing their contents", async () => {
  expect(directContracts.every(Boolean)).toBe(true);
  await Effect.runPromise(
    validateDesiredInput(
      { DBInstanceStorage: 40, serverlessConfig: { switchForce: true } },
      "Alibaba.RDS.Instance",
    ),
  );
  for (const phase of ["create", "modify", "spec", "upgrade"]) {
    await expect(
      Effect.runPromise(
        validateDesiredInput(
          { [phase]: { password: "synthetic-secret" } },
          "Alibaba.RDS.Instance",
        ),
      ),
    ).rejects.toMatchObject({
      operation: "ValidateInput",
      message:
        "Use desired properties directly on the resource; create, modify, spec and upgrade request bags are not supported",
    });
  }
});
