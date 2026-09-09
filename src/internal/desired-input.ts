import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AlibabaInvariantError } from "../error.ts";

const DesiredInput = Schema.Struct({
  create: Schema.optional(Schema.Never),
  modify: Schema.optional(Schema.Never),
  spec: Schema.optional(Schema.Never),
  upgrade: Schema.optional(Schema.Never),
});

/** Reject request-phase bags instead of silently ignoring their settings. */
export const validateDesiredInput = Effect.fn("Alibaba.validateDesiredInput")(
  function* (props: unknown, resourceType: string) {
    yield* Schema.decodeUnknownEffect(DesiredInput)(props).pipe(
      Effect.mapError(
        () =>
          new AlibabaInvariantError({
            resourceType,
            operation: "ValidateInput",
            message:
              "Use desired properties directly on the resource; create, modify, spec and upgrade request bags are not supported",
          }),
      ),
    );
  },
);
