# Alibaba provider development

Use Node 22 and pnpm. Run `pnpm install --frozen-lockfile` and `pnpm run check`.
Keep resource type names, physical naming, ownership tags and lifecycle semantics stable.
Tests use SDK fakes and loopback simulation. Do not run connected cloud operations without explicit approval.
Never commit credentials, state, customer data or project-specific account configuration.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
