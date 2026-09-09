import * as RDS from "@alicloud/rds20140815";
import * as Effect from "effect/Effect";
import type { AlibabaClientSet } from "../clients.ts";
import { retryingSdkCall } from "../error.ts";
import { waitFor, type WaitOptions } from "../internal/lifecycle.ts";

/** Instance-owned settings; omitting a setting relinquishes management of it. */
export interface InstanceConfiguration {
  readonly backupPolicy?: BackupPolicy;
  /** Desired database parameters. Omitted keys retain their current settings. */
  readonly parameters?: Readonly<Record<string, string>>;
  /** Apply reboot-required parameters immediately. Defaults to false. */
  readonly restartForParameterChanges?: boolean;
  /** UTC maintenance window, for example 02:00Z-03:00Z. Updated in place. */
  readonly maintenanceWindow?: string;
}

/** Ordinary local backup policy; support varies by engine and instance category. */
export interface BackupPolicy {
  readonly backupRetentionPeriod?: number;
  readonly preferredBackupPeriod?: string;
  readonly preferredBackupTime?: string;
  readonly enableBackupLog?: string;
  readonly logBackupRetentionPeriod?: number;
  readonly releasedKeepPolicy?: string;
}

export interface ConfigurationAttributes {
  readonly backupPolicy?: BackupPolicy;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly pendingRestartParameters?: readonly string[];
  readonly maintenanceWindow?: string;
}

const desiredEntriesMatch = (
  observed: object | undefined,
  desired: object | undefined,
) =>
  desired === undefined ||
  Object.entries(desired).every(
    ([key, value]) =>
      value === undefined ||
      (observed as Record<string, unknown> | undefined)?.[key] === value,
  );

export const configurationMatches = (
  observed: ConfigurationAttributes,
  desired: InstanceConfiguration,
) =>
  desiredEntriesMatch(observed.backupPolicy, desired.backupPolicy) &&
  desiredEntriesMatch(observed.parameters, desired.parameters) &&
  (!desired.restartForParameterChanges ||
    !observed.pendingRestartParameters?.length) &&
  (desired.maintenanceWindow === undefined ||
    desired.maintenanceWindow === observed.maintenanceWindow);

export const instanceConfiguration = (
  clients: AlibabaClientSet,
  wait?: WaitOptions,
) => {
  const backup = Effect.fn("RDS.readBackupPolicy")(function* (
    instanceId: string,
  ) {
    const response = yield* retryingSdkCall("RDS", "DescribeBackupPolicy", () =>
      clients.rds.describeBackupPolicy(
        new RDS.DescribeBackupPolicyRequest({ DBInstanceId: instanceId }),
      ),
    );
    const value = response.body;
    return {
      backupRetentionPeriod: value?.backupRetentionPeriod,
      preferredBackupPeriod: value?.preferredBackupPeriod,
      preferredBackupTime: value?.preferredBackupTime,
      enableBackupLog: value?.enableBackupLog,
      logBackupRetentionPeriod: value?.logBackupRetentionPeriod,
      releasedKeepPolicy: value?.releasedKeepPolicy,
    } satisfies BackupPolicy;
  });
  const parameters = Effect.fn("RDS.readParameters")(function* (
    instanceId: string,
    desired: Readonly<Record<string, string>>,
  ) {
    const response = yield* retryingSdkCall("RDS", "DescribeParameters", () =>
      clients.rds.describeParameters(
        new RDS.DescribeParametersRequest({ DBInstanceId: instanceId }),
      ),
    );
    const entries = (
      items: readonly {
        parameterName?: string;
        parameterValue?: string;
      }[] = [],
    ) =>
      Object.fromEntries(
        items.flatMap((item) =>
          item.parameterName === undefined || item.parameterValue === undefined
            ? []
            : [[item.parameterName, item.parameterValue]],
        ),
      );
    const configured = entries(
      response.body?.configParameters?.DBInstanceParameter,
    );
    const running = entries(
      response.body?.runningParameters?.DBInstanceParameter,
    );
    return {
      parameters: { ...running, ...configured },
      pendingRestartParameters: Object.keys(desired).filter(
        (key) => running[key] !== (configured[key] ?? running[key]),
      ),
    };
  });
  const read = Effect.fn("RDS.readConfiguration")(function* (
    instanceId: string,
    desired: InstanceConfiguration,
    maintenanceWindow?: string,
  ) {
    return {
      maintenanceWindow,
      ...(desired.backupPolicy === undefined
        ? {}
        : { backupPolicy: yield* backup(instanceId) }),
      ...(desired.parameters === undefined
        ? {}
        : yield* parameters(instanceId, desired.parameters)),
    } satisfies ConfigurationAttributes;
  });
  const sync = Effect.fn("RDS.syncConfiguration")(function* (
    instanceId: string,
    desired: InstanceConfiguration,
    maintenanceWindow?: string,
  ) {
    const observed = yield* read(instanceId, desired, maintenanceWindow);
    if (
      desired.backupPolicy !== undefined &&
      !desiredEntriesMatch(observed.backupPolicy, desired.backupPolicy)
    ) {
      yield* retryingSdkCall("RDS", "ModifyBackupPolicy", () =>
        clients.rds.modifyBackupPolicy(
          new RDS.ModifyBackupPolicyRequest({
            ...desired.backupPolicy,
            DBInstanceId: instanceId,
            backupRetentionPeriod:
              desired.backupPolicy?.backupRetentionPeriod?.toString(),
            logBackupRetentionPeriod:
              desired.backupPolicy?.logBackupRetentionPeriod?.toString(),
          }),
        ),
      );
      yield* waitFor({
        service: "RDS",
        operation: "ModifyBackupPolicy",
        read: backup(instanceId),
        ready: (value) => desiredEntriesMatch(value, desired.backupPolicy),
        wait,
      });
    }
    if (
      desired.parameters !== undefined &&
      (!desiredEntriesMatch(observed.parameters, desired.parameters) ||
        (desired.restartForParameterChanges &&
          observed.pendingRestartParameters?.length))
    ) {
      yield* retryingSdkCall("RDS", "ModifyParameter", () =>
        clients.rds.modifyParameter(
          new RDS.ModifyParameterRequest({
            DBInstanceId: instanceId,
            parameters: JSON.stringify(desired.parameters),
            forcerestart: desired.restartForParameterChanges ?? false,
          }),
        ),
      );
      yield* waitFor({
        service: "RDS",
        operation: "ModifyParameter",
        read: parameters(instanceId, desired.parameters),
        ready: (value) =>
          desiredEntriesMatch(value.parameters, desired.parameters) &&
          (!desired.restartForParameterChanges ||
            value.pendingRestartParameters.length === 0),
        wait,
      });
    }
    if (
      desired.maintenanceWindow !== undefined &&
      desired.maintenanceWindow !== maintenanceWindow
    ) {
      yield* retryingSdkCall("RDS", "ModifyDBInstanceMaintainTime", () =>
        clients.rds.modifyDBInstanceMaintainTime(
          new RDS.ModifyDBInstanceMaintainTimeRequest({
            DBInstanceId: instanceId,
            maintainTime: desired.maintenanceWindow,
          }),
        ),
      );
    }
  });
  return { read, sync };
};
