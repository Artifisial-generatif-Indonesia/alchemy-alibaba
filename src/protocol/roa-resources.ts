import type { ProtocolResponse, RpcParams } from "./world.ts";

type Body = Record<string, unknown>;
export type RoaBody = Body | Body[];
const ok = (body: Body = {}): ProtocolResponse => ({ statusCode: 200, body });
const error = (code: string, statusCode = 400): ProtocolResponse => ({
  statusCode,
  body: { code, message: code, request_id: "protocol-roa-request" },
});
interface Pool {
  nodepool_info: Body;
  scaling_group: Body;
  status: { state: string };
  kubernetes_config?: Body;
}
interface Addon {
  name: string;
  version: string;
  config?: string;
  state: string;
}
interface Task {
  reads: number;
  finish: () => void;
  fail: boolean;
}

/** ACK fixtures use its documented snake_case ROA JSON, including top-level arrays. */
export class RoaResources {
  readonly pools = new Map<string, Pool>();
  readonly addons = new Map<string, Addon>();
  readonly tasks = new Map<string, Task>();
  readonly requests: {
    method: string;
    path: string;
    body: RoaBody;
    query: RpcParams;
  }[] = [];
  failNextTask = false;
  private sequence = 0;

  task(finish: () => void, fields: Body = {}): ProtocolResponse {
    const id = `task-child-${++this.sequence}`;
    this.tasks.set(id, { reads: 0, finish, fail: this.failNextTask });
    this.failNextTask = false;
    return ok({ task_id: id, ...fields });
  }

  dispatch(
    method: string,
    path: string,
    body: RoaBody,
    query: RpcParams,
  ): ProtocolResponse | undefined {
    const taskMatch = path.match(/^\/tasks\/(task-child-[^/]+)$/);
    if (taskMatch && method === "GET") {
      const task = this.tasks.get(taskMatch[1]);
      if (!task) return error("Task.NotFound", 404);
      task.reads++;
      if (task.fail) return ok({ task_id: taskMatch[1], state: "failed" });
      if (task.reads === 2) task.finish();
      return ok({
        task_id: taskMatch[1],
        state: task.reads < 2 ? "running" : "success",
      });
    }
    const poolMatch = path.match(
      /^\/clusters\/([^/]+)\/nodepools(?:\/([^/]+))?$/,
    );
    const componentMatch = path.match(
      /^\/clusters\/([^/]+)\/components\/([^/]+)(?:\/(instance|config))?$/,
    );
    if (!poolMatch && !componentMatch) return undefined;
    this.requests.push({
      method,
      path,
      body: structuredClone(body),
      query: { ...query },
    });
    if (poolMatch) {
      if (Array.isArray(body)) return error("InvalidBody");
      const [, cluster, id] = poolMatch;
      const key = `${cluster}/${id}`;
      const pool = this.pools.get(key);
      if (!id && method === "GET")
        return ok({
          nodepools: [...this.pools]
            .filter(
              ([k, v]) =>
                k.startsWith(`${cluster}/`) &&
                (!query.NodepoolName ||
                  v.nodepool_info.name === query.NodepoolName),
            )
            .map(([, v]) => v),
        });
      if (!id && method === "POST") {
        const info = body.nodepool_info as Body | undefined;
        const scaling = body.scaling_group as Body | undefined;
        if (
          !info?.name ||
          !Array.isArray(scaling?.instance_types) ||
          !Array.isArray(scaling?.vswitch_ids)
        )
          return error("MissingParameter");
        const nodepoolId = `np-child-${++this.sequence}`;
        const row: Pool = {
          nodepool_info: {
            ...info,
            nodepool_id: nodepoolId,
            region_id: "ap-southeast-5",
          },
          scaling_group: { ...scaling, scaling_group_id: "asg-child" },
          kubernetes_config: body.kubernetes_config as Body | undefined,
          status: { state: "creating" },
        };
        this.pools.set(`${cluster}/${nodepoolId}`, row);
        return this.task(
          () => {
            row.status.state = "active";
          },
          { nodepool_id: nodepoolId },
        );
      }
      if (!pool) return error("ErrorNodePoolNotFound", 404);
      if (method === "GET") return ok({ ...pool });
      if (method === "PUT") {
        pool.status.state = "updating";
        return this.task(() => {
          Object.assign(pool.scaling_group, body.scaling_group);
          Object.assign(pool.nodepool_info, body.nodepool_info);
          if (body.kubernetes_config)
            pool.kubernetes_config = body.kubernetes_config as Body;
          pool.status.state = "active";
        });
      }
      if (method === "DELETE") {
        pool.status.state = "deleting";
        return this.task(() => {
          this.pools.delete(key);
        });
      }
      return error("InvalidMethod");
    }
    const [, cluster, name, operation] = componentMatch!;
    const key = `${cluster}/${decodeURIComponent(name!)}`;
    const addon = this.addons.get(key);
    if (operation === "instance" && method === "GET")
      return addon ? ok({ ...addon }) : error("Addon.NotFound", 404);
    if (operation === "config" && method === "POST" && !Array.isArray(body)) {
      if (!addon) return error("Addon.NotFound", 404);
      addon.config = body.config as string;
      return ok();
    }
    if (method !== "POST") return error("InvalidMethod");
    if (name === "install" || name === "upgrade") {
      if (!Array.isArray(body) || body.length !== 1)
        return error("InvalidArrayBody");
      const item = body[0]!;
      const addonName = String(
        item[name === "install" ? "name" : "component_name"] ?? "",
      );
      const version = String(
        item[name === "install" ? "version" : "next_version"] ?? "",
      );
      if (!addonName || !version) return error("MissingParameter");
      const row: Addon = {
        name: addonName,
        version,
        config: item.config as string | undefined,
        state: "installing",
      };
      this.addons.set(`${cluster}/${addonName}`, row);
      return this.task(() => {
        row.state = "active";
      });
    }
    if (name === "uninstall" && Array.isArray(body) && body.length === 1) {
      const item = body[0]!;
      const target = `${cluster}/${item.name}`;
      const row = this.addons.get(target);
      if (!row) return error("Addon.NotFound", 404);
      row.state = "uninstalling";
      return this.task(() => {
        this.addons.delete(target);
      });
    }
    return error("InvalidAction");
  }
}
