#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { run } from "./cli.ts";

run.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
