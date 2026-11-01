# Persistence fixtures

`v1-historical.json` is a small, synthetic fixture shaped field for field like
the v1 serializer in commit
`f640bb4cd31e6b3bcd452bfb2fae19e4f7e85a3c` (`src/session/persist.ts`,
2026-08-08). It is useful for deterministic migration tests, but it is not a
captured user session and its `$100` price and empty tabs are not DCSC evidence.

The maintained live recovery gate in `scripts/parity/cases/recovery.ts` uses the same
historical serializer field set with the anonymous, headless SR630 V3 capture
in `test/fixtures/parity/sr630-launch.json`. That gate supplies realistic BOM,
software, service and price data while retaining a small offline unit fixture.
