import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { Schema } from "effect";

export class AccessError extends Schema.TaggedError<AccessError>()("AccessError", {
  message: Schema.String,
  operation: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
}) {}

export const Developer = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.@+-]{0,127}$/, {
    message: "Use a stable developer ID, such as your work email (1–128 characters)",
  }),
);

/** A single host, never a subnet or an allow-all entry. Private VPN IPs are valid. */
export const HostIPv4 = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const first = Number(value.split(".")[0]);
      return isIPv4(value) && first > 0 && first < 224 && first !== 127;
    },
    { message: "Expected one IPv4 host address, without a CIDR suffix or list" },
  ),
);

export const NetworkType = Schema.Literals(["MIX", "VPC", "Classic"]);

export const Target = Schema.Struct({
  instanceId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,127}$/)),
  regionId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,63}$/)),
  developer: Developer,
  networkType: NetworkType,
});
export type Target = typeof Target.Type;

/** 32 characters, retaining the 96-bit identity hash and a distinct network suffix. */
export const developerGroupName = (
  developer: string,
  networkType: Target["networkType"] = "MIX",
) => {
  const identity = developer.toLowerCase();
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  const suffix = { MIX: "mix", VPC: "vpc", Classic: "cls" }[networkType];
  return `dev_${digest}_${suffix}`;
};

export const Group = Schema.Struct({
  DBInstanceIPArrayName: Schema.String,
  securityIPList: Schema.String,
  DBInstanceIPArrayAttribute: Schema.optional(Schema.String),
  securityIPType: Schema.optional(Schema.String),
  whitelistNetworkType: Schema.optional(Schema.String),
});
export type Group = typeof Group.Type;

export interface AccessPlan {
  readonly instanceId: string;
  readonly regionId: string;
  readonly groupName: string;
  readonly previous: ReadonlyArray<string>;
  readonly desired: ReadonlyArray<string>;
  readonly changed: boolean;
}
