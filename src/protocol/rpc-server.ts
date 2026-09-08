import http from "node:http";
import { URLSearchParams } from "node:url";
import { assertNoSecrets, redactText } from "./redaction.ts";
import {
  param,
  tagKeysFrom,
  type CapturedRequest,
  type ProtocolResponse,
  type ProtocolWorld,
  type RpcParams,
} from "./world.ts";

const SENSITIVE_PARAM = /^(?:AccessKeyId|AccessKeySecret|Signature|SecurityToken|Password|BearerToken)$/i;

const readBody = (request: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const paramsFrom = (search: string, body: string, contentType: string | undefined): RpcParams => {
  const merged = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (
    body.length > 0 &&
    (contentType === undefined ||
      contentType.includes("application/x-www-form-urlencoded") ||
      !contentType.includes("application/json"))
  ) {
    const form = new URLSearchParams(body);
    for (const [key, value] of form.entries()) merged.set(key, value);
  }
  return Object.fromEntries(merged.entries());
};

const jsonBody = (body: string): Record<string, unknown> => {
  if (body.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const captureFrom = (
  method: string,
  pathname: string,
  host: string,
  params: RpcParams,
  action: string | undefined,
  version: string | undefined,
): CapturedRequest => {
  const password = param(params, "Password");
  return {
    method,
    pathname,
    host,
    action,
    version,
    regionId: param(params, "RegionId"),
    vpcId: param(params, "VpcId") ?? param(params, "VPCId"),
    vSwitchId:
      param(params, "VSwitchId") ??
      param(params, "VswitchId") ??
      param(params, "VSwitchIds"),
    instanceId: param(params, "InstanceId") ?? param(params, "DBInstanceId"),
    instanceName: param(params, "InstanceName"),
    dbInstanceDescription: param(params, "DBInstanceDescription"),
    token: param(params, "Token"),
    clientToken: param(params, "ClientToken"),
    hasPassword: password !== undefined && password.length > 0,
    tagKeys: tagKeysFrom(params),
    pageNumber: param(params, "PageNumber"),
    pageSize: param(params, "PageSize"),
    sslEnabled: param(params, "SSLEnabled"),
  };
};

const writeJson = (
  response: http.ServerResponse,
  result: ProtocolResponse,
): void => {
  const payload = JSON.stringify(result.body);
  assertNoSecrets(payload, "protocol-response");
  response.writeHead(result.statusCode, {
    "content-type": "application/json;charset=utf-8",
  });
  response.end(payload);
};

export interface ProtocolServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export const listenProtocolServer = (
  world: ProtocolWorld,
): Promise<ProtocolServer> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      void (async () => {
        try {
          const host = request.headers.host ?? "127.0.0.1";
          const url = new URL(request.url ?? "/", `http://${host}`);
          const body = await readBody(request);
          const params = paramsFrom(
            url.search,
            body,
            request.headers["content-type"],
          );
          for (const key of Object.keys(params)) {
            if (SENSITIVE_PARAM.test(key)) {
              params[key] = "[present]";
            }
          }
          const headerAction = request.headers["x-acs-action"];
          const action =
            param(params, "Action") ??
            (typeof headerAction === "string" ? headerAction : undefined);
          const version =
            param(params, "Version") ??
            (typeof request.headers["x-acs-version"] === "string"
              ? request.headers["x-acs-version"]
              : undefined);
          const captured = captureFrom(
            request.method ?? "GET",
            url.pathname,
            host,
            paramsFrom(url.search, body, request.headers["content-type"]),
            action,
            version,
          );
          assertNoSecrets(captured, "captured-request");
          world.capture(captured);

          const isRoa = url.pathname !== "/";
          const result = isRoa
            ? world.dispatchRoa(
                request.method ?? "GET",
                url.pathname,
                jsonBody(body),
              )
            : world.dispatchRpc(action ?? "", paramsFrom(url.search, body, request.headers["content-type"]));
          writeJson(response, result);
        } catch (cause) {
          const message = redactText(
            cause instanceof Error ? cause.message : "protocol server failed",
          );
          writeJson(response, {
            statusCode: 500,
            body: { Code: "InternalError", Message: message },
          });
        }
      })();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Protocol server did not bind a loopback port"));
        return;
      }
      resolve({
        host: `127.0.0.1:${address.port}`,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            );
          }),
      });
    });
    server.on("error", reject);
  });
