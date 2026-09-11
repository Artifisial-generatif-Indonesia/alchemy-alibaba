import { describe, expect, it } from "vitest";
import {
  buildGrantStatements,
  buildVerificationQueries,
  interpretVerification,
  quoteIdentifier,
  quoteLiteral,
} from "./grants.ts";

const options = {
  database: "odin",
  account: "gateway_ro",
  schemas: ["public", "shop"],
  ownerRoles: ["odin_app"],
};

describe("grant SQL builders", () => {
  it("quotes identifiers and literals", () => {
    expect(quoteIdentifier("gateway_ro")).toBe('"gateway_ro"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("grants read-only access to existing and future tables", () => {
    const statements = buildGrantStatements(options).map((item) => item.statement);
    expect(statements).toContain('GRANT CONNECT ON DATABASE "odin" TO "gateway_ro"');
    expect(statements).toContain('ALTER ROLE "gateway_ro" SET default_transaction_read_only = on');
    expect(statements).toContain('GRANT USAGE ON SCHEMA "public" TO "gateway_ro"');
    expect(statements).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "gateway_ro"');
    expect(statements).toContain('REVOKE CREATE ON SCHEMA "public" FROM "gateway_ro"');
    expect(statements).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "odin_app" IN SCHEMA "public" GRANT SELECT ON TABLES TO "gateway_ro"',
    );
    expect(statements).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "odin_app" IN SCHEMA "shop" GRANT SELECT ON TABLES TO "gateway_ro"',
    );
    expect(statements.some((statement) => /INSERT|UPDATE|DELETE|CREATE TABLE/i.test(statement))).toBe(
      false,
    );
  });

  it("omits default privileges when no owner role is identified", () => {
    expect(
      buildGrantStatements({ ...options, ownerRoles: [] }).filter((item) =>
        item.statement.startsWith("ALTER DEFAULT"),
      ),
    ).toEqual([]);
  });

  it("builds an identity query and one default-privilege query per owner/schema", () => {
    const queries = buildVerificationQueries(options);
    expect(queries.identity).toContain("current_database()");
    expect(queries.identity).toContain("has_schema_privilege");
    expect(queries.identity).toContain("'public', 'shop'");
    expect(queries.defaultPrivileges).toBeDefined();
    expect(queries.defaultPrivileges).toContain("pg_default_acl");
    expect(queries.defaultPrivileges).toContain("'odin_app'");
    expect(queries.defaultPrivileges).toContain("%gateway_ro=r%");
  });

  it("omits the default-privilege query when no owner role is named", () => {
    expect(buildVerificationQueries({ ...options, ownerRoles: [] }).defaultPrivileges).toBeUndefined();
  });

  it("uses bool_or for CREATE so one writable schema is detected", () => {
    const queries = buildVerificationQueries(options);
    expect(queries.identity).toContain(
      "bool_or(has_schema_privilege(current_user, nspname, 'CREATE'))",
    );
    expect(queries.identity).not.toContain(
      "bool_and(has_schema_privilege(current_user, nspname, 'CREATE'))",
    );
  });

  it("accepts a healthy verification row", () => {
    const identity = [
      {
        database: "odin",
        username: "gateway_ro",
        read_only: "on",
        schema_usage: true,
        schema_create: false,
        can_read_all: true,
        can_write_any: false,
      },
    ];
    const defaults = [
      { owner_role: "odin_app", schema_name: "public", granted: true },
      { owner_role: "odin_app", schema_name: "shop", granted: true },
    ];
    expect(interpretVerification(options, identity, defaults)).toEqual({
      verified: true,
      issues: [],
    });
  });

  it.each([
    [{ database: "other" }, "connected database"],
    [{ username: "someone" }, "connected user"],
    [{ read_only: "off" }, "transaction_read_only"],
    [{ schema_usage: false }, "USAGE is missing"],
    [{ schema_create: true }, "CREATE is still allowed"],
    [{ can_read_all: false }, "SELECT is missing"],
    [{ can_write_any: true }, "write privileges"],
  ])("reports a permission issue: %o", (patch, message) => {
    const identity = [
      {
        database: "odin",
        username: "gateway_ro",
        read_only: "on",
        schema_usage: true,
        schema_create: false,
        can_read_all: true,
        can_write_any: false,
        ...patch,
      },
    ];
    const result = interpretVerification(options, identity, []);
    expect(result.verified).toBe(false);
    expect(result.issues.join(" ")).toContain(message);
  });

  it("treats a missing default privilege as unverified", () => {
    const result = interpretVerification(
      options,
      [
        {
          database: "odin",
          username: "gateway_ro",
          read_only: "on",
          schema_usage: true,
          schema_create: false,
          can_read_all: true,
          can_write_any: false,
        },
      ],
      [
        { owner_role: "odin_app", schema_name: "public", granted: false },
        { owner_role: "odin_app", schema_name: "shop", granted: true },
      ],
    );
    expect(result.verified).toBe(false);
    expect(result.issues).toEqual([
      "default SELECT for future tables is missing for odin_app in public",
    ]);
  });
});
