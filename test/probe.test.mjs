// Reader tests: dot paths, timestamps, usage windows, and every failure path.
// Fully offline — each request goes through an injected fake fetch.
import { probeProvider, readPath, toIsoTime, readUsageWindow } from '../lib/probe.js'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
  }
}

// --- dot paths and time parsing ---------------------------------------------
check('readPath nested', readPath({ data: { balance: 3 } }, 'data.balance') === 3)
check('readPath missing', readPath({ data: {} }, 'data.balance') === undefined)
check('readPath through scalar', readPath({ data: 5 }, 'data.balance') === undefined)
check('toIsoTime iso', toIsoTime('2026-11-10T16:12:00Z') === '2026-11-10T16:12:00.000Z')
check('toIsoTime epoch seconds', toIsoTime(1762000000) === new Date(1762000000 * 1000).toISOString())
check('toIsoTime epoch millis', toIsoTime(1762000000000) === new Date(1762000000000).toISOString())
check('toIsoTime garbage', toIsoTime('not a date') === null)
check('toIsoTime empty', toIsoTime('') === null)
check('readUsageWindow clamps high', readUsageWindow({ type: 'monthly', percentUsed: 140 }).percentUsed === 100)
check('readUsageWindow clamps low', readUsageWindow({ type: 'weekly', percentUsed: -3 }).percentUsed === 0)
check('readUsageWindow rejects', readUsageWindow({ type: 'x' }) === null)
check('readUsageWindow rejects null', readUsageWindow(null) === null)

// --- helpers ----------------------------------------------------------------
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => payload,
})
const fakeFetch = (payload, status = 200) => async () => response(payload, status)
const withKey = async () => 'test-key'

// --- generic json reader ----------------------------------------------------
const jsonSpec = {
  id: 'acme',
  kind: 'json',
  url: 'https://example.test/me',
  apiKeyEnv: 'ANY',
  balancePath: 'data.balance',
  currencyPath: 'data.currency',
  expiresPath: 'data.expiresAt',
}

const numeric = await probeProvider(jsonSpec, {
  resolveKey: withKey,
  fetchImpl: fakeFetch(JSON.stringify({ data: { balance: '12.34', currency: 'usd', expiresAt: 1762000000 } })),
})
check('json numeric balance', numeric.balance === 12.34, numeric)
check('json currency', numeric.currency === 'usd')
check('json period end', numeric.periodEnd === new Date(1762000000 * 1000).toISOString())

const textual = await probeProvider(jsonSpec, {
  resolveKey: withKey,
  fetchImpl: fakeFetch(JSON.stringify({ data: { balance: 'unlimited' } })),
})
check('json text balance', textual.balanceText === 'unlimited' && textual.balance === null, textual)

const failed = await probeProvider(jsonSpec, {
  resolveKey: withKey,
  fetchImpl: fakeFetch(JSON.stringify({ error: { message: 'nope' } }), 401),
})
check('json http failure surfaces', failed.ok === false && failed.error === 'nope', failed)

const anonymous = await probeProvider({ ...jsonSpec, apiKeyEnv: 'UNSET' }, {
  resolveKey: async () => '',
  fetchImpl: fakeFetch('{}'),
})
check('json without credential still reads', anonymous.ok === true, anonymous)

const missingUrl = await probeProvider({ id: 'x', kind: 'json' }, { resolveKey: withKey, fetchImpl: fakeFetch('{}') })
check('json without url fails', missingUrl.ok === false && missingUrl.error === 'no-url', missingUrl)

const malformed = await probeProvider(jsonSpec, { resolveKey: withKey, fetchImpl: fakeFetch('<html>') })
check('json malformed body', malformed.ok === true && malformed.balance === null, malformed)

// --- clinepass reader -------------------------------------------------------
const clineSpec = {
  id: 'clinebot',
  kind: 'clinepass',
  baseUrl: 'https://api.cline.bot/api/v1',
  apiKeyEnv: 'CLINE',
  timeoutMs: 5000,
}
const noKey = await probeProvider(clineSpec, { resolveKey: async () => '', fetchImpl: fakeFetch('{}') })
check('clinepass without credential', noKey.ok === false && noKey.error === 'no-credential', noKey)

const planBody = JSON.stringify({
  success: true,
  data: {
    plan: { displayName: 'Cline Pass (Monthly)', interval: 'Monthly', pricePerSeatCents: 999 },
    currentPeriodStart: '2026-10-10T16:12:00Z',
    currentPeriodEnd: '2026-11-10T16:12:00Z',
  },
})
const limitsBody = JSON.stringify({
  data: { limits: [{ type: 'five_hour', percentUsed: 0 }, { type: 'monthly', percentUsed: 81.25 }] },
})
const cline = await probeProvider(clineSpec, {
  resolveKey: withKey,
  fetchImpl: async (url) => response(String(url).includes('usage-limits') ? limitsBody : planBody),
})
check('clinepass ok', cline.ok === true, cline)
check('clinepass plan name', cline.planName === 'Cline Pass (Monthly)', cline.planName)
check('clinepass price', cline.priceCents === 999, cline.priceCents)
check('clinepass period end', cline.periodEnd === '2026-11-10T16:12:00.000Z', cline.periodEnd)
check('clinepass windows', Array.isArray(cline.windows) && cline.windows.length === 2, cline.windows)
check('clinepass window rounding', cline.windows[1].percentUsed === 81.3, cline.windows[1])

const limitsBroken = await probeProvider(clineSpec, {
  resolveKey: withKey,
  fetchImpl: async (url) => {
    if (String(url).includes('usage-limits')) throw new Error('boom')
    return response(planBody)
  },
})
check('clinepass survives a broken limits read', limitsBroken.ok === true && limitsBroken.windows.length === 0, limitsBroken)

// --- failure normalisation --------------------------------------------------
const aborted = await probeProvider({ id: 'y', kind: 'json', url: 'https://example.test' }, {
  resolveKey: withKey,
  fetchImpl: async () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  },
})
check('abort becomes timeout', aborted.ok === false && aborted.error === 'timeout', aborted)

const thrown = await probeProvider({ id: 'z', kind: 'json', url: 'https://example.test' }, {
  resolveKey: withKey,
  fetchImpl: async () => {
    throw new Error('network down')
  },
})
check('error text is preserved', thrown.ok === false && thrown.error === 'network down', thrown)
check('failed record keeps identity', thrown.id === 'z' && thrown.kind === 'json', thrown)

console.log(failures === 0 ? '\nALL READER CHECKS PASSED' : `\n${failures} READER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
