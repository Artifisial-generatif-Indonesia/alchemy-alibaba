import * as RAM from "@alicloud/ram20150501";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { AlibabaClients } from "../clients.ts";
import { isNotFound, retryingSdkCall } from "../error.ts";
import { waitFor, type WaitOptions } from "../internal/lifecycle.ts";
import type { Providers } from "../providers.ts";

export interface RolePolicyAttachmentProps {
  readonly roleName: string;
  readonly policyName: string;
  readonly policyType?: "Custom" | "System";
}
export type RolePolicyAttachment = Resource<
  "Alibaba.RAM.RolePolicyAttachment",
  RolePolicyAttachmentProps,
  Required<RolePolicyAttachmentProps>,
  never,
  Providers
>;
export const RolePolicyAttachment = Resource<RolePolicyAttachment>(
  "Alibaba.RAM.RolePolicyAttachment",
);
export const RolePolicyAttachmentProvider = (
  options: { readonly wait?: WaitOptions } = {},
) =>
  Provider.effect(
    RolePolicyAttachment,
    Effect.gen(function* () {
      const clients = yield* AlibabaClients;
      const normalize = (props: RolePolicyAttachmentProps) => ({
        ...props,
        policyType: props.policyType ?? "Custom",
      });
      const exists = (props: RolePolicyAttachmentProps) =>
        retryingSdkCall("RAM", "ListPoliciesForRole", () =>
          clients.ram.listPoliciesForRole(
            new RAM.ListPoliciesForRoleRequest({ roleName: props.roleName }),
          ),
        ).pipe(
          Effect.map(
            (r) =>
              r.body?.policies?.policy?.some(
                (p) =>
                  p.policyName === props.policyName &&
                  p.policyType === (props.policyType ?? "Custom"),
              ) ?? false,
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(false)),
        );
      return {
        version: 1,
        stables: ["roleName", "policyName", "policyType"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds.roleName !== news.roleName ||
            olds.policyName !== news.policyName ||
            (olds.policyType ?? "Custom") !== (news.policyType ?? "Custom")
          )
            return { action: "replace" };
          if (!(yield* exists(news))) return { action: "update" };
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = output ?? olds;
          return (yield* exists(props)) ? normalize(props) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          if (!(yield* exists(news)))
            yield* retryingSdkCall("RAM", "AttachPolicyToRole", () =>
              clients.ram.attachPolicyToRole(
                new RAM.AttachPolicyToRoleRequest(normalize(news)),
              ),
            );
          yield* waitFor({
            service: "RAM",
            operation: "AttachPolicyToRole",
            read: exists(news),
            ready: (v) => v,
            wait: options.wait,
          });
          return normalize(news);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!(yield* exists(output))) return;
          yield* retryingSdkCall("RAM", "DetachPolicyFromRole", () =>
            clients.ram.detachPolicyFromRole(
              new RAM.DetachPolicyFromRoleRequest(output),
            ),
          ).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* waitFor({
            service: "RAM",
            operation: "DetachPolicyFromRole",
            read: exists(output),
            ready: (v) => !v,
            wait: options.wait,
          });
        }),
      };
    }),
  );
