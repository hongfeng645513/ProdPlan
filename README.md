# ProdPlan

Web tool for planning the GO-film production line: it reads the furnace
descriptions from `Machine/Machines.xlsx` and presents every machine with its
specifications, its cycle timing and its temperature curve, and plans batches
across the line from those numbers.

## The process

```
GO film ──► Carbonization ──► Graphitization ──► Graphite film
            Furnace 3, 4       Furnace 1, 2, 5, 6
            ramp to 1000 °C    ramp to 2800 °C
```

Every cycle has three phases:

| Phase | Behaviour |
|---|---|
| **Heating** | Controlled — the temperature curve is accurate and comes straight from the workbook. |
| **Hold** | Soak at the set point. |
| **Cooling** | Natural. Depends on room temperature and how well the furnace is insulated, differs from machine to machine and drifts over time. |

Because cooling is the uncertain part, it is **modelled** rather than tabulated.
The app fits Newton's law of cooling to the measured cool-down points, anchored
at the moment heating is switched off:

```
T(t) = T_room + (T_off − T_room) · e^(−k · (t − t_off))
```

Only the cooling constant `k` is fitted, so each furnace has a single
"how fast does this one cool" dial. Fitted values from the current workbook:

| Furnace | Function | Peak | Heat | Hold | k | Fit error |
|---|---|---|---|---|---|---|
| 1, 2 | Graphitization | 2800 °C | 12 h | 1 h | 0.1200 /h | ± 99 °C |
| 5, 6 | Graphitization | 2800 °C | 12 h | 1 h | 0.1200 /h | ± 99 °C |
| 3, 4 | Carbonization | 1000 °C | 7 h | 1 h | 0.0726 /h | ± 12 °C |

In the app, room temperature, `k` and the unload temperature can be adjusted per
machine; cycle time, batches per day and kg per day recompute live. Adjustments
are kept in the browser (localStorage) and can be reset to the workbook fit.

## Planning production

The **Plan production** tab schedules real batches across the furnaces. Two
questions it answers:

- **"What can I make between these two dates?"** — pick a start and an end, and
  it fills the window and reports the graphite film that comes out.
- **"When will I have *n* kg of GF?"** — give a start and a target, and it runs
  until the target is met and reports the finish time.

Either way you choose which furnaces are available, and can seed the plan with
carbonized material already in stock.

Batches follow the full route: material is carbonized first, and a graphitization
furnace cannot load until enough carbonized holders exist. Every batch is a whole
batch — a furnace is not fired part-loaded — so a target is met or slightly
overshot, never split. Yield is applied once, at graphitization.

### Rules

Constraints live in the `Rules` sheet of the workbook, one plain sentence per
row, and are parsed rather than hard-coded:

| Sentence in the sheet | What the planner does |
|---|---|
| `Furnace 1 and Furnace 2 cannot heat at the same time` | Their power-on windows (ramp + soak) never overlap. Cooling, loading and unloading may. |
| `It takes one hour to load a furnace before heating` | A 1 h load leg is added ahead of every cycle. |
| `It takes one hour to unload a furnace after cooling` | A 1 h unload leg closes every cycle. |

A cycle is therefore:

```
load ──► heat ──► hold ──► cool ──► unload
└ 1 h ┘  └──── element is ON ────┘         └ 1 h ┘
```

The app lists every rule it read and flags any it could not interpret, so an
unparsed rule is visibly *not enforced* rather than silently ignored. Add a rule
to the sheet, rerun `npm run data`, and the planner picks it up.

Scheduling is greedy: earliest finish wins, ties go to the larger furnace (scarce
feedstock is worth more in a 3-holder furnace) and then to the furnace that has
run least, which spreads wear rather than hammering whichever sorts first.

`npm run check` asserts against generated schedules that no paired furnaces heat
together, no furnace runs two batches at once, graphitization never consumes
material before it exists, and the totals reconcile.

## Forecasting a running furnace

The **Forecast** tab answers a different question from the planner: not "what
should we run" but "this furnace is hot right now — where will it be each hour
from here". Pick the furnace, type its current temperature, set the time
(defaults to now) and say whether the element is on. Out comes an hour-by-hour
temperature curve and table.

The two directions are deliberately not symmetrical:

| Element | How it is projected |
|---|---|
| **Cooling** | Newton's law anchored on the temperature *you type*, not on the workbook's heat-off point. Cooling has no memory of how the furnace got hot, so any starting temperature is valid — including one that never appears in the workbook. |
| **Heating** | The ramp is *controlled*, so the furnace follows the recipe rather than choosing its own rate. The entered temperature is inverted against the measured ramp to find where on the recipe the furnace is, and the forecast is the rest of that recipe — ramp, then the workbook's soak, then the element goes off and it cools naturally. A furnace is never parked at temperature indefinitely, so the curve always comes back down. |

It also reports the milestones an operator actually wants: when the set point is
reached, when the soak ends and the element goes off, and when the furnace has
fallen far enough to open — so a furnace part-way up its ramp answers "when is
this batch out?", not just "when does it get hot?".

Because the heating ramp is inverted against a curve sampled once per hour,
resolution between two samples is only linear — on the graphitization furnaces'
first hour (20 → 1000 °C) that is a coarse approximation.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/index.html, a single self-contained file
```

`dist/index.html` inlines all JS and CSS, so it can be opened straight from disk
or copied to a shared drive without a web server.

## Updating the machine data

Edit `Machine/Machines.xlsx`, then regenerate the JSON the app is built from:

```bash
pip install openpyxl
npm run data           # = python tools/convert_excel.py
```

The converter reads one worksheet per machine and expects these row labels:
`Name`, `Model`, `Function`, `Holders`, `GF size`, `GF per holder(g)`, `Yield`,
a time row (`Time(hours)`, `0 1 2 …`) and a temperature row. A trailing `Open`
cell marks the point where the furnace is opened. The `Rules` sheet is read
separately, one constraint per row in plain English. It writes
`src/data/machines.json`, deriving the phase boundaries, the Newton cooling fit,
the batch capacity for each machine and the parsed rules.

## Layout

```
Machine/Machines.xlsx      source of truth for machine properties
tools/convert_excel.py     workbook -> src/data/machines.json
src/data/machines.json     generated; committed so the app builds without Python
src/lib/cooling.js         Newton cooling model, cycle timing, capacity
src/lib/schedule.js        batch scheduler: rules, two-stage route, two plan modes
src/lib/forecast.js        forward projection for a furnace that is already running
src/lib/format.js          number formatting + the categorical colour palette
src/components/            charts, machine cards, detail panel, planner, Gantt, forecast
src/App.jsx                page composition, state, tab routing
tools/check_schedule.mjs   headless assertions that a plan obeys the rules
```

## Publishing to GitHub

`origin` is already set to `https://github.com/hongfeng645513/ProdPlan.git` on
the local clone. Create the (empty) repository on GitHub, then:

```bash
cd C:\AI\ProdPlan
git push -u origin main
```

## Roadmap

- Shift patterns — loading and unloading currently run 24/7.
- Maintenance windows and per-furnace downtime.
- Firm orders with due dates, rather than one aggregate target.
