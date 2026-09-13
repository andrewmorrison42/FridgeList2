# The Fridge List — Architecture & Design

**Status:** Draft v0.2, 2026-09-13. Derived from [`URS.md`](URS.md) v0.1 and
[`SRS.md`](SRS.md) v0.2, and from an architecture interview with the
stakeholder on the same date.

**Changes in v0.2:** incorporates **FR-SHOP-3 (Menu Lock)** — the menu is
locked for the duration of a shop. This splits regeneration into a draft-phase
activity and a no-op during shopping (§5.7), adds the phase principle in §5.9,
and reduces orphaned lines (§5.7) from a routine case to a defensive backstop.

**Changes in v0.4:** results of the failure autopsy in
[`FAILURE-AUTOPSY.md`](FAILURE-AUTOPSY.md), which traced the household's two
reported failures against this design. Both are prevented, but the exercise
found one hole — nothing required a merged change to reach the screen — now
closed by FR-SYNC-7 and §11.1. Also records the atomic-upload assumption that
§7.4 had been relying on silently.

**Changes in v0.3:** results of an adversarial review of the draft phase and the
shop-closing flow. States the two design principles in §1.2. Removes the shared
`closed.json` and the trip-history file, both of which broke §4's
write-only-your-own-file rule (§8.6, §15.3). Makes the shop a chain rather than
a created object, so two shops cannot exist (§8.1). Derives line quantities
instead of storing them, removing a last-save-wins race (§5.5, §10). Replaces
the carry-over counter with a set (§9.1). Separates the menu lock from the
shopper roster (§8.1, §8.2). Adds FR-LIST-7 and FR-SHOP-4.

This document says *how* the system is built. It is subordinate to `SRS.md`:
where this document and the SRS disagree, the SRS wins and this document is
wrong. Every significant decision below records the requirement that forced
it and the alternatives that were rejected, so that a future maintainer can
tell a deliberate choice from an accident.

The system has exactly one hard correctness guarantee — **FR-SYNC-1**, tick
durability. §5 exists to establish it, §6–§8 exist to avoid undermining it,
and §14 exists to check that it holds. Nothing else in this design is allowed
to cost it.

---

## 1. Architectural drivers

These are the facts that actually determined the shape of the system. Each
one closed off options; none is incidental.

| # | Driver | Source | Consequence |
|---|---|---|---|
| D1 | A tick, once recorded, must never revert except by explicit later human action | FR-SYNC-1 | Rules out any last-writer-wins-by-wall-clock merge (§5.4) |
| D2 | "The tick vanished" and "the list rebuilt and lost my tick" are the same failure to a user | Stakeholder, Round 5 | Regeneration may only *propose*, never *replace* (§5.7) |
| D3 | Ticks must also be *undoable* by a person who can see them | Stakeholder, Round 3 | Rules out a grow-only union; forces causal tracking (§5.4) |
| D4 | Zero infrastructure — no server the household runs or pays for | Stakeholder, Round 1 | Storage is a dumb file backend; no server-side logic, no transactions (§3) |
| D5 | Phones, in a supermarket, through brief signal loss | FR-SYNC-6, URS §6 | Local-first writes with a deferred upload queue (§7.4) |
| D6 | Staleness must be visible, per participating shopper | FR-SYNC-2, Stakeholder Round 3 | Presence heartbeats and an explicit roster (§8.2) |
| D7 | Single maintainer, maintained by hand or with an LLM, for years | Stakeholder, Round 4 | No build step, no runtime dependencies (§13) |
| D8 | 638 recipes / 452 ingredients / ~1 MB of existing data to import | Supplied data files | Library is fetched conditionally, never re-polled wholesale (§7.3, §12) |
| D9 | Verification is a one-off exercise, not a maintained CI burden | Stakeholder, Round 4 | Property-based tests written once, kept, run on demand (§14) |
| D10 | Data must remain the household's if the backend disappears | Stakeholder, Rounds 2 & 7 | Every device holds the complete history; backend is a courier (§15) |
| D11 | The menu is settled before shopping, and locked during it | FR-SHOP-3 | Removes every destructive operation from the window in which ticks exist (§5.9) |

### 1.1 Decisions at a glance

| Decision | Choice |
|---|---|
| Deployment shape | Installable PWA, static files, no build step |
| App hosting | GitHub Pages (HTTPS, free, already familiar) |
| Data backend | A single shared OneDrive folder, via Microsoft Graph |
| Topology | No authority anywhere; devices coordinate through shared files |
| State model | Append-only event log, one file per device, merged on read |
| Concurrency control | Version vectors (causal), never wall-clock ordering |
| Tick/untick rule | True-wins on concurrency; an untick counts only if it saw the tick |
| Library edit rule | Last-save-wins, deterministically tie-broken |
| Shop phases | `draft` freely editable; `open` is additive only (FR-SHOP-3) |
| Regeneration | A draft-phase activity; never runs while a shop is open |
| Identity | One shared Microsoft login; anonymous per-device id + nickname |
| Language / tooling | Vanilla ES modules; dev-only test dependencies |
| Verification | Property-based testing of the merge engine (5 invariants) |
| Retention | Trip history 2 years; shop logs compacted and deleted at close |
| Backup | Weekly copy of the OneDrive folder to the household NAS |

### 1.2 Two design principles

Both were arrived at by review rather than up front, and both have since
resolved more defects than any amount of careful coding would have.

> **P-I — Prefer making a failure unrepresentable over making it handled.**
> Where a bad state can be designed out, design it out and write no handling
> code. Handling code is where the next defect lives. Applied at: one shop by
> construction (§8.1), sets instead of counters (§9.1), derived instead of
> stored quantities (§5.5), trip history as events rather than a file (§15.3),
> and the phase lock itself (§5.9).

> **P-II — Accept a risk only when the failure is loud, recoverable, and
> genuinely expensive to prevent. Fix every silent failure regardless of how
> unlikely it is.**
> A loud failure gets noticed and fixed; a silent one — a lost tick, a quantity
> quietly too low, a Wait List item that vanishes — compounds unseen for years,
> and is the entire category this rebuild exists to eliminate. Cheapness of
> prevention is checked *first*: if it costs a sentence, do it and stop
> deliberating.

A worked example of P-II: an unfinished shop blocking next week's planning
(§8.6) is accepted, because it is loud and a button fixes it. Two shops
existing at once was not accepted, because ticks would split silently between
them — even though it was just as unlikely.

---

## 2. System context

```mermaid
flowchart LR
    subgraph Devices
      P1[Phone A<br/>PWA + full local history]
      P2[Phone B<br/>PWA + full local history]
      T1[Tablet<br/>PWA + full local history]
    end
    GH[GitHub Pages<br/>static app files only<br/>never sees household data]
    OD[(OneDrive folder<br/>append-only files<br/>one per device)]
    NAS[(Home NAS<br/>weekly archive<br/>read-only copy)]

    GH -. serves app code .-> P1
    GH -. serves app code .-> P2
    GH -. serves app code .-> T1
    P1 <--> OD
    P2 <--> OD
    T1 <--> OD
    OD -. scheduled copy .-> NAS
```

Two properties of this picture matter more than the boxes:

1. **GitHub Pages never touches household data.** It serves HTML, CSS and JS.
   The data path is browser ⇄ OneDrive directly. If GitHub Pages vanished, the
   app could be served from any static host, or opened from a local file.
2. **OneDrive is a courier, not a custodian.** Every device holds the complete
   event history locally (§7.1). OneDrive moves files between devices that
   already have everything. This is what makes D10 true, and it is the reason
   an authoritative-server design was rejected (§18.1).

---

## 3. Deployment shape

### 3.1 The application

A Progressive Web App: static `index.html` plus ES modules, a service worker,
and a web app manifest. Installed to the home screen on each phone and the
tablet. Served from GitHub Pages over HTTPS (required for service workers and
for the OneDrive OAuth redirect).

