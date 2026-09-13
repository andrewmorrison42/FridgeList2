# The Fridge List — Software Requirements Specification

**Status:** Draft v0.1. Derived from [`URS.md`](URS.md) (v0.1, 2026-09-13).

## 0. How to read this document

`URS.md` says what the household needs, in their language. This document
translates that into requirements precise enough to design against and
test against — every requirement below is numbered, and every numbered
requirement has a way to check whether the system meets it. Where the URS
left something open, this document either resolves it with an explicit
assumption (marked **(assumed)**, and worth confirming with the
stakeholder) or carries the open question forward unchanged.

This is a requirements document, not a design document: it says *what*
the system must guarantee, not *how* — no data structures, storage
engines, sync protocols, or algorithms are specified here. That belongs
in the architecture & design document that follows this one.

## 1. Scope

The system is a household meal-planning and shopping-list tool, used by
one family across several personal devices, that:

- turns a week's chosen recipes, standing staples, and an ongoing
  ad-hoc backlog into a single shopping list;
- lets two or more people work that list simultaneously from separate
  devices during a shop, and reconcile their devices' state afterward
  without losing work; and
- carries a recipe library and a light history of what's been chosen,
  across weeks.

One instance serves one household. There is no multi-household or
server-hosted-for-many-families requirement (URS §2).

## 2. Definitions

Reproduced from URS §3, with the precision this document needs added.

| Term | Definition |
|---|---|
| **Ingredient** | A master-list entry: a name, a *shopping unit*, a *cooking-to-shopping unit conversion*, a *shopping group*, and an optional brand/flavour preference. Exactly one ingredient master entry exists per distinct thing the household buys. |
| **Recipe** | A name, a servings baseline, instructions, and a list of (ingredient, quantity, cooking unit) lines. |
| **Staple** | An ingredient flagged as "considered every shop," independent of any recipe. |
| **Menu selection** | The set of (recipe, servings) pairs chosen for a given week, each carrying a **status**: see §5.4. |
| **Wait List item** | An (ingredient, optional note) pair added ad hoc, independent of any recipe, that persists until fulfilled or removed. |
| **Shopping list** | The generated, per-shop list of lines, each derived from a menu selection, a staple, or a Wait List item, each with its own **done** state (see §5.6). |
| **Shop** | One occasion of shopping: begins when the household generates a shopping list with intent to shop, ends when the household marks it finished. At most one shop is open at a time (URS §3, §6). |
| **Trip history record** | An immutable record, written once when a shop finishes, of which recipes were selected that week and roughly when. |

## 3. User classes

There is exactly one user class. Any user may: create or edit a recipe,
change the ingredient master list, add to or remove from the Wait List,
select the week's menu, generate or modify a shopping list, tick or
untick a shopping-list line, and reconcile two devices. No permission or
role distinctions exist (URS §2, §7).

## 4. Operating environment

The system runs on personal touchscreen devices belonging to members of
one household — phones primarily, with at least one tablet in regular
use (URS §2, §7). No desktop-only requirement exists, and no requirement
assumes a specific number of devices beyond "more than one, sometimes
in concurrent use during a shop" (URS §6).

## 5. Functional requirements

Each requirement is independently verifiable. Requirement IDs are
stable — do not renumber; deprecate instead.

### 5.1 Ingredient master list

- **FR-ING-1.** Every ingredient shall have exactly one shopping unit
  and, for any cooking unit used to reference it from a recipe, a
  defined conversion to that shopping unit. The system shall never
  present or total a shopping-list quantity without applying this
  conversion. *(URS §3, §9)*
- **FR-ING-2.** Every ingredient shall belong to exactly one shopping
  group, used to lay out the shopping list (§5.7). *(URS §4.2, §9)*
- **FR-ING-3.** An ingredient may optionally carry a brand/flavour
  preference note. Absence of a note is the common case and shall not
  be treated as missing data. *(URS §3, §5.1)*
- **FR-ING-4.** A shopping-list line generated for an ingredient that
  carries a preference note shall display that note. *(URS §6, §9)*

### 5.2 Recipes

- **FR-REC-1.** A recipe shall record a servings baseline and, for each
  ingredient line, a quantity expressed in a cooking unit convertible
  per FR-ING-1.
- **FR-REC-2.** Any user may create or edit any recipe at any time; the
  system shall not require a special role to do so. *(URS §3, §7)*
