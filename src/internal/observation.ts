import * as Predicate from "effect/Predicate";
import { isDeepStrictEqual } from "node:util";

interface ModelDescriptor {
  types(): Record<string, unknown>;
}

/** Compare requested fields exposed by the pinned SDK read model, without prototypes. */
export const modelMatches = (
  observed: unknown,
  desired: unknown,
  model?: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    const itemType = Predicate.isObject(model) ? model.itemType : undefined;
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, index) =>
        modelMatches(observed[index], item, itemType),
      )
    );
  }
  if (Predicate.isObject(desired)) {
    const descriptor = model as ModelDescriptor | undefined;
    const fields =
      typeof descriptor?.types === "function" ? descriptor.types() : undefined;
    return Object.entries(desired).every(([key, value]) => {
      if (value === undefined || (fields !== undefined && !(key in fields)))
        return true;
      return modelMatches(
        Predicate.isObject(observed) ? observed[key] : undefined,
        value,
        fields?.[key],
      );
    });
  }
  return isDeepStrictEqual(observed, desired);
};

/** Config JSON is semantic: formatting and object-key order are not drift. */
export const jsonConfigMatches = (
  observed: string | undefined,
  desired: string | undefined,
): boolean => {
  if (desired === undefined) return true;
  if (observed === desired) return true;
  try {
    return (
      observed !== undefined &&
      isDeepStrictEqual(JSON.parse(observed), JSON.parse(desired))
    );
  } catch {
    return false;
  }
};
