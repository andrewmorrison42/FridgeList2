# The Fridge List

A household meal-planning and shopping-list tool for one family, built as an
installable PWA with no server, no build step, and no runtime dependencies.

- [`URS.md`](URS.md) — what the household needs, in their language
- [`SRS.md`](SRS.md) — numbered, testable requirements
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is built, and why
- [`FAILURE-AUTOPSY.md`](FAILURE-AUTOPSY.md) — the failures it exists to prevent,
  traced against the design
- [`data/DATA-REVIEW.md`](data/DATA-REVIEW.md) — audit of the household's data

## The one hard guarantee

**FR-SYNC-1.** Once any device records that a line is done, or that a menu
selection has been added, that fact stays true everywhere until a person takes
a distinct, later, explicit action to undo it. No merge, sync or regeneration
may revert it as a side effect.

It is guaranteed structurally, not by care:

1. Each device writes only its own files, so there is no lost-update window.
2. Compaction drops only causally superseded events.
3. A tick can only be defeated by an event that causally saw it — version
   vectors, never wall clocks.
4. Nothing else writes state: regeneration is additive, and during a shop it
   does not run at all.

## Running it

```sh
npm install          # dev dependencies only — the app itself has none
npm test             # ~7,500 generated scenarios plus worked examples
python3 -m http.server 8099    # or any static server
open http://localhost:8099/
```

The app needs a static HTTPS host in production (service workers and OAuth
require it). GitHub Pages serves it; household data never touches that host,
going browser ⇄ OneDrive directly.

## Importing the household's data

```sh
node tools/import.js data/recipes-data.reviewed.json path/to/trip-history.json
```

Writes `data/library.json` and `data/import-report.md`. The report lists what
needed a human rather than guessing.

## Layout

```
src/core/    pure: no I/O, no DOM. The guarantee lives here
src/data/    storage, sync, presence, local persistence
src/ui/      views. They render from derived state and never hold their own
tools/       one-off migration
test/        properties, domain examples, integration, storage contract
```

Two rules worth keeping as it grows:

- **Every merge decision lives in `src/core/merge.js`.** A resolution made
  anywhere else is a decision no property test is watching.
- **Every property is asserted under variation** (`test/harness.js`) — skewed
  clocks, shuffled delivery, compacted or not — never against a single run.
