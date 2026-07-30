/**
 * Client for the maintenance endpoints.
 *
 * Static Web Apps enforces the roles, not this file: writes are gated on
 * `editor` in staticwebapp.config.json and rejected by the platform before they
 * reach the API. `roles()` exists so the UI can *hide* controls the user cannot
 * use — that is a courtesy, not the security boundary. A reader who forges the
 * UI state still gets a 403 from the platform.
 */

/** Roles of the signed-in user, via the platform's own auth endpoint. */
export async function roles() {
  try {
    const res = await fetch('/.auth/me', { headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const body = await res.json()
    return body?.clientPrincipal?.userRoles || []
  } catch {
    return []
  }
}

export async function identity() {
  try {
    const res = await fetch('/.auth/me', { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = await res.json()
    return body?.clientPrincipal || null
  } catch {
    return null
  }
}

/**
 * Errors carry the server's validation messages, which are written to be shown
 * to a person — they explain why a value is wrong (a 90% yield is 0.9, not 90),
 * not merely that it is.
 */
export class ApiError extends Error {
  constructor(message, errors = [], status = 0) {
    super(message)
    this.errors = errors
    this.status = status
  }
}

async function send(method, path, body) {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ApiError(`Could not reach the server: ${err.message}`)
  }

  if (res.status === 403) {
    throw new ApiError('You do not have the editor role, so this change was rejected.', [], 403)
  }

  let payload = null
  try {
    payload = await res.json()
  } catch {
    /* some responses have no body */
  }

  if (!res.ok) {
    throw new ApiError(payload?.error || `Request failed (${res.status})`, payload?.errors || [], res.status)
  }
  return payload || {}
}

export const createMachine = (m) => send('POST', 'api/machines', m)
export const updateMachine = (id, m) => send('PUT', `api/machines/${encodeURIComponent(id)}`, m)
export const deleteMachine = (id) => send('DELETE', `api/machines/${encodeURIComponent(id)}`)

export const createEquipment = (e) => send('POST', 'api/equipment', e)
export const updateEquipment = (id, e) => send('PUT', `api/equipment/${encodeURIComponent(id)}`, e)
export const deleteEquipment = (id) => send('DELETE', `api/equipment/${encodeURIComponent(id)}`)

export const createRule = (r) => send('POST', 'api/rules', r)
export const updateRule = (id, r) => send('PUT', `api/rules/${id}`, r)
export const deleteRule = (id) => send('DELETE', `api/rules/${id}`)
