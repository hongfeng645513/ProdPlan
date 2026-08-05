/**
 * Temporary planning rules — constraints that apply to the plan on screen and
 * are never written to the database.
 *
 * They exist for the things that are true this week and not next: an engineer
 * on site Tuesday, a furnace down for a liner change, a cooling system being
 * serviced. Putting those in the Rules sheet would mean remembering to take
 * them out again, and a stale constraint is worse than no constraint because it
 * silently shapes every plan afterwards.
 */
import { parseRules } from './derive.js'

/**
 * Split typed text into individual rule sentences.
 *
 * Semicolons and newlines are unambiguous separators. Commas are not — the
 * rules in use already contain them:
 *
 *   "Cooling system 1 need to run during both heating and cooling for
 *    furnace 1, furnace 2 and furnace 3"
 *
 * Splitting that on commas destroys it. But not splitting on commas is just as
 * bad the other way: two exclusivity rules joined by one parse as a SINGLE rule
 * naming four furnaces, which is silently wrong rather than rejected.
 *
 * So a comma-separated fragment is split only when splitting improves it —
 * when every part parses on its own. Otherwise the fragment is kept whole. The
 * parser is the arbiter, which means this cannot disagree with what the planner
 * will actually enforce.
 */
export function splitRuleText(text) {
  if (!text || !text.trim()) return []

  const understood = (s) => {
    const parsed = parseRules([s])
    return parsed.raw.length === 1 && parsed.raw[0].parsed
  }

  const out = []
  for (const chunk of text.split(/[;\n]+/)) {
    const whole = chunk.trim()
    if (!whole) continue

    if (!whole.includes(',')) {
      out.push(whole)
      continue
    }

    const parts = whole.split(',').map((p) => p.trim()).filter(Boolean)
    // Only accept the split if it makes every part meaningful. A rule that
    // legitimately contains commas fails this and survives intact.
    if (parts.length > 1 && parts.every(understood)) out.push(...parts)
    else out.push(whole)
  }
  return out
}

/**
 * Parse typed text into a rules block, marking every sentence as temporary.
 */
export function parseTempRules(text) {
  const sentences = splitRuleText(text)
  const parsed = parseRules(sentences)
  return {
    ...parsed,
    sentences,
    raw: parsed.raw.map((r) => ({ ...r, temporary: true })),
    unparsed: parsed.raw.filter((r) => !r.parsed).map((r) => r.text),
  }
}

/**
 * Combine the stored rules with temporary ones for a single plan.
 *
 * Additive where it can be: exclusivity groups and support plant accumulate,
 * because a temporary rule saying two furnaces cannot heat together should
 * tighten the plan, never loosen it by replacing what is already there.
 *
 * Single-valued settings — load time, unload time, the coating profile — do
 * replace, since there is only one of each and a temporary one is a deliberate
 * override. Load and unload are taken only when actually given: `parseRules`
 * reports 0 for "not mentioned", and letting that through would quietly delete
 * the real load leg from every cycle.
 */
export function mergeRules(base, extra) {
  if (!extra || !extra.raw?.length) return base

  return {
    ...base,
    raw: [...(base.raw || []), ...extra.raw],
    exclusiveHeating: [...(base.exclusiveHeating || []), ...(extra.exclusiveHeating || [])],
    supportEquipment: [...(base.supportEquipment || []), ...(extra.supportEquipment || [])],
    coating: { ...(base.coating || {}), ...(extra.coating || {}) },
    loadHours: extra.loadHours > 0 ? extra.loadHours : base.loadHours,
    unloadHours: extra.unloadHours > 0 ? extra.unloadHours : base.unloadHours,
    // Furnace preferences accumulate, temporary ones ranking ahead of any
    // stored preference: a rule typed for this plan is the more recent
    // instruction. Omitted entirely when neither side expressed one, so the
    // merged block keeps the shape the parser produces.
    ...(extra.preferredMachines?.length || base.preferredMachines?.length
      ? {
          preferredMachines: [
            ...(extra.preferredMachines || []),
            ...(base.preferredMachines || []).filter(
              (id) => !(extra.preferredMachines || []).includes(id),
            ),
          ],
        }
      : {}),
  }
}

/**
 * Describe what the planner made of a sentence, in plain words.
 *
 * The same feedback the stored-rules editor gives: a constraint the parser
 * cannot read is listed but NOT enforced, and finding that out before planning
 * is the difference between a rule and a comment.
 */
export function describeRule(text, machines = []) {
  const nameOf = (id) => machines.find((m) => m.id === id)?.name || id.replace(/-/g, ' ')
  const p = parseRules([text])

  if (p.exclusiveHeating.length) {
    const g = p.exclusiveHeating[0]
    return { ok: true, text: `${g.machines.map(nameOf).join(' and ')} will never heat at the same time.` }
  }
  if (p.supportEquipment.length) {
    const s = p.supportEquipment[0]
    const eq = s.equipment.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
    return { ok: true, text: `${eq} runs whenever ${s.machines.map(nameOf).join(', ')} is between element-on and cool enough to unload.` }
  }
  if (p.coating.warmupAmps != null) {
    const c = p.coating
    return { ok: true, text: `Coating line draws ${c.warmupAmps} A for ${c.warmupHours} h, then ${c.runAmps} A.` }
  }
  if (p.coating.priority === 'high') {
    return { ok: true, text: 'Coating line is kept running; furnaces are pushed later instead.' }
  }
  if (p.preferredMachines?.length) {
    return {
      ok: true,
      text:
        `${p.preferredMachines.map(nameOf).join(', then ')} will be loaded first whenever ` +
        'more than one furnace is free at the same moment.',
    }
  }
  if (p.loadHours) return { ok: true, text: `Loading takes ${p.loadHours} h before every cycle.` }
  if (p.unloadHours) return { ok: true, text: `Unloading takes ${p.unloadHours} h after every cycle.` }

  return { ok: false, text: 'Not understood — this will NOT be applied to the plan.' }
}
