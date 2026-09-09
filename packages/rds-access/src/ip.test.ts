import { createServer } from "node:http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it } from "vitest";
import { detectIPv4 } from "./ip.ts";

it("detects and validates the IPv4 response using a loopback HTTP service", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/error") response.writeHead(503).end('{"ip":"203.0.113.1"}');
    else if (request.url === "/broad") response.end('{"ip":"0.0.0.0/0"}');
    else if (request.url === "/ipv6") response.end('{"ip":"2001:db8::1"}');
    else if (request.url === "/invalid") response.end('{"address":"203.0.113.1"}');
    else if (request.url === "/redirect") response.writeHead(302, { location: "/" }).end();
    else response.end('{"ip":"203.0.113.1"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback port");
  const run = (path: string) =>
    Effect.runPromise(
      detectIPv4(`http://127.0.0.1:${address.port}${path}`).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    );
  try {
    expect(await run("/")).toBe("203.0.113.1");
    for (const path of ["/error", "/broad", "/ipv6", "/invalid", "/redirect"]) {
      await expect(run(path)).rejects.toThrow("Could not detect your IPv4 address");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
