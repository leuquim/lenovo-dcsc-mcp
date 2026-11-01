# Example: single-rack B200 AI factory pod

A worked reference solution built end to end against live DCSC through this MCP
server. 32 GPUs in one 42U cabinet, rail-optimised NDR400 InfiniBand, N+N power.

Workspace `ws_2y4e2cv5`, built and priced 2026-08-08, US/USD.

**All prices are anonymous LIST prices for US/USD. This is not a quote.**
Partner and bid pricing require a Lenovo login.

---

## What it is

| | |
|---|---|
| Compute | 4 × ThinkSystem SR680a V3, 8 × NVIDIA HGX B200 180GB each |
| GPUs | **32 × B200**, 5.76 TB aggregate HBM3e |
| Host CPU | 8 × Intel Xeon Platinum 8568Y+ (48C, 350W) |
| Host memory | 16 TB (4 × 32 × 128GB TruDDR5 5600) |
| Local NVMe | 204.8 TB (4 × 8 × 6.4TB PM1745 Gen5 MU) |
| East-west fabric | 32 × NDR400 (ConnectX-7 OSFP), 1 per GPU |
| Fabric switch | NVIDIA QM9700, 64-port NDR managed |
| OOB management | NVIDIA SN2201 1GbE with Cumulus |
| Enclosure | ThinkSystem 42U Onyx Heavy Duty, 34U used / 8U free |
| Power | 4 × 63A 3-phase WYE switched+monitored PDU |
| **Total** | **$4,294,233.57 USD LIST** |

## Bill of materials

| Line | Code | Qty | Unit LIST | Extended |
|---|---|---:|---:|---:|
| ThinkSystem SR680a V3 B200 compute node | `7DM9CTO1WW` | 4 | $1,047,334.51 | $4,189,338.04 |
| NVIDIA QM9700 64-port NDR IB switch (PSE) | `0724HEC` | 1 | $69,905.01 | $69,905.01 |
| ThinkSystem 42U Onyx Heavy Duty Rack | `7D6DCTO1WW` | 1 | $29,393.51 | $29,393.51 |
| NVIDIA SN2201 1GbE managed switch (PSE) | `7D5FCTOFWW` | 1 | $5,597.01 | $5,597.01 |
| | | | **Total** | **$4,294,233.57** |

### Per compute node — $1,047,334.51

The `7DM9CTO1WW` base node ships at $953,271.51 with no local storage and no
fabric NICs. The $94,063.00 delta below is what makes it a usable factory node.

| Section | Code | Qty | Purpose |
|---|---|---:|---|
| GPU Adapter | `C519` | 1 | HGX B200 180GB 1000W 8-GPU board (base) |
| Processor | `BYWF` | 2 | Xeon Platinum 8568Y+ 48C 350W (base) |
| Memory | `C4EA` | 32 | 128GB TruDDR5 5600 RDIMM — 4TB, all 32 slots (base) |
| GPU Direct PCIe Adapters | `C51C` | 8 | ConnectX-7 NDR400 OSFP 1-port — one rail per GPU |
| CPU Direct PCIe Adapters | `BQBN` | 2 | ConnectX-7 NDR200/200GbE 2-port — storage + in-band |
| HDD not in RAID Array | `C4HM` | 8 | 6.4TB PM1745 Gen5 MU NVMe — 51.2TB scratch |
| M.2/7MM RAID Config | `BS7A` | 1 | Enable configured M.2 RAID |
| M.2 RAID Controller | `BS7M` | 1 | Intel VROC Standard |
| M.2 NVMe RAID Array 1 | `BS7F` | 1 | RAID 1 |
| M.2 Array 1 NVMe HDD | `BXMH` | 2 | 960GB PM9A3 — mirrored boot |
| Power Supply | `CBAF` | 8 | 3200W Titanium CRPS (base) |

Node role is tagged `Compute`; the switches are tagged `Management`.

### Fabric cabling — on the QM9700

| Code | Qty | Purpose |
|---|---:|---|
| `BQJX` | 16 | 2m OSFP800 → 2 × NDR OSFP400 passive copper splitter |

The QM9700 has 32 OSFP800 cages carrying 2 × NDR400 each (64 ports). Each
splitter feeds two node NICs, so 32 node ports need 16 cables and consume 16
cages — leaving **16 cages / 32 NDR400 ports free** for spine uplinks or a
second pod. That is what makes this a pod rather than an island.

### Management — on the SN2201

`AVG0` × 12, 3m Green Cat6 — 4 × XCC, 4 × PDU, switch management, spares.

## Rack elevation — DCSC-validated

```
U42 ┌──────────────────────────────┐
    │            (8U free)         │  spine uplink / storage
U37 ├──────────────────────────────┤
U36 │ SN2201 1GbE management       │  1U
U35 │ QM9700 64-port NDR InfiniBand│  1U
U27 ├──────────────────────────────┤
    │ SR680a V3  node 4            │  8U
U19 ├──────────────────────────────┤
    │ SR680a V3  node 3            │  8U
U11 ├──────────────────────────────┤
    │ SR680a V3  node 2            │  8U
U3  ├──────────────────────────────┤
    │ SR680a V3  node 1            │  8U
U1  └──────────────────────────────┘  U1-U2 reserved (placement rule)
```

Positions came from DCSC, not from arithmetic — an SR680a V3 cannot sit below
U3 in this cabinet, which is why the stack starts at U3 and 42U yields exactly
4 nodes, not 5.

- **Used:** 34U of 42U · **Weight:** 727.22 kg
- **Stability:** `WARNING` from DCSC's centre-of-gravity check. Not `FAILED`,
  so it ships, but four 116 kg nodes stacked from U3 to U35 is top-heavy —
  review ballast and shipping brackets with Lenovo before ordering.

