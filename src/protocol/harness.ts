import ACRClientImport from "@alicloud/cr20181201";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import ECSClientImport from "@alicloud/ecs20140526";
import ACKClientImport from "@alicloud/cs20151215";
import TairClientImport from "@alicloud/r-kvstore20150101";
import RDSClientImport from "@alicloud/rds20140815";
import VPCClientImport from "@alicloud/vpc20160428";
import * as Layer from "effect/Layer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AlibabaClients, type AlibabaClientSet } from "../clients.ts";
import { installLoopbackGuard, type LoopbackGuard } from "./loopback-guard.ts";
import {
  PROTOCOL_ACCESS_KEY_ID,
  PROTOCOL_ACCESS_KEY_SECRET,
} from "./redaction.ts";
import { listenProtocolServer, type ProtocolServer } from "./rpc-server.ts";
import { ProtocolWorld, type ProtocolWorldOptions } from "./world.ts";

interface CommonJsDefault<Value> {
  readonly default: Value;
}

const hasCommonJsDefault = <Value>(
  value: Value | CommonJsDefault<Value>,
): value is CommonJsDefault<Value> =>
  typeof value === "object" && value !== null && "default" in value;

const interopDefault = <Value>(value: Value | CommonJsDefault<Value>): Value =>
  hasCommonJsDefault(value) ? value.default : value;

const ACRClient = interopDefault(ACRClientImport);
const ECSClient = interopDefault(ECSClientImport);
const ACKClient = interopDefault(ACKClientImport);
const RDSClient = interopDefault(RDSClientImport);
const TairClient = interopDefault(TairClientImport);
const VPCClient = interopDefault(VPCClientImport);

const clientConfig = (host: string) =>
  new $OpenApiUtil.Config({
    accessKeyId: PROTOCOL_ACCESS_KEY_ID,
    accessKeySecret: PROTOCOL_ACCESS_KEY_SECRET,
    regionId: "ap-southeast-5",
    endpoint: host,
    protocol: "http",
    connectTimeout: 2_000,
    readTimeout: 2_000,
  });

export const protocolClients = (host: string): AlibabaClientSet => ({
  ecs: new ECSClient(clientConfig(host)),
  ack: new ACKClient(clientConfig(host)),
  acr: new ACRClient(clientConfig(host)),
  tair: new TairClient(clientConfig(host)),
  rds: new RDSClient(clientConfig(host)),
  vpc: new VPCClient(clientConfig(host)),
  regionId: "ap-southeast-5",
});

export const protocolClientLayer = (host: string) =>
  Layer.succeed(AlibabaClients, protocolClients(host));

export const fastWait = { attempts: 20, interval: 0 } as const;

export interface ProtocolHarness {
  readonly world: ProtocolWorld;
  readonly server: ProtocolServer;
  readonly clients: AlibabaClientSet;
  readonly guard: LoopbackGuard;
  readonly close: () => Promise<void>;
}

export const startProtocolHarness = async (
  options: ProtocolWorldOptions = {},
): Promise<ProtocolHarness> => {
  const guard = installLoopbackGuard();
  const world = new ProtocolWorld(options);
  try {
    const server = await listenProtocolServer(world);
    return {
      world,
      server,
      clients: protocolClients(server.host),
      guard,
      close: async () => {
        await server.close();
        guard.uninstall();
        if (guard.escaped() > 0) {
          throw new Error(
            `Alibaba protocol harness observed ${guard.escaped()} non-loopback request(s)`,
          );
        }
      },
    };
  } catch (cause) {
    guard.uninstall();
    throw cause;
  }
};

export const withProtocolHarness = async <Result>(
  run: (harness: ProtocolHarness) => Promise<Result>,
  options: ProtocolWorldOptions = {},
): Promise<Result> => {
  const harness = await startProtocolHarness(options);
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
};

export const withTempDir = async <Result>(
  run: (directory: string) => Promise<Result>,
): Promise<Result> => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-alchemy-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
