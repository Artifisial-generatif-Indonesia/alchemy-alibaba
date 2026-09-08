import ACRClient, * as ACR from "@alicloud/cr20181201";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { AlibabaClients } from "../clients.ts";
import {
  alchemyTestRuntime,
  resourceBase,
  testClientSet,
  testConfig,
} from "../test-support.ts";
import {
  EndpointAclEntry,
  EndpointAclEntryProvider,
} from "./endpoint-acl-entry.ts";
import {
  InstanceReference,
  InstanceReferenceProvider,
} from "./instance-reference.ts";
import { Namespace, NamespaceProvider } from "./namespace.ts";
import { Repository, RepositoryProvider } from "./repository.ts";
import {
  VpcEndpointLink,
  VpcEndpointLinkProvider,
} from "./vpc-endpoint-link.ts";

class StatefulACRClient extends ACRClient {
  instance = new ACR.GetInstanceResponseBody({
    instanceId: "cri-test",
    instanceName: "shared-acr",
    instanceStatus: "RUNNING",
  });
  namespace: ACR.GetNamespaceResponseBody | undefined;
  repository: ACR.GetRepositoryResponseBody | undefined;
  aclEntries: ACR.GetInstanceEndpointResponseBodyAclEntries[] = [];
  linkedVpcs: ACR.GetInstanceVpcEndpointResponseBodyLinkedVpcs[] = [];
  namespaceCreates = 0;
  namespaceReads = 0;
  namespaceUpdates = 0;
  repositoryCreates = 0;
  repositoryUpdates = 0;
  aclCreates = 0;
  aclDeletes = 0;
  vpcCreates = 0;
  vpcDeletes = 0;

  constructor() {
    super(testConfig());
  }

  override async getInstance(
    request: ACR.GetInstanceRequest,
  ): Promise<ACR.GetInstanceResponse> {
    return request.instanceId === this.instance.instanceId
      ? new ACR.GetInstanceResponse({ statusCode: 200, body: this.instance })
      : new ACR.GetInstanceResponse({ statusCode: 404 });
  }

  override async getNamespace(
    request: ACR.GetNamespaceRequest,
  ): Promise<ACR.GetNamespaceResponse> {
    this.namespaceReads += 1;
    return this.namespace?.instanceId === request.instanceId &&
      this.namespace?.namespaceName === request.namespaceName
      ? new ACR.GetNamespaceResponse({ statusCode: 200, body: this.namespace })
      : new ACR.GetNamespaceResponse({ statusCode: 404 });
  }

  override async createNamespace(
    request: ACR.CreateNamespaceRequest,
  ): Promise<ACR.CreateNamespaceResponse> {
    this.namespaceCreates += 1;
    this.namespace = new ACR.GetNamespaceResponseBody({
      instanceId: request.instanceId,
      namespaceId: "crn-test",
      namespaceName: request.namespaceName,
      namespaceStatus: "NORMAL",
      autoCreateRepo: request.autoCreateRepo,
      defaultRepoType: request.defaultRepoType,
      defaultRepoConfiguration: request.defaultRepoConfiguration,
    });
    return new ACR.CreateNamespaceResponse({ statusCode: 200 });
  }

  override async updateNamespace(
    request: ACR.UpdateNamespaceRequest,
  ): Promise<ACR.UpdateNamespaceResponse> {
    this.namespaceUpdates += 1;
    this.namespace = new ACR.GetNamespaceResponseBody({
      ...this.namespace,
      instanceId: request.instanceId,
      namespaceName: request.namespaceName,
      namespaceStatus: "NORMAL",
      autoCreateRepo: request.autoCreateRepo,
      defaultRepoType: request.defaultRepoType,
      defaultRepoConfiguration: request.defaultRepoConfiguration,
    });
    return new ACR.UpdateNamespaceResponse({ statusCode: 200 });
  }

  override async deleteNamespace(
    _request: ACR.DeleteNamespaceRequest,
  ): Promise<ACR.DeleteNamespaceResponse> {
    this.namespace = undefined;
    return new ACR.DeleteNamespaceResponse({ statusCode: 200 });
  }

