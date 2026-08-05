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
import { resolvePower } from '../src/lib/power.js'
import { validatePlan } from '../src/lib/planEdit.js'
import { splitRuleText, parseTempRules, mergeRules } from '../src/lib/tempRules.js'

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

  // The validator behind hand-editing must agree with the scheduler. Anything
  // the scheduler produces is legal by construction, so a violation reported
  // here means one of the two is wrong — and checking them against each other
  // is what stops the drag-and-drop warnings drifting away from the rules the
  // planner actually enforces.
  const found = validatePlan({
    batches,
    machines,
    rules,
    power: opts.resolved || null,
    electricity: result.electricity,
    startWipHolders: opts.startWipHolders || 0,
    horizonHours: result.mode === 'window' ? result.horizonHours : null,
  })
  check(
    'the hand-edit validator agrees this plan is legal',
    found.length === 0,
    found.map((v) => v.message).join('; ') || `${batches.length} batch(es) checked`,
  )

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
// --- temporary rules ------------------------------------------------------
//
// Commas are the whole difficulty here. Existing rules contain them, so
// splitting blindly destroys a rule; but two rules joined by one parse as a
// single rule naming four furnaces, which is silently wrong rather than
// rejected. The splitter therefore only splits when doing so makes every part
// parse — the parser being the arbiter means it cannot disagree with what the
// planner enforces.
console.log('\nG. temporary rules')
{
  const commaRule = 'Cooling system 1 need to run during both heating and cooling for furnace 1, furnace 2 and furnace 3'
  check('a rule containing commas is not torn apart',
    splitRuleText(commaRule).length === 1, JSON.stringify(splitRuleText(commaRule)))

  const two = 'Furnace 1 and Furnace 2 cannot heat at the same time, Furnace 3 and Furnace 4 cannot heat at the same time'
  const split = splitRuleText(two)
  check('two rules joined by a comma are separated', split.length === 2, JSON.stringify(split))
  check('and are not merged into one four-furnace group',
    parseTempRules(two).exclusiveHeating.every((g) => g.machines.length === 2),
    JSON.stringify(parseTempRules(two).exclusiveHeating.map((g) => g.machines)))

  check('semicolons separate',
    splitRuleText('Furnace 1 and Furnace 2 cannot heat at the same time; Furnace 5 and Furnace 6 cannot heat at the same time').length === 2)
  check('newlines separate',
    splitRuleText(
      ['Furnace 1 and Furnace 2 cannot heat at the same time',
       'Furnace 5 and Furnace 6 cannot heat at the same time'].join('\n'),
    ).length === 2)
  check('blank input yields nothing', splitRuleText('   ').length === 0)

  const merged = mergeRules(rules, parseTempRules('Furnace 3 and Furnace 4 cannot heat at the same time'))
  check('a temporary rule adds to the stored ones rather than replacing them',
    merged.exclusiveHeating.length === rules.exclusiveHeating.length + 1,
    `${rules.exclusiveHeating.length} -> ${merged.exclusiveHeating.length}`)
  check('stored load and unload times survive a temporary rule that does not mention them',
    merged.loadHours === rules.loadHours && merged.unloadHours === rules.unloadHours,
    `load ${merged.loadHours} h, unload ${merged.unloadHours} h`)
  check('an unreadable temporary rule is reported, not silently dropped',
    parseTempRules('please be careful with furnace 3').unparsed.length === 1)

  // The point of all this: the extra constraint must actually bind.
  const before = planProduction({ machines, rules, availableIds: ALL, paramsFor: defaultParams, mode: 'window', horizonHours: 24 * 14 })
  const after = planProduction({ machines, rules: merged, availableIds: ALL, paramsFor: defaultParams, mode: 'window', horizonHours: 24 * 14 })
  const heatsTogether = (plan) => {
    const a = plan.batches.filter((b) => b.machineId === 'furnace-3')
    const b2 = plan.batches.filter((b) => b.machineId === 'furnace-4')
    for (const x of a)
      for (const y of b2)
        if (x.powerFrom < y.powerTo - EPS && y.powerFrom < x.powerTo - EPS) return true
    return false
  }

  // The rule has to bite, or enforcing it proves nothing: without it, F3 and F4
  // must actually overlap.
  check('without the temporary rule, F3 and F4 do heat together',
    heatsTogether(before), `${before.batches.length} batch(es)`)
  check('with it, they never do',
    !heatsTogether(after), `${after.batches.length} batch(es)`)

  // Batch COUNT is deliberately not asserted. Scheduling is greedy, so an extra
  // constraint changes the tie-breaking and can pack better by accident — this
  // pair goes from 25 batches to 26. Fewer degrees of freedom does not mean less
  // output, and asserting otherwise tests a property the scheduler never had.
  check('the plan is genuinely rebuilt, not reused',
    JSON.stringify(before.batches.map((b) => [b.machineId, b.start])) !==
      JSON.stringify(after.batches.map((b) => [b.machineId, b.start])),
    `${before.batches.length} -> ${after.batches.length} batches`)
}

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

