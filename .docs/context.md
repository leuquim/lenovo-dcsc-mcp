# Current project context

Updated 2026-10-16. Start here when resuming work. This is the canonical current-state handoff; historical logs are supporting evidence.

## Product and delivery state

This is a local stdio MCP server for anonymous Lenovo DCSC workflows, with 72 registered tools. It uses Lenovo's same-origin API and rules engine. Prices are anonymous list prices, not partner quotes. Account saves, partner pricing and authenticated workflows are outside the verified scope.

The parity implementation and final frozen verification are finished for the implemented scope, but full website parity is **not complete**. The implementation goal is **blocked**, not achieved. Sharing the usable MCP with colleagues does not close its remaining parity gates.

The private distribution home is [leuquim/lenovo-dcsc-mcp](https://github.com/leuquim/lenovo-dcsc-mcp). Repository creation and pushing the MCP were explicitly authorized. Use the [client setup guide](../docs/client-setup.md) for Claude Code, Claude Desktop and Codex, and [contribution guide](../CONTRIBUTING.md) for checks. Access remains private; no npm registry publication or colleague invitations were requested.

The distribution preparation passed a fresh staged-file checkout: `npm ci`, typecheck, lint, all 846 unit tests / 114 files, 17 offline contracts, build, and real stdio startup with 72 tools and isolated health. A packed tarball installed with production dependencies only passed the same startup check from a different working directory. The fresh dependency audit reported zero vulnerabilities. These packaging checks used Node 24; GitHub CI is configured for Node 22 and 24, with no live Lenovo requests. Protocol behavior is unchanged by the distribution cleanup. The package advertises only its executable, not the previously nonexistent library entry point.

All source, maintained scripts, test fixtures and current context are versioned together. Raw captures and the cleanup archive remain local. The client examples use distinct session/artifact paths because concurrent processes must not write the same session file. The old setup command with a maintainer-specific home path is superseded by the portable client guide.

## Verified baseline

Snapshot `20261016T041423Z` finished 54 release commands: **52 passed, 0 failed, 2 capability-blocked**. It passed 846 unit tests in 114 files, 17 offline contracts, 89 live contracts, 170 conformance checks across all 72 tools, a 291-call nested lifecycle, and all 15 final headless browser checks. Source integrity passed before and after; the dependency audit reported zero vulnerabilities at that time. These are dated results, not a promise about future Lenovo availability.

Use the [24-finding audit](roadmaps/2026_10_15_dcsc_finding_audit.md) for closure scope and the [roadmap](roadmaps/2026_10_15_dcsc_parity.md) for requirements. The [progress ledger](roadmaps/2026_10_15_dcsc_progress.md) preserves implementation decisions and earlier results, explicitly superseded by its current checkpoint. The review originally had 23 findings; dependency remediation added finding 24.

Confirmed local corrections include commercial/software/service quantities, imported clone ownership, canonical export groups, atomic revision-bound edits, durable recovery and history, rack and supported nested lifecycle, bounded lossless projections, authoritative manufacturing validation, standalone products and Management cabling. Do not replace these with simplified state or infer closure from a successful HTTP status.

## Remaining requirements and next action

1. **P1, finding 15: populated storage graph and managed physical-alias cable replacement — blocked upstream for every tested design.** Native optical-iSCSI direct attach (DE2000H, before export) and native FC with a placed DB710S SAN switch (DS3200, r49) both return HTTP 200, no errors and zero storage rows. The 2026-10-16 diagnostics replayed both captured requests in 22 variants covering nine storage hypotheses (alias identities, assignment, layout, type, Direct Attached and expansion shapes, automatic switches): still zero storage rows, and `switch_calculation` never requests a SAN switch. With native identities, Lenovo *does* cable the managed DB710S physical alias on Management when its Management port is selected, so alias resolution is not the cause; collapsing the alias breaks that row. Lenovo's own reference designs with DM/DE/DG storage carry no storage definitions or connection rows. No native workflow has produced a storage row, so the destination-side alias guard in `src/domain/manualCabling.ts` stays. Unblocking needs a design, from Lenovo or a user, that yields a storage-network row on the website; then capture its managed cable edit, export/reimport and restart. Evidence: `artifacts/storage-diagnostics-2026-10-16/README.md`.
2. **P2: GB300 power and dependent DWC verification — blocked upstream.** Launch/derive, the website's exact power-panel request to `/powercalculation/powercalculate` (validated by a numeric SR630 V3 control), explicit 230 V AC/48 V DC inputs, and Lenovo's GB300 NVL72 reference design all return null power for `7DLZCTO2WW`. The website shows no power control for it. Preserve the explicit unknown state and the blocked live gate; do not manufacture numeric power or a cooling verdict.

Current storage catalogs also expose no expansions. Broader VLH/container shapes are future matrix growth. Native Delete Node loses a detached node on reimport; the MCP warns and offers roundtrip-safe unplace. No new hypothesis for a preserving native workflow was tested on 2026-10-16. These qualifications remain documented, not silently counted as parity.

Concurrent processes sharing one session file silently lose acknowledged changes: each holds its own store and atomically replaces the whole file, and every client without `DCSC_SESSION_FILE` defaults to the same path. The client guide documents separate paths; a fail-fast per-file ownership lock was proposed on 2026-10-16 but not implemented pending approval.

Authenticated saves and partner pricing remain untested, not broken.

## Evidence and cleanup

Raw evidence is local and intentionally excluded from Git because exports and captures can contain configuration/customer data. Repository fixtures are the maintained, reviewable test corpus. Paths below are relative to the repository root and are local evidence locators, not files guaranteed in a fresh clone:

- `artifacts/release-results/20261016T041423Z/final-verification-summary.json`: final metrics and outstanding requirements.
- `artifacts/release-results/20261016T041423Z/final-completion-evidence-audit.json`: command-by-command and requirement-by-requirement closure evidence.
- `artifacts/release-results/20261016T041423Z/reports/`: 47 preserved result files; `preserved-report-index.json` maps original paths and hashes.
- `artifacts/release-results/20261016T041423Z/runtime-artifacts.tar.gz`: complete frozen runtime evidence, SHA-256 `627fc0109074d11662501af7a8e6dff2e5e3364a26805f882551fc4660153d91`.
- `artifacts/release-results/20261016T021139Z/storage-followup/native-iscsi-direct-run2/`: decisive fresh pre-export storage request, response and summary.
- `artifacts/storage-diagnostics-2026-10-16/`: storage replay ledger, SAN-switch alias Management row, reference-solution payloads, GB300 power-panel probes and the live frontend bundle. Scripts are in `scripts/recon/`.
- `artifacts/cleanup/cleanup-result.json` and `RESTORE.txt`: cleanup inventory and recovery instructions.

All six temporary release worktrees and twelve temporary test directories were removed after archival and content verification, reclaiming about 12.9 GiB net. Old `/tmp/lenovo-dcsc-release-*` paths are historical and no longer exist. Their contents, excluding reinstallable `node_modules`, are recoverable from `artifacts/cleanup/temporary-copies.tar.gz` (SHA-256 `4d6704a9e88ca1900b0480a68d8ec4dc7d195eb0e93ac98c25bbc66cb61fbd0c`). The main working tree and original evidence were preserved. No old release job is still running; do not poll or restart old process/session handles.

## Working rules

- Run browser tests **headless**. Use isolated test state, never a colleague's live session file.
- Treat Lenovo's accepted native state and exported/reimported artifacts as the parity reference. Local planning connections are not native storage rows.
- Preserve failed/blocked evidence and qualify it. Never count upstream unavailability as a pass or a documented exclusion as closure of a required gate.
- Keep raw captures, artifacts, private configuration, credentials and local client settings out of commits. Do not add the cleanup archive to Git.
- For a new source change, run appropriate local checks and affected live parity gates; the historical full matrix need not be repeated for documentation alone.
