/**
 * Headless assertions for the planner.
 *
 * Verifies that a produced schedule actually obeys the workbook's Rules sheet —
 * a plan that quietly violates a constraint is worse than no plan at all, so
 * these run against real generated schedules rather than hand-written fixtures.
 *
 *   node tools/check_schedule.mjs
 */
import { readFileSync } from 'node:fs'
import { defaultParams } from '../src/lib/cooling.js'
import { planProduction, cycleTemplate, isCarbonization } from '../src/lib/schedule.js'

const data = JSON.parse(readFileSync(new URL('../src/data/machines.json', import.meta.url)))
const { machines, rules } = data
const ALL = machines.map((m) => m.id)
const EPS = 1e-6

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const overlaps = (a, b) => a.from < b.to - EPS && b.from < a.to - EPS

function audit(label, result, opts = {}) {
  console.log(`\n${label}`)
  const { batches } = result

  // 1. no furnace runs two batches at once
  let clash = null
  for (const m of ALL) {
    const mine = batches.filter((b) => b.machineId === m).sort((x, y) => x.start - y.start)
    for (let i = 1; i < mine.length; i++) {
      if (mine[i].start < mine[i - 1].end - EPS) clash = `${m}: ${mine[i - 1].id} vs ${mine[i].id}`
    }
  }
  check('one batch at a time per furnace', !clash, clash || '')

  // 2. paired furnaces never have their elements on together
  let heatClash = null
  for (const g of rules.exclusiveHeating) {
    const [a, b] = g.machines
    const wa = batches.filter((x) => x.machineId === a).map((x) => ({ from: x.powerFrom, to: x.powerTo }))
    const wb = batches.filter((x) => x.machineId === b).map((x) => ({ from: x.powerFrom, to: x.powerTo }))
    for (const x of wa) for (const y of wb) if (overlaps(x, y)) heatClash = `${a}/${b} @ ${x.from.toFixed(2)}h`
  }
  check('paired furnaces never heat together', !heatClash, heatClash || `${rules.exclusiveHeating.length} pair(s) checked`)

  // 3. graphitization never consumes material that does not exist yet
  const events = []
  for (const b of batches) {
    if (b.stage === 'carbonization') events.push({ t: b.end, d: +b.holders, id: b.id })
    else events.push({ t: b.start, d: -b.holders, id: b.id })
  }
  // Material that lands at exactly time t may be loaded at t, so arrivals settle
  // before consumption when the timestamps tie.
  events.sort((x, y) => x.t - y.t || y.d - x.d)
  let stock = opts.startWipHolders || 0
  let negative = null
  for (const e of events) {
    stock += e.d
    if (stock < -EPS && !negative) negative = `${e.id} at ${e.t.toFixed(2)}h (stock ${stock})`
  }
  check('feedstock never goes negative', !negative, negative || `ends with ${stock} holder(s) in stock`)

  // 4. load and unload legs match the Rules sheet
  const legBad = batches.find((b) => {
    const load = b.legs.find((l) => l.key === 'load')
    const unload = b.legs.find((l) => l.key === 'unload')
    return (
      Math.abs(load.to - load.from - rules.loadHours) > EPS ||
      Math.abs(unload.to - unload.from - rules.unloadHours) > EPS
    )
  })
  check(`load ${rules.loadHours} h / unload ${rules.unloadHours} h on every batch`, !legBad, legBad?.id || '')

  // 5. the element is on exactly between loading and cooling
  const powerBad = batches.find((b) => {
    const heat = b.legs.find((l) => l.key === 'heat')
    const hold = b.legs.find((l) => l.key === 'hold')
    return Math.abs(b.powerFrom - heat.from) > EPS || Math.abs(b.powerTo - hold.to) > EPS
  })
  check('power window = ramp + soak', !powerBad, powerBad?.id || '')

  // 6. GF total reconciles with holders x g/holder x yield
  const expected = batches
    .filter((b) => b.stage === 'graphitization')
    .reduce((a, b) => {
      const m = machines.find((x) => x.id === b.machineId)
      return a + b.holders * m.gfPerHolder * m.yield
    }, 0)
  check(
    'GF total reconciles with holders x 660 g x yield',
    Math.abs(expected - result.totals.gfGrams) < 0.01,
    `${(result.totals.gfGrams / 1000).toFixed(2)} kg`,
  )

  // 7. nothing runs past the horizon in window mode
  if (result.mode === 'window') {
    const over = batches.find((b) => b.end > result.horizonHours + EPS)
    check('every batch finishes inside the window', !over, over?.id || '')
  }

  return result
}

