import {
  Role,
  RoleProvider,
  Policy,
  PolicyProvider,
  RolePolicyAttachment,
  RolePolicyAttachmentProvider,
} from "./ram/index.ts";
import { KubernetesAdapter } from "./ack/kubeconfig.ts";
import { Secret, SecretProvider } from "./kubernetes/secret.ts";
import {
  Instance as ECSInstance,
  InstanceProvider as ECSInstanceProvider,
  SecurityGroup,
  SecurityGroupProvider,
  SecurityGroupIngress,
  SecurityGroupIngressProvider,
  SecurityGroupEgress,
  SecurityGroupEgressProvider,
  Disk,
  DiskProvider,
  DiskAttachment,
  DiskAttachmentProvider,
  KeyPair,
  KeyPairProvider,
} from "./ecs/index.ts";
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
  Eip,
  EipProvider,
  EipAssociation,
  EipAssociationProvider,
  NatGateway,
  NatGatewayProvider,
  SnatEntry,
  SnatEntryProvider,
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
  Layer.mergeAll(
    KubernetesAdapter,
    Layer.effect(
      Providers,
      Provider.collection([
        Secret,
        Role,
        Policy,
        RolePolicyAttachment,
        Eip,
        EipAssociation,
        NatGateway,
        SnatEntry,
        ECSInstance,
        Disk,
        DiskAttachment,
        KeyPair,
        SecurityGroup,
        SecurityGroupIngress,
        SecurityGroupEgress,
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
          SecretProvider(),
          RoleProvider({ wait: options.wait }),
          PolicyProvider({ wait: options.wait }),
          RolePolicyAttachmentProvider({ wait: options.wait }),
          EipProvider({ wait: options.wait }),
          EipAssociationProvider({ wait: options.wait }),
          NatGatewayProvider({ wait: options.wait }),
          SnatEntryProvider({ wait: options.wait }),
          ECSInstanceProvider({ wait: options.wait }),
          DiskProvider({ wait: options.wait }),
          DiskAttachmentProvider({ wait: options.wait }),
          KeyPairProvider({ wait: options.wait }),
          SecurityGroupProvider({ wait: options.wait }),
          SecurityGroupIngressProvider({ wait: options.wait }),
          SecurityGroupEgressProvider({ wait: options.wait }),
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
