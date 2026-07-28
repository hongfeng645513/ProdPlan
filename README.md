# ProdPlan

Web tool for planning the GO-film production line: it reads the furnace
descriptions from `Machine/Machines.xlsx` and presents every machine with its
specifications, its cycle timing and its temperature curve.

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
cell marks the point where the furnace is opened. It writes
`src/data/machines.json`, deriving the phase boundaries, the Newton cooling fit
and the batch capacity for each machine.

## Layout

```
Machine/Machines.xlsx      source of truth for machine properties
tools/convert_excel.py     workbook -> src/data/machines.json
src/data/machines.json     generated; committed so the app builds without Python
src/lib/cooling.js         Newton cooling model, cycle timing, capacity
src/lib/format.js          number formatting + the categorical colour palette
src/components/            chart, machine cards, detail panel, process flow, table
src/App.jsx                page composition, state, compare view
```

## Publishing to GitHub

The repository is initialised locally. To push it:

```bash
cd C:\AI\ProdPlan
git remote add origin https://github.com/<you>/ProdPlan.git
git branch -M main
git push -u origin main
```

## Roadmap

The natural next step is scheduling: place batches on the furnaces over a
calendar, respecting the carbonization → graphitization route, the cycle times
computed here and the number of holders per machine.
