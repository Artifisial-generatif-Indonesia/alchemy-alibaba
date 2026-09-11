import { Effect } from "effect";
import { AccessError, type Group } from "../model.ts";
import type { AccountPlan, GatewayOnboardingInput, WhitelistPlan } from "./model.ts";

const normalize = (value: string): string => value.trim().replace(/\/32$/, "");

/**
 * Plans the dedicated gateway allowlist group. Only the named group is
 * considered; every other group is outside this plan by construction.
 */
export const planWhitelist = (options: {
  readonly groups: ReadonlyArray<Group>;
  readonly networkGroups: ReadonlyArray<Group>;
  readonly groupName: string;
  readonly networkType: GatewayOnboardingInput["networkType"];
  readonly gatewayIp: string;
}): Effect.Effect<WhitelistPlan, AccessError> =>
  Effect.gen(function* () {
    const matches = options.groups.filter(
      (group) => group.DBInstanceIPArrayName.toLowerCase() === options.groupName.toLowerCase(),
    );
    if (matches.length > 1) {
      return yield* new AccessError({
        message:
          `Multiple allowlist groups are named ${options.groupName}; resolve the duplicates first.`,
      });
    }
    const group = matches[0];
    if (group === undefined) {
      return {
        kind: "whitelist",
        changed: true,
        groupName: options.groupName,
        networkType: options.networkType,
        previous: [],
        desired: [options.gatewayIp],
      } satisfies WhitelistPlan;
    }
    const networkMatches = options.networkGroups.filter(
      (item) => item.DBInstanceIPArrayName.toLowerCase() === options.groupName.toLowerCase(),
    );
    if (networkMatches.length !== 1) {
      return yield* new AccessError({
        message:
          `Could not confirm ${options.groupName} in the ${options.networkType} network; access was not changed by this read.`,
      });
    }
    const networkGroup = networkMatches[0];
    if (
      [group, networkGroup].some(
        (item) =>
          (item.DBInstanceIPArrayAttribute ?? "") !== "" ||
          (item.securityIPType !== undefined && item.securityIPType !== "IPv4") ||
          (item.whitelistNetworkType !== undefined &&
            item.whitelistNetworkType !== options.networkType),
      )
    ) {
      return yield* new AccessError({
        message:
          `Allowlist group ${options.groupName} has incompatible attributes or network type; ` +
          "it is not a dedicated gateway group.",
      });
    }
    const previous = networkGroup.securityIPList
      .split(",")
      .map(normalize)
      .filter(Boolean);
    const desired = [options.gatewayIp];
    return {
      kind: "whitelist",
      changed: previous.length !== 1 || previous[0] !== options.gatewayIp,
      groupName: options.groupName,
      networkType: options.networkType,
      previous,
      desired,
    } satisfies WhitelistPlan;
  });

/** Plans a Normal (non-privileged) database account; existing accounts are reused. */
export const planAccount = (options: {
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly type: string | undefined }>;
  readonly accountName: string;
}): Effect.Effect<AccountPlan, AccessError> =>
  Effect.gen(function* () {
    const matches = options.accounts.filter(
      (account) => account.name.toLowerCase() === options.accountName.toLowerCase(),
    );
    if (matches.length > 1) {
      return yield* new AccessError({
        message: `Multiple RDS accounts are named ${options.accountName}; resolve the duplicates first.`,
      });
    }
    const account = matches[0];
    if (account === undefined) {
      return {
        kind: "account",
        changed: true,
        accountName: options.accountName,
        exists: false,
        accountType: undefined,
      } satisfies AccountPlan;
    }
    if (account.type !== undefined && account.type !== "Normal") {
      return yield* new AccessError({
        message:
          `Account ${options.accountName} is ${account.type}; the gateway requires a Normal account.`,
      });
    }
    return {
      kind: "account",
      changed: false,
      accountName: options.accountName,
      exists: true,
      accountType: account.type,
    } satisfies AccountPlan;
  });