- **FR-REC-3.** The system shall record, per recipe, the most recent
  week it was selected (used by FR-REC-4 and FR-HIST-2), independent of
  whether it was actually cooked.
- **FR-REC-4.** Wherever the system presents recipes for selection into
  a week's menu, it shall show each recipe's cook-history signal (how
  long since it was last selected/cooked) alongside it — not only in a
  separate historical view. *(URS §9)*
- **FR-REC-5.** The system shall not provide a bulk multi-recipe delete
  operation. *(URS §8)*

### 5.3 Staples

- **FR-STA-1.** An ingredient flagged as a staple shall be included in
  every generated shopping list automatically, without being
  individually selected by a user for that shop. *(URS §3, §4.2)*
- **FR-STA-2.** Staple status is a property of the ingredient, held
  separately from any recipe or Wait List membership; the system shall
  never conflate the three. *(URS §6, §9 — "selectionsSignature
  must never depend on anything shopping mutates" is the kind of defect
  this requirement exists to prevent, though that is an implementation
  detail out of scope here.)*

### 5.4 Menu selection and carry-over

A menu selection's status shall be one of: **Planned**, **Cooked**,
**Carried over**, or **Flagged**. The lifecycle:

- **FR-MENU-1.** Any user may add a recipe with a servings count to the
  current week's menu selection at any time, including after a shop has
  started (URS §4.2, §6). Newly added entries start as **Planned**.
- **FR-MENU-2.** Any user may mark a **Planned** menu selection as
  **Cooked**, at any time, including after the shop that produced its
  ingredients has finished. *(URS §4.4)*
