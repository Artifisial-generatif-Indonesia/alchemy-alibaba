import { Effect, Schema } from "effect";
import { RdsApi } from "./alibaba.ts";
import { AccessError, developerGroupName, HostIPv4, Target, type AccessPlan } from "./model.ts";

const validateTarget = (target: Target) =>
  Schema.decodeUnknownEffect(Target)(target).pipe(
    Effect.mapError(
      () =>
        new AccessError({ message: "Invalid instance, region, developer ID, or network type." }),
    ),
  );
const normalize = (value: string) => value.trim().replace(/\/32$/, "");

const currentGroup = Effect.fn("currentGroup")(function* (target: Target, groupName: string) {
  const api = yield* RdsApi;
  const groups = yield* api.groups(target.instanceId);
  const matches = groups.filter((group) => group.DBInstanceIPArrayName.toLowerCase() === groupName);
  if (matches.length > 1) {
    return yield* new AccessError({
      message: "Multiple allowlists matched this developer; resolve the duplicate groups first.",
    });
  }
  const group = matches[0];
  if (!group) return undefined;

  // The SDK discards WhitelistNetworkType from responses. Check membership with
  // a server-side filter, keeping the unfiltered read to detect other networks.
  const networkGroups = yield* api.groups(target.instanceId, target.networkType);
  const networkMatches = networkGroups.filter(
    (item) => item.DBInstanceIPArrayName.toLowerCase() === groupName,
  );
  if (networkMatches.length !== 1) {
    return yield* new AccessError({
      message:
        "Could not confirm a unique developer group in the requested network type; access was not changed by this read.",
    });
  }
  const networkGroup = networkMatches[0];
  if (
    [group, networkGroup].some(
      (item) =>
        item.DBInstanceIPArrayAttribute ||
        (item.securityIPType && item.securityIPType !== "IPv4") ||
        (item.whitelistNetworkType && item.whitelistNetworkType !== target.networkType),
    )
  ) {
    return yield* new AccessError({
      message:
        "The developer group has incompatible attributes or network type; access was not changed.",
    });
  }
  return networkGroup;
});

/** With no IP, plan shows the result of revoking this developer's entry. */
export const planAccess = Effect.fn("planAccess")(function* (
  input: Target,
  ip?: string,
): Effect.fn.Return<AccessPlan, AccessError, RdsApi> {
  const target = yield* validateTarget(input);
  if (ip !== undefined) {
    yield* Schema.decodeUnknownEffect(HostIPv4)(ip).pipe(
      Effect.mapError(
        () =>
          new AccessError({
            message: "Expected one IPv4 host address, without a CIDR suffix or list.",
          }),
      ),
    );
  }
  const api = yield* RdsApi;
  yield* api.verifyInstance(target);
  const groupName = developerGroupName(target.developer, target.networkType);
  const group = yield* currentGroup(target, groupName);
  const previous = group?.securityIPList.split(",").map(normalize).filter(Boolean) ?? [];
  // RDS requires one entry. Loopback removes this group's remote access.
  const desired = ip === undefined && group === undefined ? [] : [ip ?? "127.0.0.1"];
  return {
    instanceId: target.instanceId,
    regionId: target.regionId,
    groupName,
    previous,
    desired,
    changed:
      previous.length !== desired.length ||
      previous.some((value, index) => value !== desired[index]),
  };
});

const applyAccess = Effect.fn("applyAccess")(
  function* (target: Target, ip?: string) {
    const plan = yield* planAccess(target, ip);
    if (!plan.changed) return plan;
    const api = yield* RdsApi;
    yield* api.setGroup(target, plan.groupName, plan.desired[0]);
    for (let attempt = 0; attempt < 30; attempt++) {
      const group = yield* currentGroup(target, plan.groupName);
      if (group && normalize(group.securityIPList) === plan.desired[0]) return plan;
      if (attempt < 29) yield* Effect.sleep("2 seconds");
    }
    return yield* new AccessError({
      message: "RDS accepted the update but did not confirm it in time. Run plan before retrying.",
    });
  },
  Effect.timeoutOrElse({
    duration: "90 seconds",
    orElse: () =>
      Effect.fail(
        new AccessError({
          message: "Access update timed out; its outcome may be unknown. Run plan before retrying.",
        }),
      ),
  }),
);

export const refreshAccess = Effect.fn("refreshAccess")(function* (target: Target, ip: string) {
  return yield* applyAccess(target, ip);
});

export const revokeAccess = Effect.fn("revokeAccess")(function* (target: Target) {
  return yield* applyAccess(target);
});
