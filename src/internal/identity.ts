import * as Effect from "effect/Effect";
import { hasAlchemyTags } from "alchemy/Tags";
import { AlibabaInvariantError } from "../error.ts";

export const requireRecoveryOwnership = Effect.fn(
  "Alibaba.requireRecoveryOwnership",
)(function* (id: string, resourceType: string, tags: Record<string, string>) {
  if (!(yield* hasAlchemyTags(id, tags)))
    return yield* new AlibabaInvariantError({
      resourceType,
      operation: "RecoverIdentity",
      message:
        "A matching name belongs to an unowned resource; adopt the identified resource explicitly before modifying it",
    });
});

/** Name searches are discovery, never permission to choose an arbitrary match. */
export const uniqueMatch = <T>(items: readonly T[], resourceType: string) =>
  items.length > 1
    ? Effect.fail(
        new AlibabaInvariantError({
          resourceType,
          operation: "ObserveIdentity",
          message:
            "Multiple resources match this name; resolve the inventory before continuing",
        }),
      )
    : Effect.succeed(items[0]);

/** A fixed name must not let a replacement adopt its outgoing generation. */
export const replacement = (
  resourceType: string,
  oldName?: string,
  newName?: string,
) =>
  newName !== undefined && oldName === newName
    ? Effect.fail(
        new AlibabaInvariantError({
          resourceType,
          operation: "PlanReplacement",
          message:
            "Immutable settings changed with the same explicit name. Choose a new name for the replacement, or explicitly destroy the old resource first.",
        }),
      )
    : Effect.succeed({ action: "replace" } as const);
