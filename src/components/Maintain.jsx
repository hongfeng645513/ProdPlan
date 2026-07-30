import { useState } from 'react'
import { parseRules } from '../lib/derive.js'
import * as api from '../lib/api.js'
import { num } from '../lib/format.js'

/**
 * Maintain the source data: machines, equipment and rules.
 *
 * Curve points are intentionally not editable here. They are the measured
 * record, they are what the phase detection and the Newton fit are derived
 * from, and editing them wants a different kind of UI than a form — so they
 * stay read-only until that is built properly.
 *
 * Everything derived (phases, k, capacity) recomputes on save because the whole
 * payload is rebuilt by derive.js from the reloaded source rows. Nothing
 * derived is stored, so nothing derived can go stale.
 */

/**
 * Describe, in plain words, what the parser made of a rule sentence.
 *
 * This is the point of keeping rules as free text: the constraint stays as
 * expressive as English, and the author finds out *immediately* whether the
 * planner understood it — rather than discovering after the fact that a rule
 * has been sitting there unenforced.
 */
function describeRule(text, machines) {
  const nameOf = (id) => machines.find((m) => m.id === id)?.name || id
  const parsed = parseRules([text])

  if (parsed.exclusiveHeating.length) {
    const g = parsed.exclusiveHeating[0]
    return { ok: true, text: `${g.machines.map(nameOf).join(' and ')} will never have their elements on at the same time.` }
  }
  if (parsed.supportEquipment.length) {
    const s = parsed.supportEquipment[0]
    const eq = s.equipment.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
    return {
      ok: true,
      text: `${eq} runs from element-on until cool enough to unload, for ${s.machines.map(nameOf).join(', ')} — counted once, however many are running.`,
    }
  }
  if (parsed.coating.warmupAmps != null) {
    const c = parsed.coating
    return {
      ok: true,
      text: `Coating line draws ${num(c.warmupAmps)} A for its first ${num(c.warmupHours)} h, then ${num(c.runAmps)} A${c.restartsWarmup ? '; a stop costs the warm-up again' : ''}.`,
    }
  }
  if (parsed.coating.priority === 'high') {
    return { ok: true, text: 'Coating line is kept running; furnaces get pushed later instead of shedding it.' }
  }
  if (parsed.loadHours) {
    return { ok: true, text: `A ${num(parsed.loadHours)} h load leg is added before every cycle.` }
  }
  if (parsed.unloadHours) {
    return { ok: true, text: `A ${num(parsed.unloadHours)} h unload leg closes every cycle.` }
  }
  return {
    ok: false,
    text: 'Not understood — this rule will be listed but NOT enforced by the planner.',
  }
}

