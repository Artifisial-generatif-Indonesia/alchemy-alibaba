import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import {
  Addon,
  AddonProvider,
  ManagedCluster,
  ManagedClusterProvider,
  NodePool,
  NodePoolProvider,
} from "./ack/index.ts";
import {
  EndpointAclEntry,
  EndpointAclEntryProvider,
  InstanceReference,
  InstanceReferenceProvider,
  Namespace,
  NamespaceProvider,
  Repository,
  RepositoryProvider,
  VpcEndpointLink,
  VpcEndpointLinkProvider,
} from "./acr/index.ts";
import {
  Account as TairAccount,
  AccountProvider as TairAccountProvider,
  Instance as TairInstance,
  InstanceProvider as TairInstanceProvider,
  SecurityIpGroup as TairSecurityIpGroup,
  SecurityIpGroupProvider as TairSecurityIpGroupProvider,
} from "./tair/index.ts";
import {
  Account as RDSAccount,
  AccountPrivilege as RDSAccountPrivilege,
  AccountPrivilegeProvider as RDSAccountPrivilegeProvider,
  AccountProvider as RDSAccountProvider,
  Database as RDSDatabase,
  DatabaseProvider as RDSDatabaseProvider,
  Instance as RDSInstance,
  InstanceProvider as RDSInstanceProvider,
  SecurityIpGroup as RDSSecurityIpGroup,
  SecurityIpGroupProvider as RDSSecurityIpGroupProvider,
} from "./rds/index.ts";
import {
  clients,
  clientsFromEnvironment,
  type AlibabaClientOptions,
} from "./clients.ts";
import type { WaitOptions } from "./internal/lifecycle.ts";
import {
  Network,
  NetworkProvider,
  VSwitch,
  VSwitchProvider,
} from "./vpc/index.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Alibaba",
) {}

export interface AlibabaProviderOptions {
  readonly wait?: WaitOptions;
  readonly createRecoveryWait?: WaitOptions;
  readonly deleteDependencyWait?: WaitOptions;
  readonly deleteRequestWait?: WaitOptions;
}

/** Resource providers with AlibabaClients left as an explicit requirement. */
export const resourceProviders = (options: AlibabaProviderOptions = {}) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Network,
      VSwitch,
      ManagedCluster,
      NodePool,
      Addon,
      InstanceReference,
      Namespace,
      Repository,
      EndpointAclEntry,
      VpcEndpointLink,
      TairInstance,
      TairAccount,
      TairSecurityIpGroup,
      RDSInstance,
      RDSDatabase,
      RDSAccount,
      RDSAccountPrivilege,
      RDSSecurityIpGroup,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        NetworkProvider({
          wait: options.wait,
          deleteDependencyWait: options.deleteDependencyWait,
        }),
        VSwitchProvider({
          wait: options.wait,
          deleteDependencyWait: options.deleteDependencyWait,
        }),
        ManagedClusterProvider({ wait: options.wait }),
        NodePoolProvider({ wait: options.wait }),
        AddonProvider({ wait: options.wait }),
        InstanceReferenceProvider(),
        NamespaceProvider({ wait: options.wait }),
        RepositoryProvider({ wait: options.wait }),
        EndpointAclEntryProvider({ wait: options.wait }),
        VpcEndpointLinkProvider({ wait: options.wait }),
        TairInstanceProvider({
          wait: options.wait,
          createRecoveryWait: options.createRecoveryWait,
        }),
        TairAccountProvider({ wait: options.wait }),
        TairSecurityIpGroupProvider({ wait: options.wait }),
        RDSInstanceProvider({
          wait: options.wait,
          createRecoveryWait: options.createRecoveryWait,
          deleteRequestWait: options.deleteRequestWait,
        }),
        RDSDatabaseProvider({ wait: options.wait }),
        RDSAccountProvider({ wait: options.wait }),
        RDSAccountPrivilegeProvider({ wait: options.wait }),
        RDSSecurityIpGroupProvider({ wait: options.wait }),
      ),
    ),
  );

export const providers = (
  clientOptions: AlibabaClientOptions,
  options: AlibabaProviderOptions = {},
) => resourceProviders(options).pipe(Layer.provide(clients(clientOptions)));

export const providersFromEnvironment = (
  options: AlibabaProviderOptions = {},
) =>
  resourceProviders(options).pipe(
    Layer.provide(clientsFromEnvironment()),
    Layer.orDie,
  );
