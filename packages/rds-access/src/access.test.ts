import { $OpenApiUtil } from "@alicloud/openapi-core";
import RdsClientImport, * as RDS from "@alicloud/rds20140815";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planAccess, refreshAccess, revokeAccess } from "./access.ts";
import { rdsApiLayer, type RdsSdk } from "./alibaba.ts";
import { developerGroupName, type Group, type Target } from "./model.ts";

const interopDefault = <T>(value: T | { readonly default: T }): T =>
  typeof value === "object" && value !== null && "default" in value ? value.default : value;
const RdsClient = interopDefault(RdsClientImport);

const target: Target = {
  instanceId: "pgm-example",
  regionId: "ap-southeast-5",
  developer: "alice@example.com",
  networkType: "MIX",
};
const groupName = developerGroupName(target.developer);
const group = (name: string, ip: string, networkType = target.networkType): Group => ({
  DBInstanceIPArrayName: name,
  securityIPList: ip,
  securityIPType: "IPv4",
  whitelistNetworkType: networkType,
});

function harness(initial: Group[] = []) {
  const groups = [...initial];
  const client = new RdsClient(
    new $OpenApiUtil.Config({
      regionId: target.regionId,
      accessKeyId: "fake-id",
      accessKeySecret: "fake-secret",
    }),
  );
  // Stub the transport, retaining the SDK's request serialization and response decoding.
  const callApi = vi.spyOn(client, "callApi").mockImplementation(async (params, request) => {
    expect(params.action).toBe("DescribeDBInstanceIPArrayList");
    const networkType = request.query?.WhitelistNetworkType;
    return {
      body: {
        Items: {
          DBInstanceIPArray: groups
            .filter((item) => networkType === undefined || item.whitelistNetworkType === networkType)
            .map((item) => ({
              DBInstanceIPArrayName: item.DBInstanceIPArrayName,
              DBInstanceIPArrayAttribute: item.DBInstanceIPArrayAttribute,
              SecurityIPList: item.securityIPList,
              SecurityIPType: item.securityIPType,
              WhitelistNetworkType: item.whitelistNetworkType,
            })),
        },
      },
    };
  });
  const sdk = {
    describeDBInstanceAttribute: vi.fn<RdsSdk["describeDBInstanceAttribute"]>(async () => ({
      body: {
        items: {
          DBInstanceAttribute: [{ DBInstanceId: target.instanceId, regionId: target.regionId }],
        },
      },
    })),
    describeDBInstanceIPArrayList: vi.fn<RdsSdk["describeDBInstanceIPArrayList"]>((request) =>
      client.describeDBInstanceIPArrayList(request),
    ),
    modifySecurityIps: vi.fn<RdsSdk["modifySecurityIps"]>(async (request) => {
      const index = groups.findIndex(
        (item) =>
          item.DBInstanceIPArrayName === request.DBInstanceIPArrayName &&
          item.whitelistNetworkType === request.whitelistNetworkType,
      );
      const next = group(
        request.DBInstanceIPArrayName!,
        request.securityIps!,
        request.whitelistNetworkType as Target["networkType"],
      );
      if (index === -1) groups.push(next);
      else groups[index] = next;
      return { body: { requestId: "fake-request" } };
    }),
  };
  const layer = rdsApiLayer({ regionId: target.regionId, sdk });
  return {
    sdk,
    callApi,
    groups,
    run: <A, E>(effect: Effect.Effect<A, E, import("./alibaba.ts").RdsApi>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  };
}

afterEach(() => vi.useRealTimers());

describe("developer RDS access", () => {
  it("creates and replaces only Alice's group while retaining Bob and application groups", async () => {
    const preserved = [
      group("default", "127.0.0.1"),
      group("app_vpc", "10.0.0.0/16"),
      group(developerGroupName("bob@example.com"), "198.51.100.22"),
    ];
    const h = harness(preserved);
    await h.run(refreshAccess(target, "203.0.113.10"));
    const result = await h.run(refreshAccess(target, "203.0.113.20"));
    expect(result.previous).toEqual(["203.0.113.10"]);
    expect(h.groups).toEqual([...preserved, group(groupName, "203.0.113.20")]);
    expect(h.sdk.modifySecurityIps.mock.calls.map(([request]) => ({ ...request }))).toEqual([
      expect.objectContaining({
        DBInstanceId: target.instanceId,
        DBInstanceIPArrayName: groupName,
        securityIps: "203.0.113.10",
        modifyMode: "Cover",
        securityIPType: "IPv4",
        whitelistNetworkType: "MIX",
      }),
      expect.objectContaining({
        DBInstanceIPArrayName: groupName,
        securityIps: "203.0.113.20",
        modifyMode: "Cover",
      }),
    ]);
  });

  it("previews a change without writing", async () => {
    const h = harness([group(groupName, "203.0.113.10")]);
    expect(await h.run(planAccess(target, "203.0.113.20"))).toMatchObject({
      changed: true,
      desired: ["203.0.113.20"],
    });
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it("treats the same host written as /32 as already current", async () => {
    const h = harness([group(groupName, "203.0.113.10/32")]);
    expect(await h.run(refreshAccess(target, "203.0.113.10"))).toMatchObject({ changed: false });
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it("revokes only the developer group and is idempotent", async () => {
    const h = harness([group("app_vpc", "10.0.0.0/16"), group(groupName, "203.0.113.10")]);
    await h.run(revokeAccess(target));
    expect(await h.run(revokeAccess(target))).toMatchObject({ changed: false });
    expect(h.groups).toEqual([group("app_vpc", "10.0.0.0/16"), group(groupName, "127.0.0.1")]);
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
  });

  it("does not create a group to revoke nonexistent access", async () => {
    const h = harness();
    expect(await h.run(revokeAccess(target))).toMatchObject({ changed: false, desired: [] });
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it.each([
    "0.0.0.0",
    "0.0.0.0/0",
    "203.0.113.1/24",
    "203.0.113.1,198.51.100.1",
    "::1",
    "127.0.0.1",
    "224.0.0.1",
    "999.1.1.1",
  ])("rejects invalid or broad IP input %s before any Alibaba call", async (ip) => {
    const h = harness();
    await expect(h.run(refreshAccess(target, ip))).rejects.toThrow("one IPv4 host");
    expect(h.sdk.describeDBInstanceAttribute).not.toHaveBeenCalled();
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it("allows a single private source address for VPN routing", async () => {
    const h = harness();
    await h.run(refreshAccess(target, "10.1.2.3"));
    expect(h.groups).toEqual([group(groupName, "10.1.2.3")]);
  });

  it("rejects an invalid target before any Alibaba call", async () => {
    const h = harness();
    await expect(
      h.run(refreshAccess({ ...target, instanceId: "pgm-one,pgm-two" }, "203.0.113.1")),
    ).rejects.toThrow("Invalid instance");
    expect(h.sdk.describeDBInstanceAttribute).not.toHaveBeenCalled();
  });

  it.each([
    { DBInstanceId: "pgm-wrong", regionId: target.regionId },
    { DBInstanceId: target.instanceId, regionId: "cn-hangzhou" },
  ])("refuses instance or region mismatch", async (instance) => {
    const h = harness();
    h.sdk.describeDBInstanceAttribute.mockResolvedValue({
      body: { items: { DBInstanceAttribute: [instance] } },
    });
    await expect(h.run(refreshAccess(target, "203.0.113.1"))).rejects.toThrow("did not match");
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it("refuses incomplete API responses instead of treating missing groups as absent", async () => {
    const h = harness();
    h.sdk.describeDBInstanceIPArrayList.mockResolvedValue({ body: {} });
    await expect(h.run(refreshAccess(target, "203.0.113.1"))).rejects.toThrow(
      "incomplete allowlist",
    );
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it.each([
    { DBInstanceIPArrayAttribute: "hidden" },
    { securityIPType: "IPv6" },
  ])("refuses an incompatible existing developer group: %o", async (attributes) => {
    const h = harness([{ ...group(groupName, "203.0.113.2"), ...attributes }]);
    await expect(h.run(revokeAccess(target))).rejects.toThrow("incompatible attributes");
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it.each([
    ["plan", (input: Target) => planAccess(input, "203.0.113.10")],
    ["refresh same IP", (input: Target) => refreshAccess(input, "203.0.113.10")],
    ["refresh new IP", (input: Target) => refreshAccess(input, "203.0.113.20")],
    ["revoke", revokeAccess],
  ] as const)("refuses %s when the SDK strips a mismatched network type", async (_, operation) => {
    const input: Target = { ...target, networkType: "VPC" };
    const name = developerGroupName(input.developer, input.networkType);
    const h = harness([group(name, "203.0.113.10", "Classic")]);
    await expect(h.run(operation(input))).rejects.toThrow("network type");
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
    expect(h.callApi.mock.calls.map(([, request]) => request.query?.WhitelistNetworkType)).toEqual([
      undefined,
      "VPC",
    ]);
  });

  it.each(["MIX", "VPC", "Classic"] as const)(
    "refreshes and revokes %s groups through SDK decoding",
    async (networkType) => {
      const input: Target = { ...target, networkType };
      const name = developerGroupName(input.developer, networkType);
      const h = harness();
      await h.run(refreshAccess(input, "203.0.113.10"));
      expect(await h.run(refreshAccess(input, "203.0.113.10"))).toMatchObject({ changed: false });
      await h.run(revokeAccess(input));
      expect(h.groups).toEqual([group(name, "127.0.0.1", networkType)]);
      expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(2);
      expect(
        h.callApi.mock.calls.some(([, request]) => request.query?.WhitelistNetworkType === networkType),
      ).toBe(true);
      const response = (await h.sdk.describeDBInstanceIPArrayList(
        new RDS.DescribeDBInstanceIPArrayListRequest({ DBInstanceId: input.instanceId }),
      )) as RDS.DescribeDBInstanceIPArrayListResponse;
      expect(response.body?.items?.DBInstanceIPArray?.[0]).not.toHaveProperty("whitelistNetworkType");
    },
  );

  it("does not confirm a write whose group appears in another network", async () => {
    const input: Target = { ...target, networkType: "VPC" };
    const name = developerGroupName(input.developer, input.networkType);
    const h = harness();
    h.sdk.modifySecurityIps.mockImplementation(async (request) => {
      h.groups.push(group(name, request.securityIps!, "MIX"));
      return { body: {} };
    });
    await expect(h.run(refreshAccess(input, "203.0.113.10"))).rejects.toThrow("network type");
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
  });

  it("uses the newer filtered read when deciding whether an update is needed", async () => {
    const h = harness([group(groupName, "203.0.113.20")]);
    h.sdk.describeDBInstanceIPArrayList.mockResolvedValueOnce({
      body: { items: { DBInstanceIPArray: [group(groupName, "203.0.113.10")] } },
    });
    expect(await h.run(refreshAccess(target, "203.0.113.10"))).toMatchObject({
      previous: ["203.0.113.20"],
      changed: true,
    });
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
  });

  it("refuses duplicate group identities", async () => {
    const h = harness([
      group(groupName, "203.0.113.1"),
      group(groupName.toUpperCase(), "203.0.113.2"),
    ]);
    await expect(h.run(revokeAccess(target))).rejects.toThrow("Multiple allowlists");
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it("refuses duplicate identities across networks before writing", async () => {
    const h = harness([
      group(groupName, "203.0.113.1"),
      group(groupName, "203.0.113.2", "VPC"),
    ]);
    await expect(h.run(revokeAccess(target))).rejects.toThrow("Multiple allowlists");
    expect(h.sdk.modifySecurityIps).not.toHaveBeenCalled();
  });

  it("waits for the API to confirm the new entry", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sdk.describeDBInstanceIPArrayList
      .mockResolvedValueOnce({ body: { items: { DBInstanceIPArray: [] } } })
      .mockResolvedValueOnce({ body: { items: { DBInstanceIPArray: [] } } });
    const promise = h.run(refreshAccess(target, "203.0.113.1"));
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(promise).resolves.toMatchObject({ changed: true });
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
    expect(h.sdk.describeDBInstanceIPArrayList).toHaveBeenCalledTimes(4);
  });

  it("fails if an accepted update never becomes visible", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sdk.modifySecurityIps.mockResolvedValue({ body: {} });
    const assertion = expect(h.run(refreshAccess(target, "203.0.113.1"))).rejects.toThrow(
      "did not confirm",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
  });

  it("does not retry ambiguous writes or leak SDK credential payloads", async () => {
    const h = harness();
    h.sdk.modifySecurityIps.mockRejectedValue({
      code: "RequestTimeout",
      message: "accessKeySecret=do-not-log",
      request: { password: "do-not-log" },
    });
    try {
      await h.run(refreshAccess(target, "203.0.113.1"));
      expect.fail("Expected failure");
    } catch (error) {
      expect(String(error)).toContain("RequestTimeout");
      expect(String(error)).not.toContain("do-not-log");
      expect(JSON.stringify(error)).not.toContain("do-not-log");
    }
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
  });

  it("keeps names stable and distinct across developer identities and networks", () => {
    expect(
      (["MIX", "VPC", "Classic"] as const).map((networkType) =>
        developerGroupName("alice@example.com", networkType),
      ),
    ).toEqual([
      "dev_ppinjibjpmaobclpanceijco_mix",
      "dev_ppinjibjpmaobclpanceijco_vpc",
      "dev_ppinjibjpmaobclpanceijco_cls",
    ]);
    expect(developerGroupName("Alice@example.com")).toBe(groupName);
    expect(developerGroupName("alice@another.com")).not.toBe(groupName);
    expect(developerGroupName("alice@example.com", "VPC")).not.toBe(groupName);
    expect(developerGroupName("alice@example.com", "Classic")).not.toBe(groupName);
  });

  it.each(["MIX", "VPC", "Classic"] as const)(
    "keeps every %s name within 32 characters",
    (networkType) => {
      for (const developer of [
        "a",
        "1",
        "alice@example.com",
        "abcdefghijklmnop@example.com",
        "a".repeat(128),
        "A._+-@example.com",
      ]) {
        const name = developerGroupName(developer, networkType);
        expect(name).toMatch(/^[a-z][a-z0-9_]{0,30}[a-z0-9]$/);
        expect(developerGroupName(developer.toUpperCase(), networkType)).toBe(name);
      }
    },
  );
});
