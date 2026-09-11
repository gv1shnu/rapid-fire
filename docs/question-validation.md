# The Lost Schema — question validation & progress

**Validation rules (12 s clock):** stem ≤ 20 words · code ≤ 5 lines · table ≤ 4×4 ·
options ≤ 10 words · exactly one correct · every wrong option tagged with a misconception ·
**tables rendered from `table_json`, never described in the stem** · stem is one short catchy line.

Status legend: **PASS** = meets every rule · **FIX** = needs a change (noted).

---

## Progress

| Round | Theme | Target pool | Authored | Validated | Status |
|------:|-------|:-----------:|:--------:|:---------:|--------|
| 1 | Vault of Keys | 45 | 0 | — | not started |
| 2 | Guild City | 45 | 0 | — | not started |
| 3 | Dune Dig / Cipher Lock | 45 | 1 | 1 | seed sample validated |
| 4 | Alchemist's Workshop | 45 | 0 | — | not started |
| 5 | Pirate Harbour / Card Table | 45 | 2 | 2 | seed samples validated |
| 6 | Orbit Grand Prix | 45 | 0 | — | not started |
| 7 | Nesting Temple | 45 | 0 | — | not started |
| 8 | Noir Bureau | 45 | 1 | 1 | seed sample validated |
| 9 | Cartographer's Finale | 45 | 0 | — | not started |
| **Total** | | **405** | **4** | **4** | rules locked; 4 seed samples pass |

The full 405-question bank is **not yet authored** — the four questions below are the validated
seed samples that set the shape every future row must follow. Author the rest in the sheet, then
run the import validator (it applies the rules above to all rows at once).

---

## Validated seed samples

Each is shown as it renders (catchy stem + real table) and in the `table_json` shape the sheet
stores. ✓ marks the correct option; every wrong option carries its misconception tag.

### R5-001 · Card Table · `reverse_query` · medium — **PASS**

**"Who came in pairs?"** From this hand, which query returns only ranks dealt more than once?

| suit | rank |
|:----:|:----:|
| ♠ | K |
| ♠ | 7 |
| ♥ | 7 |
| ♦ | 2 |
| ♣ | 7 |

- ✓ `SELECT rank FROM hand GROUP BY rank HAVING COUNT(*) > 1`
- `... WHERE COUNT(*) > 1 GROUP BY rank` — *aggregate in WHERE*
- `SELECT DISTINCT rank FROM hand` — *doesn't count*
- `... GROUP BY suit HAVING COUNT(*) > 1` — *wrong grouping column*

`table_json`: `{ "cols": ["suit","rank"], "rows": [["♠","K"],["♠","7"],["♥","7"],["♦","2"],["♣","7"]] }`
Checks: stem 12 words ✓ · table 5×2 (≤4 cols) ✓ · options ≤10 words ✓ · one correct ✓ · tabled ✓

> Note: 5 rows is fine — the ≤4 limit is on **columns**; keep hands to ≤ 6 rows for the clock.

### R5-002 · Card Table · `predict_result` · medium — **PASS**

**"Face or number?"** Bucket this hand with `CASE WHEN rank IN ('J','Q','K') THEN 'face' ELSE 'number' END` and group — how many rows come back?

| suit | rank |
|:----:|:----:|
| ♠ | K |
| ♥ | J |
| ♦ | 9 |
| ♣ | 4 |

- ✓ `2`
- `4` — *counts cards, not groups*
- `1` — *forgets 'number' bucket*
- `3` — *treats each face card as its own group*

`table_json`: `{ "cols": ["suit","rank"], "rows": [["♠","K"],["♥","J"],["♦","9"],["♣","4"]] }`
Checks: stem 18 words ✓ · table 4×2 ✓ · options ≤10 words ✓ · one correct ✓ · tabled ✓

### R3-001 · Cipher Lock · `fill_blank` · easy — **PASS**

**"Crack the 8."** 8 letters, starts **S**, ends **n** — which `WHERE` keeps only those words?

- ✓ `word LIKE 'S______n'`  *(S + 6× `_` + n)*
- `word LIKE 'S%n'` — *any length*
- `word LIKE 'S_n'` — *only 3 letters*
- `word LIKE '%S%n%'` — *S and n anywhere*

No data table needed (pattern question). Checks: stem 14 words ✓ · options ≤10 words ✓ ·
one correct ✓ · misconceptions tagged ✓

### R8-001 · Noir Bureau · `predict_result` · medium — **PASS**

**"Who's left after the LEFT JOIN?"** How many rows does `suspects LEFT JOIN alibis USING (case_id)` return?

**suspects**

| case_id | name |
|:-------:|:----:|
| 1 | Rao |
| 2 | Das |
| 3 | Iqbal |

**alibis**

| case_id | alibi |
|:-------:|:-----:|
| 1 | café |
| 1 | tram |

- ✓ `4`
- `2` — *counts only matches (INNER)*
- `3` — *one row per suspect*
- `5` — *Cartesian of both tables*

`table_json`: `{ "left": {"cols":["case_id","name"],"rows":[[1,"Rao"],[2,"Das"],[3,"Iqbal"]]},
"right": {"cols":["case_id","alibi"],"rows":[[1,"café"],[1,"tram"]]} }`
Checks: stem 12 words ✓ · two tables ≤3 rows ✓ · options ≤10 words ✓ · one correct ✓ · tabled ✓

---

## What to do next

1. Author each round's pool in the sheet using the seed shapes above (aim 15 easy / 20 medium /
   10 hard per round).
2. Put every data row in `table_json`; keep the stem to one catchy line.
3. Run the import validator — it re-validates **all** rows against these rules and rejects any that
   dump data into the stem, exceed the size limits, or lack exactly one correct option.
4. Update the progress table's *Authored / Validated / Status* columns from the validator's report.
