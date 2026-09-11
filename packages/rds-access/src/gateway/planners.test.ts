import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Group } from "../model.ts";
import { planAccount, planWhitelist } from "./planners.ts";

const group = (name: string, ip: string, extra: Partial<Group> = {}): Group => ({
  DBInstanceIPArrayName: name,
  securityIPList: ip,
  securityIPType: "IPv4",
  whitelistNetworkType: "MIX",
  ...extra,
});

const whitelist = (options: {
  readonly groups: ReadonlyArray<Group>;
  readonly networkGroups?: ReadonlyArray<Group>;
}) =>
  Effect.runPromise(
    planWhitelist({
      groups: options.groups,
      networkGroups: options.networkGroups ?? options.groups,
      groupName: "gateway",
      networkType: "MIX",
      gatewayIp: "10.20.1.151",
    }),
  );

describe("gateway whitelist planning", () => {
  it("plans a new dedicated group without touching other groups", async () => {
    const others = [group("default", "127.0.0.1"), group("app_vpc", "10.0.0.0/16")];
    const plan = await whitelist({ groups: others });
    expect(plan).toMatchObject({
      changed: true,
      groupName: "gateway",
      previous: [],
      desired: ["10.20.1.151"],
    });
  });

  it("reuses the group when the gateway IP is already the only entry", async () => {
    const plan = await whitelist({
      groups: [group("gateway", "10.20.1.151/32"), group("app", "10.0.0.0/16")],
    });
    expect(plan).toMatchObject({ changed: false, previous: ["10.20.1.151"] });
  });

  it("replaces only the dedicated group's entries", async () => {
    const plan = await whitelist({
      groups: [group("gateway", "10.0.0.1,10.0.0.2")],
    });
    expect(plan).toMatchObject({ changed: true, previous: ["10.0.0.1", "10.0.0.2"] });
  });

  it("refuses duplicate and incompatible groups", async () => {
    await expect(
      whitelist({ groups: [group("gateway", "10.0.0.1"), group("GATEWAY", "10.0.0.2")] }),
    ).rejects.toThrow("Multiple allowlist groups");
    await expect(
      whitelist({ groups: [group("gateway", "10.0.0.1", { DBInstanceIPArrayAttribute: "hidden" })] }),
    ).rejects.toThrow("incompatible attributes");
    await expect(
      whitelist({ groups: [group("gateway", "10.0.0.1", { securityIPType: "IPv6" })] }),
    ).rejects.toThrow("incompatible attributes");
  });

  it("refuses a mismatched network type", async () => {
    await expect(
      whitelist({
        groups: [group("gateway", "10.0.0.1")],
        networkGroups: [],
      }),
    ).rejects.toThrow("Could not confirm");
    await expect(
      whitelist({
        groups: [group("gateway", "10.0.0.1", { whitelistNetworkType: "Classic" })],
        networkGroups: [group("gateway", "10.0.0.1", { whitelistNetworkType: "Classic" })],
      }),
    ).rejects.toThrow("network type");
  });
});

describe("gateway account planning", () => {
  it("plans creation of a missing account", async () => {
    const plan = await Effect.runPromise(
      planAccount({ accounts: [{ name: "other", type: "Normal" }], accountName: "gateway_ro" }),
    );
    expect(plan).toMatchObject({ changed: true, exists: false, accountName: "gateway_ro" });
  });

  it("reuses an existing Normal account case-insensitively", async () => {
    const plan = await Effect.runPromise(
      planAccount({ accounts: [{ name: "GATEWAY_RO", type: "Normal" }], accountName: "gateway_ro" }),
    );
    expect(plan).toMatchObject({ changed: false, exists: true });
  });

  it("refuses privileged or duplicate accounts", async () => {
    await expect(
      Effect.runPromise(
        planAccount({ accounts: [{ name: "gateway_ro", type: "Super" }], accountName: "gateway_ro" }),
      ),
    ).rejects.toThrow("Normal account");
    await expect(
      Effect.runPromise(
        planAccount({
          accounts: [
            { name: "gateway_ro", type: "Normal" },
            { name: "GATEWAY_RO", type: "Normal" },
          ],
          accountName: "gateway_ro",
        }),
      ),
    ).rejects.toThrow("Multiple RDS accounts");
  });
});
