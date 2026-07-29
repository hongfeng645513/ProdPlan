# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web tool for planning a GO-film production line: two carbonization furnaces
(F3, F4) feed four graphitization furnaces (F1, F2, F5, F6). It reads furnace
specifications, temperature curves, scheduling rules and electrical ratings out
of `Machine/Machines.xlsx`, then plans batches across the line and reports the
current the site would draw. React + Vite, no backend.

## Commands

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/index.html, single self-contained file (vite-plugin-singlefile)
npm run check    # headless assertions against generated schedules
npm run data     # = python tools/convert_excel.py   (needs: pip install openpyxl)
```

There is no linter, no formatter, and no unit-test framework. `npm run check` is
the entire test suite: one script that builds real plans and asserts properties
of them. It has no filter flag — it always runs everything and exits non-zero on
the first failure count. To narrow it down, read the labelled `ok`/`FAIL` lines
or temporarily comment out `audit(...)` calls in `tools/check_schedule.mjs`.

## Architecture

### The data pipeline

```
Machine/Machines.xlsx ──(npm run data)──> src/data/machines.json ──> the app
```

`src/data/machines.json` is **generated but committed**, so the app builds
without Python. Never hand-edit it — edit the workbook and regenerate, or the
next `npm run data` silently reverts the change. The converter prints warnings
to stderr (unknown furnace names in rules, missing current ratings, unparsed
rules); read them, they are the main feedback channel for workbook mistakes.

`tools/convert_excel.py` reads one worksheet per machine plus two special
sheets, `Rules` and `Electricity`. Adding a field to the app means adding it in
`build()` / `parse_sheet()` there first, then reading it in the components.

### Constraints come from the spreadsheet, not from constants

The `Rules` sheet holds one plain-English sentence per row, parsed by
`parse_rules()` in the converter into `exclusiveHeating`, `supportEquipment`,
`coating`, `loadHours`, `unloadHours`. Two invariants hold throughout the
codebase and should be preserved:

- **An unparsed rule is never silently dropped.** Every sentence is carried
  through in `rules.raw` with `parsed: true|false`, and `planProduction()` turns
  each unparsed one into a user-visible warning. A rule the planner does not
  understand must be visibly *not enforced*.
- **A missing number is never guessed.** A blank current rating on the
  `Electricity` sheet counts as 0 A plus a warning; `"Unknown"` becomes an
  operator input field. Guessing would quietly raise the current ceiling, which
  is the one failure a current limit exists to prevent. The converter keeps
  those three states apart (`rated`, `needsInput`, blank) on purpose.

To support a new kind of rule sentence: add a branch in `parse_rules()`, then
consume the new field in `src/lib/schedule.js` or `src/lib/power.js`.

### Cycle length is computed, not stored

`src/lib/cooling.js` is the single source of truth for how long a cycle takes.
Heating and soak come from the measured workbook curve; only the cooling tail is
modelled, with one fitted Newton constant `k` per furnace. Because an operator
can retune `ambient`, `k` and `unloadTemp` per machine, **cycle length is not
constant** — `cycleTemplate()` in `schedule.js` recomputes it from the current
parameters on every plan. Anything that assumes a fixed cycle time is wrong.

Those overrides live in `App.jsx` (`localStorage`, key `prodplan.cooling.v1`)
and reach everything else through a single `paramsFor(machine)` callback passed
down to the planner and forecast. That is the only mutable per-machine state.

### The power model has two halves, and they are deliberately different

`src/lib/power.js` exports two things that both compute load, for different
reasons — this is the least obvious part of the codebase:

- **`createLedger()`** is the mutable ledger the scheduler books against *while*
  placing batches. It assumes the coating line is up, because the `Rules` sheet
  ranks it above the furnaces: furnaces get pushed later, the coating line does
  not get shed. `earliestStart()` walks forward cut by cut to find a start that
  fits under the cap.
- **`simulate()`** rebuilds the whole timeline *after* the plan is fixed, and is
  the only place the coating line's trip-and-restart state machine lives (off →
  2 h warm-up at 200 A producing nothing → running at 100 A; any dip in headroom
  trips it and the warm-up is paid again). Only at this point is it known when
  there was really headroom for it.

Consequences worth remembering: the current cap is enforced *during* scheduling,
so a breaching plan is never produced; and shared support plant (cooling/vacuum
systems) is counted **once** across all the furnaces it serves — `union()` of
intervals, not a per-batch sum. A naive sum over batches double-counts it, and
`npm run check` asserts against exactly that.

In `planProduction()`, `settle()` alternates between the exclusive-heating check
and the current-cap check, because clearing one can push a batch onto the other;
it iterates until neither wants to move it. The greedy loop also has two passes:
pass 1 keeps the coating line up, and only if nothing at all can be placed does
pass 2 let a batch push it over.

### Planning vs forecasting

`src/lib/schedule.js` answers "what should we run" (greedy, earliest-finish
first; ties to the larger furnace, then the least-used one). `src/lib/forecast.js`
answers a different question — "this furnace is hot right now, where will it be
each hour" — and the two directions are asymmetric on purpose: cooling is
anchored on the temperature the operator types, while heating is inverted
against the measured ramp to locate the furnace on its recipe and then plays the
rest of the recipe out. Don't "fix" that asymmetry into symmetry.

## Conventions

- Plain ESM JavaScript and JSX. No TypeScript, no test framework, no path
  aliases. `"type": "module"`.
- **`src/lib/*.js` must stay Node-runnable** — no React, no DOM, no JSX imports.
  `tools/check_schedule.mjs` imports them directly under bare Node, so pulling a
  browser dependency into a lib module breaks the checks.
- Charts are hand-rolled SVG in `src/components/`, no charting library. The
  categorical palette and theme colours live in `src/lib/format.js`.
- Comments here explain *why the model is shaped this way* (which quantity is
  measured vs modelled, why a load is counted once). That density is intentional
  in the lib and converter files; match it rather than stripping it.

## Environment notes

- Something on this machine (sync client or antivirus) periodically interrupts
  git mid-write, leaving a stale `.git/index.lock` that blocks `git add`, and
  `tmp_obj_*` leftovers beside the real loose objects. Both are safe to delete
  once you have confirmed no git process is actually running — the `.lock` files
  are empty, and each `tmp_obj_*` is a hard link to an object that already
  landed in `.git/objects/`, so removing it leaves the object intact. Verify
  with `git fsck --full` afterwards.
- Git reports CRLF warnings on nearly every file; they are noise, not a problem
  to fix.
- `origin` is `https://github.com/hongfeng645513/ProdPlan.git`, branch `main`.
