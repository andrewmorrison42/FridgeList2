# The Fridge List — User Requirement Statement

**Status:** Draft v0.1, captured from a stakeholder interview on 2026-09-13.

This document describes what the system must do, for a family of five who
plan meals, shop weekly (and sometimes mid-week), and split the physical
shop across two or more people and devices. It intentionally does not
describe *how* to build it — the existing `index.html` app was built by
rapid prototyping, and its sync design is the specific thing this rebuild
means to get right. Read this before designing anything; edit it freely,
it's yours.

This is a deliberate clean-slate rebuild, not a refactor: the goal is to
stop building on top of prior design iterations and accumulated cruft, even
where the old app's behaviour was acceptable. Section 4.5 (carry-over of
uncooked menu items) is a genuinely new feature with no equivalent in the
existing app, and its owners expect it to change the behaviour of menu
selection, ingredient state and shopping-list generation together — it
should be treated as a first-class part of the design, not bolted on
afterward.

Anything marked **(open)** is a question the interview didn't settle —
resolve it before treating that section as final.

## 1. Purpose

A shared household tool that turns a week's meal choices into a shopping
list, and coordinates two or more people ticking that list off in the
supermarket without losing or duplicating work.

## 2. Users

- One household of five. Every family that wants this runs its own
  separate instance — this is not a multi-tenant service.
- No roles or permissions: any family member can plan meals, edit a
  recipe, add to the Wait List, or shop.
- Devices: phones are primary; one tablet is also used. No desktop-only
  usage.

## 3. Core concepts

| Term | Meaning |
|---|---|
| **Recipe** | A dish: ingredients and quantities in *cooking* units (e.g. "1 cup flour"), instructions, a servings baseline. Built up over years; rarely edited, and when edited it's usually by whoever is cooking it at the time. |
| **Ingredient (master list)** | The shared vocabulary recipes and lists refer to. Each ingredient carries the unit it's *shopped* in (which may differ from the unit it's *cooked* in — flour is cups in a recipe, weight on a shopping list), which shopping-list group/bucket it belongs to, and — only where it actually matters — a brand/flavour preference. |
| **Staple** | Something needed most weeks regardless of the menu (breakfast items, toilet paper, laundry powder). Considered automatically every shop; never chosen meal-by-meal. |
| **Menu selection** | The recipes picked for the week, with servings per recipe, chosen by whoever is around the kitchen table — possibly more than one person at once. |
| **Wait List** | An ongoing, ad-hoc backlog of pantry items someone noticed running low, unrelated to any specific recipe. Persists across shops until bought; not reset weekly. |
| **Shopping list** | The generated, tickable list for one shop: menu ingredients (converted to shopping units) + staples + open Wait List items, minus whatever's already at home. |
| **Shop / trip** | One occasion of going shopping, from the decision to shop through to everyone finishing. Never more than one shop happens at a time. |
| **Trip history** | A record of which menu items were chosen and roughly when — used only to answer "how long since we last had this?" Not a spend or inventory record. |

## 4. Core workflows

### 4.1 Between shops
Any family member can add something to the Wait List the moment they
notice it's running low.

### 4.2 Starting a shop
1. The household decides to shop (weekly, or ad hoc mid-week).
2. Menu selection: family members pick recipes and servings for the
   week. Two people may do this at the same time. Menu items left over,
   uncooked, from the previous week's plan appear here too by default
   (see 4.5) — they aren't silently dropped.
3. Staples are pulled in automatically; nobody re-selects them.
4. The system generates one combined list from menu ingredients (unit
   conversion applied) + staples + open Wait List items.
5. The household reviews that list against what's already in the
   pantry and removes what isn't needed.
6. The list is grouped into buckets of similar item types (not
   necessarily store-aisle order, but consistent groupings) so two
   people can split up and each cover different sections.

### 4.3 During the shop
- Typically one or two people shop at once, in different parts of the
  store, each ticking off items on their own device in parallel.
- It must always be clear *how current* a device's view is — a short
  lag between devices is fine, but the app must never let someone
  believe their list is current when it isn't.
- Someone realising they need one more thing mid-shop must be able to
  add it without disrupting or losing progress already made.
- When the people shopping "come back together," there must be an
  explicit way to force the two devices' state together:
  - Default behaviour is an automatic union — anything either side
    ticked or added is kept.
  - The user must be warned about: the same item having been ticked
    independently by both people (informational — not an error), and
    any item neither person ticked off (a genuine gap, needs a
    decision).

### 4.4 After the shop
- Recipes actually cooked get marked as cooked.
- Anything noticed as out of stock goes onto the Wait List.
- Uncooked menu items carry forward automatically (4.5) rather than
  vanishing when the week resets.

### 4.5 Carry-over of uncooked menu items
- A menu item not marked cooked before the next shop is generated must
  still appear on the following week's menu selection — not disappear
  — so it either gets cooked or is deliberately removed.
- It carries over for one further week only. If still uncooked after
  that, the household must be flagged to make a manual decision
  (remove it, or keep it deliberately).