  override async getRepository(
    request: ACR.GetRepositoryRequest,
  ): Promise<ACR.GetRepositoryResponse> {
    return this.repository?.instanceId === request.instanceId &&
      this.repository?.repoNamespaceName === request.repoNamespaceName &&
      this.repository?.repoName === request.repoName
      ? new ACR.GetRepositoryResponse({ statusCode: 200, body: this.repository })
      : new ACR.GetRepositoryResponse({ statusCode: 404 });
  }

  override async createRepository(
    request: ACR.CreateRepositoryRequest,
  ): Promise<ACR.CreateRepositoryResponse> {
    this.repositoryCreates += 1;
    this.repository = new ACR.GetRepositoryResponseBody({
      instanceId: request.instanceId,
      repoId: "crr-test",
      repoNamespaceName: request.repoNamespaceName,
      repoName: request.repoName,
      repoStatus: "NORMAL",
      repoType: request.repoType,
      summary: request.summary,
      detail: request.detail,
      tagImmutability: request.tagImmutability,
    });
    return new ACR.CreateRepositoryResponse({ statusCode: 200 });
  }

  override async updateRepository(
    request: ACR.UpdateRepositoryRequest,
  ): Promise<ACR.UpdateRepositoryResponse> {
    this.repositoryUpdates += 1;
    this.repository = new ACR.GetRepositoryResponseBody({
      ...this.repository,
      instanceId: request.instanceId,
      repoId: request.repoId,
      repoNamespaceName: request.repoNamespaceName,
      repoName: request.repoName,
      repoStatus: "NORMAL",
      repoType: request.repoType,
      summary: request.summary,
      detail: request.detail,
      tagImmutability: request.tagImmutability,
    });
    return new ACR.UpdateRepositoryResponse({ statusCode: 200 });
  }

  override async deleteRepository(
    _request: ACR.DeleteRepositoryRequest,
  ): Promise<ACR.DeleteRepositoryResponse> {
    this.repository = undefined;
    return new ACR.DeleteRepositoryResponse({ statusCode: 200 });
  }

  override async getInstanceEndpoint(
    _request: ACR.GetInstanceEndpointRequest,
  ): Promise<ACR.GetInstanceEndpointResponse> {
    return new ACR.GetInstanceEndpointResponse({
      statusCode: 200,
      body: new ACR.GetInstanceEndpointResponseBody({
        enable: true,
        aclEnable: true,
        status: "RUNNING",
        aclEntries: this.aclEntries,
      }),
    });
  }

  override async createInstanceEndpointAclPolicy(
    request: ACR.CreateInstanceEndpointAclPolicyRequest,
  ): Promise<ACR.CreateInstanceEndpointAclPolicyResponse> {
    this.aclCreates += 1;
    this.aclEntries = (request.entries ?? []).map(
      (entry) =>
        new ACR.GetInstanceEndpointResponseBodyAclEntries({
          entry: entry.entry,
          comment: entry.comment,
        }),
    );
    return new ACR.CreateInstanceEndpointAclPolicyResponse({ statusCode: 200 });
  }

  override async deleteInstanceEndpointAclPolicy(
    request: ACR.DeleteInstanceEndpointAclPolicyRequest,
  ): Promise<ACR.DeleteInstanceEndpointAclPolicyResponse> {
    this.aclDeletes += 1;
    const removed = new Set((request.entries ?? []).map((entry) => entry.entry));
    this.aclEntries = this.aclEntries.filter(
      (entry) => entry.entry === undefined || !removed.has(entry.entry),
    );
    return new ACR.DeleteInstanceEndpointAclPolicyResponse({ statusCode: 200 });
  }

  override async getInstanceVpcEndpoint(
    _request: ACR.GetInstanceVpcEndpointRequest,
  ): Promise<ACR.GetInstanceVpcEndpointResponse> {
    return new ACR.GetInstanceVpcEndpointResponse({
      statusCode: 200,
      body: new ACR.GetInstanceVpcEndpointResponseBody({
        linkedVpcs: this.linkedVpcs,
        domains: ["registry-vpc.example.test"],
      }),
    });
  }