- **FR-MENU-3.** When the household starts a new shop (i.e. generates a
  new week's shopping list), every **Planned** entry from the previous
  week that was never marked **Cooked** shall carry over into the new
  week's menu selection with status **Carried over**, rather than being
  removed. *(URS §4.5 — this is the requirement with no equivalent in
  the existing app.)*
- **FR-MENU-4.** A **Carried over** entry behaves exactly like a
  **Planned** entry for the purposes of FR-MENU-2 (it can be cooked) and
  for appearing in the menu picker (FR-REC-4).
- **FR-MENU-5.** An entry may carry over at most once (FR-MENU-3). If a
  **Carried over** entry is itself never cooked by the time the
  *following* shop is started, the system shall transition it to
  **Flagged** rather than carrying it over silently again, and shall
  require a user to explicitly resolve it — either mark it **Cooked**,
  remove it, or deliberately re-plan it — before treating it as settled.
  *(URS §4.5, §10 — the URS leaves open whether one week is right for
  every recipe; this requirement assumes a uniform one-week carry-over
  and flags the open question rather than resolving it. **(assumed)**)*
- **FR-MENU-6.** A user may remove any menu selection (Planned, Carried
  over, or Flagged) at any time, which is how a Flagged entry is
  deliberately dropped.
- **FR-MENU-7.** When a shopping list is (re)generated and it includes a
  **Carried over** entry, the system shall not fold that entry's
  ingredients into the ordinary combined shopping-list lines (FR-LIST-2)
  unchecked. Instead:
  1. Any ingredient needed *only* by one or more **Carried over**
     entries (i.e. no current **Planned** menu selection or staple also
     needs it) shall be shown in a distinct **"Carried over —
     check before buying"** section of the shopping list, separate
     from the main grouped list (FR-LIST-6). This exists as a reminder
     that the ingredient may already have been used for something else
     in the intervening week, even though it was originally bought or
     earmarked for the carried-over recipe.
  2. From that section, a user may move an ingredient onto the main
     shopping list (it is still needed, buy it) or dismiss it (it's
     still on hand, don't buy it this shop). Neither action is
     required before the list can be used — the section is a prompt,
     not a block.
  3. An ingredient needed by a **Carried over** entry *and* by a
     current **Planned** entry or staple is already on the main list
     via that other source and shall not additionally appear in the
     carried-over section — it is being bought regardless, so there is
     nothing to check.
  *(URS §4.5. Supersedes the earlier draft of this requirement, which
  specified a per-ingredient yes/no prompt; the stakeholder's revision
  is a visible reminder list rather than a gate, on the grounds that the
  real risk is a carried-over ingredient having been silently consumed
  by an unrelated meal, not merely forgotten. This also resolves the
  open question in URS §10 about whether the decision should be
  "remembered": there is no yes/no decision being remembered any more —
  dismissing an item from the section only affects the current shop, and
  it is free to reappear next time if the entry is still Carried over
  and still unresolved.)*

### 5.5 Wait List

- **FR-WAIT-1.** Any user may add an ingredient (with an optional note)
  to the Wait List at any time, independent of any shop being in
  progress. *(URS §4.1)*
- **FR-WAIT-2.** A Wait List item shall persist across shops until it is
  either fulfilled (see FR-LIST-4) or explicitly removed by a user. It
  shall never be reset purely because a week or a shop ended. *(URS §3)*

### 5.6 Shopping list generation

- **FR-LIST-1.** Generating a shopping list shall combine, into one
  list: every ingredient line implied by the current week's menu
  selections (excluding suppressed carry-over lines per FR-MENU-7),
  every staple ingredient (FR-STA-1), and every open Wait List item.
- **FR-LIST-2.** Where the same ingredient arises from more than one
  source (e.g. two recipes, or a recipe and a staple), the system shall
  combine them into a single shopping-list line with a summed,
  converted quantity, not one line per source.
- **FR-LIST-3.** After generation and before shopping begins, a user
  shall be able to remove any line from the shopping list (the "already
  have it" pantry check), without affecting the underlying menu
  selection, staple flag, or Wait List item it came from. *(URS §4.2)*
- **FR-LIST-4.** Removing a shopping-list line that originated from a
  Wait List item shall be treated as fulfilling that Wait List item (it
  is removed from the Wait List, not merely hidden from this shop).
- **FR-LIST-5.** Each shopping-list line shall have a done state:
  **not done** or **done**. A user may set either state on any line at
  any time while a shop is open.
- **FR-LIST-6.** The shopping list, wherever displayed, shall be
  organised by each line's ingredient's shopping group (FR-ING-2), not
  alphabetically and not by insertion order, so that people covering
  different physical areas of a shop can each see a coherent subset.
  *(URS §4.2, §8, §9)*

### 5.7 During a shop

- **FR-SHOP-1.** A user may add a new item (from any source — a new
  Wait List entry, a new menu selection, or a direct addition) to a
  shopping list that is already open, and the system shall incorporate
  it without discarding or resetting any existing line's done state.
  *(URS §4.2, §6)*
- **FR-SHOP-2.** The system shall never remove or reset a shopping-list
  line's **done** state as a side effect of anything other than a
  direct, explicit user action to untick it. In particular, adding an
  item (FR-SHOP-1), reconciling two devices (§5.8), or any background
  synchronisation shall never cause a **done** line to revert to **not
  done**. *(URS §6 — this is the tick durability requirement, restated
  here as it applies within a single device's session; see FR-SYNC-1
  for the cross-device form.)*

### 5.8 Cross-device sync and reconciliation

These requirements exist because the previous implementation violated
them; see `URS.md` §6 for the household's account of the resulting
failures.

- **FR-SYNC-1 (Tick Durability Invariant).** Once any device records
  that a shopping-list line is **done**, or that a menu selection has
  been added, that fact shall remain true everywhere from that point
  on — on every device, through every subsequent synchronisation,
  reconciliation, or shopping-list regeneration — until and unless a
  user takes a distinct, later, explicit action to undo it. No merge,
  sync, or regeneration process may cause such a fact to revert as a
  side effect. This is the system's one hard correctness guarantee and
  takes precedence over every other sync requirement below. *(URS §6)*
- **FR-SYNC-2.** Every device shall be able to show the user, at any
  time, whether its view of the shared data might be stale (i.e.
  whether changes made elsewhere might not yet be reflected locally). A
  device shall never present stale data indistinguishably from current
  data. *(URS §6)*
- **FR-SYNC-3.** A short delay between one device recording a change
  and another device reflecting it is acceptable and is not a defect.
  An unbounded delay, a silent failure to ever propagate, or a change
  that propagates incorrectly, are defects. *(URS §6)*
- **FR-SYNC-4.** The system shall provide an explicit reconciliation
  action, usable at any time (not only at the end of a shop), that:
  1. combines the two (or more) devices' states such that every tick
     and every addition made on any device is retained (an automatic
     union — never a one-sided overwrite of one device's state by
     another's), consistent with FR-SYNC-1;
  2. reports, as informational (not requiring action), any
     shopping-list line that was independently ticked **done** on more
     than one device; and
  3. reports, as requiring a decision, any shopping-list line that
     remains **not done** on every device after the union, at a point
     where the household believed the shop was complete. *(URS §4.3,
     §6)*
- **FR-SYNC-5.** The specific mechanism a device uses to exchange data
  with others (which storage or transport it uses) is unconstrained by
  this specification; only the outcomes above are required. *(URS §6)*
- **FR-SYNC-6.** The system shall continue to function for
  single-device use (adding items, ticking lines, viewing the list)
  through brief losses of connectivity, deferring propagation to other
  devices until connectivity returns, rather than blocking the user.
  Sustained full offline operation for an entire shop is not required.
  *(URS §6)*

### 5.9 Trip history

- **FR-HIST-1.** When a shop finishes, the system shall write an
  immutable record of which recipes were part of that week's menu
  selection and approximately when the shop finished. This record shall
  never be edited after being written. *(URS §3, §5.1)*
- **FR-HIST-2.** The recipe cook-history signal (FR-REC-4) shall be
  derived from trip history records.

## 6. Non-functional requirements

- **NFR-1.** The system shall present no user-role or permission
  distinctions; every requirement in §5 that says "any user" is
  absolute. *(URS §7)*
- **NFR-2.** The system shall not send notifications or alerts of any
  kind. *(URS §7, §8)*
- **NFR-3.** One deployment/instance of the system serves exactly one
  household; the system carries no requirement to isolate or
  distinguish between multiple households in one deployment. *(URS §2,
  §7)*
- **NFR-4.** The system's shopping-list grouping (FR-LIST-6) is not
  required to match the physical layout of any specific store. *(URS
  §8)*

## 7. Explicitly out of scope

Carried from URS §8 without change, since these are absence-of-requirement
statements rather than behaviour to translate:

- Pantry inventory / quantity-on-hand tracking.
- Per-item price or spend tracking.
- Bulk multi-recipe delete (also stated as FR-REC-5, since its absence
  is easy to accidentally reintroduce).
- Notifications and alerts (also NFR-2).
- Store-accurate aisle ordering.

## 8. Traceability to the URS

| URS section | SRS requirements |
|---|---|
| §3 Core concepts | FR-ING-*, FR-REC-1, FR-STA-*, FR-MENU-*, FR-WAIT-*, FR-LIST-*, FR-HIST-* |
| §4.1 Between shops | FR-WAIT-1 |
| §4.2 Starting a shop | FR-MENU-1, FR-STA-1, FR-LIST-1–3, FR-LIST-6, FR-ING-2 |
| §4.3 During the shop | FR-SHOP-1, FR-SYNC-2–4 |
| §4.4 After the shop | FR-MENU-2, FR-WAIT-1, FR-HIST-1 |
| §4.5 Carry-over | FR-MENU-3–7 |
| §5 Data requirements | §2 Definitions, FR-ING-1–3, FR-HIST-1 |
| §6 Sync & concurrency | FR-SYNC-1–6, FR-SHOP-2 |
| §7 Non-functional | NFR-1–4, §4 Operating environment |
| §8 Out of scope | §7 Explicitly out of scope |
| §9 Carried forward | FR-REC-4, FR-LIST-6, FR-ING-3–4, FR-ING-1, FR-STA-2 |

## 9. Open questions carried from the URS

Unchanged from `URS.md` §10 except where §5 above records an assumption
made to keep this document unambiguous; those assumptions are marked
**(assumed)** in place and should be confirmed, not silently treated as
decided:

- [x] Should the "already have this as surplus" decision on a
      carried-over ingredient be remembered, or asked fresh each time?
      **Resolved:** neither — FR-MENU-7 replaces the per-ingredient
      decision with a standing reminder section; there is no decision
      to remember, since dismissing an item only affects the current
      shop.
- [ ] Is one week the right carry-over period for every recipe
      (FR-MENU-5), or should it vary? Assumed: uniform one week.
- [ ] Any appetite for basic spend tracking in a later phase?
- [ ] Does recipe edit history/undo matter, given FR-REC-2 allows
      anyone to edit at any time?
- [ ] Is there a requirement to export or print a shopping list?
- [ ] Any requirement for accounts/login beyond whatever a sync
      mechanism needs?
