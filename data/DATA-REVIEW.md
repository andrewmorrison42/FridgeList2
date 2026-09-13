# Recipe data — correctness review

**Date:** 2026-09-13. **Source:** the household's `recipes-data.json`
(638 recipes, 452 ingredients, 5,561 recipe ingredient lines).
**Output:** [`recipes-data.reviewed.json`](recipes-data.reviewed.json).

This review separates two things deliberately: **defects fixed**, where the
correct value was unambiguous and the change cannot alter how any existing
version of the app behaves; and **findings referred to the household**, where
a fix would change shopping quantities, merge things that may not be the same
thing, or guess at intent. Nothing in the second list has been touched.

## Verification of the output

The corrected file was checked against the original and is identical except
for the 19 changes listed below:

- 638 recipes and 452 ingredients — unchanged counts
- every ingredient **name** identical (recipes reference ingredients by name,
  so any rename would orphan references)
- all 5,561 recipe → ingredient references identical, in the same order
- ingredient ids now unique across all 452 entries
- no ingredient left with an empty shopping unit

## Fixed (19 changes)

| Fix | Count | Detail |
|---|---|---|
| Aisle capitalisation | 6 | `freezer`→`Freezer`, `international`→`International`, `baking`→`Baking` (×2), `biscuits`→`Biscuits` (×2). Affects grouping only |
| Missing ingredient ids | 9 | Nine entries — added later than the rest — had no `id`, `needed`, `servingSize` or `kjPerServe`. Ids 497–505 assigned; the other three fields left absent |
| Empty shopping unit | 1 | *Toothpaste* had `shoppingUnit: ""`. Set to `qty`. **A judgement call**, but the only sensible unit for toothpaste |
| Unparseable quantities | 3 | `½`→`0.5` (Kidney beans, minestrone), `2 ½`→`2.5` (Onion, ikea-meatballs), `½`→`0.5` (Thyme, ultimate-meatloaf). All were strings holding a unicode fraction |

## Referred to the household

### 1. Conversions are volume-based, not weight-based

**The most consequential finding.** Every ingredient in the data converts at
**1 cup = 250**, regardless of what it is:

| Ingredient | Implied per cup | Reality |
|---|---|---|
| Butter | 250 g | ~227 g — close enough |
| Rice (arborio) | 250 g | ~200 g — near enough |
| Almonds (ground) | 250 g | ~100 g |
| Basil | 250 g | ~25 g for fresh leaves |
| Cabbage | 250 g | ~70 g shredded |

The data is treating `g` as if it were `mL` — a cup is 250 mL, and that number
has been carried straight into a field labelled grams. For dense ingredients
it is roughly right; for leafy or flaked ones it overstates by up to ten times.

This matters because **FR-ING-1 requires that a shopping quantity is never
presented without applying a cooking→shopping conversion** — and the conversion
currently in the data is not a real one for many ingredients.

**Not fixed, because fixing it would change what you buy.** Correcting basil
from 250 g to 25 g per cup is a change to your shopping list, not a data
cleanup, and it is your decision. Three options:

- **(a) Leave it.** You have shopped successfully for years with these numbers,
  which suggests you read them as a rough guide and buy a bunch of basil
  regardless.
- **(b) Correct only the worst offenders** — the leafy and flaked ingredients
  where the error is severalfold. Perhaps 20–30 ingredients.
- **(c) Change the shopping unit** for those ingredients from `g` to `qty`
  (a bunch, a punnet), which is how you actually buy them. This is arguably
  the honest fix: the problem is not the conversion factor but that grams were
  never the right unit for fresh herbs.

### 2. "Mint" and "Tahini" are each two different things

Two duplicate ingredient names, and **they should not be merged** — contrary to
the earlier recommendation, which was made before this evidence:

| Name | Entry A | Entry B |
|---|---|---|
| Mint | Fruit and Vegetables / **Vegetables** aisle | Pantry / **Spices** aisle |
| Tahini | Breakfast, serving size 11 | Breakfast, serving size 25 |

Mint is clearly *fresh* versus *dried* — two genuinely different purchases in
two different parts of the shop. Merging them would put dried mint in the
vegetable aisle.

There is already a live defect here: recipes reference ingredients **by name**,
so every recipe calling for "Mint" resolves to whichever entry is found first.
Some of those recipes mean the other one.

**Requires a human decision**, because renaming them (to "Mint (fresh)" and
"Mint (dried)") means deciding, recipe by recipe, which one each of them meant.
That cannot be inferred. Doing this before the migration would be worth it —
the migration assigns stable ids and rewrites references, so this is the natural
moment to disambiguate, and the last easy one.

### 3. Nine ingredient lines have a quantity of zero

`prawn-capsicum-and-feta-penne` (Tinned tomato), `chicken-wings-in-maple-glaze`
(Lettuce), `chicken-nugget-tacos` (Cucumber), `creamy-salmon-risoni` (Lettuce),
`speedy-honey-chicken-and-rainbow-vegetables` (Baby Corn, Zucchini) and three
others.

These look like garnishes — "serve with lettuce" — recorded with no amount. They
will generate a shopping line of zero, which is meaningless. Either give them a
quantity or the model needs a "to taste / to serve" concept that has no
quantity and does not reach the shopping list. **The second is probably right,
and it is a requirements question, not a data one.**

### 4. One quantity is almost certainly wrong

`crispy-honey-chilli-beef` lists **Honey, `1/3`, unit `mL`** — a third of a
millilitre of honey. Almost certainly "⅓ cup" recorded with the wrong unit.
Left alone, because parsing it faithfully to `0.333` would produce a confidently
wrong number rather than an obviously broken one. Worth checking against the
original recipe.

### 5. Thirty-nine recipes list the same ingredient twice

For example `apple-crumble` lists Flour (Plain) twice — once for the filling,
once for the crumble. This is legitimate, and generation sums duplicate lines
anyway (FR-LIST-2), so **no action is needed**. Noted only so that it is not
mistaken for a defect later.

### 6. Three recipe names appear twice, under different ids

`caramelised onion marmalade`, `pan fried pork and water chestnut dumplings`,
`mexican beef risotto`. Could be deliberate variants or genuine duplicates —
only you can tell. Note FR-REC-5 forbids a bulk delete, so if any are
duplicates they are removed one at a time, deliberately.

### 7. Six ingredients sit in the "Uncategorised" aisle

*Toothpaste, Tea bags (earl grey), Vanilla extract, water, Tea (earl grey),
vanilla bean paste* — all in shopping category "Other".

Under the layout agreed in the architecture (category as header, aisle as
subheading) these land in an "Other / Uncategorised" bucket at the bottom of
the list, which is where things go to be forgotten. Five minutes of
categorisation would remove the bucket entirely.

Also: **`water` is an ingredient.** It presumably should never reach a shopping
list. That is either a data fix or a "never shop this" flag on the ingredient
master — worth deciding which, since there may be others like it.

### 8. Conversion rounding noise — no action

107 ingredient/unit pairs have slightly inconsistent implied conversions, e.g.
Salt at 4, 4.8, 5, 5.33, 6 and 8 g per teaspoon. These come from rounding small
quantities in individual recipes, not from disagreement about what a teaspoon
is. The migration should take the **median** implied factor per
(ingredient, cooking unit), which lands on the sensible value in every case
sampled. Worth stating explicitly because FR-ING-1 assumes *one* conversion per
pair, and the data holds several — the median is how that gets resolved.
