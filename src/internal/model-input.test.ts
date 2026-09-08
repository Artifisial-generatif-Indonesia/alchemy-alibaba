import { expect, it } from "vitest";
import type { InstanceProps as RdsProps } from "../rds/instance.ts";
import type { InstanceProps as TairProps } from "../tair/instance.ts";
import type { ModelInput } from "./model-input.ts";

it("preserves SDK field types, excludes secrets, and retains actual dictionary inputs", () => {
  // These assertions are checked by tsc as well as the runtime suite.
  // @ts-expect-error Storage is numeric.
  const storage: RdsProps["spec"] = { DBInstanceStorage: "forty" };
  // @ts-expect-error Private key belongs in the Redacted input.
  const ssl: RdsProps["ssl"] = { serverKey: "synthetic-test-key" };
  // @ts-expect-error Password belongs in the Redacted input.
  const create: TairProps["create"] = { password: "synthetic-test-password" };
  const labels: ModelInput<Record<string, string>> = { app: "test" };
  // @ts-expect-error Real dictionaries must keep their value types.
  const invalidLabels: ModelInput<Record<string, string>> = { app: 123 };
  expect(labels.app).toBe("test");
  void [storage, ssl, create, invalidLabels];
});