// --------------------------------------------------------------------------
console.log('cycle lengths under default cooling parameters')
for (const m of machines) {
  const t = cycleTemplate(m, defaultParams(m), rules)
  console.log(
    `  ${m.name}  ${isCarbonization(m) ? 'carb ' : 'graph'}  ` +
      `load ${t.load} + heat ${t.heat} + hold ${t.hold} + cool ${t.cool.toFixed(2)} + unload ${t.unload}` +
      ` = ${t.total.toFixed(2)} h   power ${t.powerFrom}-${t.powerTo} h`,
  )
}

const week = planProduction({ machines, rules, availableIds: ALL, mode: 'window', horizonHours: 24 * 7 })
audit('A. one week, all six furnaces', week)
console.log(
  `   -> ${(week.totals.gfGrams / 1000).toFixed(2)} kg GF, ${week.totals.batches} batches ` +
    `(${week.totals.carbBatches} carb / ${week.totals.graphBatches} graph), ` +
    `${week.totals.gfPerDay.toFixed(0)} g/day, bottleneck: ${week.bottleneck?.stage}`,
)

const month = planProduction({ machines, rules, availableIds: ALL, mode: 'window', horizonHours: 24 * 30 })
audit('B. 30 days, all six furnaces', month)
console.log(`   -> ${(month.totals.gfGrams / 1000).toFixed(2)} kg GF, ${month.totals.gfPerDay.toFixed(0)} g/day`)

const target = planProduction({ machines, rules, availableIds: ALL, mode: 'target', targetGrams: 20000 })
audit('C. target 20 kg GF', target)
console.log(
  `   -> ${(target.totals.gfGrams / 1000).toFixed(2)} kg in ${target.finishHours.toFixed(1)} h ` +
    `(${(target.finishHours / 24).toFixed(1)} days), reached: ${target.reachedTarget}`,
)

const subset = planProduction({
  machines,
  rules,
  availableIds: ['furnace-3', 'furnace-1', 'furnace-2'],
  mode: 'window',
  horizonHours: 24 * 14,
})
audit('D. two weeks, only F1, F2, F3 (one carb furnace, an exclusive graph pair)', subset)
console.log(`   -> ${(subset.totals.gfGrams / 1000).toFixed(2)} kg GF, ${subset.totals.batches} batches`)

const stock = planProduction({
  machines,
  rules,
  availableIds: ['furnace-5', 'furnace-6'],
  mode: 'window',
  horizonHours: 24 * 5,
  startWipHolders: 9,
})
audit('E. graphitization only, 9 holders of carbonized stock on hand', stock, { startWipHolders: 9 })
console.log(`   -> ${(stock.totals.gfGrams / 1000).toFixed(2)} kg GF from stock, ${stock.totals.batches} batches`)

const impossible = planProduction({
  machines,
  rules,
  availableIds: ['furnace-1'],
  mode: 'target',
  targetGrams: 5000,
  maxHours: 24 * 10,
})
audit('F. unreachable target (F1 alone, no feedstock, 10-day cap)', impossible)
check('unreachable target is reported, not faked', !impossible.reachedTarget && impossible.totals.gfGrams === 0)

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'}`)
process.exit(failures ? 1 : 0)