function Feedback({ busy, error, warnings, saved }) {
  if (busy) return <p className="sub">Saving…</p>
  if (error) {
    return (
      <div className="notice notice-error">
        <strong>{error.message}</strong>
        {error.errors?.length > 0 && (
          <ul className="notice-list">
            {error.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  return (
    <>
      {saved && <p className="sub saved-text">Saved.</p>}
      {warnings?.length > 0 && (
        <div className="notice">
          <ul className="notice-list">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

const BLANK_MACHINE = {
  id: '', name: '', model: '', function: 'Graphitization',
  holders: 1, gfSize: '', gfPerHolder: 660, yield: 0.9,
}
const BLANK_EQUIPMENT = { id: '', name: '', maxAmps: null, rated: false, needsInput: false }

export default function Maintain({ data, canEdit, onChanged }) {
  const [section, setSection] = useState('machines')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [saved, setSaved] = useState(false)

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    setWarnings([])
    setSaved(false)
    try {
      const res = await fn()
      setWarnings(res?.warnings || [])
      setSaved(true)
      await onChanged()
      return true
    } catch (err) {
      setError(err)
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="detail">
      <h2>Maintain data</h2>
      <p className="sub">
        Machines, equipment and rules are stored in the database and read live by the planner.
        Cycle timing, the cooling fit and batch capacity are recomputed from these values — they are
        never stored, so they cannot go stale.
      </p>

      {!canEdit && (
        <div className="notice">
          You have read access only. Editing requires the <code>editor</code> role — ask whoever
          administers the app to grant it.
        </div>
      )}

      <div className="filters maintain-tabs">
        {[
          ['machines', `Machines (${data.machines.length})`],
          ['equipment', `Equipment (${data.power.equipment.length})`],
          ['rules', `Rules (${data.rules.raw.length})`],
        ].map(([k, label]) => (
          <button key={k} className={section === k ? 'is-active' : ''} onClick={() => setSection(k)}>
            {label}
          </button>
        ))}
      </div>

      <Feedback busy={busy} error={error} warnings={warnings} saved={saved} />

      {section === 'machines' && <Machines data={data} canEdit={canEdit} run={run} />}
      {section === 'equipment' && <Equipment data={data} canEdit={canEdit} run={run} />}
      {section === 'rules' && <Rules data={data} canEdit={canEdit} run={run} />}
    </section>
  )
}

// --------------------------------------------------------------------------

function Machines({ data, canEdit, run }) {
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(BLANK_MACHINE)

  const startEdit = (m) => {
    setEditing(m.id)
    setDraft({ ...m })
  }
  const startNew = () => {
    setEditing('__new__')
    setDraft(BLANK_MACHINE)
  }
  const save = async () => {
    const ok = await run(() =>
      editing === '__new__' ? api.createMachine(draft) : api.updateMachine(editing, draft),
    )
    if (ok) setEditing(null)
  }
  const remove = async (m) => {
    if (!confirm(`Delete ${m.name}? Its temperature curve is deleted with it. This cannot be undone.`)) return
    await run(() => api.deleteMachine(m.id))
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <caption>Furnace specifications. The temperature curve is read-only here.</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Function</th>
              <th scope="col">Model</th>
              <th scope="col">Holders</th>
              <th scope="col">GF / holder</th>
              <th scope="col">Yield</th>
              <th scope="col">Curve</th>
              {canEdit && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.machines.map((m) => (
              <tr key={m.id}>
                <th scope="row">{m.name}</th>
                <td>{m.function}</td>
                <td>{m.model}</td>
                <td>{m.holders}</td>
                <td>{num(m.gfPerHolder)} g</td>
                <td>{num((m.yield ?? 0) * 100)} %</td>
                <td>{m.measured?.length || 0} pts</td>
                {canEdit && (
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => startEdit(m)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(m)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && !editing && (
        <button className="btn" onClick={startNew}>Add furnace</button>
      )}

      {editing && (
        <div className="edit-panel">
          <h3>{editing === '__new__' ? 'New furnace' : `Edit ${draft.name}`}</h3>
          <div className="edit-grid">
            {editing === '__new__' && (
              <label>
                Id
                <input
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder="furnace-7"
                />
                <span className="hint">Lowercase, hyphens. Cannot be changed later.</span>
              </label>
            )}
            <label>
              Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              Function
              <select
                value={draft.function}
                onChange={(e) => setDraft({ ...draft, function: e.target.value })}
              >
                <option>Carbonization</option>
                <option>Graphitization</option>
              </select>
              <span className="hint">The planner routes batches on this.</span>
            </label>
            <label>
              Model
              <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            </label>
            <label>
              Holders
              <input
                type="number" min="1" step="1"
                value={draft.holders}
                onChange={(e) => setDraft({ ...draft, holders: parseInt(e.target.value, 10) })}
              />
            </label>
            <label>
              GF size
              <input value={draft.gfSize} onChange={(e) => setDraft({ ...draft, gfSize: e.target.value })} />
            </label>
            <label>
              GF per holder (g)
              <input
                type="number" min="0" step="1"
                value={draft.gfPerHolder}
                onChange={(e) => setDraft({ ...draft, gfPerHolder: parseFloat(e.target.value) })}
              />
            </label>
            <label>
              Yield
              <input
                type="number" min="0" max="1" step="0.01"
                value={draft.yield}
                onChange={(e) => setDraft({ ...draft, yield: parseFloat(e.target.value) })}
              />
              <span className="hint">A fraction: 90 % is 0.9.</span>
            </label>
          </div>
          <div className="edit-actions">
            <button className="btn" onClick={save}>Save</button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}

// --------------------------------------------------------------------------

function Equipment({ data, canEdit, run }) {
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(BLANK_EQUIPMENT)

  const startEdit = (e) => {
    setEditing(e.id)
    setDraft({ id: e.id, name: e.name, maxAmps: e.maxAmps, rated: e.rated, needsInput: e.needsInput })
  }
  const save = async () => {
    const ok = await run(() =>
      editing === '__new__' ? api.createEquipment(draft) : api.updateEquipment(editing, draft),
    )
    if (ok) setEditing(null)
  }
  const remove = async (e) => {
    if (!confirm(`Delete ${e.name}? This cannot be undone.`)) return
    await run(() => api.deleteEquipment(e.id))
  }

  /** The three states, named the way the planner treats them. */
  const stateOf = (e) =>
    e.rated ? `${num(e.maxAmps)} A` : e.needsInput ? 'Unknown — typed in per plan' : 'No rating — counted as 0 A'

  return (
    <>
      <div className="table-wrap">
        <table>
          <caption>
            Current ratings. A blank rating is counted as 0 A and warned about, never guessed —
            guessing would quietly raise the site current ceiling.
          </caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Rating</th>
              <th scope="col">Role in a plan</th>
              {canEdit && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.power.equipment.map((e) => (
              <tr key={e.id}>
                <th scope="row">{e.name}</th>
                <td className={!e.rated && !e.needsInput ? 'warn-cell' : ''}>{stateOf(e)}</td>
                <td>{e.kind}</td>
                {canEdit && (
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => startEdit(e)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(e)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && !editing && (
        <button className="btn" onClick={() => { setEditing('__new__'); setDraft(BLANK_EQUIPMENT) }}>
          Add equipment
        </button>
      )}

      {editing && (
        <div className="edit-panel">
          <h3>{editing === '__new__' ? 'New equipment' : `Edit ${draft.name}`}</h3>
          <div className="edit-grid">
            {editing === '__new__' && (
              <label>
                Id
                <input
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder="cooling-system-2"
                />
              </label>
            )}
            <label>
              Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              Rating state
              <select
                value={draft.rated ? 'rated' : draft.needsInput ? 'unknown' : 'blank'}
                onChange={(e) => {
                  const v = e.target.value
                  setDraft({
                    ...draft,
                    rated: v === 'rated',
                    needsInput: v === 'unknown',
                    maxAmps: v === 'rated' ? (draft.maxAmps ?? 0) : null,
                  })
                }}
              >
                <option value="rated">Rated — a known current</option>
                <option value="unknown">Unknown — operator types it per plan</option>
                <option value="blank">No rating — counted as 0 A, with a warning</option>
              </select>
            </label>
            {draft.rated && (
              <label>
                Max amps
                <input
                  type="number" min="0" step="1"
                  value={draft.maxAmps ?? 0}
                  onChange={(e) => setDraft({ ...draft, maxAmps: parseFloat(e.target.value) })}
                />
              </label>
            )}
          </div>
          <div className="edit-actions">
            <button className="btn" onClick={save}>Save</button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}

// --------------------------------------------------------------------------

function Rules({ data, canEdit, run }) {
  const [editing, setEditing] = useState(null)
  const [text, setText] = useState('')

  const preview = describeRule(text, data.machines)

  const save = async () => {
    const ok = await run(() =>
      editing === '__new__' ? api.createRule({ text }) : api.updateRule(editing, { text }),
    )
    if (ok) setEditing(null)
  }
  const remove = async (r, id) => {
    if (!confirm(`Delete this rule?\n\n"${r.text}"`)) return
    await run(() => api.deleteRule(id))
  }

  return (
    <>
      <p className="sub">
        Rules are written as plain sentences and parsed by the planner. A sentence it cannot
        interpret is listed but <strong>not enforced</strong> — the preview below tells you which
        before you save.
      </p>

      <div className="table-wrap">
        <table>
          <caption>Scheduling constraints, in the order they are read.</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Rule</th>
              <th scope="col">Effect</th>
              {canEdit && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.rules.raw.map((r, i) => {
              const d = describeRule(r.text, data.machines)
              return (
                <tr key={i}>
                  <td>{i}</td>
                  <th scope="row" className="rule-text">{r.text}</th>
                  <td className={d.ok ? '' : 'warn-cell'}>{d.text}</td>
                  {canEdit && (
                    <td className="row-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => { setEditing(i); setText(r.text) }}
                      >
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(r, i)}>Delete</button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {canEdit && !editing && editing !== 0 && (
        <button className="btn" onClick={() => { setEditing('__new__'); setText('') }}>Add rule</button>
      )}

      {editing !== null && (
        <div className="edit-panel">
          <h3>{editing === '__new__' ? 'New rule' : `Edit rule ${editing}`}</h3>
          <label className="rule-editor">
            Sentence
            <textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Furnace 1 and Furnace 2 cannot heat at the same time"
            />
          </label>
          <div className={preview.ok ? 'notice notice-ok' : 'notice'}>
            <strong>{preview.ok ? 'Will be enforced as:' : 'Warning:'}</strong> {preview.text}
          </div>
          <div className="edit-actions">
            <button className="btn" onClick={save} disabled={!text.trim()}>Save</button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}
