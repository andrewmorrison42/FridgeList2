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
   `Files.ReadWrite.All`, `offline_access` and `User.Read`

No client secret is created, and none is needed: a static page cannot keep one,
which is why the app uses the authorisation code flow with PKCE (`src/data/auth.js`).

**Share the folder, once.** Everyone signs in with their own Microsoft
account. One person's OneDrive holds the `FridgeList` folder (with the earlier
app, it already does); they share it with the others:

1. On [onedrive.com](https://onedrive.com), as the folder's owner: right-click
   **FridgeList** → **Share** → each person's Microsoft account email →
   **allow editing** (view-only means their ticks silently fail to save)
2. Each person, on onedrive.com as themselves: **Shared** → **FridgeList** →
   **Add shortcut to My files**. This copies nothing; it is how the app finds
   the folder. (The app also looks in *Shared with me*, but Microsoft is
   retiring that list, so do not rely on it.)

**Then, on each device:**

1. Open the app, go to the **Setup** tab
2. Paste the same **Application (client) ID** — the same one on every device
3. Leave **Folder** as `/FridgeList` unless you want it elsewhere
4. Tap **Connect to OneDrive** and sign in **as the person who uses this phone**
   — Microsoft asks which account; choose theirs
5. Give the device a **Name** ("Dad's phone") so the list can say who ticked what

Setup then says which folder the phone is using: *in this account's OneDrive*
on the owner's phone, *shared by …* on everyone else's. If an account can see
more than one folder of that name — say one started from the starter recipes on
another phone — Setup says so, and **Show the folders this account can see**
lists each with its owner and recipe count, to choose the right one for that
phone. If it cannot find one,
it says so and shows these steps — it never quietly starts a folder of its own,
which would give that phone a list nobody else sees. (There is a button to
start a new folder, for a household setting up for the first time.)

The app writes its own files into `state/` and `shops/` inside the folder, and
reads the recipes from `recipes-data.json` there (see Recipes below). The
earlier app's other files are left alone. Everything is plain JSON you can
read, copy or back up by hand.

**About the permission.** `Files.ReadWrite.All` is what lets a person open a
folder someone else owns; `Files.ReadWrite` covers only their own files. It
reaches any file the person can reach in OneDrive, not just this folder — the
app only ever uses the one folder (`src/data/onedrive.js`), and the earlier app
asks for the same. Anyone who signed in before version 0.7.0 is asked to sign
in again to grant it.

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

The editor also sets the slow-cooker and in-season tags and the source website,
adds and renames section headings (Marinade, Icing), and moves lines up and down
— a line moved past a heading goes into that section. **Delete recipe** is at the
bottom of the editor. From a recipe, **Copy** puts it on the clipboard laid out
for an email or a message, and **Keep the screen on** stops the phone dimming
while you cook (remembered per phone; also in Setup).

**Import from website** (on the Recipes tab) takes a recipe pasted from a site:
either what the **🛒 Grab Recipe** bookmark copies — set it up from the import
screen; it is the same bookmark the earlier app used — or the whole page,
selected and copied. It opens in the editor with each website line shown beside
its row and the likeliest ingredients offered, and nothing is saved until
**Save**.

A new ingredient typed into a recipe asks where it goes on the shopping list
(category and aisle) and how it is bought (weight, volume or counted). **Setup →
Ingredient list** shows every ingredient's category, aisle and unit, and flags
the ones still needing any of them.

**Setup → Shopping list** holds the household's staples (bought every week, with
amounts) and two switches: staples on or off, and **Pantry items start as "at
home"**, which puts recipe Pantry items in an *At home already* group on the list
with a **Need it** button. These live in the recipe file's settings, so they
apply on every phone and in the earlier app too.

The **Plan** tab prints the week's menu for the fridge (**Print menu**), and the
**Wait** tab takes anything typed in, not only ingredients from the list — it
appears on the shopping list under *Wait list*.

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

Three rules worth keeping as it grows:

- **Bump `src/version.js` (and `package.json`) with every change that ships.**
  Setup shows it under the title, so anyone can see at a glance which version
  a phone is running.

- **Every merge decision lives in `src/core/merge.js`.** A resolution made
  anywhere else is a decision no property test is watching.
- **Every property is asserted under variation** (`test/harness.js`) — skewed
  clocks, shuffled delivery, compacted or not — never against a single run.
