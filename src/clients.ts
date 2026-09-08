import ACRClientImport from "@alicloud/cr20181201";
import CredentialImport, {
  CLIProfileCredentialsProvider,
} from "@alicloud/credentials";
import ACKClientImport from "@alicloud/cs20151215";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import TairClientImport from "@alicloud/r-kvstore20150101";
import RDSClientImport from "@alicloud/rds20140815";
import VPCClientImport from "@alicloud/vpc20160428";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface CommonJsDefault<Value> {
  readonly default: Value;
}

const hasCommonJsDefault = <Value>(
  value: Value | CommonJsDefault<Value>,
): value is CommonJsDefault<Value> =>
  typeof value === "object" && value !== null && "default" in value;

/** Alibaba SDK packages expose a nested default under native Node ESM. */
const interopDefault = <Value>(
  value: Value | CommonJsDefault<Value>,
): Value => (hasCommonJsDefault(value) ? value.default : value);

type ACRClient = InstanceType<typeof ACRClientImport>;
type ACKClient = InstanceType<typeof ACKClientImport>;
type Credential = InstanceType<typeof CredentialImport>;
type RDSClient = InstanceType<typeof RDSClientImport>;
type TairClient = InstanceType<typeof TairClientImport>;
type VPCClient = InstanceType<typeof VPCClientImport>;

// Keep the SDK's documented defaults explicit so every provider request is
// bounded even when a generated client stops supplying its own fallback.
export const ALIBABA_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const ALIBABA_DEFAULT_READ_TIMEOUT_MS = 10_000;
/** CreateDBInstance explicitly recommends at least a 20-second read timeout. */
export const ALIBABA_RDS_DEFAULT_READ_TIMEOUT_MS = 20_000;

const ACRClient = interopDefault(ACRClientImport);
const ACKClient = interopDefault(ACKClientImport);
const Credential = interopDefault(CredentialImport);
const RDSClient = interopDefault(RDSClientImport);
const TairClient = interopDefault(TairClientImport);
const VPCClient = interopDefault(VPCClientImport);

export interface AlibabaEndpoints {
  readonly ack?: string;
  readonly acr?: string;
  readonly tair?: string;
  readonly rds?: string;
  readonly vpc?: string;
}

export interface AlibabaClientOptions {
  readonly regionId: string;
  readonly credential?: Credential;
  readonly endpoints?: AlibabaEndpoints;
  readonly protocol?: string;
  readonly connectTimeout?: number;
  readonly readTimeout?: number;
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
  readonly network?: string;
  readonly userAgent?: string;
}

export interface AlibabaClientSet {
  readonly ack: ACKClient;
  readonly acr: ACRClient;
  readonly tair: TairClient;
  readonly rds: RDSClient;
  readonly vpc: VPCClient;
  readonly regionId: string;
}

export class AlibabaClients extends Context.Service<
  AlibabaClients,
  AlibabaClientSet
>()("alchemy-alibaba/AlibabaClients") {}

const clientConfig = (
  options: AlibabaClientOptions,
  endpoint: string | undefined,
  defaultReadTimeout = ALIBABA_DEFAULT_READ_TIMEOUT_MS,
): $OpenApiUtil.Config =>
  new $OpenApiUtil.Config({
    credential: options.credential ?? new Credential(),
    regionId: options.regionId,
    endpoint,
    protocol: options.protocol,
    connectTimeout:
      options.connectTimeout ?? ALIBABA_DEFAULT_CONNECT_TIMEOUT_MS,
    readTimeout: options.readTimeout ?? defaultReadTimeout,
    httpProxy: options.httpProxy,
    httpsProxy: options.httpsProxy,
    noProxy: options.noProxy,
    network: options.network,
    userAgent: options.userAgent ?? "alchemy-alibaba/0.1",
  });

export const makeClients = (options: AlibabaClientOptions): AlibabaClientSet => ({
  ack: new ACKClient(clientConfig(options, options.endpoints?.ack)),
  acr: new ACRClient(clientConfig(options, options.endpoints?.acr)),
  tair: new TairClient(clientConfig(options, options.endpoints?.tair)),
  rds: new RDSClient(
    clientConfig(
      options,
      options.endpoints?.rds,
      ALIBABA_RDS_DEFAULT_READ_TIMEOUT_MS,
    ),
  ),
  vpc: new VPCClient(clientConfig(options, options.endpoints?.vpc)),
  regionId: options.regionId,
});

export const clients = (options: AlibabaClientOptions) =>
  Layer.succeed(AlibabaClients, makeClients(options));

/** Uses one named Alibaba CLI profile without exposing its access keys. */
export const credentialFromCliProfile = (profile: string): Credential =>
  new Credential(
    null,
    CLIProfileCredentialsProvider.builder()
      .withProfileName(profile)
      .build(),
  );

const environmentOptions = Config.all({
  regionId: Config.string("ALIBABA_CLOUD_REGION"),
  profile: Config.option(Config.string("ALIBABA_CLOUD_PROFILE")),
  ackEndpoint: Config.option(Config.string("ALIBABA_CLOUD_ACK_ENDPOINT")),
  acrEndpoint: Config.option(Config.string("ALIBABA_CLOUD_ACR_ENDPOINT")),
  tairEndpoint: Config.option(Config.string("ALIBABA_CLOUD_TAIR_ENDPOINT")),
  rdsEndpoint: Config.option(Config.string("ALIBABA_CLOUD_RDS_ENDPOINT")),
  vpcEndpoint: Config.option(Config.string("ALIBABA_CLOUD_VPC_ENDPOINT")),
});

/**
 * Uses the official Alibaba credential provider chain. No access key is read
 * directly by this module or persisted in Alchemy state.
 */
export const clientsFromEnvironment = () =>
  Layer.effect(
    AlibabaClients,
    Effect.map(environmentOptions, (options) =>
      makeClients({
        regionId: options.regionId,
        credential:
          options.profile._tag === "Some"
            ? credentialFromCliProfile(options.profile.value)
            : undefined,
        endpoints: {
          ack: options.ackEndpoint._tag === "Some" ? options.ackEndpoint.value : undefined,
          acr: options.acrEndpoint._tag === "Some" ? options.acrEndpoint.value : undefined,
          tair:
            options.tairEndpoint._tag === "Some"
              ? options.tairEndpoint.value
              : undefined,
          rds: options.rdsEndpoint._tag === "Some" ? options.rdsEndpoint.value : undefined,
          vpc: options.vpcEndpoint._tag === "Some" ? options.vpcEndpoint.value : undefined,
        },
      }),
    ),
  );