// --------------------------------------------------------------------------
// Electricity. The point of a current limit is that it is never breached, so
// these run against the load profile of a real plan rather than the model in
// isolation.
console.log('\nG. electricity — the profile must never cross the limit')

const RD = 60
const FACILITY = 120
const supportAmps = Object.fromEntries(
  (data.power?.equipment || []).map((e) => [e.id, e.maxAmps || 0]),
)

for (const cap of [400, 500, 600, 700, 900, 1500]) {
  const power = resolvePower(data.power, {
    maxAmps: cap,
    baseline: { 'r-d': RD, facility: FACILITY },
  })
  const r = planProduction({
    machines,
    rules,
    availableIds: ALL,
    mode: 'window',
    horizonHours: 24 * 7,
    power,
  })
  const e = r.electricity
  const worst = e.steps.reduce((a, s) => Math.max(a, s.total), 0)

  check(
    `cap ${cap} A — peak ${worst.toFixed(0)} A stays under it`,
    worst <= cap + 1e-3,
    `${r.totals.batches} batch(es), ${(r.totals.gfGrams / 1000).toFixed(2)} kg`,
  )

  // Every band adds up to the total it reports, at every step and every hour.
  const partsBad = e.steps.find(
    (s) => Math.abs(s.total - (s.baseline + s.support + s.coating + s.furnace)) > 1e-6,
  )
  check(`cap ${cap} A — bands sum to the total`, !partsBad)

  // Shared support plant is counted once. The most any of it can ever add is
  // the sum of the distinct systems, never a multiple of them.
  const maxSupport = (data.power?.support || []).reduce(
    (a, s) => a + (supportAmps[s.equipment] || 0),
    0,
  )
  const doubled = e.steps.find((s) => s.support > maxSupport + 1e-6)
  check(
    `cap ${cap} A — support plant never double-counted (max ${maxSupport} A)`,
    !doubled,
    doubled ? `${doubled.support} A at ${doubled.from.toFixed(2)} h` : '',
  )

  // Furnaces draw on the ramp only: at any instant, the furnace band must equal
  // the sum of the ratings of exactly those furnaces whose heat leg covers it.
  const bad = e.steps.find((s) => {
    const mid = (s.from + s.to) / 2
    const expect = r.batches
      .filter((b) => {
        const heat = b.legs.find((l) => l.key === 'heat')
        return mid >= heat.from - 1e-9 && mid < heat.to - 1e-9
      })
      .reduce((a, b) => a + (supportAmps[b.machineId] || 0), 0)
    return Math.abs(expect - s.furnace) > 1e-6
  })
  check(`cap ${cap} A — furnace draw is the heating ramp only`, !bad)
}

// The coating line, left alone with plenty of headroom, must follow the rule
// exactly: 200 A for two hours, then 100 A, and never drop.
{
  const power = resolvePower(data.power, { maxAmps: 100000, baseline: {} })
  const r = planProduction({
    machines,
    rules,
    availableIds: ALL,
    mode: 'window',
    horizonHours: 24 * 7,
    power,
  })
  const segs = r.electricity.coatingSegs
  const c = data.power.coating
  check(
    `coating warm-up is ${c.warmupHours} h at ${c.warmupAmps} A`,
    segs[0]?.phase === 'warmup' &&
      Math.abs(segs[0].to - segs[0].from - c.warmupHours) < EPS &&
      segs[0].amps === c.warmupAmps,
  )
  check(
    `coating then runs at ${c.runAmps} A continuously`,
    segs[1]?.phase === 'run' && segs[1].amps === c.runAmps,
  )
  check(
    'coating never drops when there is headroom',
    Math.abs(r.electricity.coatingUptime - 1) < EPS && r.electricity.coatingTrips.length === 0,
  )
}

// A limit under the baseline cannot schedule anything, and must say so rather
// than quietly planning over it.
{
  const power = resolvePower(data.power, {
    maxAmps: 200,
    baseline: { 'r-d': RD, facility: FACILITY },
  })
  const r = planProduction({
    machines,
    rules,
    availableIds: ALL,
    mode: 'window',
    horizonHours: 24 * 3,
    power,
  })
  check(
    'a limit below the plant rating schedules nothing rather than overshooting',
    r.totals.batches === 0 && r.electricity.peak <= 200 + 1e-3,
    `peak ${r.electricity.peak.toFixed(0)} A`,
  )
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'}`)
process.exit(failures ? 1 : 0)
