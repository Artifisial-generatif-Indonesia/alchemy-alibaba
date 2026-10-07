import { ClientError } from "@alicloud/openapi-core";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAccess } from "./access.ts";
import {
  callerName,
  describeCredentials,
  rdsApiLayer,
  type CredentialSource,
  type RdsSdk,
} from "./alibaba.ts";
import type { Target } from "./model.ts";

const target: Target = {
  instanceId: "pgm-example",
  regionId: "ap-southeast-5",
  developer: "alice@example.com",
  networkType: "MIX",
};
const ACCOUNT_ID = "5123456789012345";
const ENCODED = "eyJBdXRoQWN0aW9uIjoicmRzOk1vZGlmeVNlY3VyaXR5SXBzIn0SECRETDIAGNOSTIC";
const deniedMessage =
  "User not authorized to operate on the specified resource, or this API does not support RAM.";

/** Built the way @alicloud/openapi-core builds a 4xx ClientError from the response body. */
const clientError = (status: number, body: Record<string, unknown>) =>
  new ClientError({
    statusCode: status,
    code: `${body.Code}`,
    message: `code: ${status}, ${body.Message} request id: ${body.RequestId}`,
    detail: `${body.Detail}`,
    description: `${body.Description}`,
    data: body,
    accessDeniedDetail: body.AccessDeniedDetail,
    requestId: `${body.RequestId}`,
  });

const forbidden = () =>
  clientError(403, {
    Code: "Forbidden",
    Message: deniedMessage,
    RequestId: "5E4C1F8A-0D2B-4D7A-9C6E-0123456789AB",
    HostId: "rds.aliyuncs.com",
    AccessDeniedDetail: {
      AuthAction: "rds:ModifySecurityIps",
      AuthPrincipalDisplayName: "readonly-bot",
      AuthPrincipalOwnerId: ACCOUNT_ID,
      AuthPrincipalType: "SubUser",
      EncodedDiagnosticMessage: ENCODED,
      NoPermissionType: "ImplicitDeny",
      PolicyType: "AccountLevelIdentityBasedPolicy",
    },
  });

const ramUser = async () => ({
  body: {
    accountId: ACCOUNT_ID,
    arn: `acs:ram::${ACCOUNT_ID}:user/readonly-bot`,
    identityType: "RAMUser",
    principalId: "273859201938475",
    userId: "273859201938475",
  },
});

function harness(failure: unknown, getCallerIdentity?: () => Promise<unknown>) {
  const sdk = {
    describeDBInstanceAttribute: vi.fn<RdsSdk["describeDBInstanceAttribute"]>(async () => ({
      body: {
        items: {
          DBInstanceAttribute: [{ DBInstanceId: target.instanceId, regionId: target.regionId }],
        },
      },
    })),
    describeDBInstanceIPArrayList: vi.fn<RdsSdk["describeDBInstanceIPArrayList"]>(async () => ({
      body: { items: { DBInstanceIPArray: [] } },
    })),
    modifySecurityIps: vi.fn<RdsSdk["modifySecurityIps"]>(async () => {
      throw failure;
    }),
    ...(getCallerIdentity === undefined
      ? {}
      : { getCallerIdentity: vi.fn<NonNullable<RdsSdk["getCallerIdentity"]>>(getCallerIdentity) }),
  };
  const fail = (
    credentials: CredentialSource = { kind: "flag", profile: "readonly" },
  ) =>
    Effect.runPromise(
      refreshAccess(target, "203.0.113.10").pipe(
        Effect.flip,
        Effect.provide(
          rdsApiLayer({
            regionId: target.regionId,
            profile: credentials.kind === "default" ? undefined : credentials.profile,
            credentials,
            sdk,
          }),
        ),
      ),
    );
  return { sdk, fail };
}

afterEach(() => vi.useRealTimers());

