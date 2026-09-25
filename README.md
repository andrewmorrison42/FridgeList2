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

## Putting it on the web

The app is static files at the repository root, so GitHub Pages serves it with
no build step:

1. Repository **Settings → Pages**
2. **Source:** *Deploy from a branch*
3. **Branch:** `main`, folder `/ (root)` → **Save**

A minute later it is live at `https://<user>.github.io/<repo>/`. That host
serves application code only — household data goes browser ⇄ OneDrive directly
and never passes through it.

On each phone, open that URL and use the browser's **Add to Home Screen**. It
then opens like an app, works through a dead spot in the supermarket, and
updates itself when you push.

## Connecting it to OneDrive

The app works without this — it just stays on one device. To share a list
between phones, register a free Azure application once for the whole household.

**Once, in the Azure portal** ([portal.azure.com](https://portal.azure.com)):

1. **Microsoft Entra ID → App registrations → New registration**
2. **Name:** anything, e.g. `Fridge List`
3. **Supported account types:** *Personal Microsoft accounts only*
4. **Redirect URI:** choose platform **Single-page application (SPA)** and enter
   your Pages URL exactly, including the trailing slash —
   `https://<user>.github.io/<repo>/`
   *The SPA platform matters: it is what enables CORS on the token endpoint and
   requires PKCE. "Web" will not work from a static page.*
5. **Register**, then copy the **Application (client) ID**
6. **API permissions → Add a permission → Microsoft Graph → Delegated**, add
   `Files.ReadWrite`, `offline_access` and `User.Read`

No client secret is created, and none is needed: a static page cannot keep one,
which is why the app uses the authorisation code flow with PKCE (`src/data/auth.js`).

**Then, on each device:**

1. Open the app, go to the **Setup** tab
2. Paste the same **Application (client) ID** — the same one on every device
3. Leave **Folder** as `/FridgeList` unless you want it elsewhere
4. Tap **Connect to OneDrive** and sign in with the household's shared
   Microsoft account — the same account on every device
5. Give the device a **Name** ("Dad's phone") so the list can say who ticked what

The first device to connect creates the app's own files in the folder; the
rest pick them up on their next sync. Recipes come from `recipes-data.json` in
the same folder (see Recipes below). Data appears in OneDrive under `FridgeList`
as plain JSON you can read, copy or back up by hand.

For local testing, register `http://localhost:8099/` as a second SPA redirect
URI on the same app registration.

## Recipes

The app reads its recipes from a JSON file in the household's OneDrive — by
default `recipes-data.json` in the folder set in Setup, which is the file the
earlier Fridge List app uses, so both share one recipe book. Set **Setup →
Recipe file** to point a device at a different file. If there is no file at
that path, Setup offers to start one from the starter recipes; it never
replaces a file that is already there.

Recipes are edited in the app (**Recipes → Edit**, or **+ New recipe**). A
save changes only that one recipe, keeps every field the earlier app uses, and
writes only if the file has not changed since it was read — so an edit made
elsewhere to another recipe is kept, and one made to the same recipe is
flagged rather than overwritten. **While both apps are in use, edit recipes in
only one of them at a time:** the earlier app can still overwrite a recent edit
made here.

A device not connected to OneDrive keeps its own copy, started from the starter
recipes in `data/recipes-data.reviewed.json`. That file is public, so it holds
recipes and ingredients only — no trip history or cook dates.

To check a recipe file the way the app reads it:

```sh
node tools/import.js path/to/recipes-data.json
```

This writes `data/import-report.md`, listing what needed a human rather than
guessing.

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
