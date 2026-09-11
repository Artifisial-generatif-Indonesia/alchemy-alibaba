import type { GrantStatementPlan } from "./model.ts";

/** Quotes a PostgreSQL identifier. Values are additionally bounded by `SqlIdentifier`. */
export const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Quotes a PostgreSQL string literal. */
export const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const aclPatterns = (account: string): ReadonlyArray<string> => [
  `${quoteLiteral(`%${account}=r%`)}`,
  `${quoteLiteral(`%"${account}"=r%`)}`,
];

export interface GrantOptions {
  readonly database: string;
  readonly account: string;
  readonly schemas: ReadonlyArray<string>;
  readonly ownerRoles: ReadonlyArray<string>;
}

/**
 * Read-only grants. Every statement is idempotent so a rerun after a partial
 * failure converges without dropping or recreating anything.
 */
export const buildGrantStatements = (options: GrantOptions): ReadonlyArray<GrantStatementPlan> => {
  const account = quoteIdentifier(options.account);
  const database = quoteIdentifier(options.database);
  const statements: GrantStatementPlan[] = [
    {
      statement: `GRANT CONNECT ON DATABASE ${database} TO ${account}`,
      description: `allow ${options.account} to connect to ${options.database}`,
    },
    {
      statement: `ALTER ROLE ${account} SET default_transaction_read_only = on`,
      description: `default ${options.account} sessions to read-only`,
    },
  ];
  for (const schema of options.schemas) {
    const name = quoteIdentifier(schema);
    statements.push(
      {
        statement: `GRANT USAGE ON SCHEMA ${name} TO ${account}`,
        description: `allow ${options.account} to use schema ${schema}`,
      },
      {
        statement: `GRANT SELECT ON ALL TABLES IN SCHEMA ${name} TO ${account}`,
        description: `allow ${options.account} to read existing tables in ${schema}`,
      },
      {
        statement: `REVOKE CREATE ON SCHEMA ${name} FROM ${account}`,
        description: `deny ${options.account} schema creation in ${schema}`,
      },
    );
    for (const role of options.ownerRoles) {
      statements.push({
        statement:
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(role)} IN SCHEMA ${name} ` +
          `GRANT SELECT ON TABLES TO ${account}`,
        description: `allow ${options.account} to read future tables in ${schema} owned by ${role}`,
      });
    }
  }
  return statements;
};

const schemaValues = (schemas: ReadonlyArray<string>): string =>
  schemas.map((schema) => `(${quoteLiteral(schema)})`).join(", ");

export interface VerificationQueries {
  /** One row with identity, read-only mode and schema/table permissions. */
  readonly identity: string;
  /** One row per owner/schema pair, or undefined when no owner role is named. */
  readonly defaultPrivileges: string | undefined;
}

export const buildVerificationQueries = (options: GrantOptions): VerificationQueries => {
  const schemaList = options.schemas.map(quoteLiteral).join(", ");
  const identity = [
    "SELECT",
    "  current_database()::text AS database,",
    "  current_user::text AS username,",
    "  current_setting('transaction_read_only')::text AS read_only,",
    "  coalesce(schema_privs.can_usage, true) AS schema_usage,",
    "  coalesce(schema_privs.can_create, false) AS schema_create,",
    "  coalesce(table_privs.can_read_all, true) AS can_read_all,",
    "  coalesce(table_privs.can_write_any, false) AS can_write_any",
    "FROM (",
    "  SELECT",
    "    bool_and(has_schema_privilege(current_user, nspname, 'USAGE')) AS can_usage,",
    "    bool_or(has_schema_privilege(current_user, nspname, 'CREATE')) AS can_create",
    `  FROM (VALUES ${schemaValues(options.schemas)}) AS schemas(nspname)`,
    ") AS schema_privs",
    "CROSS JOIN (",
    "  SELECT",
    "    bool_and(has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT')) AS can_read_all,",
    "    bool_or(has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT,UPDATE,DELETE,TRUNCATE')) AS can_write_any",
    "  FROM pg_tables",
    `  WHERE schemaname IN (${schemaList})`,
    ") AS table_privs",
  ].join("\n");
  const defaultPrivileges =
    options.ownerRoles.length === 0
      ? undefined
      : [
          "SELECT",
          "  wanted.owner_role,",
          "  wanted.schema_name,",
          "  coalesce(bool_or(d.oid IS NOT NULL), false) AS granted",
          `FROM (VALUES ${options.ownerRoles
            .flatMap((ownerRole) =>
              options.schemas.map(
                (schema) => `(${quoteLiteral(ownerRole)}, ${quoteLiteral(schema)})`,
              ),
            )
            .join(", ")}) AS wanted(owner_role, schema_name)`,
          "LEFT JOIN pg_roles r ON r.rolname = wanted.owner_role",
          "LEFT JOIN pg_namespace n ON n.nspname = wanted.schema_name",
          "LEFT JOIN pg_default_acl d",
          "  ON d.defaclrole = r.oid",
          " AND d.defaclnamespace = n.oid",
          " AND d.defaclobjtype = 'r'",
          ` AND (d.defaclacl::text LIKE ${aclPatterns(options.account)[0]} OR d.defaclacl::text LIKE ${
            aclPatterns(options.account)[1]
          })`,
          "GROUP BY wanted.owner_role, wanted.schema_name",
          "ORDER BY wanted.owner_role, wanted.schema_name",
        ].join("\n");
  return { identity, defaultPrivileges };
};

export interface AccountVerification {
  readonly verified: boolean;
  readonly issues: ReadonlyArray<string>;
}

const truthy = (value: unknown): boolean => value === true || value === "t" || value === "true";

/**
 * Interprets the rows returned by `buildVerificationQueries`. It only reports
 * what PostgreSQL itself reports for the connected account; it does not infer
 * success from control-plane state.
 */
export const interpretVerification = (
  options: GrantOptions,
  identityRows: ReadonlyArray<Record<string, unknown>>,
  defaultPrivilegeRows: ReadonlyArray<Record<string, unknown>> = [],
): AccountVerification => {
  const issues: string[] = [];
  const identity = identityRows[0];
  if (identity === undefined) {
    return { verified: false, issues: ["PostgreSQL returned no identity row."] };
  }
  if (identity["database"] !== options.database) {
    issues.push(`connected database is not ${options.database}`);
  }
  if (identity["username"] !== options.account) {
    issues.push(`connected user is not ${options.account}`);
  }
  if (String(identity["read_only"]) !== "on") {
    issues.push("transaction_read_only is not on");
  }
  if (!truthy(identity["schema_usage"])) {
    issues.push("USAGE is missing on at least one schema");
  }
  if (truthy(identity["schema_create"])) {
    issues.push("CREATE is still allowed on at least one schema");
  }
  if (!truthy(identity["can_read_all"])) {
    issues.push("SELECT is missing on at least one existing table");
  }
  if (truthy(identity["can_write_any"])) {
    issues.push("write privileges are present on at least one existing table");
  }
  if (options.ownerRoles.length > 0 && defaultPrivilegeRows.length === 0) {
    issues.push("default privileges for future tables were not reported");
  }
  for (const row of defaultPrivilegeRows) {
    if (!truthy(row["granted"])) {
      issues.push(
        `default SELECT for future tables is missing for ${String(row["owner_role"])} in ${String(
          row["schema_name"],
        )}`,
      );
    }
  }
  return { verified: issues.length === 0, issues };
};