- Its ingredients must **not** be silently re-added to the new
  shopping list by default — some may already be on hand as leftovers
  from the earlier shop (half a capsicum, say). Instead, flag each such
  ingredient so the household can decide, per item, whether it still
  needs buying.

## 5. Data requirements

### 5.1 Long-lived (persists indefinitely)
- Recipes: ingredients with cooking-unit quantities, instructions,
  servings baseline, link to cook history.
- Ingredient master list, each entry carrying: shopping-list
  group/bucket, shopping unit (distinct from cooking unit, with a
  conversion), and an optional brand/flavour preference — present only
  where a real preference exists, not on every ingredient.
- Staples list: what's considered every shop, independent of the
  week's menu.
- Trip history: which menu items were chosen and roughly when. Not a
  price, quantity, or per-item purchase record.

### 5.2 Week/shop-scoped (short-lived, though entries can carry over)
- This week's menu selections and servings.
- The current Wait List — ongoing, not reset weekly.
- The generated shopping list for the shop in progress, and its
  tick/removal state.

### 5.3 Explicitly excluded from the data model
- Pantry inventory / quantity-on-hand tracking — rejected as too much
  complexity for the value; the household prefers to eyeball the
  pantry rather than maintain counts.
- Per-item pricing / spend tracking — not wanted now. The household
  already holds prices and preferred brands in their heads. **(open:**
  worth a future phase, but out of scope for this rebuild.)

## 6. Sync & concurrency requirements

This is the rebuild's central problem, not an add-on. The existing
app's failures — Wait List items dropping mid-week, tick state
refreshing incorrectly mid-shop — are exactly what this section exists
to prevent.

- **Concurrency shape:** at most one shop happens at a time; during a
  shop, typically one or two devices are ticking independently in
  different parts of the store. At other times, up to a couple of
  people may edit the week's menu selections concurrently. Never two
  independent shops running at once.
- Sync state must be visibly trustworthy — a device must be able to
  show the user how current its data is, rather than imply falsely
  that it's up to date. Staleness is acceptable as long as it's visible
  and there is a way to correct it without losing anyone's work.
- **Hard guarantee: a tick is never lost.** Once a menu item is added
  to the plan, or a shopping-list item is ticked off during a shop, no
  later sync, reconciliation, merge, or regeneration may cause that
  tick to disappear or silently revert — on any device, under any
  ordering of events. This is a correctness requirement, not a
  best-effort one, and should be the first thing tested against any
  proposed sync design.
- A short propagation delay between devices is acceptable; silent,
  permanent loss or an incorrect overwrite of someone's work is not.
- There must be an explicit "reconcile now" action for when two
  shoppers rejoin each other, defaulting to an automatic union of both
  sides' ticks and additions (never a one-sided overwrite that could
  drop a tick), and surfacing:
  - items ticked redundantly by both sides (informational), and
  - items neither side ticked off (a gap needing a decision).
- Adding an item to a shop already in progress must not disrupt or
  lose progress already made on that shop.
- The sync backend (OneDrive today) is an implementation detail, not a
  requirement — any backend that delivers reliable, trustworthy sync
  is acceptable.
- Store connectivity has generally been adequate; the requirement is
  graceful degradation through brief connectivity loss, not full
  offline operation.

## 7. Non-functional requirements

- Platforms: phones (primary), tablet (secondary). No desktop-specific
  requirement.
- No notification/push requirement at this stage — explicitly not
  wanted.
- No user roles or permission distinctions — full-trust household.
- Single household per deployment; no shared-service / multi-household
  requirement.

## 8. Explicitly out of scope

- Bulk multi-recipe delete.
- Pantry inventory tracking with quantities.
- Per-item price/spend tracking (for now).
- Notifications and alerts.
- Store-accurate aisle ordering — consistent groupings are enough; the
  grouping doesn't need to mirror any one store's physical layout.

## 9. Carried forward from the existing app (explicitly still wanted)

- Recipe "last cooked" / cook-history signal, but shown where recipes
  are *chosen* for the week (the picker), not only in a separate
  history view.
- A grouped (not store-mapped, not alphabetical) shopping list layout.
- A brand/flavour preference notable on a shopping-list line, only
  where it matters for that ingredient.
- Ingredient master list with distinct shopping vs. cooking units and
  conversion between them.
- Staples as a category distinct from both menu-derived items and
  Wait List items.

## 10. Open questions

- [ ] Should a household's "already have this as surplus" decision on
      a carried-over ingredient be remembered, or asked fresh each
      time it recurs?
- [ ] Any appetite for basic spend tracking in a later phase?
- [ ] Does recipe edit history/undo matter, given edits are rare and
      made in the moment while cooking — or is last-save-wins fine?
- [ ] Is there a requirement to export or print a shopping list, or is
      on-device viewing always sufficient?
- [ ] Any requirement for accounts/login beyond whatever the sync
      backend itself needs?
- [ ] Confirm: one extra week of carry-over for an uncooked menu item,
      then a mandatory manual decision — is one week definitely right,
      or does it depend on the recipe?
