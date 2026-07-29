/**
 * Where the app gets its machine data.
 *
 * Transitional by design. The source of truth is moving into Postgres, but the
 * committed src/data/machines.json is kept as a fallback so this step cannot
 * break the app: if the API answers, its data wins; if it does not, the bundled
 * snapshot is used and the app says so.
 *
 * The same fetch-or-fall-back shape is what makes the editing UI safe to add
 * later — the read path is proven before anything can write.
 *
 * Note this fallback is a migration aid, not the offline story. The decision on
 * this project is that the app becomes online-only, so once the database is the
 * only place machine data is maintained, the snapshot goes stale the moment
 * someone edits a furnace. Retire it rather than trusting it.
 */
import bundled from '../data/machines.json'
import { buildPayload } from './derive.js'

/** Milliseconds before a silent API is treated as absent. */
const TIMEOUT_MS = 8000

/**
 * @returns {Promise<{payload: object, origin: 'api'|'bundled', error: string|null}>}
 */
export async function loadMachineData() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch('api/machines', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`API returned ${res.status}`)

    const src = await res.json()
    if (!Array.isArray(src.machines) || src.machines.length === 0) {
      throw new Error('API returned no machines')
    }

    return { payload: buildPayload(src), origin: 'api', error: null }
  } catch (err) {
    // Opening dist/index.html from disk lands here too, which is exactly the
    // behaviour wanted while the migration is in progress.
    return {
      payload: bundled,
      origin: 'bundled',
      error: err.name === 'AbortError' ? 'the database did not respond' : err.message,
    }
  } finally {
    clearTimeout(timer)
  }
}