The service worker caches the app shell so the app opens instantly and works
through signal loss (D5). It caches **application code only** — never
household data, which lives in IndexedDB (§7.1). App updates are picked up on
next launch; the running app is never swapped out mid-shop.

### 3.2 The data

One folder in the household's OneDrive, written and read by every device. No
process runs anywhere on the household's behalf. There is no server, no
database, no scheduled job and nothing to keep alive.

### 3.3 Authentication

A single shared Microsoft account, signed in on each device via MSAL.js
(authorisation code flow with PKCE — the only flow appropriate for a public
client with no secret). Scope: `Files.ReadWrite` limited to the application's
folder path. Tokens are held per-device by MSAL; refresh is silent, so in
practice nobody signs in twice.

There are no application accounts, no roles and no permissions — NFR-1 and
URS §7 make this absolute. Anyone holding the shared login can do everything.

> **Open (A1):** the stakeholder described the OneDrive folder as "shared with
> family". Sharing a folder to family members' *own* Microsoft accounts is an
> alternative to one shared login and would work with the same design, but
> changes the OAuth setup. The baseline assumed here is the single shared
> account agreed in Round 1. Confirm before implementation.

---

## 4. Topology

There is **no authority**. No device is a coordinator, a primary, or a
tiebreaker. No device's opinion outranks another's. Every device:

- holds the full history locally,
- computes the shared state itself by merging (§5),
- writes **only its own files** and never touches another device's,
- reaches identical conclusions to every other device that has seen the same
  events (§5.8, invariant P2).

The "write only your own file" rule is the load-bearing one. It means two
devices can never collide on a write, which is what lets us satisfy D1 and D4
simultaneously on a backend that offers no transactions and no reliable
compare-and-swap. **Nothing in the implementation may ever write to a file
owned by another device.** Compaction (§7.5) and shop closure (§8.6) are
designed around this rule rather than being allowed to break it.

---

## 5. State model — the core of the design

### 5.1 Everything is an event

The system stores no mutable state. It stores an append-only sequence of
events, and derives current state by merging them. Every user action emits one
or more events; nothing else may change state.

```js
{
  id:       "d3f1a2-0087",      // deviceId + seq, globally unique
  dev:      "d3f1a2",           // origin device
  seq:      87,                 // monotonic per device, never reused
  deps:     { d3f1a2: 86, a91c04: 42 },  // version vector: what this device had seen
  ts:       "2026-09-13T04:21:09.881Z",  // wall clock — DISPLAY ONLY (§5.3)
  type:     "line.done",
  payload:  { shopId: "...", lineId: "...", done: true }
}
```

Events are immutable. There is no update-in-place and no delete; a correction
is a new event.

### 5.2 Device identity

On first run a device generates a random `deviceId` and stores it in
`localStorage`. It is not tied to the login and carries no personal data. The
user is invited (not required) to give the device a nickname — "Dad's phone" —
purely so the reconcile report can say who ticked what (FR-SYNC-4.2).

If `localStorage` is cleared the device becomes a new device. This is harmless:
its old events survive in its old file and still merge correctly.

### 5.3 Causality, and why clocks are not used for ordering

Each event carries `deps`: a version vector recording, per device, the highest
sequence number this device had already seen when the event was created.

Event `A` **happened-before** `B` (written `A → B`) if and only if
`A.seq ≤ B.deps[A.dev]`. If neither `A → B` nor `B → A`, the events are
**concurrent** — they were created without knowledge of each other.

`ts` is recorded for display ("ticked 3 minutes ago") and is **never** used to
order events or resolve conflicts. Phone clocks disagree, sometimes by minutes.
An ordering that trusts them lets a device with a lagging clock revert a tick it
never saw — exactly the silent loss FR-SYNC-1 forbids. This is not a
theoretical concern; it is the single most likely way to reintroduce the bug
this rebuild exists to eliminate.

> **Implementation rule:** no comparison of two `ts` values may ever decide
> whether a change takes effect, except in the explicitly clock-tolerant
> last-save-wins case of §5.5, where the requirement permits it.

### 5.4 The merge rule for ticks (FR-SYNC-1)

For any line's done-state, gather every `line.done` event for that line and
take the **maximal set** — those not happened-before any other event in the
group. Then:

> **If any event in the maximal set says `done: true`, the line is done.
> Only if *every* event in the maximal set says `done: false` is it not done.**

True wins on concurrency. Read what this means in practice:

| Situation | Outcome |
|---|---|
| A ticks; nobody else acts | Done |
| A ticks; B unticks *having seen A's tick* | Not done — B knew, and chose |
| A ticks; B unticks *without having seen A's tick* | **Done** — A's tick is concurrent, and survives |
| A unticks; A ticks again later | Done — later event causally supersedes |
| A ticks and B ticks independently | Done, and flagged as a redundant double-tick (FR-SYNC-4.2) |

The third row is the guarantee. **A tick can only be undone by an action that
demonstrably knew the tick existed.** That is precisely FR-SYNC-1's "a
distinct, later, explicit action" — "later" meaning *causally* later, which is
a fact about what the user could see, not about what their phone thought the
time was.

Where the maximal set contains more than one event with differing values, the
disagreement is real and is surfaced at reconcile as a conflict (§8.4) rather
than silently resolved. The household's own answer to Round 3 was that
unticking happens when people are standing together talking, so this should be
rare; when it isn't rare, the app says so rather than guessing.

### 5.5 Merge rules for everything else

The same machinery, with a different resolution function per entity type. This
is a small table, not a second subsystem — which is why library edits and shop
ticks share one code path (Round 4, Q5).

| Entity | Rule | Rationale |
|---|---|---|
| Shopping line done/not-done | True-wins on concurrency (§5.4) | FR-SYNC-1 |
| Menu selection present/absent | **Present-wins** on concurrency | FR-SYNC-1 covers "a menu selection has been added" |
| Menu selection cooked flag | True-wins on concurrency | Marking cooked is additive; un-cooking must be causally informed |
| Wait List item present/absent | Present-wins on concurrency | FR-WAIT-2 — an item must never vanish |
| Menu servings count | Last-save-wins | Numeric correction; loss is visible and trivially redone |
| Generated line quantity | **Not stored — derived** from the merged menu selection set | See below |
| Manually added line quantity | Last-save-wins | Nothing derives it |
| Recipe fields, ingredient fields | Last-save-wins, per field | Stakeholder Round 4: edits are rare and made in the moment |
| Shopping line removal (pre-shop) | Present-wins; removal only valid while the shop is a draft | FR-LIST-3 + §8.5 |
| Carried-over dismissal | Shop-scoped, last-save-wins | FR-MENU-7.2 — affects the current shop only |

**Quantities of generated lines are derived, never stored.** Had they been a
stored last-save-wins field, two people generating concurrently in draft — one
with menu {X}, one with {X, Y} — would each emit a total for an ingredient the
two recipes share, and the merge would keep one of them, possibly the smaller.
You would buy too few onions and nothing would say so: a silent failure, which
P-II forbids at any probability. Deriving the quantity from the merged menu
selection set removes the race entirely, because both devices converge on the
same menu and therefore compute the same total. Only manually added lines carry
a stored quantity, because nothing derives them.

A second rule of the same family, learned from the carry-over counter (§9.1):

> **Never increment. Record set membership and derive the number.** Counters
> double-count when the same logical change is computed on two devices; sets
> are idempotent under union and cannot.

Last-save-wins needs a deterministic answer for genuinely concurrent edits, or
devices would disagree forever. Order by: causal order first; if concurrent,
by `ts`; if equal, by `dev` string. Every device computes the same answer. Clock
skew here can pick the "wrong" winner by a few seconds, which is acceptable —
the requirement explicitly permits last-save-wins for library edits, and the
loss is a visible field value someone can retype, not a silently vanished tick.

### 5.6 Identity of a shopping line