  override async createInstanceVpcEndpointLinkedVpc(
    request: ACR.CreateInstanceVpcEndpointLinkedVpcRequest,
  ): Promise<ACR.CreateInstanceVpcEndpointLinkedVpcResponse> {
    this.vpcCreates += 1;
    this.linkedVpcs = [
      new ACR.GetInstanceVpcEndpointResponseBodyLinkedVpcs({
        vpcId: request.vpcId,
        vswitchId: request.vswitchId,
        status: "RUNNING",
        defaultAccess: false,
        ip: "10.0.0.10",
      }),
    ];
    return new ACR.CreateInstanceVpcEndpointLinkedVpcResponse({ statusCode: 200 });
  }

  override async deleteInstanceVpcEndpointLinkedVpc(
    _request: ACR.DeleteInstanceVpcEndpointLinkedVpcRequest,
  ): Promise<ACR.DeleteInstanceVpcEndpointLinkedVpcResponse> {
    this.vpcDeletes += 1;
    this.linkedVpcs = [];
    return new ACR.DeleteInstanceVpcEndpointLinkedVpcResponse({ statusCode: 200 });
  }
}

describe("ACR provider lifecycles", () => {
  it("does not call ACR when an interrupted namespace has no parent identity", async () => {
    const fake = new StatefulACRClient();
    const layer = NamespaceProvider().pipe(
      Layer.provide(Layer.succeed(AlibabaClients, testClientSet({ acr: fake }))),
    );
    const program = Effect.gen(function* () {
      const provider = yield* Namespace.Provider;
      const read = provider.read;
      if (read === undefined) throw new Error("Namespace read is missing");
      return yield* read({
        ...resourceBase("interrupted-namespace"),
        olds: {} as never,
        output: undefined,
      });
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toBeUndefined();
    expect(fake.namespaceReads).toBe(0);
  });

  it("reads an existing paid ACR instance without owning its lifecycle", async () => {
    const fake = new StatefulACRClient();
    const layer = InstanceReferenceProvider().pipe(
      Layer.provide(
        Layer.succeed(AlibabaClients, testClientSet({ acr: fake })),
      ),
    );
    const base = resourceBase("acr-instance");
    const program = Effect.gen(function* () {
      const provider = yield* InstanceReference.Provider;
      const output = yield* provider.reconcile({
        ...base,
        news: { instanceId: "cri-test" },
        olds: undefined,
        output: undefined,
      });
      const read = provider.read;
      if (read === undefined) throw new Error("InstanceReference read is missing");
      const observed = yield* read({
        ...base,
        olds: { instanceId: "cri-test" },
        output,
      });
      yield* provider.delete({
        ...base,
        olds: { instanceId: "cri-test" },
        output,
      });
      return observed;
    });

    const observed = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(observed).toMatchObject({
      instanceId: "cri-test",
      instanceName: "shared-acr",
      status: "RUNNING",
    });
    expect(fake.instance.instanceId).toBe("cri-test");
  });

  it("creates, updates, observes, and deletes namespaces", async () => {
    const fake = new StatefulACRClient();
    const layer = NamespaceProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(Layer.succeed(AlibabaClients, testClientSet({ acr: fake }))),
    );
    const base = resourceBase("namespace");
    const initial = {
      instanceId: "cri-test",
      name: "example",
      settings: { autoCreateRepo: false, defaultRepoType: "PRIVATE" },
    };
    const changed = {
      ...initial,
      settings: { autoCreateRepo: true, defaultRepoType: "PRIVATE" },
    };
    const program = Effect.gen(function* () {
      const provider = yield* Namespace.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const unchanged = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: initial,
        output: created,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: unchanged,
      });
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({
      name: "example",
      autoCreateRepo: true,
    });
    expect(fake.namespaceCreates).toBe(1);
    expect(fake.namespaceUpdates).toBe(1);
    expect(fake.namespace).toBeUndefined();
  });

  it("creates, updates, observes, and deletes repositories", async () => {
    const fake = new StatefulACRClient();
    const layer = RepositoryProvider({ wait: { attempts: 2, interval: 0 } }).pipe(
      Layer.provide(Layer.succeed(AlibabaClients, testClientSet({ acr: fake }))),
    );
    const base = resourceBase("repository");
    const initial = {
      instanceId: "cri-test",
      namespaceName: "example",
      name: "api",
      settings: {
        repoType: "PRIVATE" as const,
        summary: "Example API",
        tagImmutability: false,
      },
    };
    const changed = {
      ...initial,
      settings: { ...initial.settings, tagImmutability: true },
    };
    const program = Effect.gen(function* () {
      const provider = yield* Repository.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const unchanged = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: initial,
        output: created,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: unchanged,
      });
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return updated;
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({
      repositoryId: "crr-test",
      tagImmutability: true,
    });
    expect(fake.repositoryCreates).toBe(1);
    expect(fake.repositoryUpdates).toBe(1);
    expect(fake.repository).toBeUndefined();
  });

  it("replaces changed ACL comments and normalizes default identity fields", async () => {
    const fake = new StatefulACRClient();
    const layer = EndpointAclEntryProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(
      Layer.provide(Layer.succeed(AlibabaClients, testClientSet({ acr: fake }))),
    );
    const base = resourceBase("acl");
    const initial = {
      instanceId: "cri-test",
      entry: "203.0.113.10/32",
      comment: "developer",
    };
    const changed = { ...initial, comment: "ci" };
    const program = Effect.gen(function* () {
      const provider = yield* EndpointAclEntry.Provider;
      const diff = provider.diff;
      if (diff === undefined) throw new Error("EndpointAclEntry diff is missing");
      const noDiff = yield* diff({
        ...base,
        olds: initial,
        news: { ...initial, endpointType: "Internet", moduleName: "Registry" },
        oldBindings: [],
        newBindings: [],
        output: undefined,
      });
      const created = yield* provider.reconcile({
        ...base,
        news: initial,
        olds: undefined,
        output: undefined,
      });
      const updated = yield* provider.reconcile({
        ...base,
        news: changed,
        olds: initial,
        output: created,
      });
      yield* provider.delete({ ...base, olds: changed, output: updated });
      return { noDiff, updated };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
    );
    expect(result.noDiff).toBeUndefined();
    expect(result.updated).toMatchObject({
      endpointType: "Internet",
      moduleName: "Registry",
      comment: "ci",
    });
    expect(fake.aclCreates).toBe(2);
    expect(fake.aclDeletes).toBe(2);
    expect(fake.aclEntries).toEqual([]);
  });

  it("creates, observes, and deletes VPC endpoint links", async () => {
    const fake = new StatefulACRClient();
    const layer = VpcEndpointLinkProvider({
      wait: { attempts: 2, interval: 0 },
    }).pipe(
      Layer.provide(Layer.succeed(AlibabaClients, testClientSet({ acr: fake }))),
    );
    const base = resourceBase("vpc-link");
    const props = {
      instanceId: "cri-test",
      vpcId: "vpc-test",
      vswitchId: "vsw-test",
    };
    const program = Effect.gen(function* () {
      const provider = yield* VpcEndpointLink.Provider;
      const created = yield* provider.reconcile({
        ...base,
        news: props,
        olds: undefined,
        output: undefined,
      });
      const unchanged = yield* provider.reconcile({
        ...base,
        news: props,
        olds: props,
        output: created,
      });
      yield* provider.delete({ ...base, olds: props, output: unchanged });
      return unchanged;
    });

    await expect(
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(alchemyTestRuntime)),
      ),
    ).resolves.toMatchObject({
      status: "RUNNING",
      moduleName: "Registry",
      ip: "10.0.0.10",
    });
    expect(fake.vpcCreates).toBe(1);
    expect(fake.vpcDeletes).toBe(1);
    expect(fake.linkedVpcs).toEqual([]);
  });
});
