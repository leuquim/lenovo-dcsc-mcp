# Development and verification

Read [current context](.docs/context.md) before changing behavior. It links the original requirements, current finding audit, remaining coverage limitations and local evidence locations.

## Local checks

Use Node 24 (`nvm use` if installed); Node 22 is also covered by CI.

```bash
npm ci
npm run check
```

Unit tests and offline contracts use committed fixtures and isolated temporary configuration. `smoke:stdio` starts the built server from a different working directory and calls only tool discovery and health. It requires no Lenovo account or network access. These checks do not establish live website parity.

## Live and browser checks

Run affected gates deliberately; Lenovo's catalog, validation and availability change independently of this repository.

```bash
npm run contract:live -- all
npx tsx scripts/conformance.ts
npx playwright install chromium
npm run parity -- all
```

All browser tests must be headless. CI runs offline checks only, avoiding uncontrolled upstream traffic and transient availability failures. Use the maintained `npm run parity -- <case>` cases for affected workflows, and `npm run parity -- all` serially before a release. Selected gates exit 2 when an upstream capability is unavailable; report that as blocked, never passed. Scoped native limitations are listed in the README and [current context](.docs/context.md).

`scripts/recon/` contains historical experiments, some dependent on private local captures. It is intentionally excluded from maintained lint/typecheck. Raw `artifacts/` and old `/tmp/` evidence references describe the original development environment; they are not required to run local checks from a fresh clone.

## Package checks

The supported distribution is an authenticated clone followed by `npm ci` and `npm run build`. `npm pack` builds a self-contained executable package containing compiled runtime code and client documentation. It excludes raw captures, tests, local settings and development dependencies. The package is marked private to prevent accidental npm registry publication.

```bash
npm pack
# Install the resulting .tgz into an isolated directory to test production dependencies:
npm install --prefix /absolute/path/to/test-install --omit=dev /absolute/path/to/lenovo-dcsc-mcp-0.1.0.tgz
npm run smoke:stdio -- /absolute/path/to/test-install/node_modules/lenovo-dcsc-mcp/dist/mcp/server.js
```

The MCP executable is `dist/mcp/server.js`; this package does not advertise a JavaScript library entry point. Protocol traffic goes to stdout; logs go to stderr. Avoid an npm wrapper in a client's stdio command, because wrapper output can corrupt protocol traffic.

## Data and changes

Keep exported designs, sessions, browser traces, cookies, credentials and local client configuration out of commits. Test fixtures must contain anonymous or synthetic data and the minimum fields needed for their regression. Preserve the distinction between native DCSC state and local planning metadata. Keep unknown upstream values explicit.

Run appropriate focused tests and affected live parity checks for behavior changes. Update [.docs/website-actions.md](.docs/website-actions.md) when the website's behaviour or evidence changes; do not claim full parity while a required gate remains unmet. Open pull requests against `main`; GitHub CI checks Node 22 and 24 and production-package startup.
