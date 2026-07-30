/**
 * Server-side validation for the maintenance endpoints.
 *
 * Validation lives on the server because the browser is not the only way in —
 * and because several of these fields fail *silently* rather than loudly, which
 * is the real reason this file is careful rather than perfunctory:
 *
 *   function   The planner decides what a furnace does with
 *              `function.toLowerCase().startsWith('carb')`. Anything that is
 *              not recognisably carbonization is therefore treated as
 *              graphitization — no error, just a furnace quietly doing the
 *              wrong job in every plan.
 *
 *   yield      Stored as a fraction (0.9), not a percentage. Typing 90 does not
 *              look wrong in a form, and produces output figures 100x too high.
 *
 *   maxAmps    Three states that mean different things (see equipment below).
 *              Collapsing them loosens the site current cap, which is the one
 *              failure a current limit exists to prevent.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v) => typeof v === 'string' && v.trim().length > 0

/** @returns {string[]} list of problems; empty means valid */
function validateMachine(m, { requireId = false } = {}) {
  const errors = []

  if (requireId) {
    if (!isStr(m.id)) errors.push('id is required')
    else if (!SLUG.test(m.id)) errors.push("id must be lowercase letters, digits and hyphens, e.g. 'furnace-7'")
  }

  if (!isStr(m.name)) errors.push('name is required')

  // Not cosmetic — see the note at the top of this file.
  const fn = String(m.function || '').toLowerCase()
  if (!isStr(m.function)) {
    errors.push('function is required')
  } else if (!fn.startsWith('carb') && !fn.startsWith('graph')) {
    errors.push(
      `function must start with "Carbonization" or "Graphitization" — got "${m.function}". ` +
        'The planner routes batches on this word; anything else is silently treated as graphitization.',
    )
  }

  if (!Number.isInteger(m.holders) || m.holders < 1) {
    errors.push('holders must be a whole number of at least 1')
  }

  if (!isNum(m.gfPerHolder) || m.gfPerHolder <= 0) {
    errors.push('gfPerHolder must be a positive number of grams')
  }

  if (!isNum(m.yield) || m.yield <= 0 || m.yield > 1) {
    errors.push(
      `yield must be a fraction between 0 and 1 — got ${m.yield}. ` +
        'A 90% yield is 0.9, not 90.',
    )
  }

  return errors
}

/**
 * Equipment ratings have three distinct states and they must stay distinct:
 *
 *   rated:true,  maxAmps set   a rating the plan holds itself to
 *   needsInput:true, maxAmps null   sheet said "Unknown"; the operator types it
 *   neither,     maxAmps null   nothing claimed; counted as 0 A AND warned about
 */
function validateEquipment(e, { requireId = false } = {}) {
  const errors = []

  if (requireId) {
    if (!isStr(e.id)) errors.push('id is required')
    else if (!SLUG.test(e.id)) errors.push("id must be lowercase letters, digits and hyphens, e.g. 'cooling-system-2'")
  }

  if (!isStr(e.name)) errors.push('name is required')

  if (e.rated && e.needsInput) {
    errors.push('equipment cannot both have a rating and be marked Unknown — pick one')
  }

  if (e.rated) {
    if (!isNum(e.maxAmps) || e.maxAmps < 0) {
      errors.push('a rated item needs a maxAmps value of 0 or more')
    }
  } else if (e.maxAmps != null) {
    errors.push('maxAmps must be empty unless the item is marked as rated')
  }

  return errors
}

function validateRule(r) {
  const errors = []
  if (!isStr(r.text)) errors.push('rule text is required')
  else if (r.text.length > 500) errors.push('rule text must be under 500 characters')
  return errors
}

module.exports = { validateMachine, validateEquipment, validateRule, SLUG }
