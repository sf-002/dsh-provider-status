/**
 * Provider status — account-summary readers.
 *
 * Pure data plumbing: one timed JSON request, then the ClinePass plan reader or a
 * configurable dot-path reader. No Cordis, no schema, no caching — the Host half
 * owns those, which keeps this module directly testable against a real API.
 */
export const DEFAULT_TIMEOUT_MS = 10000

/**
 * Read one dot path out of a JSON value.
 * @param value - decoded document or nested node.
 * @param path - dotted property path such as `data.balance`.
 * @returns the addressed value, or undefined.
 */
export function readPath(value, path) {
  let node = value
  for (const segment of String(path ?? '').split('.').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[segment]
  }
  return node
}

/**
 * Convert a timestamp-like value to an ISO string.
 * @param value - ISO string, epoch milliseconds or epoch seconds.
 * @returns the ISO timestamp, or null when the value is not a usable time.
 */
export function toIsoTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  return null
}

/**
 * Normalize one usage-limit window reported by ClinePass.
 * @param window - raw window record.
 * @returns the percent used and its reset time, or null when unusable.
 */
export function readUsageWindow(window) {
  if (window === null || typeof window !== 'object') return null
  const used = Number(window.percentUsed)
  if (!Number.isFinite(used)) return null
  return {
    type: typeof window.type === 'string' ? window.type : null,
    percentUsed: Math.max(0, Math.min(100, Math.round(used * 10) / 10)),
    resetsAt: toIsoTime(window.resetsAt),
  }
}

/**
 * Perform one timed JSON request.
 * @param url - absolute URL.
 * @param spec - provider spec supplying the timeout and auth header.
 * @param apiKey - credential written into the auth header; empty skips the header.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the decoded document, null for an empty body.
 */
export async function getJson(url, spec, apiKey, fetchImpl = fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const headers = { Accept: 'application/json' }
    if (apiKey !== '') headers[spec.authHeader ?? 'Authorization'] = `${spec.authPrefix ?? 'Bearer '}${apiKey}`
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    const text = await response.text()
    let body = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    if (!response.ok) {
      const detail = body?.error?.message ?? body?.error ?? `HTTP ${response.status}`
      throw new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

/**
 * ClinePass: plan period, price and rolling usage windows.
 * @param spec - provider spec.
 * @param apiKey - resolved credential.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the provider record without identity fields.
 */
export async function probeClinePass(spec, apiKey, fetchImpl = fetch) {
  if (apiKey === '') return { ok: false, error: 'no-credential' }
  const base = String(spec.baseUrl ?? 'https://api.cline.bot/api/v1').replace(/\/+$/, '')
  const [planDocument, limitsDocument] = await Promise.all([
    getJson(`${base}/users/me/plan`, spec, apiKey, fetchImpl),
    getJson(`${base}/users/me/plan/usage-limits`, spec, apiKey, fetchImpl).catch(() => null),
  ])
  const planData = planDocument?.data ?? planDocument
  const plan = planData?.plan ?? planData ?? {}
  const limits = limitsDocument?.data?.limits ?? limitsDocument?.limits ?? []
  const priceCents = Number(plan?.pricePerSeatCents ?? plan?.priceInCents)
  return {
    ok: true,
    planName: typeof plan?.displayName === 'string' ? plan.displayName : (typeof plan?.name === 'string' ? plan.name : null),
    interval: typeof plan?.interval === 'string' ? plan.interval : null,
    priceCents: Number.isFinite(priceCents) ? priceCents : null,
    periodStart: toIsoTime(planData?.currentPeriodStart),
    periodEnd: toIsoTime(planData?.currentPeriodEnd),
    windows: Array.isArray(limits) ? limits.map(readUsageWindow).filter((window) => window !== null) : [],
  }
}

/**
 * Any provider document with configurable amount, currency and period paths.
 * @param spec - provider spec.
 * @param apiKey - resolved credential.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the provider record without identity fields.
 */
export async function probeJson(spec, apiKey, fetchImpl = fetch) {
  if (typeof spec.url !== 'string' || spec.url.trim() === '') return { ok: false, error: 'no-url' }
  const document = await getJson(spec.url, spec, apiKey, fetchImpl)
  const rawBalance = readPath(document, spec.balancePath ?? 'data.balance')
  const numeric = typeof rawBalance === 'string' ? Number(rawBalance) : rawBalance
  const currency = readPath(document, spec.currencyPath ?? 'data.currency')
  return {
    ok: true,
    balance: typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null,
    balanceText: typeof rawBalance === 'string' && !Number.isFinite(Number(rawBalance)) ? rawBalance : null,
    currency: typeof currency === 'string' ? currency : null,
    periodEnd: toIsoTime(readPath(document, spec.expiresPath ?? 'data.expiresAt')),
  }
}

/**
 * Read one provider, converting any failure into a record the UI can report.
 * @param spec - provider spec supplying id, kind and request settings.
 * @param dependencies - credential resolver and optional fetch implementation.
 * @returns the stored record.
 */
export async function probeProvider(spec, { resolveKey, fetchImpl = fetch }) {
  const checkedAt = Date.now()
  try {
    const apiKey = await resolveKey(spec.apiKeyEnv)
    const outcome = spec.kind === 'json'
      ? await probeJson(spec, apiKey, fetchImpl)
      : await probeClinePass(spec, apiKey, fetchImpl)
    return { ...outcome, id: spec.id, label: spec.label ?? null, kind: spec.kind ?? 'clinepass', checkedAt }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      id: spec.id,
      label: spec.label ?? null,
      kind: spec.kind ?? 'clinepass',
      error: aborted ? 'timeout' : String(error?.message ?? error),
      checkedAt,
    }
  }
}