A line is identified by `(shopId, ingredientId)`. Not by name, not by position,
not by a per-device generated id. Two devices adding the same ingredient to the
same shop produce events about the *same line*, which merge — rather than two
lines that later have to be de-duplicated, a process that has to decide which
one's tick to keep and is therefore a way to lose a tick.

This is why ingredient identity must be a stable id rather than a name (§12.2).

### 5.7 Regeneration is a draft-phase activity

Generating a shopping list is a **pure function** of (menu selections, staples,
Wait List, ingredient master) producing a proposed set of lines. What may be
done with that proposal depends entirely on which phase the shop is in
(§8.1) — and the two cases are different enough to state separately.

**While the shop is `draft`.** Regeneration runs freely and may emit both
additions and removals. This is safe not by permission but **by construction**:
ticking is only possible once a shop is open (FR-LIST-5), so during `draft`
*no tick exists anywhere* and there is nothing for FR-SYNC-1 to protect.
Menu edits, servings changes and the pantry check all belong here.

Two rules still hold in draft, because they protect deliberate human decisions
rather than ticks:

- A pantry-check removal (FR-LIST-3) is a `line.suppressed` **event**, not a
  deletion. A later regeneration must not resurrect flour that someone has
  already said they have. Suppression persists for the life of the draft.
  Where the suppressed line originated from a Wait List item, the suppression
  **also fulfils that item** and removes it from the Wait List (FR-LIST-4) —
  "we already have it" settles the Wait List entry just as buying it would
  (FR-LIST-7). Suppressing a line and leaving its Wait List item open would
  make the item reappear on every future shop.
- Nothing is ever overwritten. Regeneration emits events like everything else
  (§5.1); it does not compute a state and store it.

**Once the shop is `open`.** Regeneration **does not run at all.** FR-SHOP-3
locks the menu for the duration of the shop, so the inputs that produced the
list cannot change, so there is nothing to recompute. The shop's line set from
this point changes only by explicit addition (§8.5).

There is no code path anywhere that computes a fresh list and writes it over the
live one, in either phase. This is driver D2 made structural: the user cannot
tell a regeneration bug from a sync bug, so regeneration is denied the ability
to destroy anything at all — and after the lock, denied the ability to run.

**Orphaned lines.** A line whose source has disappeared while the shop is open
is marked `orphaned` in the UI and **never deleted**, because deleting it would
take its tick with it. Under FR-SHOP-3 this should now be nearly unreachable —
the menu is frozen, and the shop snapshots its generation inputs at the lock
(§6), so ordinary library edits cannot orphan a line either. It is retained as
a **defensive backstop** rather than a routine path: if a line ever does lose
its source during an open shop, the system shows that fact and keeps the tick,
instead of quietly removing evidence that someone put something in the trolley.

**Quantities** need no special handling, because generated quantities are
derived rather than stored (§5.5). A servings change in draft simply changes
what the list derives; there is no stored number to go stale and no `line.qty`
event to race. At the lock, the derived quantities are frozen into the shop's
header (§6) and do not change again for the shop's duration.

### 5.8 Why FR-SYNC-1 holds

The guarantee rests on four structural properties, not on care:

1. **No device can overwrite another's writes.** Each device appends only to
   its own file (§4). There is no lost-update window because there is no shared
   mutable target.
2. **No event is ever deleted while it still affects state.** Compaction (§7.5)
   removes only events that are causally superseded — by definition, events
   whose removal cannot change the merged result (invariant P5).
3. **A `done: true` event can only be defeated by an event that saw it.**
   §5.4's maximal-set rule, with no clock involved.
4. **Nothing else may write state.** Regeneration is additive (§5.7); shop
   closure is additive (§8.6); import runs once, before any shop exists (§12).

§14 turns each of these into a testable property rather than an assertion.

### 5.9 The phase principle

FR-SHOP-3 makes a single sentence carry most of the weight of this design:

> **Destructive operations are permitted exactly when there is nothing for
> FR-SYNC-1 to protect.**

Ticks exist only while a shop is `open` (FR-LIST-5). So the phases line up
exactly with the risk:

| | `draft` | `open` |
|---|---|---|
| Ticks in existence | none | the thing being protected |
| Menu add / remove | yes | **no** (FR-SHOP-3) |
| Line removal | yes — the pantry check (FR-LIST-3) | **no** |
| Regeneration | yes | **does not run** |
| Line addition | yes | yes (FR-SHOP-1) |
| Wait List addition | yes | yes — deliberate and purely additive |
| Tick / untick | n/a | yes (§5.4) |
| Mark cooked | yes | yes (FR-MENU-2 — not a menu change) |

Read the `open` column: **there is no destructive operation in it at all.** The
merge engine's hardest case — a removal racing a tick — cannot arise, because
removals do not exist in the only window where ticks do.

This is worth stating plainly, because it reorders the design's own priorities:
**the phase lock does more for tick durability than the merge rules do.** The
causal merge of §5.4 still earns its place — it is what makes a deliberate
untick safe, which the lock does not address — but it now guards a far narrower
risk than it was originally drawn to cover. That is the right direction for a
system with one hard guarantee: prefer making a failure impossible over making
it recoverable.

---

## 6. Storage layout

```
/FridgeList/
  state/
    snapshot/<deviceId>-<n>.json      compacted event bundles (§7.5)
    log/<deviceId>.jsonl              append-only events since that device's last compaction
  shops/
    <shopId>/
      header.json                     written once at the lock; immutable
      log/<deviceId>.jsonl            append-only shop events
      snapshot/<deviceId>-<n>.json    compacted shop events, incl. the close (§8.6)
      presence/<deviceId>.json        heartbeat; small; overwritten by its owner only
  archive/
    shops/<shopId>/                   closed shops, retained per §15.3
```

`state/` holds everything long-lived: recipes, the ingredient master list,
staples, the Wait List, menu selections (including carry-over status), and
settings. `shops/<shopId>/` holds everything scoped to one shop: its lines and
their done state. Menu selections live in `state/` rather than in a shop
because they outlive shops — that is what carry-over means (FR-MENU-3).

There is no shared `closed.json` and no trip-history file. Both existed in v0.1
and both broke the rule above: a file written by whichever device happened to
act, and therefore a file two devices could overwrite. Closing is an event
(§8.6) and trip history is derived from those events (§15.3). Every file in the
tree is now either written by exactly one device, or written exactly once and
never again.

`header.json` is written once when the shop locks, and records **the resolved
line set and the inputs that produced it** — menu selection ids, the staple set,
Wait List ids, and the recipe revisions used. Because FR-SHOP-3 freezes those
inputs, the open shop holds no live references to the library: a recipe edited
mid-shop by whoever is cooking cannot alter a list someone is standing in a shop
holding. It also means FR-HIST-1's trip record falls out for free at close — the
selections are already captured.

Every path containing `<deviceId>` is written by that device and no other. The
only file not so scoped is `header.json`, written exactly once at the lock and
never modified. Two devices locking concurrently write identical content, since
both derive it from the same merged menu.

---

## 7. The sync engine

### 7.1 Local-first

Every user action is applied to local state and written to IndexedDB
**synchronously with the tap** — before any network call. The UI updates from
local state. Upload happens afterwards, asynchronously, and may fail without
the user losing anything (D5, FR-SYNC-6).

IndexedDB holds the complete event history plus a derived state cache. This is
what makes every device a full replica (D10), and what lets the app open
instantly rather than waiting on the network.

### 7.2 Change detection

Polling uses the Graph **delta** query on the folder, which returns only what
changed since the last call. That makes a poll cheap regardless of how much
data is stored. Individual files are fetched with `If-None-Match` against their
stored ETag, so an unchanged file costs a 304 and no body.

### 7.3 Cadence

| Situation | Poll interval | Notes |
|---|---|---|
| Shop open, app in foreground | 3 s | Ticks propagate within a few seconds |
| Shop open, app backgrounded | on resume | Phones suspend timers; resume triggers an immediate poll |
| No shop open | on launch, on focus, after any local write, else 60 s | Library changes are not urgent |

