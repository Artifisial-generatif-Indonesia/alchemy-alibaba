import * as RDS from "@alicloud/rds20140815";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Redacted from "effect/Redacted";
import { AlibabaClients } from "../clients.ts";
import {
  AlibabaInvariantError,
  isNotFound,
  retryingSdkCall,
  sdkCall,
} from "../error.ts";
import {
  physicalName,
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Without } from "../internal/model-input.ts";
import type { Providers } from "../providers.ts";

export type AccountSettings = Without<
  RDS.CreateAccountRequest,
  "DBInstanceId" | "accountName" | "accountPassword" | "accountDescription"
>;

export interface AccountProps {
  readonly instanceId: string;
  readonly name?: string;
  readonly password: Redacted.Redacted<string>;
  readonly description?: string;
  readonly settings?: AccountSettings;
}

export interface AccountPrivilegeAttribute {
  readonly databaseName: string;
  readonly privilege?: string;
  readonly detail?: string;
}

export interface AccountAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly status?: string;
  readonly type?: string;
  readonly description?: string;
  readonly checkPolicy?: boolean;
  readonly privileges: readonly AccountPrivilegeAttribute[];
  readonly passwordExpiresAt?: string;
}

export type Account = Resource<
  "Alibaba.RDS.Account",
  AccountProps,
  AccountAttributes,
  never,
  Providers
>;

export const Account = Resource<Account>("Alibaba.RDS.Account");

type ObservedAccount =
  RDS.DescribeAccountsResponseBodyAccountsDBInstanceAccount;

const toAttributes = (
  instanceId: string,
  name: string,
  account: ObservedAccount,
): AccountAttributes => ({
  instanceId,
  name: account.accountName ?? name,
  status: account.accountStatus,
  type: account.accountType,
  description: account.accountDescription,
  checkPolicy: account.checkPolicy,
  privileges: (account.databasePrivileges?.databasePrivilege ?? []).flatMap(
    (privilege) =>
      privilege.DBName === undefined
        ? []
        : [
            {
              databaseName: privilege.DBName,
              privilege: privilege.accountPrivilege,
              detail: privilege.accountPrivilegeDetail,
            },
          ],
  ),
  passwordExpiresAt: account.passwordExpireTime,
});

export interface AccountProviderOptions {
  readonly wait?: WaitOptions;
}

/** RDS accounts expose no ownership metadata and are silently adoptable. */
export const AccountProvider = (options: AccountProviderOptions = {}) =>
  Provider.effect(
    Account,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (instanceId: string, name: string) =>
        retryingSdkCall("RDS", "DescribeAccounts", () =>
          clients.rds.describeAccounts(
            new RDS.DescribeAccountsRequest({
              DBInstanceId: instanceId,
              accountName: name,
              pageNumber: 1,
              pageSize: 200,
            }),
          ),
        ).pipe(
          Effect.map((response) =>
            response.body?.accounts?.DBInstanceAccount?.find(
              (account) => account.accountName === name,
            ),
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        stables: ["instanceId", "name"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds.instanceId === undefined || olds.password === undefined) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            olds.name !== news.name ||
            olds.settings?.accountType !== news.settings?.accountType ||
            olds.settings?.checkPolicy !== news.settings?.checkPolicy
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const name = yield* physicalName(id, olds.name ?? output?.name, 63);
          const account = yield* get(instanceId, name);
          return account === undefined
            ? undefined
            : toAttributes(instanceId, name, account);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 63);
          let account = yield* get(news.instanceId, name);
          if (account === undefined) {
            yield* sdkCall("RDS", "CreateAccount", () =>
              clients.rds.createAccount(
                new RDS.CreateAccountRequest({
                  ...news.settings,
                  DBInstanceId: news.instanceId,
                  accountName: name,
                  accountPassword: Redacted.value(news.password),
                  accountDescription: news.description,
                }),
              ),
            );
          } else {
            if (
              (news.settings?.accountType !== undefined &&
                account.accountType !== news.settings.accountType) ||
              (news.settings?.checkPolicy !== undefined &&
                account.checkPolicy !== news.settings.checkPolicy)
            ) {
              return yield* new AlibabaInvariantError({
                resourceType: Account.Type,
                operation: "ReconcileAccount",
                message: `Account ${name} exists with immutable settings that differ from the requested accountType or checkPolicy`,
              });
            }
            if (
              news.description !== undefined &&
              account.accountDescription !== news.description
            ) {
              yield* sdkCall("RDS", "ModifyAccountDescription", () =>
                clients.rds.modifyAccountDescription(
                  new RDS.ModifyAccountDescriptionRequest({
                    DBInstanceId: news.instanceId,
                    accountName: name,
                    accountDescription: news.description,
                  }),
                ),
              );
            }
            if (olds === undefined || !Equal.equals(olds.password, news.password)) {
              yield* sdkCall("RDS", "ResetAccountPassword", () =>
                clients.rds.resetAccountPassword(
                  new RDS.ResetAccountPasswordRequest({
                    DBInstanceId: news.instanceId,
                    accountName: name,
                    accountPassword: Redacted.value(news.password),
                  }),
                ),
              );
            }
          }
          account = yield* waitForPresent({
            service: "RDS",
            operation: "ReconcileAccount",
            read: get(news.instanceId, name),
            ready: (value) =>
              (value.accountStatus?.toLowerCase() === "available" ||
                value.accountStatus?.toLowerCase() === "normal") &&
              (news.description === undefined ||
                value.accountDescription === news.description) &&
              (news.settings?.accountType === undefined ||
                value.accountType === news.settings.accountType) &&
              (news.settings?.checkPolicy === undefined ||
                value.checkPolicy === news.settings.checkPolicy),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, name, account);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryingSdkCall("RDS", "DeleteAccount", () =>
            clients.rds.deleteAccount(
              new RDS.DeleteAccountRequest({
                DBInstanceId: output.instanceId,
                accountName: output.name,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "RDS",
            operation: "DeleteAccount",
            read: get(output.instanceId, output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
