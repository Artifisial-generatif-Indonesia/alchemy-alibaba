import { Stack } from "alchemy";
import type { AlchemyContext } from "alchemy/AlchemyContext";
import type {
  CompiledStack,
  StackServices,
} from "alchemy/Stack";
import type { Stage } from "alchemy/Stage";
import * as Test from "alchemy/Test/Core";
import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resourceProviders } from "../providers.ts";
import type { Providers } from "../providers.ts";
import { fileState } from "./file-state.ts";
import { fastWait, protocolClientLayer } from "./harness.ts";

export const protocolMakeOptions = (
  host: string,
  directory: string,
) => ({
  providers: resourceProviders({
    wait: fastWait,
    createRecoveryWait: fastWait,
    deleteDependencyWait: fastWait,
    deleteRequestWait: fastWait,
  }).pipe(Layer.provide(protocolClientLayer(host))),
  state: fileState(directory),
  stage: "test-protocol",
  sidecar: false,
  dev: false,
});

export const protocolStack = <A>(
  name: string,
  options: ReturnType<typeof protocolMakeOptions>,
  effect: Effect.Effect<A, ConfigError, Providers | StackServices>,
) => {
  if (options.providers === undefined || options.state === undefined) {
    throw new Error("Protocol stack tests require providers and file state");
  }
  return Stack(name, {
    providers: options.providers,
    state: options.state,
  }, effect);
};

export const deployProtocol = <A>(
  options: ReturnType<typeof protocolMakeOptions>,
  stack: Test.TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
) => Test.run(Test.deploy(options, stack), options);

export const destroyProtocol = (
  options: ReturnType<typeof protocolMakeOptions>,
  stack: Test.TestEffect<CompiledStack, Stage | AlchemyContext>,
) => Test.run(Test.destroy(options, stack), options);