The 1 MB library is never re-fetched by a poll — only when its snapshot file's
ETag actually changes (D8).

### 7.4 The upload queue

**This design depends on the upload being atomic.** A device rewrites its own
`.jsonl` with new events appended; were that write to land partially, the device
would truncate its own log and lose its own events — the same failure the whole
file layout exists to prevent, self-inflicted. A Graph simple upload of a small
file is atomic: it creates a new version of the item rather than mutating it in
place, so a failed upload leaves the previous version intact and the retry
re-sends. **Any future storage backend must provide the same guarantee**
(§15.2); it is not optional, and it had been assumed rather than stated until
the failure autopsy asked why F1 could not recur.

Unsent events sit in an IndexedDB queue. On failure, retry with exponential
backoff (2 s, 4 s, 8 s, 16 s, then every 30 s) until success. Uploads are
appends of whole-file content: the device rewrites its own `.jsonl` with the
new events included. Since only that device writes that file, the rewrite
cannot lose anyone's work — and if it fails halfway, the previous version
remains and the retry re-sends.

The queue depth is visible in the UI (§8.3). A device with unsent events says
so. It never claims to be up to date.

### 7.5 Compaction

Logs grow. Compaction keeps them small, and must do so without ever risking
property 2 of §5.8.

A device compacts when its own log exceeds a threshold (256 KB or 2,000
events). It writes `state/snapshot/<deviceId>-<n>.json` containing **the set of
events still affecting current state**, with superseded events dropped, plus
the version vector those events cover. It then truncates its own log to the
events not covered.

A snapshot is therefore *a log with dead events removed* — not a different kind
of thing. Readers merge snapshots and logs with identical code (§5.1), which
means compaction adds no new merge logic and therefore no new place for a tick
to disappear. Snapshots are per-device files, so two devices compacting at once
cannot collide; a device deletes only its own older snapshots, and only after
writing the newer one successfully.

---

## 8. The shop lifecycle

### 8.1 States

`draft` → `open` → `closed`. At most one shop is not `closed` at any time
(SRS §2) — and this is guaranteed structurally rather than by convention:

> **Nobody creates a shop.** There is always exactly one current shop, in
> `draft`. Generating a list populates it; locking transitions it; closing it
> brings the next one into being. Shop ids form a chain — each shop's close
> event names its successor's id, derived deterministically from its own, from
> a fixed genesis id.

Two people therefore cannot start two shops, because starting a shop is not an
operation that exists. This matters more than it looks: were two shops to exist,
ticks would split silently between them, which P-II forbids. Deterministic
successor ids also mean two concurrent closes name the same next shop rather
than forking the chain.

**`draft`** is where decisions are made: pick the menu, set servings, generate,
and do the pantry check (FR-LIST-3). Everything is editable, and regeneration
runs on demand (§5.7).

**Locking the menu is one action; joining as a shopper is another.** They are
deliberately separate:

- **"Menu is settled"** — pressed once, by whoever happens to be there, after
  the meals are chosen. It locks the menu for everyone. Concurrent presses are
  harmless: the lock is a true-wins register (§5.4), so two people pressing it
  produce one lock.
- **"I'm shopping"** — pressed by each person going to the shop, at whatever
  time suits them. This is the roster (§8.2), and it drives staleness reporting.

Per FR-SHOP-3, from the lock until the shop finishes:

- **No menu selection may be added or removed.** The week's plan is settled.
- **No shopping-list line may be removed.** The pantry check is over.
- **Lines may be added** — a Wait List entry or a direct addition (FR-SHOP-1).
- **Lines may be ticked and unticked** (FR-LIST-5, §5.4).
- **Selections may be marked cooked** (FR-MENU-2) — that is not a menu change.

The rationale is the household's own: *a shop is the execution of a decision
already made, so the decision is not revised while it is being executed.* The
architectural payoff is §5.9 — it removes every destructive operation from the
only window in which ticks exist. Nobody can delete a line, or the menu entry
behind it, out from under someone else's tick, because during a shop nobody can
delete anything at all.

Wait List additions are the deliberate exception, and they are safe for the same
reason FR-SYNC-1 permits them: they are purely additive. Someone spotting an
empty jar of mayonnaise in aisle six adds to the list; they never take away.

**A menu addition already in flight when the lock lands is not discarded.**
Someone adding a recipe at the same moment another person locks has not seen the
lock, so the two events are concurrent — and FR-SYNC-1 protects menu additions
as explicitly as it protects ticks. Rejecting it would be exactly the silent
loss this design exists to prevent. So the addition lands, and its ingredients
join the list **as additions**, which the lock already permits (FR-SHOP-1). The
household is told, not asked: *"Chicken Adobo was added as the list locked — its
ingredients are on the list."* Informational, in the same register as the
double-tick report (§8.4) and the carry-over section (§9.1).

Stated precisely, then: **the menu is locked from the moment each device sees
the lock; anything already in flight lands as an addition.**

### 8.2 The shopper roster and presence

When a shop opens, household members **nominate themselves as participating**.
Joining is explicit — a tap — because the roster is what staleness reporting is
scoped to (D6). A device that starts ticking without nominating is enrolled
silently and shown as a participant, so no one's work is invisible.

Each participating device writes `presence/<deviceId>.json` every 15 seconds:
its nickname, its last successful sync time, and its unsent-queue depth. Its own
file, per §4. Presence is how the app answers "who's about" — and it works
across the whole store, which Bluetooth proximity would not have (§18.5).

A device leaves by tapping "I'm done", or drops off the roster automatically
after 5 minutes without a heartbeat. A dropped device cannot hold up a close
(§8.6).

### 8.3 Showing staleness (FR-SYNC-2)

Two independent conditions, both surfaced, per the stakeholder's Round 3 answer:

- **Am I current?** Time since this device's last successful poll, plus its
  unsent-queue depth. Shown always, as plain text: "synced 4s ago", or
  "not syncing — 3 unsent, last synced 4m ago".
- **Is everyone else current?** Per participating shopper, time since their last
  heartbeat: "Sam · 20s", "Alex · 6m ⚠".

Either condition exceeding 60 seconds raises a visible warning. The app must
never render a list that looks current when it is not — if sync state is
unknown, it says unknown. A brief lag is fine and is stated (FR-SYNC-3); a
confident-looking lie is the defect.

### 8.4 Reconcile (FR-SYNC-4)

Available at any time, not only at the end. Reconcile forces an immediate full
sync — upload everything queued, fetch every device's log — then reports:

1. **The union.** Every tick and every addition from every device, retained.
   Never a one-sided overwrite; this is just §5.4 applied, so it needs no
   special path and cannot diverge from ordinary syncing.
2. **Double-ticks** (FR-SYNC-4.2): lines independently ticked on more than one
   device. Informational — someone bought it twice, or one of you picked it up
   and forgot to say. Not an error.
3. **Gaps** (FR-SYNC-4.3): lines still not done on any device. A decision is
   needed: get it, or accept it's not happening.
4. **Disagreements**: lines whose maximal event set contains both a tick and an
   untick (§5.4). Shown as "Sam ticked this, Alex unticked it" with both times,
   for the two of you to settle out loud.

### 8.5 Adding mid-shop (FR-SHOP-1)

