import type { PolicyDocument } from "../ram/internal.ts";

/** Trust one service account using ACK's existing RRSA OIDC provider. */
export const rrsaTrustPolicy = (options: {
  readonly oidcProviderArn: string;
  readonly issuer: string;
  readonly namespace: string;
  readonly serviceAccount: string;
}): PolicyDocument => ({
  Version: "1",
  Statement: [
    {
      Effect: "Allow",
      Action: "sts:AssumeRoleWithOIDC",
      Principal: { Federated: [options.oidcProviderArn] },
      Condition: {
        StringEquals: {
          "oidc:iss": options.issuer,
          "oidc:aud": "sts.aliyuncs.com",
          "oidc:sub": `system:serviceaccount:${options.namespace}:${options.serviceAccount}`,
        },
      },
    },
  ],
});

/** Requires the ACK pod-identity webhook addon and namespace injection label. */
export const rrsaServiceAccountAnnotations = (roleName: string) => ({
  "pod-identity.alibabacloud.com/role-name": roleName,
});
