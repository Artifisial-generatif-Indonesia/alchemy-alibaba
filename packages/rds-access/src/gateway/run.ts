import { Effect, Layer, Option, Redacted } from "effect";
import { AccessError } from "../model.ts";
import { GatewayApi } from "./alibaba.ts";
import type {
  GatewayOnboardingInput,
  GatewayOnboardingPlan,
  GatewayOnboardingResult,
} from "./model.ts";
import {
  applyGatewayOnboarding,
  planGatewayOnboarding,
  type OnboardingOptions,
} from "./onboard.ts";
import { ensurePasswordFile, readPasswordFile } from "./secret-file.ts";
import { Postgres } from "./sql-runner.ts";

/** Layers a caller must supply; both can be built without importing Effect. */
export interface GatewayOnboardingLayers {
  readonly gateway: Layer.Layer<GatewayApi, AccessError, never>;
  readonly postgres: Layer.Layer<Postgres, never, never>;
}

const provide = <A>(
  effect: Effect.Effect<A, AccessError, GatewayApi | Postgres>,
  layers: GatewayOnboardingLayers,
) => effect.pipe(Effect.provide(layers.gateway), Effect.provide(layers.postgres));

/** Promise wrapper for callers that do not use Effect directly. */
export const runGatewayPlan = (
  input: GatewayOnboardingInput,
  options: OnboardingOptions,
  layers: GatewayOnboardingLayers,
): Promise<GatewayOnboardingPlan> =>
  Effect.runPromise(provide(planGatewayOnboarding(input, options), layers));

/** Promise wrapper for callers that do not use Effect directly. */
export const runGatewayApply = (
  input: GatewayOnboardingInput,
  options: OnboardingOptions,
  layers: GatewayOnboardingLayers,
): Promise<GatewayOnboardingResult> =>
  Effect.runPromise(provide(applyGatewayOnboarding(input, options), layers));

export const readPasswordFileAsync = (
  path: string,
): Promise<Redacted.Redacted<string> | undefined> =>
  Effect.runPromise(
    readPasswordFile(path).pipe(
      Effect.map((value) => (Option.isSome(value) ? value.value : undefined)),
    ),
  );

export const ensurePasswordFileAsync = (
  path: string,
  generate: () => string,
): Promise<Redacted.Redacted<string>> =>
  Effect.runPromise(ensurePasswordFile(path, generate));
