import * as ACK from "@alicloud/cs20151215";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import { sdkInput, type SecretInput } from "./secret-input.ts";

it("unwraps nested ACK credentials only at the SDK boundary and rejects plain strings without echoing them", async () => {
  const input: SecretInput<ACK.CreateClusterRequest> = {
    loginPassword: Redacted.make("cluster-bootstrap-secret"),
    userData: Redacted.make("encoded-bootstrap-secret"),
    nodepools: [
      {
        scalingGroup: { loginPassword: Redacted.make("node-bootstrap-secret") },
      },
    ],
  };
  expect(JSON.stringify(input)).not.toContain("bootstrap-secret");
  const request = await Effect.runPromise(
    sdkInput<ACK.CreateClusterRequest>(input, "Alibaba.ACK.ManagedCluster"),
  );
  expect(request.loginPassword).toBe("cluster-bootstrap-secret");
  expect(request.userData).toBe("encoded-bootstrap-secret");
  expect(request.nodepools?.[0]?.scalingGroup?.loginPassword).toBe(
    "node-bootstrap-secret",
  );
  const invalid: SecretInput<ACK.CreateClusterNodePoolRequest> = {
    // @ts-expect-error Raw passwords must also be rejected by the public input type.
    scalingGroup: { loginPassword: "plain-bootstrap-secret" },
  };
  await expect(
    Effect.runPromise(
      sdkInput<ACK.CreateClusterNodePoolRequest>(
        invalid,
        "Alibaba.ACK.NodePool",
      ),
    ),
  ).rejects.toMatchObject({
    operation: "ValidateSecrets",
    message: "ACK loginPassword and userData values must use Redacted.make",
  });
});
