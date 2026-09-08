# Preparing and publishing a release

Candidate: `alchemy-alibaba@0.2.0`, npm channel `latest`, GitHub tag
`v0.2.0`. The notes are in [CHANGELOG.md](CHANGELOG.md). The existing
`v0.1.0` tag must not be moved.

## Preparation (no publication)

Use Node 22.22.1 and npm 11.19.1, then run from the repository root:

```sh
npx --yes npm@11.19.1 ci
npx --yes npm@11.19.1 run release:prepare
```

This runs type checking, the local test suite, build, and the repository security
audit. It then rebuilds into an empty `dist`, packs the exact npm artifact,
checks its complete file list and exports, and installs that tarball in a
fresh temporary consumer with the required peers and overrides. All public
imports, consumer TypeScript usage, and the consumer audit must pass.

The package step can also run as `npm run check:package` after the source checks.
CI runs it after the source/security gates. All SDK tests use loopback;
preparation contacts npm for installation/auditing but performs no cloud operations.

Outputs under the gitignored `artifacts/0.2.0/` directory:

- `alchemy-alibaba-0.2.0.tgz`: the validated package to publish.
- `SHA256SUMS`: the tarball's SHA-256 digest.
- `verification.json`: package identity, npm integrity, import/type/audit results,
  required peers and consumer overrides.
- `release-notes.md`: the prepared GitHub release notes.

Commit the reviewed source and release metadata. Before publication, verify the
release commit's CI result and prepare its artifact from that clean checkout.
Local preparation does not establish npm package-name ownership or publishing
access. Confirm those with the intended publisher before the first publication.

## Publication (separate explicit authorization)

The following steps change external services. They are not run by preparation
or CI. Authenticate using the publisher's supported npm login/2FA flow; never
commit a token or pass one in a command argument.

Verify the digest from the artifact directory:

```sh
cd artifacts/0.2.0
sha256sum --check SHA256SUMS
```

Publish the verified tarball, explicitly selecting the release channel:

```sh
npx --yes npm@11.19.1 publish ./alchemy-alibaba-0.2.0.tgz --tag latest --access public --registry=https://registry.npmjs.org/
```

The package also sets `publishConfig.tag` to `latest`.
If publication returns an ambiguous error, first check the registry
for this exact version and compare `dist.integrity` with `verification.json`;
do not blindly republish or change the version to bypass an uncertain outcome.

After npm publication is confirmed, from the clean repository root:

```sh
git tag -a v0.2.0 -m "alchemy-alibaba 0.2.0"
git push origin HEAD:main
git push origin v0.2.0
gh release create v0.2.0 --verify-tag --title "0.2.0" --notes-file CHANGELOG.md artifacts/0.2.0/alchemy-alibaba-0.2.0.tgz artifacts/0.2.0/SHA256SUMS artifacts/0.2.0/verification.json
```

If the repository requires a PR, merge it and prepare the artifact at that
reviewed commit before tagging. Confirm that the new tag resolves to that commit.
Never force-push a release tag. After a partial publication, complete only the
missing step; do not delete/recreate a published version or an existing tag.

Finally, verify the npm `latest` tag and integrity, install the registry version
in a fresh consumer using the README overrides, and confirm the GitHub release
is a normal release. Record the final version, commit, integrity, and URLs.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
and [publishConfig](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#publishconfig).
