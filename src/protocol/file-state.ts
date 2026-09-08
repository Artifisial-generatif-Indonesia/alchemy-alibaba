import { decodeFqn, encodeFqn } from "alchemy/FQN";
import {
  encodeState,
  reviveState,
} from "alchemy/State/StateEncoding";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import {
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "alchemy/State/State";
import type { ReplacedResourceState, ResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const fail = (error: unknown) =>
  new StateStoreError({
    message: error instanceof Error ? error.message : "file state failed",
    cause: error instanceof Error ? error : undefined,
  });

const parseState = (contents: string): PersistedState | undefined =>
  contents.trim().length === 0
    ? undefined
    : (JSON.parse(contents, reviveState) as PersistedState);

export const makeFileStateService = (root: string): StateService => {
  const stageDir = ({ stack, stage }: { stack: string; stage: string }) =>
    path.join(root, stack, stage);
  const resourceFile = (request: {
    stack: string;
    stage: string;
    fqn: string;
  }) => path.join(stageDir(request), `${encodeFqn(request.fqn)}.json`);
  const outputFile = (request: { stack: string; stage: string }) =>
    path.join(stageDir(request), "__stack_output__.json");

  const writeAtomic = (file: string, contents: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
  };

  const listJson = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter(
        (file) => file.endsWith(".json") && file !== "__stack_output__.json",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const service: StateService = {
    id: "temp-file",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    listStacks: () =>
      Effect.try({
        try: () => {
          try {
            return readdirSync(root);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        },
        catch: fail,
      }),
    listStages: (stack) =>
      Effect.try({
        try: () => {
          try {
            return readdirSync(path.join(root, stack));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        },
        catch: fail,
      }),
    get: (request) =>
      Effect.try({
        try: () => {
          try {
            return parseState(readFileSync(resourceFile(request), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return undefined;
            }
            throw error;
          }
        },
        catch: fail,
      }),
    getReplacedResources: (request) =>
      Effect.try({
        try: () =>
          listJson(stageDir(request))
            .map((file) =>
              parseState(
                readFileSync(path.join(stageDir(request), file), "utf8"),
              ),
            )
            .filter(
              (state): state is ReplacedResourceState =>
                state !== undefined &&
                (state as ResourceState).status === "replaced",
            ),
        catch: fail,
      }),
    set: (request) =>
      Effect.try({
        try: () => {
          writeAtomic(
            resourceFile(request),
            JSON.stringify(encodeState(request.value), null, 2),
          );
          return request.value;
        },
        catch: fail,
      }),
    delete: (request) =>
      Effect.try({
        try: () => {
          try {
            rmSync(resourceFile(request));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
        catch: fail,
      }),
    deleteStack: ({ stack, stage }) =>
      Effect.try({
        try: () => {
          const dir =
            stage === undefined ? path.join(root, stack) : stageDir({ stack, stage });
          rmSync(dir, { recursive: true, force: true });
        },
        catch: fail,
      }),
    list: (request) =>
      Effect.try({
        try: () =>
          listJson(stageDir(request)).map((file) =>
            decodeFqn(file.replace(/\.json$/, "")),
          ),
        catch: fail,
      }),
    getOutput: (request) =>
      Effect.try({
        try: () => {
          try {
            return parseState(readFileSync(outputFile(request), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return undefined;
            }
            throw error;
          }
        },
        catch: fail,
      }),
    setOutput: (request) =>
      Effect.try({
        try: () => {
          writeAtomic(
            outputFile(request),
            JSON.stringify(encodeState(request.value), null, 2),
          );
          return request.value;
        },
        catch: fail,
      }),
  };
  return service;
};

export const listPersistedFqns = (root: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry === "__stack_output__.json") continue;
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".json") && !entry.endsWith(".tmp")) {
        found.push(decodeFqn(entry.replace(/\.json$/, "")));
      }
    }
  };
  walk(root);
  return found;
};

export const fileState = (root: string) =>
  Layer.succeed(State, Effect.succeed(makeFileStateService(root)));