## Power — DCSC figures, not estimates

Per rack, at 230V-AC with the node power policy `N+N redundant with
over-subscription` and a 70% load factor:

| Band | Power | Current |
|---|---:|---:|
| Idle | 12.5 kW | 58.9 A |
| **Expected** (size the room against this) | **29.2 kW** | 131.8 A |
| Max | 46.8 kW | 212.8 A |
| **Worst case** (size the breaker against this) | **49.8 kW** | 225.6 A |

Heat at expected load: 99,594 BTU/hr.

Each node reports 74.72% power utilisation across its 8 × 3200W supplies.

### Why 4 × 63A PDUs

`C0CS` — 0U 18 C13/C15 + 18 C13/C15/C19 switched and monitored 63A 3-phase WYE.

One PDU carries 63A × 230V × 3 ≈ 43.5 kW. The design pairs two PDUs per feed,
two feeds (A/B):

- Per feed: 87 kW raw, **69.6 kW at an 80% derate** — covers the 49.8 kW worst
  case with a whole feed lost. N+N holds.
- Outlets: 4 × 18 C19-capable = 72, against 32 node PSU cords + switches.
- DCSC caps the `0U PDU - Switched and Monitored` group at 4 per rack, so this
  is the maximum switched 0U power the cabinet accepts.

A single pair of 63A PDUs would have been 34.8 kW per feed derated — under the
46.8 kW max. Four is not belt-and-braces here, it is the requirement.

## Scaling

`dcsc_scale_out` measures rack capacity against DCSC rather than dividing 42 by
8. For this node in this cabinet: **4 nodes per rack**. Multiply the pod:

| Pod count | GPUs | Racks | Expected kW | LIST |
|---:|---:|---:|---:|---:|
| 1 | 32 | 1 | 29.2 | $4.29 M |
| 4 | 128 | 4 | 116.8 | $17.2 M |
| 8 | 256 | 8 | 233.6 | $34.4 M |

Beyond one pod the QM9700 downlinks stop being the constraint and a spine layer
does — budget the free 16 cages per leaf accordingly.

If rack power density is the binding constraint rather than floor space, the
liquid-cooled SR780a V3 (`7DJ5CTO1WW`) is the swap.

## Reproducing it

```
dcsc_launch("7DM9CTO1WW")
dcsc_configure(node, [C51C×8, BQBN×2, C4HM×8, BS7A, BS7M, BS7F, BXMH×2])
dcsc_set_node_role(node, "Compute")
dcsc_add_rack(ws, "7D6DCTO1WW")
dcsc_configure_pdu(ws, rackId, "C0CS", 4)
dcsc_launch("0724HEC", workspace: ws)   → dcsc_configure([BQJX×16])
dcsc_launch("7D5FCTOFWW", workspace: ws) → dcsc_configure([AVG0×12])
dcsc_place_in_rack(ws, rackId, each)
dcsc_set_topology(each, "IB_NDR")
dcsc_power(ws) · dcsc_validate(ws)
```

Nodes 2-4 are separate `dcsc_launch` calls into the same workspace.
`dcsc_set_quantity(4)` prices four nodes correctly but places only one item —
physical placement is per configuration.

## Validation status

`dcsc_validate(ws_2y4e2cv5)` → **valid, 0 errors, 0 warnings**, via DCSC's own
`/lmc_validation`. No constraint is breached on any of the seven
configurations; PCI slots on each node are exactly full at 10/10.

## Corrections applied since this was first written

Three claims above were wrong or incomplete and have been fixed in the server:

- **The rack shipped with no line cords.** `dcsc_configure_pdu` truncated a
  mixed cord list to 20 rows; DCSC returns 25 jumper cords before the first
  LINECORD, so all 16 line cords fell off the end. Cords are now bucketed by
  section and the tool refuses to call a rack complete without one.
- **"Rail-optimised" was the wrong term** for a single-leaf fabric — all 8
  rails land on one switch. Correct for 4 nodes, wrong as a name, and the
  scale-out table below understates multi-pod cost because it omits the spine.
- **The 46.8 kW air-cooled rack now raises a cooling advisory** rather than
  being priced in silence.

## Known gaps hit while building this

Two things did not work, both pre-existing server-side gaps rather than
configuration errors:

1. **`dcsc_add_cabling(mode: "auto")` → HTTP 500.** DCSC's `/auto_connect`
   rejected the rack-bearing payload. The workspace was re-read afterwards and
   is intact with an empty cable list. The 16 splitter cables are in the BOM and
   priced; what is missing is the port-to-port map.
2. **Export failures — root cause found, and it was ours.** Both symptoms
   traced to one bug: `getWorkspace()` resolves a *configuration* id up to its
   parent workspace, so `dcsc_export(node)` in a seven-product workspace built
   the whole-workspace payload — racks included — and DCSC rejected it. Export
   scope now follows the handle.

   With that fixed and the rack payload no longer attempted, both cases work:
   a configuration handle exports 1 configuration / 40 part blocks, a workspace
   handle exports 3 / 120, and a rack-bearing workspace exports in a single
   request with `rackDataOmitted: true` instead of two 5xx attempts and a
   tripped breaker.

   What remains genuinely server-side is only the rack payload itself, so
   `RACK_DIAGRAM` / `RACK_REPORT` / `FLOOR` / `P2P_REPORT` are still
   unavailable.

`dcsc_validate` also reports `rackDataOmitted: true` for the same reason: the
LMC handoff covers the seven configurations, not the rack layout.

Consequence: **this pod cannot yet be exported as one CFXML and re-imported to
raise a bid.** The individual node, switch and rack configurations can be, and
the rack layout above is DCSC-validated even though it does not survive export.
