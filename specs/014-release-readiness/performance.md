# Performance screening — release gate HOLD

Measured 12 November 2026 using Bun 1.3.11, Intel Xeon Platinum 8573C,
18 GiB host RAM with a 16 GiB executor limit. Synthetic in-memory SQLite,
paired balanced movements, MYR, one populated accounting year, 36-month approved
book schedules, and a synthetic custom 1% original-cost allowance scheme. Rates
are arithmetic fixtures, not Malaysian tax guidance.

| Dataset | Movements | Registered assets | Earlier YAs |
| ------- | --------: | ----------------: | ----------: |
| Small   |    10,000 |               100 |           3 |
| Medium  |   100,000 |             1,000 |           5 |
| Stress  | 1,000,000 |            10,000 |          10 |

Earlier YAs contain empty source periods and two retained finalised revisions
per YA. Current-year finalisation includes every asset's scheme claim and
explicit zero utilisation. This does not benchmark dense multi-year claim
histories; separate regression suites cover carry-forward/amendment correctness.

## Results

| Operation                  | Small (ms) | Medium (ms) |   Stress (ms) |
| -------------------------- | ---------: | ----------: | ------------: |
| Tax source capture         |        236 |         894 |          9538 |
| Asset register             |        146 |       1,087 |         14401 |
| Depreciation preview       |        264 |       1,546 |         24661 |
| Closing preview            |        194 |       1,449 |         12953 |
| Worksheet detail           |        309 |       2,836 |         37956 |
| Read + save draft          |      1,250 |       6,072 | Not completed |
| Finalise with asset claims |        815 |       6,699 | Not completed |
| CSV generation             |         87 |         247 | Not completed |
| HTML generation            |         32 |         346 | Not completed |

Small and medium use three samples per operation, except finalisation uses one.
The reported screening p95 with three samples is their maximum; it is not a
statistically established service SLA. Stress uses one sample. `coldMs` in the
JSON means first timed invocation after setup, not cold-process startup. Draft
save includes an immediately preceding detail read, matching a refresh-and-save
sequence; it is not an isolated database transaction timing. Finalisation is
measured with an already prepared payload. CSV/HTML metrics measure generation
from retained evidence, not network download, browser rendering or printing.

Small source snapshot: 1,928,659 bytes; peak process RSS 345 MiB.
Medium source snapshot: 19,431,262 bytes; peak process RSS 2,296 MiB.
These high-water marks include fixture setup and retained benchmark results,
not just the incremental memory of one production request.

The stress process was deliberately stopped after RSS reached 13,334,048 KiB
(about 12.72 GiB), exceeding its 12 GiB safety budget before it could exhaust the
16 GiB executor. Draft saving, claim finalisation and exports did not complete.
This is a failed scalability gate, not a passing million-movement certification
or proof of production recovery time. Completed stress reads reconciled sources;
there is no claim that the unfinished save committed.

## Changes supported by profiling

- History lists and first-year checks read revision metadata instead of decoding
  every source snapshot; claim schedules are scoped to earlier YAs.
- Detail reads hash/diff source evidence once rather than repeatedly. Stable
  full-source hashes avoid redundant per-line change comparisons.
- Tax writes reuse immutable bookkeeping/asset reads only within the immediate
  transaction. The scope clears on success and error. Tax adjustments, scheme
  definitions, permissions and revision state remain fresh reads.
- Version checks fetch the version instead of decoding an entire snapshot.

An attempted narrower asset query regressed performance and was not retained.
The final register still uses its established exception/reconciliation logic.
No percentage speedup claim is made: early profiling used a different setup and
payload and is not an identical before/after benchmark.

## Remaining gate

The small fixture meets the proposed response targets. At medium volume,
worksheet detail exceeds the 2s read target and claim completion exceeds the 3s
save/finalise target. Export generation stays below 10s. The stress run fails the
memory/time screening. Broad large-ledger release readiness is **not approved**.

Query counts expose further work: medium register 2,008 queries, depreciation
preview 5,009, detail 2,042, read+save 4,124 and completion 2,334. Batch the remaining
per-asset reads, reduce repeated retained-snapshot decoding and bound worksheet
response/working-set growth before repeating this gate. Also test disk-backed
books, concurrent requests, dense historic claim schedules and actual deployment
hardware. No silent year splitting, partial tax computation or new arbitrary
production data cap was introduced to make the benchmark pass.

## Reproduce

```sh
bun run test:release:benchmark small 3
bun run test:release:benchmark medium 3
bun run test:release:benchmark stress 1
```

The benchmark imports only isolated fixture operations, opens in-memory books,
and uses the preload that refuses the configured database client. Run each size
as a separate process with ample memory and an external process memory budget;
the stress command itself has no production memory limiter. Do not run it on a
production service host. Structured observations are in benchmark-results.json.
