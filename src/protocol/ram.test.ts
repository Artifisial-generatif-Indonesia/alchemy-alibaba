import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import * as RAM from "../ram/index.ts";
import { rrsaTrustPolicy } from "../ack/rrsa.ts";
import { withProtocolHarness, withTempDir } from "./harness.ts";
import {
  deployProtocol,
  destroyProtocol,
  protocolMakeOptions,
  protocolStack,
} from "./stack.ts";

it(
  "rotates RAM policy versions, scopes RRSA trust, repairs detached grants and removes attachments first",
  { timeout: 30000 },
  async () => {
    await withTempDir((directory) =>
      withProtocolHarness(async ({ server, world }) => {
        const options = protocolMakeOptions(server.host, directory);
        const trust = rrsaTrustPolicy({
          oidcProviderArn: "acs:ram::123456789:oidc-provider/ack-rrsa-test",
          issuer: "https://issuer.example",
          namespace: "test",
          serviceAccount: "api",
        });
        expect(JSON.stringify(trust)).toContain(
          '"oidc:sub":"system:serviceaccount:test:api"',
        );
        const stack = (revision: number) =>
          protocolStack(
            "WorkloadIdentity",
            options,
            Effect.gen(function* () {
              const role = yield* RAM.Role("role", {
                assumeRolePolicy: trust,
                tags: revision ? {} : { remove: "yes" },
              });
              const policy = yield* RAM.Policy("policy", {
                document: {
                  Version: "1",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: ["oss:GetObject"],
                      Resource: [`acs:oss:*:*:test/revision-${revision}/*`],
                    },
                  ],
                },
              });
              yield* RAM.RolePolicyAttachment("grant", {
                roleName: role.name,
                policyName: policy.name,
              });
              return { role: role.name, policy: policy.name };
            }),
          );
        const first = await deployProtocol(options, stack(0));
        const mutations = () =>
          world.ram.actions.filter(
            (a) => !a.startsWith("Get") && !a.startsWith("List"),
          );
        const initial = mutations().length;
        expect(await deployProtocol(options, stack(0))).toEqual(first);
        expect(mutations()).toHaveLength(initial);
        for (let i = 1; i <= 6; i++)
          expect(await deployProtocol(options, stack(i))).toEqual(first);
        expect(world.ram.policies.get(first.policy)?.DefaultVersion).toBe("v7");
        expect(world.ram.policies.get(first.policy)?.versions).toHaveLength(5);
        expect(
          world.ram.tags.get(`role/${first.role}`)?.remove,
        ).toBeUndefined();
        world.ram.attachments.clear();
        await deployProtocol(options, stack(6));
        expect(world.ram.attachments.size).toBe(1);
        await destroyProtocol(options, stack(6));
        expect(
          world.ram.roles.size +
            world.ram.policies.size +
            world.ram.attachments.size,
        ).toBe(0);
        expect(world.ram.actions.indexOf("DetachPolicyFromRole")).toBeLessThan(
          world.ram.actions.indexOf("DeleteRole"),
        );
        expect(world.ram.actions.indexOf("DetachPolicyFromRole")).toBeLessThan(
          world.ram.actions.indexOf("DeletePolicy"),
        );
      }),
    );
  },
);
