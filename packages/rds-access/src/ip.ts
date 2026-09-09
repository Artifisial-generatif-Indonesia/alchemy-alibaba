import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { AccessError, HostIPv4 } from "./model.ts";

/** Uses the injected HTTP client, so applications can supply their own IP service. */
export const DEFAULT_IP_SERVICE_URL = "https://api.ipify.org?format=json";

export const detectIPv4 = Effect.fn("detectIPv4")(
  function* (url: string) {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get(url);
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Struct({ ip: HostIPv4 }))(
      response,
    );
    return body.ip;
  },
  Effect.timeout("10 seconds"),
  Effect.mapError(
    () =>
      new AccessError({
        message:
          "Could not detect your IPv4 address. Check your network or pass --ip with the DB connection's source IPv4 address.",
      }),
  ),
);
