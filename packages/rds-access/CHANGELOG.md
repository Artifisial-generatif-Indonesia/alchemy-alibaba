# alibaba-rds-access changelog

## 0.1.1 (unreleased)

- Make Alibaba API failures diagnosable. `AccessError` now keeps Alibaba's
  sanitized error message, the RequestId and, for permission errors, the
  AccessDeniedDetail `AuthAction`, `NoPermissionType` and `PolicyType`.
  Messages are single-line, bounded to 300 characters, and redact
  credential-like values; `EncodedDiagnosticMessage` is never retained.
- Name the identity on `Forbidden*`/`NoPermission*` failures: the profile and
  whether it came from `--profile` or `ALIBABA_CLOUD_PROFILE`, or the SDK default
  credential chain. A best-effort `sts:GetCallerIdentity` lookup (five-second
  limit, never masks the original error) adds the RAM user or role name. The
  message then states the missing action and the instance.
- `plan` prints the credentials it ran as, and `plan --json` includes
  `credentials` and `caller`, so a read-only profile is visible before
  `refresh`.
- Add `describeCredentials` and the `CredentialSource` type to the API, and an
  optional `credentials` option on `rdsApiLayer`.
- Add the `@alicloud/sts20150401` dependency for the caller lookup.

RDS requests are unchanged.

## 0.1.0

- Initial release: `plan`, `refresh` and `revoke` for a per-developer RDS IP
  allowlist group.
