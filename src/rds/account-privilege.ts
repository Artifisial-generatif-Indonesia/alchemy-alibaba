import * as RDS from "@alicloud/rds20140815";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import {
  isNotFound,
  retryingSdkCall,
  sdkCall,
  type AlibabaProviderError,
} from "../error.ts";
import {
  waitForAbsent,
  waitForPresent,
  type WaitOptions,
} from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface AccountPrivilegeProps {
  readonly instanceId: string;
  readonly accountName: string;
  readonly databaseName: string;
  readonly privilege:
    | "ReadWrite"
    | "ReadOnly"
    | "DDLOnly"
    | "DMLOnly"
    | "DBOwner";
}

export interface AccountPrivilegeAttributes extends AccountPrivilegeProps {
  readonly detail?: string;
}

export type AccountPrivilege = Resource<
  "Alibaba.RDS.AccountPrivilege",
  AccountPrivilegeProps,
  AccountPrivilegeAttributes,
  never,
  Providers
>;

export const AccountPrivilege = Resource<AccountPrivilege>(
  "Alibaba.RDS.AccountPrivilege",
);

const isPrivilege = (
  value: string | undefined,
): value is AccountPrivilegeProps["privilege"] =>
  value === "ReadWrite" ||
  value === "ReadOnly" ||
  value === "DDLOnly" ||
  value === "DMLOnly" ||
  value === "DBOwner";

type ObservedPrivilege = {
  readonly accountPrivilege?: string;
  readonly accountPrivilegeDetail?: string;
};

/**
 * PostgreSQL's RDS API reports DBOwner as `ALL` from DescribeDatabases while
 * DescribeAccounts may omit the database privilege entirely. Keep the
 * provider's desired vocabulary stable across those two read models.
 */
const normalizePrivilege = (
  privilege: string | undefined,
): string | undefined => (privilege === "ALL" ? "DBOwner" : privilege);

const isMissingPrivilege = (error: AlibabaProviderError): boolean =>
  isNotFound(error);

/**
 * PostgreSQL privileged ("Super") accounts have implicit access to every
 * database. Alibaba may expose that access as `ALL` from DescribeDatabases
 * while omitting it from DescribeAccounts, and RevokeAccountPrivilege cannot
 * remove the implicit grant. Treating it as an owned binding would make
 * deletion wait forever.
 */
const hasImplicitDatabaseAccess = (accountType: string | undefined): boolean =>
  accountType !== undefined &&
  ["super", "high", "privileged"].includes(accountType.toLowerCase());

/** Privileges are identified by instance, account, and database and are adoptable. */
export interface AccountPrivilegeProviderOptions {
  readonly wait?: WaitOptions;
}

