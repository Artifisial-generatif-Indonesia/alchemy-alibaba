import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { AlibabaInvariantError } from "../error.ts";
import type { ModelInput } from "./model-input.ts";

/** Keep SDK request structure while requiring redaction for nested bootstrap secrets. */
export type SecretInput<T> = T extends readonly (infer Item)[]
  ? SecretInput<Item>[]
  : T extends object
    ? {
        [K in keyof ModelInput<T>]: K extends "loginPassword" | "userData"
          ? Redacted.Redacted<string> | undefined
          : SecretInput<ModelInput<T>[K]>;
      }
    : T;

/** Unwrap only immediately before constructing an SDK request. Never echo inputs. */
export const sdkInput = <T>(input: SecretInput<T>, resourceType: string) =>
  Effect.try({
    try: () => {
      const visit = (value: unknown, key?: string): unknown => {
        if (value === undefined) return undefined;
        if (key === "loginPassword" || key === "userData") {
          if (!Redacted.isRedacted(value)) throw new Error("unredacted");
          return Redacted.value(value);
        }
        if (Array.isArray(value)) return value.map((item) => visit(item));
        if (Predicate.isObject(value))
          return Object.fromEntries(
            Object.entries(value).map(([key, value]) => [
              key,
              visit(value, key),
            ]),
          );
        return value;
      };
      return visit(input) as ModelInput<T>;
    },
    catch: () =>
      new AlibabaInvariantError({
        resourceType,
        operation: "ValidateSecrets",
        message: "ACK loginPassword and userData values must use Redacted.make",
      }),
  });
