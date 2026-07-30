/**
 * Where the app gets its machine data.
 *
 * Postgres is the source of truth and the data is maintained in the app, so in
 * production there is no fallback: if the database cannot be reached, the app
 * says so and shows nothing.
 *
 * That is deliberate. A bundled snapshot would still render six furnaces and
 * plausible numbers while silently predating every edit anyone has made — and
 * a plan built on stale machine data looks exactly like a plan built on current
 * data. Failing visibly is worth more than rendering something wrong.
 *
 * The one exception is `npm run dev`, where there is no API at all. There the
 * committed snapshot is used so the UI can be worked on offline, and the app
 * states which one it is using.
 */
import { buildPayload } from './derive.js'

/** Milliseconds before a silent API is treated as unreachable. */
const TIMEOUT_MS = 10000

/**
 * @returns {Promise<{payload: object|null, origin: 'api'|'bundled', error: string|null}>}
 */
export async function loadMachineData() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch('api/machines', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`the API returned ${res.status}`)

    const src = await res.json()
    if (!Array.isArray(src.machines) || src.machines.length === 0) {
      throw new Error('the database returned no machines')
    }

    return { payload: buildPayload(src), origin: 'api', error: null }
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'the database did not respond in time' : err.message

    if (import.meta.env.DEV) {
      // Local development only: no API is running, so fall back to the
      // committed snapshot rather than blocking UI work.
      const bundled = (await import('../data/machines.json')).default
      return { payload: bundled, origin: 'bundled', error: reason }
    }

    return { payload: null, origin: 'api', error: reason }
  } finally {
    clearTimeout(timer)
  }
}