Two things may be added during an open shop: a **Wait List entry** (which also
becomes a line on this shop's list) and a **direct addition** to the list. A new
*menu selection* may not — that is FR-SHOP-3, and it is the one change from the
original requirement.

Adding emits `line.added` and nothing else. No regeneration is triggered (it
cannot run — §5.7), no existing line is recomputed, no done state is touched.

The UI must refuse menu changes during an open shop rather than accepting and
discarding them: an event asserting a menu add or removal against an open shop
is invalid and is rejected at the point of creation, not filtered out during
merge. Validation in the merge engine would mean such an event could exist, and
anything that can exist eventually arrives in an order nobody planned for.

### 8.6 Closing a shop

One person taps "Shopping is completed", as the household does today
(FR-SHOP-4). The app:

1. Forces a full sync.
2. Shows the FR-SYNC-4.3 gap report **and** the roster's freshness — including
   "Alex's phone hasn't checked in for 11 minutes", and a warning if the closer's
   own device has not synced recently, since the report they are acting on is
   computed from their view.
3. Lets them finish anyway, with all of that plainly visible.

**Closing is an event, not a file.** An earlier draft of this document had the
closing device write a shared `closed.json` — which broke §4's rule that a
device writes only its own files, and would have let two concurrent closes
overwrite each other. If the surviving file covered fewer events, devices would
then have deleted their logs against an incomplete version vector, losing ticks
silently. §7.5 had already solved this exact problem for snapshots, so closing
reuses it rather than inventing anything:

- Closing emits a `shop.closed` event into the closer's **own** log, carrying
  the selections and the close time. It is a true-wins register (§5.4), so
  concurrent closes converge on one close.
- The compacted final state is written as a **per-device snapshot**, exactly as
  §7.5 describes.

No shared file, no race, no new mechanism.

**Then each device deletes its own log and presence file** — after confirming
its own events are covered by the merged close. No device ever deletes another's
file. The worst case is a stray small file from a device that was offline at
close, cleaned up when it next opens.

A device that reconnects after close holding events the close did not cover does
not discard them and does not hide them. It uploads them; they merge normally,
and the closed shop's line states update. It then raises: "3 ticks from this
device arrived after the shop was closed" — with what they were.

This is safe only because of a decision made for an unrelated reason: trip
history records **recipes selected and the close time, nothing more** (Round 6).
Late-arriving ticks cannot change either, so FR-HIST-1's "never edited after
being written" is never threatened by them. A trip history that had stored line
detail would have been invalidated by exactly this case.

**Wait List fulfilment (FR-LIST-7).** At close, every **done** line that
originated from a Wait List item fulfils that item, removing it from the Wait
List. Without this, buying something never takes it off the list and it returns
every week — a silent failure, and the kind P-II says to fix regardless of how
mundane it looks.

**If nobody closes the shop.** Because the menu is locked (FR-SHOP-3), an
unfinished shop blocks planning the next one. This failure is accepted under
P-II — it is loud, and one button fixes it — but only on the condition
FR-SHOP-4 attaches: wherever the system declines an action because a shop is
still open, it must **name the open shop and offer the completion action from
that same place**. A bare refusal would turn a loud failure into a stuck one.

A device whose view is of a shop that has since closed shows "this shop finished
20 minutes ago" with what changed, rather than continuing to present a list that
is no longer live.

---

## 9. Domain model

Derived state, computed by merging events (§5). Types shown as they exist in
memory; the events that produce them are per-field changes.

```js
Ingredient {
  id, name,
  shoppingUnit,                    // 'g' | 'mL' | 'qty'
  category,                        // shopping-list header  (FR-ING-2)
  aisle,                           // shopping-list subheading
  conversions: { [cookingUnit]: factor },   // FR-ING-1
  preference,                      // optional brand/flavour note (FR-ING-3)
  isStaple, stapleQty              // FR-STA-1/2, held on the ingredient
}

Recipe {
  id, name, category, servings,
  lines: [{ ingredientId, quantity, unit, displayQty, displayUnit }],
  method: [...], notes, source, sourceUrl, images
}

MenuSelection {
  recipeId, servings,
  status,                          // planned | cooked | carried | flagged
  addedAt, statusChangedAt,
  carriedInto: Set<shopId>         // NOT a counter — see §5.5, §9.1
}

WaitListItem { id, ingredientId, note, addedAt }

ShoppingLine {
  shopId, ingredientId,            // identity — see §5.6
  qty,                             // DERIVED for generated lines (§5.5);
                                   // stored only for manual additions
  unit, sources: [...],            // recipe | staple | waitlist | manual
  done, doneBy, doneAt,
  orphaned                         // its source went away (§5.7)
}
```

**Staple status is a property of the ingredient**, held separately from recipe
membership and Wait List membership, and the three are never conflated —
FR-STA-2 names this explicitly as a defect class to design out.

### 9.1 Carry-over (FR-MENU-3, -5, -7)

Status transitions are computed when a new shop is generated — a `draft`-phase
activity, per §5.7 — and emitted as **explicit events**, never inferred at
render time. Inferred status would be
recomputed differently on devices holding different subsets of history, and
would therefore drift.

- Generating a new shop: each `planned` selection not `cooked` becomes
  `carried`.

A selection records **the set of shops it has been carried into**, not a
counter. Two devices generating in draft both compute the same transition; set
union makes that idempotent, whereas an incremented counter would reach two and
send the entry straight to `flagged` a week early. This is the "never increment"
rule of §5.5 in practice, and it is the whole fix for that defect.
- Generating again: each `carried` selection not `cooked` becomes `flagged`
  (FR-MENU-5). A flagged entry demands an explicit resolution — cook, remove, or
  deliberately re-plan — and says so in the picker until someone acts.
- `carried` behaves exactly like `planned` for cooking and for appearing in the
  picker (FR-MENU-4).

The **"Carried over — check before buying"** section (FR-MENU-7) is derived, not
stored: ingredients needed *only* by `carried` selections, with no `planned`
selection or staple also needing them. An ingredient needed by both is already
on the main list and does not appear here (FR-MENU-7.3).

From that section a line can be moved onto the main list, or dismissed. Neither
is required — it is a prompt, not a gate. Dismissal is scoped to the current
shop (FR-MENU-7.2), so nothing is remembered and the item is free to reappear
next shop if still unresolved. This is what closes the URS §10 open question.

---

## 10. Shopping list generation and layout

Generation (FR-LIST-1, -2) is a pure function, exercised directly by tests. It
runs only while the shop is `draft` (§5.7); once the shop is locked its output
is fixed.

1. For each `planned` menu selection, scale each recipe line by
   `servings / recipe.servings`.
2. Convert cooking units to the ingredient's shopping unit via
   `conversions` (FR-ING-1). A quantity is never presented or totalled
   unconverted.
3. Add every staple ingredient at its staple quantity (FR-STA-1).
4. Add every open Wait List item.
5. Sum by `ingredientId` into a single line per ingredient, retaining the list
   of contributing sources (FR-LIST-2). This sum is **derived on read from the
   merged menu selection set**, never stored as a field (§5.5), so two people
   generating concurrently cannot disagree about it.
6. Exclude carried-over-only ingredients from the main list; they go to the
   carry-over section (FR-MENU-7.1).

Applied additively per §5.7.

### 10.1 Layout (FR-LIST-6)

**Category as header, aisle as subheading** — the stakeholder's decision in
Round 7, and the data supports it: the two fields form a clean hierarchy with no
crossovers, but category alone puts 282 of 452 ingredients (62%) into *Pantry*,
which would make "you take Pantry, I'll take the rest" a useless split.

```
Fruit and Vegetables
    Fruit          …
    Vegetables     …
Meat
    Meat           …
    Fish           …
Cold
    Dairy · Deli · Freezer
Pantry
    Baking · Spices · Sauces · Breakfast · Biscuits · Rice/pasta ·
    Tins - veg · Beverage · Alcohol · International · Bakery ·
    Tins - fruit · Snacks
Toiletries
Other
```

Six headers to scan, with enough internal structure that a person can be handed
"Pantry, Baking through International" and have a coherent run. Never
alphabetical, never insertion order.

A line whose ingredient carries a preference note displays it (FR-ING-4).

### 10.2 Printing

A `@media print` stylesheet renders the grouped list for the fridge door —
headers, subheadings, tick boxes, no app chrome. Pure CSS, no dependency, no
export pipeline. Confirmed wanted in Round 4.

---

## 11. Application structure

```
/
  index.html            app shell
  sw.js                 service worker (app code caching only)
  manifest.webmanifest
  src/
    core/               NO I/O, NO DOM — pure, and the most heavily tested code
      events.js         event construction, version vectors, causality
      merge.js          the resolution rules (§5.4, §5.5)
      store.js          derived state + subscriptions (§11.1, FR-SYNC-7)
      shop.js           the shop chain and phase permissions (§8.1)
      library.js        recipes, ingredients, cook history (§9, FR-HIST-2)
      generate.js       shopping list generation (§10)
      carryover.js      status transitions (§9.1)
      units.js          conversion (FR-ING-1)
    data/
      persist.js        IndexedDB: the full local replica (§7.1)
      storage.js        the five-function storage interface (§15.2)
      onedrive.js       that interface, over Graph (§3.3)
      sync.js           polling, delta, upload queue, compaction
      presence.js       heartbeats, roster, staleness
    ui/
      main.js           mount and router; subscribes views to the store
      app.js            wiring and every action; owns the side effects
      dom.js            h() and bind() — no framework (§13)
      views.js          plan, list, wait list, recipes
      status.js         staleness, roster, phase actions, close report
      styles.css        phone-first, with the print sheet of §10.2
  tools/
    import.js           one-off migration (§12) — Node, run once
  test/
    harness.js          scenario replay under environmental variation (§14.1)
    properties.test.js  the invariants (§14)
    store.test.js       FR-SYNC-7 — a merge reaches the screen (§11.1)
    storage-contract.test.js   what any storage backend must satisfy (§15.2)
    fakes/storage.js    an in-memory backend that misbehaves on purpose
```

### 11.1 The merge must reach the screen (FR-SYNC-7)

Every requirement about synchronisation constrains how data moves **between**
devices. None constrained how it moves from a device's own state to its own
screen — and a device that has merged a tick correctly but still displays the
old list is, to the person holding it, identical to one that never received the
tick. That was a live hole until the failure autopsy found it, and it is a
plausible root cause of one of the two failures actually reported.

So: **a merge that changes derived state re-renders the affected views, with no
user action.** Concretely — the store publishes a change; views subscribe; no
view reads state once at mount and keeps it. There is no pull-to-refresh
anywhere in this app, and no screen that is only correct just after you opened
it.

This is not testable by the property suite in §14, which exercises the engine
and never the screen. It is checked by a scenario test (Stage 3): merge an
event from a simulated second device and assert the rendered list changed.

`src/core/` is pure: no network, no DOM, no storage, no clock except what is
passed in. That is what makes the invariants testable by generating millions of
scenarios in memory (§14). **The merge rules must not leak outside
`core/merge.js`.** A resolution decision made anywhere else is a bug, because it
is a decision no property test is watching.

---

## 12. Migration from existing data

A one-off Node script, `tools/import.js`, run once by the maintainer, producing
an initial snapshot uploaded to `state/snapshot/`. Not part of the app, not
shipped to devices. Input: the household's existing `recipes-data.json`,
`trip-history.json`. The in-progress shopping list is not imported — per-shop
state is ephemeral by design.

### 12.1 What the data looks like

Analysed 2026-09-13, in full, with the results in
[`data/DATA-REVIEW.md`](data/DATA-REVIEW.md) and a corrected source at
`data/recipes-data.reviewed.json`.

**Referential integrity is perfect**: 5,561 recipe ingredient lines across 638
recipes reference 438 distinct ingredient names, and every one resolves against
the 452-entry master list. Zero orphans. This is a clean import, not a salvage.

Two findings from that review bear on the design rather than on the data:

- **Conversions in the source are volumetric, not gravimetric.** Every
  ingredient converts at 1 cup = 250, whatever it is — the number is millilitres
  carried into a field labelled grams. For dense ingredients that is near
  enough; for leafy ones it overstates by up to tenfold. FR-ING-1 requires a
  real conversion, so either the factors are corrected or those ingredients move
  to a `qty` shopping unit. **Unresolved — it changes what the household buys,
  so it is theirs to decide.**
- **Some ingredients should never reach a shopping list** — `water` is in the
  master list. The model has no way to express that today. Either a data fix or
  a "never shop this" flag on the ingredient; see §19 A6.

### 12.2 Transformations

| Step | Action |
|---|---|
| Ingredient identity | Assign a stable `id`; rewrite all 5,561 references from name to id (Round 6). Names become editable display labels — a typo fix can no longer orphan 40 recipe lines |
| Duplicate names | 452 entries, 450 distinct names — but the duplicates (*Mint*, *Tahini*) are **not** the same thing: one Mint is fresh (Vegetables aisle), the other dried (Spices). They must be disambiguated by hand before the import assigns ids, not merged. See `data/DATA-REVIEW.md` §2 |
| Aisle casing | Merge `Baking`/`baking`, `Biscuits`/`biscuits`, `Freezer`/`freezer`, `International`/`international`. 26 values → 22 |
| Quantities | 1,269 of 5,561 are strings, the rest numbers. Coerce to number; fail loudly on anything unparseable |
| Units | `unit` is the shopping unit; `displayUnit` the cooking unit. Absent on 3,104 lines, meaning cooked and shopped in the same unit — no conversion, which satisfies FR-ING-1 trivially |
| Staples | From `settings.staples` + `settings.stapleQty` onto the ingredient (§9) |
| Trip history | **Recipes selected and timestamp only** (Round 6); line detail discarded. Two-year cut applied |
| Anomalies | One ingredient has an empty shopping unit — **flagged in a report, not auto-fixed** |

The script writes `import-report.md`: every merge performed, every coercion, and
every anomaly needing a human. The stakeholder's instruction (Round 6) is that
sanitisation happens *after* the main app is built, so the report is the
deliverable, not a blocking gate.

---

## 13. Technology choices

**Vanilla ES modules. No bundler, no framework, no runtime dependencies.**

The reasoning is D7. Frameworks themselves are usually fine; the *build
toolchain* is what rots. Return in eighteen months and `npm install` pulls a
transitive dependency that no longer resolves, or Node has moved on and the
bundler won't run — and now there is maintenance archaeology standing between
you and a one-line change. Browsers, by contrast, run twenty-year-old JavaScript
without complaint. A file you can open and read is also a file an LLM can read.

The structure a framework would impose comes from the module boundaries in §11
instead. That is a discipline, and it is cheaper to sustain than a toolchain.

**Dev-only dependencies:** `vitest` and `fast-check`, for §14. They are allowed
to rot. If they break in 2029, the app is unaffected and the invariants can be
re-verified with whatever exists then.

**Two external runtime pieces**, both unavoidable and both pinned:
- `@azure/msal-browser` for OAuth (writing PKCE by hand would be worse).
- Microsoft Graph, called with `fetch`. No SDK.

---

## 14. Verification

Per D9: written once, kept in the repository, run on demand when the merge code
changes. Not a CI obligation.

Unit tests would prove almost nothing here — the bugs in a merge engine live in
the orderings nobody thought to write down. So the core is tested by
**property-based testing**: `fast-check` generates thousands of random
scenarios — N simulated devices, random sequences of ticks, unticks, adds,
removals, regenerations, compactions, and network partitions delivering events
in arbitrary orders to arbitrary subsets — and asserts these five invariants
hold in every one.

| | Invariant | Guards |
|---|---|---|
| **P1** | **Tick durability.** If any event sets a line done, and no untick event exists that causally follows *every* tick on that line, then every device that has seen the tick computes `done`. Under every ordering, every partition, every subset. | FR-SYNC-1 |
| **P2** | **Convergence.** Any two devices that have seen the same set of events compute byte-identical state, regardless of the order they arrived. | FR-SYNC-3 |
| **P3** | **Addition durability.** A menu selection or Wait List item, once added, is present on every device until an explicit causally-later removal. | FR-SYNC-1, FR-WAIT-2 |
| **P4** | **Regeneration safety.** Regenerating at any point, any number of times, with any inputs, never changes any existing line's `done` state. | FR-SHOP-2, D2 |
| **P5** | **Compaction safety.** `merge(compact(E)) == merge(E)` for every event set E. Compaction can never change an outcome. | §5.8 property 2 |
| **P6** | **Phase integrity.** No removal event of any kind — line, menu selection, or Wait List item — is ever valid against a shop in the `open` phase. Generated scenarios attempt them; the engine must reject every one. | FR-SHOP-3, §5.9 |
| **P7** | **Single shop.** No sequence of events, under any interleaving, produces two shops simultaneously not `closed`, or forks the shop chain into two successor ids. | SRS §2, §8.1 |
| **P8** | **Wait List closure.** A Wait List item whose line was **done** at close is absent from the Wait List afterwards; one whose line was not done is still present. | FR-LIST-7, FR-WAIT-2 |

P1 and P4 are the two that matter most, because they are the two failures the
household actually experienced. P6 is the cheapest of the eight and arguably the
highest-leverage: it verifies the structural claim of §5.9, and if it holds then
a large share of P1's scenario space is unreachable rather than merely safe. A shrinking counterexample from `fast-check` is
worth more than any amount of reading the code.

### 14.1 Every property is asserted under variation, never against one run

A property checked against a single replay of a scenario is a property checked
under one arbitrary set of conditions. So `test/harness.js` replays each
generated scenario under **every environmental variation that must not matter**
— per-device clocks skewed in both directions, shuffled delivery order,
compacted and uncompacted — and fails if any of them changes the answer. Every
property goes through it; using the raw scenario runner gets you a single-run
test, which is what the harness exists to discourage.

This began as one property about clock skew, which was the one that caught the
household's original failure class outright. There was no reason for that to be
a single property rather than the way all of them are written.

One caveat, recorded so it is not later "fixed" the wrong way: invariance under
clock skew holds for causally-resolved registers, which is all of them today. A
last-save-wins field is *permitted* to depend on `ts` (§5.5). If one is added it
must be projected out of the comparison — never the harness loosened.

### 14.2 Testing what cannot be pure

The property suite exercises the merge engine and nothing else. Both failures
the household actually reported happened at the edges — storage in one reading,
rendering in the other — so the edges get their own treatment:

- **Rendering** (`test/store.test.js`). `src/core/store.js` keeps the
  notification logic pure, which makes FR-SYNC-7 testable without a DOM: events
  in, subscribers told, and a property asserting that after any interleaving,
  delivered in any chunk size, what the last notification carried equals the
  merged truth. It also asserts the converse — no notification when the answer
  did not change — so a blind untick that loses does not cause a re-render.
- **Storage** (`test/storage-contract.test.js`). The backend is defined by an
  executable contract that any implementation must pass, exercised against an
  in-memory fake that fails on purpose. The OneDrive adapter runs the same
  contract when it exists.

The atomicity requirement of §7.4 is in that contract, and one test exists
purely to demonstrate why: with a non-atomic backend, a device destroys its own
log and loses ticks no other device holds a copy of.

Writing it surfaced something the requirement had not stated. A retry
immediately after a bad write *heals* the corruption — so the loss only becomes
permanent when the device does not get to retry. That is not an exotic case: it
is a phone going back into a pocket, the app suspending, or a flat battery by
the freezers. **A durability property that holds only while the app stays awake
is not durability**, and the test now models the interruption rather than
assuming a co-operative device.

Beyond all of this: worked examples of unit conversion (FR-ING-1), list
generation (§10), and the carry-over state machine (§9.1) — ordinary unit tests,
since those are pure functions with known answers.

---

## 15. Data ownership and longevity

### 15.1 Where the data actually lives

**On every device.** Each phone and the tablet holds the complete event history
in IndexedDB. OneDrive holds a copy and moves files between them.

This is the answer to "what if the backend disappears". If OneDrive vanished
tomorrow, nothing is lost: five devices still hold the full history, and the
storage layer is pointed somewhere else. The data is not *in* OneDrive in any
meaningful sense — it is *mirrored through* it.

An authoritative-server design does not have this property: there the server
holds the truth and the phone holds a cache. That asymmetry is why §18.1 rejects
it, and it is the substance of driver D10.

### 15.2 Switching backends

All storage access goes through one module exposing five functions:

```js
list(path)            // → [{ path, etag, size, modified }]
read(path, etag?)     // → { content, etag } | NOT_MODIFIED
write(path, content)  // own files only — enforced by convention and review
remove(path)          // own files only
delta(cursor)         // → { changes, cursor }   (falls back to list() if unsupported)
```

Nothing above this line knows what OneDrive is. Porting to Dropbox, Google
Drive, a WebDAV share on the NAS, or the File System Access API is a day's work
against a known interface, and §14's properties re-run unchanged to prove the
port didn't break the guarantee.

`delta` is the only function with no universal equivalent; the fallback is
`list()` plus ETag comparison, which is slower but correct.

### 15.3 Retention

| Data | Retention |
|---|---|
| Recipes, ingredients, staples | Indefinite |
| Wait List | Until fulfilled or removed (FR-WAIT-2) |
| Menu selections | Until cooked, removed, or resolved from flagged |
| Open shop logs | Deleted at close, after compaction into a per-device snapshot (§8.6) |
| Closed shop line detail | 12 months in `archive/`, then deleted |
| `shop.closed` events (trip history) | **2 years** (Round 5) |

**Trip history is not stored separately.** It is the set of `shop.closed`
events, each carrying the recipes selected and the close time — which is exactly
what FR-HIST-1 requires and nothing more (Round 6). The event's immutability
satisfies "written once, never edited" for free, and removes a shared
append-only file that two devices could have raced on.

Retention then splits cleanly: the small `shop.closed` events live two years and
feed the FR-REC-4 "how long since we had this?" signal — roughly 104 records of
a few hundred bytes. The bulky per-shop line snapshots are archived at twelve
months and deleted, since nothing reads them.

### 15.4 Backup

A weekly scheduled copy of the OneDrive folder to the household NAS. The NAS is
a **backup target, not a server**: nothing in the supermarket ever talks to it,
so it adds no open ports, no certificates, and no availability risk. It gives
the household an offline archive they fully own — which was the real concern
behind the self-hosting question in Round 8 — without the availability
regression that hosting on a domestic connection would bring (§18.2).

The files are plain JSON. They can be copied, emailed, or read in a text editor
without the app, which is the ultimate escape hatch.

---

## 16. Security and privacy

Deliberately minimal, and appropriate to the deployment:

- **One shared login**, full trust within the household (NFR-1). Anyone holding
  it sees everything. This is the household's explicit preference.
- **Data is not encrypted at rest** beyond OneDrive's own. Confirmed acceptable
  in Round 5: nothing here is sensitive, and readable-by-hand JSON is a feature.
- **No secrets in the app.** The OAuth client id is public by design; there is
  no client secret, because a static app cannot keep one. PKCE covers this.
- **No public endpoint.** Unlike a self-hosted or backend-as-a-service design,
  there is nothing exposed to the internet that could be misconfigured into
  readability. The only access path is the Microsoft login.
- **No analytics, no telemetry, no third-party scripts.** The app talks to
  Microsoft Graph and nothing else.
- **No notifications** of any kind (NFR-2) — explicitly not wanted.

---

## 17. Requirements traceability

| Requirement | Where satisfied |
|---|---|
| FR-ING-1 conversion | §9, §10 step 2, §12.2, `core/units.js` |
| FR-ING-2 one group | §9 (`category`), §10.1 |
| FR-ING-3/4 preference | §9, §10.1 |
| FR-REC-1 recipes | §9 |
| FR-REC-2 anyone may edit | §5.5 (last-save-wins); §6 (an open shop is immune, via the header snapshot) |
| FR-REC-3 last selected | §9, §15.3 |
| FR-REC-4 signal in the picker | §9.1, §15.3 |
| FR-REC-5 no bulk delete | Not implemented — deliberate absence |
| FR-STA-1/2 staples | §9 (property of ingredient), §10 step 3 |
| FR-MENU-1–6 lifecycle | §9.1; FR-MENU-1 and FR-MENU-6 bounded by §5.9, §8.1 |
| FR-MENU-7 carry-over section | §9.1, §10 step 6 |
| FR-WAIT-1/2 Wait List | §9, §5.5 (present-wins) |
| FR-LIST-1–3 generation | §10 |
| FR-LIST-4 removal fulfils Wait List item | §5.7 |
| FR-LIST-5 done state | §5.4 |
| FR-LIST-6 grouping | §10.1 |
| FR-LIST-7 Wait List fulfilled by purchase | §8.6, §14 P8 |
| FR-SHOP-1 add mid-shop | §8.5, §5.7 |
| FR-SHOP-3 menu lock | §5.7, §5.9, §8.1, §8.5, §14 P6 |
| FR-SHOP-4 explicit completion | §8.6 |
| FR-SHOP-2 no side-effect reset | §5.7, §14 P4 |
| **FR-SYNC-1 tick durability** | **§5.4, §5.8, §14 P1** |
| FR-SYNC-2 visible staleness | §8.2, §8.3 |
| FR-SYNC-3 bounded delay | §7.3, §14 P2 |
| FR-SYNC-4 reconcile | §8.4 |
| FR-SYNC-5 transport unconstrained | §15.2 |
| FR-SYNC-6 brief offline | §7.1, §7.4 |
| FR-SYNC-7 display currency | §11.1; `FAILURE-AUTOPSY.md` F2(c) |
| FR-HIST-1 immutable trip record | §8.6, §15.3 (the `shop.closed` event itself) |
| FR-HIST-2 signal derived from history | §15.3 |
| NFR-1 no roles | §3.3 |
| NFR-2 no notifications | §16 |
| NFR-3 one household | §3.2 |
| NFR-4 not store layout | §10.1 |

---

## 18. Alternatives considered and rejected

### 18.1 Authoritative server (Supabase or similar)

**Genuinely attractive.** Postgres assigns ordering server-side, eliminating
clock skew entirely; a version column makes the tick/untick rule a constraint
the database *enforces* rather than one we implement and must prove; Realtime
subscriptions propagate sub-second, which matters when two people are at
opposite ends of the store.

Rejected because:

- **The client becomes a cache, not a replica.** The server holds the truth. If
  the service goes away or the free tier changes, the household's data is
  somewhere they must extract it from — not already sitting on five devices.
  This is the decisive point, and it is driver D10.
- **Free-tier projects pause after ~7 days of inactivity.** A weekly-shopping
  household lives on that boundary and any holiday guarantees a pause —
  discoverable, in the worst case, while standing in the shop. Mitigable with a
  scheduled keep-alive job, at which point the zero-infrastructure system has
  infrastructure (D4).
- **A static app cannot hide a key.** Row-level security becomes the only thing
  between the data and the internet. Correctly configured it is fine; the
  file-based design has no equivalent surface at all.

### 18.2 Self-hosting on the household NAS

Rejected: it makes the primary worry worse, not better. A PWA served over HTTPS
cannot call `http://nas` — browsers block mixed content — so the NAS needs a
real certificate on a real hostname, which means a domain, dynamic DNS, and
either a forwarded port (exposing a box full of family documents, the exact
configuration NAS ransomware campaigns have targeted) or a tunnel service
(reintroducing the third-party dependency the move was meant to remove).

More fundamentally: the NAS sits behind domestic power and a domestic internet
connection. A router reboot or an outage makes the shopping list unreachable
*from the supermarket*. Self-hosting maximises continuity of ownership and
minimises availability at the moment of use. Those are different goals, and
§15.4 serves the first without sacrificing the second.

### 18.3 Last-writer-wins by wall-clock timestamp

Rejected for tick state. Phone clocks disagree; a device with a lagging clock
could revert a tick it never saw. That is a silent loss and a direct FR-SYNC-1
violation. Retained *only* for library edits (§5.5), where the requirement
explicitly permits last-save-wins and the failure mode is a retypeable field.

### 18.4 Grow-only union (ticks can never be undone)

Trivially satisfies FR-SYNC-1 and was rejected by the stakeholder in Round 3:
people pick up the wrong thing and need to undo it when they regroup. §5.4
keeps the guarantee while permitting a *causally informed* undo.

### 18.5 Bluetooth / Wi-Fi proximity or a supermarket mesh

Not available to a PWA. Web Bluetooth does not exist in Safari/iOS, and where it
exists it is GATT-client-only behind a per-device chooser — a web page cannot
advertise itself or discover peers. A browser page also cannot listen for
incoming connections, so phone-to-phone serving is impossible regardless of
hotspots. WebRTC could open a data channel, but needs signalling, which on a LAN
would mean scanning QR codes — redone on every reconnect, with iOS suspending
the page whenever the screen locks.

It is also largely self-cancelling: a hotspot's uplink *is* mobile data, so if
the hotspot is useful both phones already have internet and OneDrive works.

Presence heartbeats (§8.2) give the household what proximity would have —
knowing who is live — and do it across the whole store rather than within ten
metres. Brief signal loss is handled by the local-first queue (§7.4).

### 18.6 A framework with a build step

Rejected per §13 and driver D7.

---

## 19. Open questions

Architectural, needing an answer before or during implementation:

- **A1.** Single shared Microsoft account (assumed), or a folder shared to
  family members' own accounts? Affects OAuth setup only. §3.3.
- **A2.** Staleness warning threshold assumed at 60 s and heartbeat at 15 s.
  Both want tuning against a real shop; they are configuration, not design.
- **A3.** Closed-shop archive retention assumed at 12 months (§15.3). Trip
  history at 2 years is confirmed; this one is not.
- **A4.** FR-SHOP-3 gives no way out of a shop locked against the wrong menu:
  there is no unlock and no abandon. Two candidates, both safe under §5.9
  because both are confined to the state where no tick exists: **unlock while
  the shop has zero ticks**, or an explicit **abandon this shop** action.
  Neither is specified. Worth settling before implementation, because "we
  locked it too early" is a thing that will happen. Note this is *not* the same
  as the unfinished-shop case, which is resolved (§8.6, FR-SHOP-4).
- **A5.** Related: nothing forces anyone to tap "start shopping". If the
  household simply begins ticking, either the app must treat the first tick as
  an implicit lock, or ticking must be unavailable until the shop is open. The
  second is more predictable; the first is kinder. Not yet decided.
- **A6.** The ingredient model has no way to say "this is never bought".
  `water` is in the master list, and recipe lines exist with a quantity of zero
  that read as "to taste" or "to serve". Both need somewhere to live: a
  never-shop flag on the ingredient, and a quantity-less recipe line that does
  not reach the shopping list. Neither is in `SRS.md`. See
  `data/DATA-REVIEW.md` §3 and §7.
- **A7.** FR-ING-1 assumes one conversion per (ingredient, cooking unit). The
  source data holds several for 107 pairs — rounding noise, not disagreement.
  The migration resolves it by taking the median implied factor, which is
  recorded here so the choice is visible rather than buried in a script.

Carried forward from `SRS.md` §9, unchanged and not blocking:

- Is one week the right carry-over period for every recipe (FR-MENU-5)?
- Any appetite for spend tracking in a later phase?
- Recipe edit history/undo — resolved as last-save-wins (Round 4), but the URS
  question stands if that proves wrong in practice.

Resolved by this document:

- ~~Export or print a shopping list?~~ Print, yes — §10.2.
- ~~Accounts/login beyond what sync needs?~~ No — one shared login, §3.3.
