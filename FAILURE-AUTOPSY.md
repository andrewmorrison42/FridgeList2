# Failure autopsy

**Date:** 2026-09-13. **Purpose:** to test the design against the failures it
exists to prevent, rather than against itself.

`ARCHITECTURE.md` has been checked for internal consistency. That is a
different thing from being correct. This document takes the two failures the
household actually experienced, reconstructs each as a precise sequence of
events, and asks of each: **which specific rule now prevents this?** A failure
that cannot be traced to a named preventing rule is not known to be fixed.

Both failures are stated in the household's own words. No prior implementation
was examined; the reconstructions below are of the *failure class*, derived
from the symptoms, not of any particular code.

---

## F1 — One user's actions overwrote another's list

> *"We have had instances where one user's actions overwrote the list that
> others had, and resulted in loss of lists as to what is needed to be bought."*

### Reconstruction

The classic lost update. With a single shared list document, any write is a
read–modify–write, and two of them interleave like this:

| | Device A | Device B | Shared document |
|---|---|---|---|
| 1 | reads list `S` | | `S` |
| 2 | | reads list `S` | `S` |
| 3 | adds *olives* → holds `S+olives` | | `S` |
| 4 | | adds *capers* → holds `S+capers` | `S` |
| 5 | **writes** `S+olives` | | `S+olives` |
| 6 | | **writes** `S+capers` | `S+capers` |

At step 6 *olives* is gone. Nobody did anything wrong, nobody is told, and the
item is simply not bought. There is a second, worse variant: A regenerates the
list from the menu and writes the result, destroying B's pantry-check removals
and mid-shop additions in one stroke.

### What prevents it now

Three independent rules, and it is worth noticing that **no one of them would
be sufficient alone**:

| Rule | Where | What it kills |
|---|---|---|
| A device writes **only its own file** | §4 | Step 6 cannot overwrite step 5 — they are different files. The lost-update window does not exist because there is no shared mutable target |
| State is **merged on read**, additions are present-wins | §5.1, §5.5 | Both *olives* and *capers* survive the merge. Neither user's work depends on the other's write order |
| Regeneration is **additive**, and does not run at all once a shop is open | §5.7 | The destructive variant is gone: there is no code path that computes a list and writes it over the live one |

The household's own assessment — *"separate write files, then merging on read
will fix this"* — is correct, and the menu lock (FR-SHOP-3) narrows it further
by removing the remaining destructive operations from the window in which ticks
exist (§5.9).

### Residual risk

One, at the implementation level rather than the design level. §7.4 has a
device **rewrite its own file** with new events appended. If that upload were
partial, the device could truncate its own log and lose its own events — the
same failure, self-inflicted. This is safe on OneDrive, because a simple upload
of a small file is atomic and creates a new version rather than mutating in
place, but it is a property the design depends on and had not been written
down. **Now recorded in §7.4.**

**Verdict: prevented, three times over.**

---

## F2 — A second user's ticks never appeared on the first user's list

> *"We have had instances where items ticked off by a second user did not get
> reflected in the list on a first user."*

This one is more interesting, because the household's proposed fix addresses
only part of it. The symptom — "B's tick isn't on A's screen" — has **four**
possible causes, and per-device files fix only one.

| # | Cause | Addressed by | Status |
|---|---|---|---|
| (a) | A never fetched B's data | §7.3 polling every 3 s while a shop is open; §7.4 retry queue; §8.3 shows time since last successful sync | ✓ |
| (b) | A fetched it, but a stale write overwrote it — i.e. F1 again, wearing a different hat | §4, §5.4 — as F1 | ✓ |
| (c) | A fetched and merged it, but **the screen never re-rendered** | **nothing** | ✗ **gap** |
| (d) | A was showing cached data and gave no sign it was stale | §8.2 presence, §8.3 staleness banner | ✓ |

Cause (b) matters: it is entirely possible F1 and F2 were the same defect seen
from two angles, since an overwrite of A's state by a stale write would erase
B's tick exactly as described. The design covers that reading.

### The gap this autopsy found

**Cause (c) is not addressed anywhere in the architecture.** §11 says the UI
reads derived state, but nothing *requires* a device to re-render when a merge
changes that state. A device could sync perfectly, merge correctly, hold the
right answer in memory — and still show yesterday's list until someone pulls to
refresh or reopens the app.

From the user's position this is indistinguishable from the tick never
arriving. And FR-SYNC-3 already says an unbounded delay is a defect; a render
that never happens is an unbounded delay.

This is precisely the kind of defect the autopsy method exists to find: it is
invisible to a consistency check, invisible to the merge properties in §14
(which test the engine, not the screen), and it is a plausible root cause of
the failure that actually happened.

**Resolved by adding FR-SYNC-7** to `SRS.md`, and a corresponding rule in §11:
a change merged into local state must reach the display without user action.

**Verdict: (a), (b) and (d) prevented; (c) was an open hole, now closed.**

---

## What this exercise produced

| Finding | Outcome |
|---|---|
| F1 is prevented by three independent rules | Confirmed; no change needed |
| F1 depends on uploads being atomic — undocumented assumption | Recorded in §7.4 |
| F2 has four root causes, not one | Confirmed |
| F2 cause (c), stale rendering, was unaddressed | **New FR-SYNC-7**; §11 rule added |

One real gap, from two failures, in an afternoon — and it was in the part of
the system the property tests were never going to look at. The merge engine has
had far more scrutiny than the path between a merge and a person's eyes, and
the failures the household reported live at the end of that path.

Worth repeating this exercise against any future failure, rather than reasoning
forward from the design and hoping it covers them.
