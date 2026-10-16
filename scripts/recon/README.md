# Historical reconnaissance scripts

One-off browser probes, export bisects and import experiments are retained as development history. They are outside the maintained typecheck/lint and release surface; some require ignored local captures and are not reproducible from a fresh clone.

Use the maintained `contract:live`, `parity:*` and `release:checkpoint` scripts in `package.json` for current checks. Browser runs must be headless. Historical rack export failures are superseded by the verified October workflow.

See [current context](../../.docs/context.md) for remaining gates and the authoritative evidence locations.