describe("Alibaba error diagnostics", () => {
  it("explains a permission error with Alibaba's message, RequestId, denial detail and caller", async () => {
    const h = harness(forbidden(), ramUser);
    const error = await h.fail();
    expect(error.message).toBe(
      [
        `ModifySecurityIps failed (Forbidden): ${deniedMessage}`,
        "RequestId: 5E4C1F8A-0D2B-4D7A-9C6E-0123456789AB",
        "Denied action: rds:ModifySecurityIps (NoPermissionType ImplicitDeny, PolicyType AccountLevelIdentityBasedPolicy)",
        'Credentials: profile "readonly" (--profile), RAM user readonly-bot',
        "This identity lacks rds:ModifySecurityIps on pgm-example; use a profile that has it.",
      ].join("\n"),
    );
    expect(error).toMatchObject({
      operation: "ModifySecurityIps",
      code: "Forbidden",
      serviceMessage: deniedMessage,
      requestId: "5E4C1F8A-0D2B-4D7A-9C6E-0123456789AB",
      authAction: "rds:ModifySecurityIps",
      noPermissionType: "ImplicitDeny",
      policyType: "AccountLevelIdentityBasedPolicy",
      credentials: 'profile "readonly" (--profile)',
      caller: "RAM user readonly-bot",
    });
    expect(h.sdk.getCallerIdentity).toHaveBeenCalledTimes(1);
    // A failed write is reported, never retried.
    expect(h.sdk.modifySecurityIps).toHaveBeenCalledTimes(1);
  });

  it("never prints the EncodedDiagnosticMessage or account identifiers", async () => {
    const failure = forbidden();
    (failure.data as Record<string, unknown>).Message =
      `${deniedMessage} EncodedDiagnosticMessage: ${ENCODED}`;
    const error = await harness(failure, ramUser).fail();
    for (const rendered of [error.message, String(error), JSON.stringify(error)]) {
      expect(rendered).not.toContain(ENCODED);
      expect(rendered).not.toContain(ACCOUNT_ID);
      expect(rendered).not.toContain("273859201938475");
    }
    expect(error.message).toContain("EncodedDiagnosticMessage: [redacted]");
  });

  it("reports an error that has no message without inventing one", async () => {
    const error = await harness(
      clientError(403, { Code: "NoPermission" }),
      async () => {
        throw new Error("sts denied");
      },
    ).fail();
    expect(error.message).not.toContain("undefined");
    expect(error.message.split("\n")).toEqual([
      "ModifySecurityIps failed (NoPermission).",
      'Credentials: profile "readonly" (--profile)',
      "This identity lacks rds:ModifySecurityIps on pgm-example; use a profile that has it.",
    ]);
    expect(error.serviceMessage).toBeUndefined();
    expect(error.requestId).toBeUndefined();
    expect(error.caller).toBeUndefined();

    const bare = await harness({}).fail();
    expect(bare.message.split("\n")[0]).toBe("ModifySecurityIps failed.");
  });

  it("does not let a hanging caller lookup mask the original error", async () => {
    vi.useFakeTimers();
    const h = harness(forbidden(), () => new Promise(() => {}));
    const pending = h.fail();
    await vi.advanceTimersByTimeAsync(5_100);
    const error = await pending;
    expect(error.code).toBe("Forbidden");
    expect(error.caller).toBeUndefined();
    expect(error.message).toContain("use a profile that has it");
  });

  it("looks up the caller only for permission errors", async () => {
    const h = harness(
      clientError(400, {
        Code: "InvalidSecurityIPs.Format",
        Message: "Specified security IP is not valid.",
        RequestId: "AB12CD34-0000-4000-8000-000000000000",
      }),
      ramUser,
    );
    const error = await h.fail();
    expect(error.message.split("\n")).toEqual([
      "ModifySecurityIps failed (InvalidSecurityIPs.Format): Specified security IP is not valid.",
      "RequestId: AB12CD34-0000-4000-8000-000000000000",
      'Credentials: profile "readonly" (--profile)',
      "Run plan to inspect the entry before retrying.",
    ]);
    expect(h.sdk.getCallerIdentity).not.toHaveBeenCalled();
  });

  it("strips control characters, redacts credentials and bounds the message length", async () => {
    const error = await harness(
      clientError(403, {
        Code: "Forbidden.RAM",
        Message:
          "denied\u001b[31m\r\nAccessKeyId=LTAI5tAbCdEfGhIjKlMn Signature=abc123 password: hunter2 " +
          "x".repeat(1_000),
        RequestId: "bad id\nwith newline",
      }),
    ).fail();
    expect(error.serviceMessage).toBeDefined();
    expect(error.serviceMessage!.length).toBeLessThanOrEqual(300);
    expect(error.message).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    for (const secret of ["LTAI5tAbCdEfGhIjKlMn", "abc123", "hunter2"]) {
      expect(error.message).not.toContain(secret);
    }
    expect(error.requestId).toBeUndefined();
  });

  it.each([
    [{ kind: "flag", profile: "readonly" }, 'profile "readonly" (--profile)'],
    [{ kind: "environment", profile: "development" }, 'profile "development" (ALIBABA_CLOUD_PROFILE)'],
    [{ kind: "default" }, "SDK default credential chain"],
  ] as const)("names the credential source %j in permission errors", async (source, expected) => {
    const error = await harness(clientError(403, { Code: "Forbidden" })).fail(source);
    expect(error.credentials).toBe(expected);
    expect(error.message).toContain(`Credentials: ${expected}`);
    expect(describeCredentials(source)).toBe(expected);
  });

  it("prints only the RAM user or role name of the caller", () => {
    expect(callerName({ body: { arn: `acs:ram::${ACCOUNT_ID}:user/alice.dev` } })).toBe(
      "RAM user alice.dev",
    );
    expect(
      callerName({ body: { arn: `acs:ram::${ACCOUNT_ID}:assumed-role/rds-operator/session-1` } }),
    ).toBe("RAM role rds-operator");
    expect(callerName({ body: { arn: `acs:ram::${ACCOUNT_ID}:root` } })).toBe(
      "account root identity",
    );
    expect(callerName({ body: { arn: "acs:ram::1:user/bad\nname" } })).toBeUndefined();
    expect(callerName({ body: {} })).toBeUndefined();
  });
});
