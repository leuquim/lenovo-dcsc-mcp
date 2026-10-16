# Handoff: Bring the DCSC MCP to 1:1 functional parity with the DCSC web UI

> Historical handoff, superseded by [current context](../context.md) and the October finding audit. The next steps and blocked rack-export claim below describe the earlier state.

**Created:** 2026-08-08  
**Status:** Anonymous confident coverage + hygiene pass (export still blocked)

## Next task

P1 rack-bearing export remains blocked until a real browser capture of a successful
`export_zip` form POST with non-empty `rackData` / `rackArea` is obtained (or Lenovo DTO docs).
Do not invent new shapes.

## Gap inventory

**P0 — CLOSED** (floor client-side, cabling auto_connect, PDU autoDerive)

**P1 — export deliverables — BLOCKED (reconfirmed)**
- Playwright capture attempt (`scripts/capture-rack-export-attempt.ts`): import + workspace +
  Export UI produced **0** network/form `export_zip` captures with rack payload.
- Shipped `exportZip` with dual-shape still returns `rackDataOmitted: true` (HTTP 500 then fallback).
- Evidence: `artifacts/export_capture_attempt/`, scratch `export-capture-attempt.log`.

**P2 — services CTO path — DOCUMENTED**
- Services **tab lists** via `dcsc_list_options(session, tab: "Services")` / `query: "warranty"`.
- Launch with `serviceCto=true` auto-attaches default package (CFC selected lines).
- Package UI sections (`Lenovo Recommends|*`) list options but **autoDerive does not accept**
  those section names as selections (selectedQty stays 0).
- CFC characters only expose the **currently selected** code as a feature — no alternate to switch.
- Portal categories still via `dcsc_service_categories`.
- Contract group `services_cto` asserts list + honest non-acceptance of package configure.

**P2/P3 other**
- Promotions / recommendations / VCs / Excel / Express — still out of scope anonymously.
- Validate, locale, topology — implemented earlier.

**Account-gated**
- Partner/bid pricing, save/restore, Bid Portal.

## Hygiene
- Throwaway probes moved to `scripts/recon/` (see `scripts/recon/README.md`).
- Keep: `contract-suite.ts`, smokes, `capture-rack-export-attempt.ts`, `probe-export-dual-shape.ts`.

## Contract groups
import, rack, power, fabric, scaleout, blueprints, persist, floor, cabling, pdu,
validate, locale, topology, services, **services_cto**.