export const AccountPrivilegeProvider = (
  options: AccountPrivilegeProviderOptions = {},
) =>
  Provider.effect(
    AccountPrivilege,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const getFromAccounts = (
        instanceId: string,
        accountName: string,
        databaseName: string,
      ): Effect.Effect<ObservedPrivilege | undefined, AlibabaProviderError> =>
        retryingSdkCall("RDS", "DescribeAccounts", () =>
          clients.rds.describeAccounts(
            new RDS.DescribeAccountsRequest({
              DBInstanceId: instanceId,
              accountName,
              pageNumber: 1,
              pageSize: 200,
            }),
          ),
        ).pipe(
          Effect.map((response) => {
            const account = response.body?.accounts?.DBInstanceAccount?.find(
              (item) => item.accountName === accountName,
            );
            const privilege = (
              account?.databasePrivileges?.databasePrivilege ?? []
            ).find((item) => item.DBName === databaseName);
            return privilege === undefined
              ? undefined
              : {
                  accountPrivilege: normalizePrivilege(
                    privilege.accountPrivilege,
                  ),
                  accountPrivilegeDetail: privilege.accountPrivilegeDetail,
                };
          }),
          Effect.catchIf(isMissingPrivilege, () => Effect.succeed(undefined)),
        );
      const getFromDatabases = (
        instanceId: string,
        accountName: string,
        databaseName: string,
      ): Effect.Effect<ObservedPrivilege | undefined, AlibabaProviderError> =>
        retryingSdkCall("RDS", "DescribeDatabases", () =>
          clients.rds.describeDatabases(
            new RDS.DescribeDatabasesRequest({
              DBInstanceId: instanceId,
              DBName: databaseName,
              pageNumber: 1,
              pageSize: 100,
            }),
          ),
        ).pipe(
          Effect.map((response) => {
            const database = response.body?.databases?.database?.find(
              (item) => item.DBName === databaseName,
            );
            const privilege = (
              database?.accounts?.accountPrivilegeInfo ?? []
            ).find((item) => item.account === accountName);
            return privilege === undefined
              ? undefined
              : {
                  accountPrivilege: normalizePrivilege(
                    privilege.accountPrivilege,
                  ),
                  accountPrivilegeDetail: privilege.accountPrivilegeDetail,
                };
          }),
          Effect.catchIf(isMissingPrivilege, () => Effect.succeed(undefined)),
        );
      const get = (
        instanceId: string,
        accountName: string,
        databaseName: string,
      ) =>
        getFromAccounts(instanceId, accountName, databaseName).pipe(
          Effect.flatMap((observed) =>
            observed === undefined
              ? getFromDatabases(instanceId, accountName, databaseName)
              : Effect.succeed(observed),
          ),
          Effect.catchIf(isMissingPrivilege, () => Effect.succeed(undefined)),
        );
      const attrs = (
        props: AccountPrivilegeProps,
        detail?: string,
      ): AccountPrivilegeAttributes => ({ ...props, detail });
      return {
        version: 1,
        stables: ["instanceId", "accountName", "databaseName"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.instanceId === undefined ||
            olds.accountName === undefined ||
            olds.databaseName === undefined ||
            olds.privilege === undefined
          ) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            olds.accountName !== news.accountName ||
            olds.databaseName !== news.databaseName
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = {
            instanceId: olds.instanceId ?? output?.instanceId,
            accountName: olds.accountName ?? output?.accountName,
            databaseName: olds.databaseName ?? output?.databaseName,
            privilege: olds.privilege ?? output?.privilege,
          };
          if (
            props.instanceId === undefined ||
            props.accountName === undefined ||
            props.databaseName === undefined
          ) {
            return undefined;
          }
          const observed = yield* get(
            props.instanceId,
            props.accountName,
            props.databaseName,
          );
          return !isPrivilege(observed?.accountPrivilege)
            ? undefined
            : attrs(
                { ...props, privilege: observed.accountPrivilege },
                observed.accountPrivilegeDetail,
              );
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const observed = yield* get(
            news.instanceId,
            news.accountName,
            news.databaseName,
          );
          if (observed?.accountPrivilege !== news.privilege) {
            yield* sdkCall("RDS", "GrantAccountPrivilege", () =>
              clients.rds.grantAccountPrivilege(
                new RDS.GrantAccountPrivilegeRequest({
                  DBInstanceId: news.instanceId,
                  accountName: news.accountName,
                  DBName: news.databaseName,
                  accountPrivilege: news.privilege,
                }),
              ),
            );
          }
          const fresh = yield* waitForPresent({
            service: "RDS",
            operation: "GrantAccountPrivilege",
            read: get(news.instanceId, news.accountName, news.databaseName),
            ready: (value) => value.accountPrivilege === news.privilege,
            wait: options.wait,
          });
          return attrs(news, fresh.accountPrivilegeDetail);
        }),
        delete: Effect.fn(function* ({ output }) {
          const accountHasImplicitAccess = yield* retryingSdkCall(
            "RDS",
            "DescribeAccountsForPrivilegeDelete",
            () =>
              clients.rds.describeAccounts(
                new RDS.DescribeAccountsRequest({
                  DBInstanceId: output.instanceId,
                  accountName: output.accountName,
                  pageNumber: 1,
                  pageSize: 200,
                }),
              ),
          ).pipe(
            Effect.map((response) => {
              const account = response.body?.accounts?.DBInstanceAccount?.find(
                (item) => item.accountName === output.accountName,
              );
              // If the account is already gone, there is no privilege left to
              // revoke. A privileged account's database access is implicit and
              // is cleaned up when the account itself is deleted.
              return (
                account === undefined ||
                hasImplicitDatabaseAccess(account.accountType)
              );
            }),
            Effect.catchIf(isNotFound, () => Effect.succeed(true)),
          );
          if (accountHasImplicitAccess) return;

          yield* retryingSdkCall("RDS", "RevokeAccountPrivilege", () =>
            clients.rds.revokeAccountPrivilege(
              new RDS.RevokeAccountPrivilegeRequest({
                DBInstanceId: output.instanceId,
                accountName: output.accountName,
                DBName: output.databaseName,
              }),
            ),
          ).pipe(Effect.catchIf(isMissingPrivilege, () => Effect.void));
          yield* waitForAbsent({
            service: "RDS",
            operation: "RevokeAccountPrivilege",
            read: get(
              output.instanceId,
              output.accountName,
              output.databaseName,
            ),
            wait: options.wait,
          });
        }),
      };
    }),
  );
