import * as RDS from "@alicloud/rds20140815";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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

export interface DatabaseProps {
  readonly instanceId: string;
  /** Dependency anchors: create after these accounts, delete before them. */
  readonly accountNames?: readonly string[];
  /** Dependency anchor: create after this IP group, delete before it. */
  readonly securityGroupName?: string;
  readonly name?: string;
  readonly characterSetName: string;
  readonly description?: string;
  readonly create?: Without<
    RDS.CreateDatabaseRequest,
    "DBInstanceId" | "DBName" | "characterSetName" | "DBDescription"
  >;
}

export interface DatabaseAttributes {
  readonly instanceId: string;
  readonly name: string;
  readonly status: string;
  readonly characterSetName?: string;
  readonly description?: string;
  readonly engine?: string;
  readonly collate?: string;
  readonly ctype?: string;
  readonly connectionLimit?: string;
  readonly tablespace?: string;
}

export type Database = Resource<
  "Alibaba.RDS.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

export const Database = Resource<Database>("Alibaba.RDS.Database");

type ObservedDatabase =
  RDS.DescribeDatabasesResponseBodyDatabasesDatabase;

const characterSetMatches = (
  database: ObservedDatabase,
  desired: string,
) => {
  const [characterSetName, collate, ctype] = desired.split(",");
  return (
    database.characterSetName === characterSetName &&
    (collate === undefined || database.collate === collate) &&
    (ctype === undefined || database.ctype === ctype)
  );
};

const toAttributes = (
  instanceId: string,
  name: string,
  database: ObservedDatabase,
): DatabaseAttributes => ({
  instanceId,
  name: database.DBName ?? name,
  status: database.DBStatus ?? "Unknown",
  characterSetName: database.characterSetName,
  description: database.DBDescription,
  engine: database.engine,
  collate: database.collate,
  ctype: database.ctype,
  connectionLimit: database.connLimit,
  tablespace: database.tablespace,
});

export interface DatabaseProviderOptions {
  readonly wait?: WaitOptions;
}

/** RDS databases expose no ownership metadata and are silently adoptable. */
export const DatabaseProvider = (options: DatabaseProviderOptions = {}) =>
  Provider.effect(
    Database,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const get = (instanceId: string, name: string) =>
        retryingSdkCall("RDS", "DescribeDatabases", () =>
          clients.rds.describeDatabases(
            new RDS.DescribeDatabasesRequest({
              DBInstanceId: instanceId,
              DBName: name,
              pageNumber: 1,
              pageSize: 100,
            }),
          ),
        ).pipe(
          Effect.map((response) =>
            response.body?.databases?.database?.find(
              (database) => database.DBName === name,
            ),
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      return {
        version: 1,
        stables: ["instanceId", "name"] as const,
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.instanceId === undefined ||
            olds.characterSetName === undefined
          ) {
            return undefined;
          }
          return olds.instanceId !== news.instanceId ||
            olds.name !== news.name ||
            olds.characterSetName !== news.characterSetName
            ? ({ action: "replace" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const instanceId = olds.instanceId ?? output?.instanceId;
          if (instanceId === undefined) return undefined;
          const name = yield* physicalName(id, olds.name ?? output?.name, 64);
          const database = yield* get(instanceId, name);
          return database === undefined
            ? undefined
            : toAttributes(instanceId, name, database);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* physicalName(id, news.name ?? output?.name, 64);
          let database = yield* get(news.instanceId, name);
          if (database === undefined) {
            yield* sdkCall("RDS", "CreateDatabase", () =>
              clients.rds.createDatabase(
                new RDS.CreateDatabaseRequest({
                  ...news.create,
                  DBInstanceId: news.instanceId,
                  DBName: name,
                  characterSetName: news.characterSetName,
                  DBDescription: news.description,
                }),
              ),
            );
          } else {
            if (!characterSetMatches(database, news.characterSetName)) {
              return yield* new AlibabaInvariantError({
                resourceType: Database.Type,
                operation: "ReconcileDatabase",
                message: `Database ${name} exists with character set ${database.characterSetName ?? "unknown"}; changing characterSetName requires replacement`,
              });
            }
            if (
              news.description !== undefined &&
              database.DBDescription !== news.description
            ) {
              yield* sdkCall("RDS", "ModifyDBDescription", () =>
                clients.rds.modifyDBDescription(
                  new RDS.ModifyDBDescriptionRequest({
                    DBInstanceId: news.instanceId,
                    DBName: name,
                    DBDescription: news.description,
                  }),
                ),
              );
            }
          }
          database = yield* waitForPresent({
            service: "RDS",
            operation: "ReconcileDatabase",
            read: get(news.instanceId, name),
            ready: (value) =>
              value.DBStatus?.toLowerCase() === "running" &&
              characterSetMatches(value, news.characterSetName) &&
              (news.description === undefined ||
                value.DBDescription === news.description),
            wait: options.wait,
          });
          return toAttributes(news.instanceId, name, database);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryingSdkCall("RDS", "DeleteDatabase", () =>
            clients.rds.deleteDatabase(
              new RDS.DeleteDatabaseRequest({
                DBInstanceId: output.instanceId,
                DBName: output.name,
              }),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitForAbsent({
            service: "RDS",
            operation: "DeleteDatabase",
            read: get(output.instanceId, output.name),
            wait: options.wait,
          });
        }),
      };
    }),
  );
