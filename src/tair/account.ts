import * as Tair from "@alicloud/r-kvstore20150101";
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
  Tair.CreateAccountRequest,
  "instanceId" | "accountName" | "accountPassword"
>;

export interface AccountProps {
  readonly instanceId: string;
  readonly name?: string;
  readonly password: Redacted.Redacted<string>;
  readonly settings?: AccountSettings;
}

export interface AccountAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly status?: string;
  readonly type?: string;
  readonly description?: string;
  readonly privilege?: string;
  readonly parameters?: string;
}

export type Account = Resource<
  "Alibaba.Tair.Account",
  AccountProps,
  AccountAttributes,
  never,
  Providers
>;

export const Account = Resource<Account>("Alibaba.Tair.Account");

type ObservedAccount =
  Tair.DescribeAccountsResponseBodyAccountsAccount;

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
  privilege:
    account.databasePrivileges?.databasePrivilege?.[0]?.accountPrivilege,
  parameters: account.parameters,
});

export interface AccountProviderOptions {
  readonly wait?: WaitOptions;
}

/** Tair accounts expose no ownership metadata and are silently adoptable. */
export const AccountProvider = (options: AccountProviderOptions = {}) =>
  Provider.effect(
    Account,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (instanceId: string, name: string) =>
        retryingSdkCall("Tair", "DescribeAccounts", () =>
          clients.tair.describeAccounts(
            new Tair.DescribeAccountsRequest({
              instanceId,
              accountName: name,
              pageNumber: 1,
              pageSize: 100,
            }),
          ),
        ).pipe(
          Effect.map((response) =>
            response.body?.accounts?.account?.find(
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
          const oldSettings = olds.settings ?? {};
          const newSettings = news.settings ?? {};
          return olds.instanceId !== news.instanceId ||
            olds.name !== news.name ||
            oldSettings.accountPrivilege !== newSettings.accountPrivilege ||
            oldSettings.accountType !== newSettings.accountType ||
            oldSettings.parameters !== newSettings.parameters
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const name = yield* physicalName(id, olds.name ?? output?.name, 100);
          const account = yield* get(instanceId, name);
          return account === undefined
            ? undefined
            : toAttributes(instanceId, name, account);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 100);
          const settings = news.settings ?? {};
          let account = yield* get(news.instanceId, name);
          if (account === undefined) {
            yield* sdkCall("Tair", "CreateAccount", () =>
              clients.tair.createAccount(
                new Tair.CreateAccountRequest({
                  ...settings,
                  instanceId: news.instanceId,
                  accountName: name,
                  accountPassword: Redacted.value(news.password),
                }),
              ),
            );
          } else {
            if (
              (settings.accountPrivilege !== undefined &&
                account.databasePrivileges?.databasePrivilege?.[0]
                  ?.accountPrivilege !== settings.accountPrivilege) ||
              (settings.accountType !== undefined &&
                account.accountType !== settings.accountType) ||
              (settings.parameters !== undefined &&
                account.parameters !== settings.parameters)
            ) {
              return yield* new AlibabaInvariantError({
                resourceType: Account.Type,
                operation: "ReconcileAccount",
                message: `Account ${name} exists with immutable settings that differ from the requested accountPrivilege, accountType, or parameters`,
              });
            }
            if (
              settings.accountDescription !== undefined &&
              account.accountDescription !== settings.accountDescription
            ) {
              yield* sdkCall("Tair", "ModifyAccountDescription", () =>
                clients.tair.modifyAccountDescription(
                  new Tair.ModifyAccountDescriptionRequest({
                    instanceId: news.instanceId,
                    accountName: name,
                    accountDescription: settings.accountDescription,
                  }),
                ),
              );
            }
            if (olds === undefined || !Equal.equals(olds.password, news.password)) {
              yield* sdkCall("Tair", "ResetAccountPassword", () =>
                clients.tair.resetAccountPassword(
                  new Tair.ResetAccountPasswordRequest({
                    instanceId: news.instanceId,
                    accountName: name,
                    accountPassword: Redacted.value(news.password),
                  }),
                ),
              );
            }
          }
          account = yield* waitForPresent({
            service: "Tair",
            operation: "ReconcileAccount",
            read: get(news.instanceId, name),
            ready: (value) =>
              (value.accountStatus?.toLowerCase() === "available" ||
                value.accountStatus?.toLowerCase() === "normal") &&
              (settings.accountDescription === undefined ||
                value.accountDescription === settings.accountDescription) &&
              (settings.accountPrivilege === undefined ||
                value.databasePrivileges?.databasePrivilege?.[0]
                  ?.accountPrivilege === settings.accountPrivilege) &&
              (settings.accountType === undefined ||
                value.accountType === settings.accountType) &&
              (settings.parameters === undefined ||
                value.parameters === settings.parameters),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, name, account);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryingSdkCall("Tair", "DeleteAccount", () =>
            clients.tair.deleteAccount(
              new Tair.DeleteAccountRequest({
                instanceId: output.instanceId,
                accountName: output.name,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "Tair",
            operation: "DeleteAccount",
            read: get(output.instanceId, output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
