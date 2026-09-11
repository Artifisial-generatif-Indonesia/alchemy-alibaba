import { Effect, Schema } from "effect";
import { NetworkType } from "../model.ts";

/**
 * PostgreSQL identifier accepted for databases, accounts, schemas and roles.
 * Values are always re-quoted before they reach SQL, so this only bounds the
 * shape and keeps diagnostics readable.
 */
export const SqlIdentifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/, {
    message: "Expected a PostgreSQL identifier of at most 63 characters",
  }),
);

export const Alias = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/, {
    message: "Expected a lowercase alias such as odin_staging",
  }),
);

export const DisplayName = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.trim() === value &&
      value.length >= 1 &&
      value.length <= 64 &&
      !/[\u0000-\u001f\u007f]/.test(value),
    { message: "Expected a display name of 1-64 printable characters" },
  ),
);

export const WhitelistGroupName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/, {
    message: "Expected an RDS whitelist group name of at most 63 characters",
  }),
);

export const GatewayOnboardingInput = Schema.Struct({
  instanceId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,127}$/)),
  regionId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,63}$/)),
  database: SqlIdentifier,
  displayName: DisplayName,
  alias: Alias,
  account: SqlIdentifier.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("gateway_ro")),
  ),
  whitelistGroup: WhitelistGroupName.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("gateway")),
  ),
  schemas: Schema.Array(SqlIdentifier).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(["public"])),
  ),
  ownerRoles: Schema.Array(SqlIdentifier).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  networkType: NetworkType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("MIX"))),
  gatewayInstanceId: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,127}$/)),
  ),
  profile: Schema.optional(Schema.String),
});
export type GatewayOnboardingInput = typeof GatewayOnboardingInput.Type;

export interface RdsPrivateEndpoint {
  readonly host: string;
  readonly port: number;
  readonly ipAddress: string;
}

export interface RdsInstanceInfo {
  readonly instanceId: string;
  readonly regionId: string;
  readonly engine: string;
  readonly engineVersion: string | undefined;
  readonly vpcId: string;
  readonly vSwitchId: string;
  readonly endpoint: RdsPrivateEndpoint;
  readonly databases: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly type: string | undefined }>;
}

export interface VpcInfo {
  readonly vpcId: string;
  readonly cidrBlock: string | undefined;
  readonly regionId: string;
  readonly ownerId: number | undefined;
}

export interface VSwitchInfo {
  readonly vSwitchId: string;
  readonly vpcId: string;
  readonly routeTableId: string;
}

export interface GatewayInstanceInfo {
  readonly instanceId: string;
  readonly privateIp: string;
  readonly vpcId: string;
  readonly vSwitchId: string;
  readonly status: string;
}

export interface GatewayTopology {
  readonly instance: GatewayInstanceInfo;
  readonly vpc: VpcInfo;
  readonly vSwitch: VSwitchInfo;
}

export interface PeerConnectionInfo {
  readonly peeringId: string;
  readonly name: string | undefined;
  readonly status: string;
  readonly requesterVpcId: string;
  readonly acceptingVpcId: string;
  readonly acceptingRegionId: string | undefined;
  readonly acceptingOwnerUid: number | undefined;
  readonly requesterCidrs: ReadonlyArray<string>;
  readonly acceptingCidrs: ReadonlyArray<string>;
}

export interface RouteEntryInfo {
  readonly routeEntryId: string | undefined;
  readonly destinationCidrBlock: string;
  readonly nextHopId: string | undefined;
  readonly nextHopType: string | undefined;
  readonly status: string | undefined;
}

export interface RoutePlan {
  readonly routeTableId: string;
  readonly destinationCidrBlock: string;
  readonly nextHopId: string;
  readonly nextHopType: "VpcPeer";
  readonly description: string;
  readonly exists: boolean;
  readonly changed: boolean;
}

export type PeeringAction =
  | { readonly kind: "none" }
  | { readonly kind: "reuse"; readonly peeringId: string }
  | { readonly kind: "accept"; readonly peeringId: string }
  | { readonly kind: "create"; readonly name: string };

export interface ConnectivityPlan {
  readonly kind: "connectivity";
  readonly changed: boolean;
  readonly summary: string;
  readonly sameVpc: boolean;
  readonly gatewayVpcId: string;
  readonly rdsVpcId: string;
  readonly gatewayPrivateIp: string;
  readonly rdsPrivateIp: string;
  readonly peering: PeeringAction;
  readonly routes: ReadonlyArray<RoutePlan>;
}

export interface WhitelistPlan {
  readonly kind: "whitelist";
  readonly changed: boolean;
  readonly groupName: string;
  readonly networkType: GatewayOnboardingInput["networkType"];
  readonly previous: ReadonlyArray<string>;
  readonly desired: ReadonlyArray<string>;
}

export interface AccountPlan {
  readonly kind: "account";
  readonly changed: boolean;
  readonly accountName: string;
  readonly exists: boolean;
  readonly accountType: string | undefined;
}

export interface GrantStatementPlan {
  readonly statement: string;
  readonly description: string;
}

export interface GrantsPlan {
  readonly kind: "grants";
  readonly changed: boolean;
  /** `skipped` means no account secret was available to probe permissions. */
  readonly verification: "verified" | "pending" | "skipped";
  readonly issues: ReadonlyArray<string>;
  readonly statements: ReadonlyArray<GrantStatementPlan>;
}

export type OnboardingStep = ConnectivityPlan | WhitelistPlan | AccountPlan | GrantsPlan;

export interface OnboardingEndpoint {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly account: string;
  readonly dialect: "postgresql";
}

export interface GatewayOnboardingPlan {
  readonly instanceId: string;
  readonly regionId: string;
  readonly displayName: string;
  readonly alias: string;
  readonly changed: boolean;
  readonly endpoint: OnboardingEndpoint;
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly warnings: ReadonlyArray<string>;
}

export interface AppliedStep {
  readonly kind: OnboardingStep["kind"];
  readonly changed: boolean;
  readonly applied: boolean;
  readonly summary: string;
}

export interface GatewayOnboardingResult {
  readonly applied: boolean;
  readonly plan: GatewayOnboardingPlan;
  readonly steps: ReadonlyArray<AppliedStep>;
}
