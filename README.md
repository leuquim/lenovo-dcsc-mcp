# lenovo-dcsc-mcp

An MCP server that drives Lenovo's **Data Center Solution Configurator**
([dcsc.lenovo.com](https://dcsc.lenovo.com/)) programmatically, so an LLM can
search the catalog, launch a configuration, explore options against Lenovo's
real rules engine, and read back list prices.

DCSC ships only as a browser SPA. This server talks to the same same-origin
JSON API the SPA uses. **No Lenovo login is required** for catalog, launch and
pricing — that is verified, not assumed.

---

## Status

| Capability | State |
|---|---|
| Catalog search & browse | **Working** |
| Launch a CTO/LFO configuration | **Working** |
| Explore options (search, tabs, sections, feature detail) | **Working** |
| List pricing + resource constraints | **Working** |
| Bill of materials | **Working** |
| Change selections (mutation, with rules reconciliation) | **Working** |
| Export CFXML + Excel ZIP | **Working** |
| Import XML | Not started |
| Preconfigured (LFO) models | **Working** — launch, inspect, export |
| Multiple identical units (quantity) | **Working** — extends price and the exported line |
| Rack enclosures + U placement | **Not supported** — see below |
| Multi-product solutions (server + switch + cables) | **Not supported** — see below |
| Cluster / HPC-LeSI solution modes | Cluster mode is not offered anonymously |
| Saved config IDs, partner/bid pricing, supply status | **Out of scope** — requires a Lenovo ID |

Verified end to end against live DCSC: search → launch → configure → export
produces a CFXML 2.6 file (~52 KB, 44 parts) plus the quote workbook.
`scripts/conformance.ts` exercises all 13 tools and 30 assertions.

**CTO and LFO are mirrored endpoint families and both must be routed
explicitly** — `/ctos/*` vs `/lfos/*` for launch, autoDerive and export. The
LFO routes additionally resolve the model by its **LFO code**, not the
underlying CTO code; sending the CTO code returns "Unable to find a model with
model number …".

---

## Quick start

```bash
npm install
npm run build

# Prove the client works against live DCSC (~4 requests)
npx tsx scripts/smoke.ts

# Drive the MCP server exactly as an LLM client would
npx tsx scripts/mcp-smoke.ts
```

Register with Claude Code:

```bash
claude mcp add lenovo-dcsc -- node /home/miquel/projects/lenovo-dcsc/dist/mcp/server.js
```

## Tools

| Tool | Purpose |
|---|---|
| `dcsc_find_products` | Search the catalog. The normal way to get from "SR630 V3" to `7D73CTO1WW`. |
| `dcsc_browse_catalog` | Walk the category tree. Use only to understand structure. |
| `dcsc_solution_modes` | List solution modes and their master slices. |
| `dcsc_launch` | Start a configuration session; returns a compact summary. |
| `dcsc_list_options` | Search or list options. `query` searches all tabs; `tab` lists sections; `section` lists options. |
| `dcsc_get_feature` | Full detail + attribute map for up to 10 codes. |
| `dcsc_get_configuration` | The selected parts, grouped by tab (BOM). |
| `dcsc_configure` | Apply option changes. Returns only the diff: added/removed/replaced parts, price delta, constraints. |
| `dcsc_set_quantity` | Set how many identical units (1–99). Use for "8 of these nodes". |
| `dcsc_undo` | Revert the last `dcsc_configure`. |
| `dcsc_export` | Export to a ZIP on disk; returns paths to the CFXML and the Excel quote. |
| `dcsc_session_info` / `dcsc_session_list` / `dcsc_session_close` | Session management. |
| `dcsc_health` | Circuit breaker state, WAF cooldown, effective config. |

### Why the tools look like this

A single `launch` response is ~150 KB — it cannot go into a model's context.
Every tool therefore returns a **projection**, not the tree:

```
L0  session summary   tabs, price, constraints            ~1–2 KB
L1  tab view          sections + current selections       ~1 KB
L2  section view      one line per option, paginated      ~1–3 KB
L3  feature detail    everything, for a few codes         ~1 KB
```

Two deliberate choices worth knowing:

- **Search beats browsing.** `dcsc_list_options(session, query: "64GB")` searches
  every tab at once. Walking eleven tabs to find a feature code is the failure
  mode the design exists to prevent.
- **Prices are deltas.** Within a section, options are priced relative to the
  current selection ("+$4,200"), because that is the question actually being
  asked.

## What it cannot do yet

The single-configuration session model covers one product, configured, in any
quantity. It does **not** cover a *solution*: several different products sharing
a rack, with placement and cabling.

Concretely, a request like "8 × SR680a V4 in a rack with a switch and cables"
yields the 8 nodes priced and exported correctly, but not the rack, the switch
as part of the same solution, or the port-to-port cabling report.

What that needs (endpoints exist and are reachable — `scripts/probe-rack.ts`
maps them):

- a **workspace** holding many configurations rather than one
- `/ctos/racks/{code}/launch`, `/ctos/racks/hardware`, `/ctos/racks/customize`
  for the rack and its contents (`racks/categories` returns 367 rack-catalog
  products; the catalog carries 77 networking products)
- `/p2p-report` and `/calculateDistance` for cabling
- `RACK_DIAGRAM` / `FLOOR` / `P2P_REPORT` export flags, which are already in
  `EXPORT_FILE_TYPES`

Also unsupported: `networkingInformation` and `messageHistory` in the export
payload are deliberately omitted (their real shapes are unknown and the naive
ones fail), and both are needed for rack/cluster exports.

## Configuration

All settings take `DCSC_`-prefixed env vars, or a JSON file at
`~/.config/lenovo-dcsc/config.json`. Env wins.

| Variable | Default | Notes |
|---|---|---|
| `DCSC_COUNTRY` / `DCSC_GEO` / `DCSC_LANGUAGE` / `DCSC_CURRENCY` | `US` / `NA` / `en` / `USD` | These four travel together; a mismatched pairing is a classic DCSC 500. |
| `DCSC_HOST` | `dcsc.lenovo.com` | Restricted to a fixed allowlist. |
| `DCSC_MAX_CONCURRENCY` | `2` | |
| `DCSC_TOOL_REQUEST_BUDGET` | `40` | Hard cap per tool call. |
| `DCSC_LOG_LEVEL` | `info` | Logs go to **stderr**; stdout is JSON-RPC. |
| `DCSC_LOG_RAW_ERRORS` | `false` | Local debugging only — bypasses 5xx redaction. |
| `DCSC_ENABLED` | `true` | Kill switch. |

## Operational rules this codebase enforces

These are structural, not conventional — both are checked by ESLint and by tests.

1. **One HTTP chokepoint.** Only `src/http/**` may import `undici`. Everything
   else calls `send()`, which applies the six mandatory headers and seven
   mandatory query params. Omitting `integrationParams: {}` or `masterSlices`
   makes DCSC return HTTP 500, sometimes with a raw JDBC statement, so
   `assertPreamble()` fails **locally** before a request is spent.

2. **5xx bodies never reach the user.** DCSC leaks SQL, Java stack frames and
   internal hostnames in error responses. Users see a fixed template plus a
   request id; logs get a redacted, hashed form. Covered by tests.

3. **Back off, never evade.** HTTP 499 is DCSC's bot-mitigation verdict. It is
   never retried and trips a global cooldown ladder (60 s → 5 m → 15 m → 1 h).
   The User-Agent is pinned, the host list is fixed, and there is no proxy
   support anywhere — rotating any of those to dodge the flag would change what
   this activity is, and the codebase forecloses it.

4. **A 5xx on a POST is ambiguous, not retryable.** It raises
   `DcscAmbiguousStateError` so the caller re-reads state. A silent duplicate
   mutation is worse than a visible failure.

5. **The raw payload is kept verbatim.** DCSC holds no server-side session
   (`launch` returns `id: null`), so the client owns the configuration and posts
   it back on mutation. All summarization is derived *beside* the raw, never
   instead of it.

## How mutation and export actually work

These contracts were recovered by driving the real SPA in a browser and reading
the outgoing requests (`fixtures/capture/autoDerive-request.json`). They are
undocumented and were not guessable — several details cost repeated HTTP 500s
before the capture settled them.

**The configuration lives on the client.** `launch` returns `id: null`; DCSC
keeps no server-side session. The client generates the id (`US__<uuid>0`) and
posts the configuration back on every call.

**Mutation — `POST /api/ctos/autoDerive`** (`batch_customizing` is 404 in the
current release; it has been retired):

- The body carries a **reduced** model, not the 150 KB launch tree: only the
  sections that hold selections, each with its `results[]`. About 24 KB.
  Posting the full tree fails with `ConfigurationResult.getSections() is null`.
- A `delta` describes the change — `{section, featureCode, quantity,
  previousFeatureCode, previousQuantity}`. DCSC reconciles dependent parts from
  it, so it is load-bearing rather than descriptive.
- `workspaceInformation.configurations` is **null**; the configurations go in
  the top-level `configurations` array.
- `workspaceInformation.nonRackData` (physical placement) is a different object
  from `workspace.nonRackArea` (layout). Conflating them returns a bare 500.
- **A priming `autoDerive` with no delta must run right after launch.** It
  materialises the derived sections — fillers, labels, voltage, service and
  software rows — that the launch response does not contain. Without it the
  first real change is rejected.
- `customizingFlags.autoDerive` is what guided vs expert mode toggles.

**Export — `POST /api/ctos/export_zip`**, a form-encoded POST (the SPA submits
it through a hidden iframe, but at the wire level it is an ordinary POST):

- `exportFileTypes` is a plain top-level array inside `data` — `["XML",
  "QUOTE", "SUMMARY", …]`. Omit it and the server returns HTTP 200 with a valid
  but **empty** archive. It is not the `{zipAll, selection}` shape the bundle's
  own builder function suggests.
- The export DTO takes a **different configuration shape** from autoDerive and
  rejects unknown properties. It reads `code`, not `ctoCode` — omit `code` and
  the rule engine requests `/cto/characters/` with an empty segment and 404s.
- `cloneDependencyColor` values are objects, not colour scalars; `{}` is fine.
- `networkingInformation` and `messageHistory` are **not sent**. The real client
  sends both, but their shapes differ from the obvious ones and each fails the
  whole body with `"Failed to read request"`. They only matter for rack and
  cluster solutions.
- The query is minimal — `country_or_region`, `language`, `currency`,
  `fileName`, `_request` — with no `geo`, `solutionMode` or `masterSlices`.
- `image` (the html2canvas rack diagram) is empty even in the real browser for a
  non-rack configuration, so no headless browser is needed.

Output: a ZIP containing `<name>.xml` (Lenovo **CFXML 2.6** — the file that
re-imports into DCSC and raises a bid in Lenovo Bid Portal) and `<name>.xlsx`
(the quote workbook). Archives land under `DCSC_ARTIFACT_DIR` with a manifest.

### Re-capturing after a DCSC release

If a release breaks these contracts, re-capture rather than guess:

```bash
playwright-cli -s=dcsc open "https://dcsc.lenovo.com/#/configuration/cto/7D73CTO1WW?hardwareType=server" --browser=chromium
```

Then install a hook that records the outgoing form and **suppresses the submit**
(the download otherwise kills the CLI session), drive Summary → Export → Save,
and read `window.__cap` back with `eval`. Query specific fields rather than
dumping the whole 27 KB body.

## Drift detection

DCSC is undocumented, unversioned, and ships releases weekly to fortnightly.

```bash
npm run mine
```

fetches the date-stamped SPA bundle, extracts every API path literal, the export
form fields and the format flags, and **diffs them against the previous
baseline** — telling you what Lenovo added, removed or renamed *before* you call
any of it. This costs **zero API requests**. Run it on a schedule.

## Tests

```bash
npm test        # offline; no network
npm run lint
npm run typecheck
```

`test/safety.test.ts` covers the properties that must not regress: redaction,
the 5xx template, the retry and 499 policies, the preamble assertion, export
filename sanitisation, and the mutation diff.

Live checks (these hit DCSC; keep them occasional, not per-commit):

```bash
npx tsx scripts/smoke.ts         # client foundation, ~4 requests
npx tsx scripts/export-smoke.ts  # launch -> autoDerive -> export
npx tsx scripts/mcp-smoke.ts     # happy path over stdio
npx tsx scripts/conformance.ts   # every tool + edge cases, ~30 assertions
```

**`conformance.ts` is the one that matters.** It asserts that every registered
tool is exercised — the coverage gate fails if a tool is added without a check —
and it covers what the happy path misses: the LFO endpoint family, batched
changes, pagination, filters, stale-revision rejection, and the error surface
(including that no internals leak). It caught three real bugs the smoke test
could not: LFO priming routed to the CTO endpoint, LFO export routed to the CTO
endpoint, and `toToolError` collapsing our own guidance messages into a generic
string.

## Limits and risks

- **List prices only, and not a quote.** Anonymous responses carry list price
  for one country and currency. Partner and bid pricing sit behind
  `/lbp/*`, which requires a Lenovo ID. Every price-bearing result is stamped
  with currency, country, `pricedAt` and a disclaimer.
- **Lenovo's terms apply.** There is no `robots.txt` (it 404s), but that is not
  permission. Closed CORS and a WAF are signals this traffic is not intended.
  Whether to run this is a business decision, not a technical one.
- **It will break.** Undocumented and unversioned against a weekly release
  cadence. Budget maintenance; run the drift detector.
- **A configuration containing errors cannot be imported into Lenovo's quote
  tools.** Any feature that presents a config as quote-ready must check this.
- **The legitimate path exists.** Lenovo runs an internal DCSC API programme
  (release notes reference configuration API response modes, an xconfig search
  API, and "Public-to-APIH"). It is partner-gated and undocumented. Contact
  `salesconfig@lenovo.com`.

  If credentials arrive, the swap point is `DcscService` — the MCP tools already
  talk only to it, never to HTTP. A formal `DcscTransport` interface was drafted
  and then removed: with one implementation it was unreferenced code, and
  guessing the shape of an API nobody has seen would have been worse than
  deriving it when it exists.
