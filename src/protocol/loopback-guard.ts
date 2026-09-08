import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export class LoopbackEscapeError extends Error {
  readonly code = "LoopbackEscape";
  readonly host: string;

  constructor(host: string) {
    super(
      `Alibaba protocol tests must stay on loopback; a request targeted ${host}`,
    );
    this.name = "LoopbackEscapeError";
    this.host = host;
  }
}

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (host === undefined || host.length === 0) return false;
  const hostname = host.replace(/^\[/, "").replace(/\](?::\d+)?$/, "");
  const name = hostname.includes(":") && !hostname.startsWith(":")
    ? hostname.slice(0, hostname.lastIndexOf(":"))
    : hostname;
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
};

const hostFromArgs = (args: unknown[]): string | undefined => {
  const target = args[0];
  if (typeof target === "string") {
    try {
      return new URL(target).host;
    } catch {
      return target;
    }
  }
  if (target instanceof URL) return target.host;
  if (typeof target === "object" && target !== null) {
    const options = target as {
      host?: string;
      hostname?: string;
      port?: number | string;
    };
    if (typeof options.hostname === "string") {
      return options.port === undefined
        ? options.hostname
        : `${options.hostname}:${options.port}`;
    }
    if (typeof options.host === "string") return options.host;
  }
  return undefined;
};

export interface LoopbackGuard {
  readonly escaped: () => number;
  readonly uninstall: () => void;
}

const wrap = (
  module: typeof http | typeof https,
  original: {
    request: typeof http.request;
    get: typeof http.get;
  },
  onEscape: () => void,
) => {
  const guarded = ((...args: unknown[]) => {
    const host = hostFromArgs(args);
    if (!isLoopbackHost(host)) {
      onEscape();
      throw new LoopbackEscapeError(host ?? "unknown-host");
    }
    return original.request.apply(module, args as Parameters<typeof http.request>);
  }) as typeof http.request;
  module.request = guarded;
  module.get = ((...args: unknown[]) => {
    const request = guarded(...(args as Parameters<typeof http.request>));
    request.end();
    return request;
  }) as typeof http.get;
};

export const installLoopbackGuard = (): LoopbackGuard => {
  const originalHttp = { request: http.request, get: http.get };
  const originalHttps = { request: https.request, get: https.get };
  let escaped = 0;
  const onEscape = () => {
    escaped += 1;
  };
  wrap(http, originalHttp, onEscape);
  wrap(https, originalHttps, onEscape);
  return {
    escaped: () => escaped,
    uninstall: () => {
      http.request = originalHttp.request;
      http.get = originalHttp.get;
      https.request = originalHttps.request;
      https.get = originalHttps.get;
    },
  };
};
