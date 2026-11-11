/**
 * Provider status — Host half.
 *
 * Resolves one short account summary (money balance and/or the end of the paid
 * period) for each configured LLM provider and publishes it on a read-only route.
 * The Client half renders that summary in the composer statistics row and beside
 * every provider heading of the model picker.
 *
 * The route carries only what the UI prints: plan name, period end, price, quota
 * percentages and a balance amount. Credentials never leave this process.
 */
import z from '@deepseek-ai/schemastery'
import { probeProvider } from './probe.js'

/** Route the Client half polls; no other owner may claim it. */
export const ROUTE_PATH = '/api/plugins/sf-002-provider-status/state'

const DEFAULT_CLINEPASS_BASE_URL = 'https://api.cline.bot/api/v1'
const DEFAULT_CLINEPASS_KEY_ENV = 'CLINEBOT_API_KEY'
const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_REFRESH_SECONDS = 120
const MIN_REFRESH_SECONDS = 15
/** How long one failed read is reused before it is retried. */
const FAILED_RETRY_MS = 20000

/**
 * One provider whose account summary this plugin publishes.
 *
 * `kind: 'clinepass'` reads the ClinePass plan and usage-limit endpoints;
 * `kind: 'json'` reads any JSON document a provider exposes and takes the
 * amount, currency and period end from dot paths.
 */
const ProviderSpec = z.object({
  id: z
    .string()
    .required()
    .description('Provider id exactly as the model catalog reports it (for example `clinebot`).'),
  label: z
    .string()
    .description('Display name override; the model catalog provider name wins while it is known.'),
  kind: z
    .union(['clinepass', 'json'])
    .default('clinepass')
    .description('Which reader produces this provider summary.'),
  baseUrl: z
    .string()
    .default(DEFAULT_CLINEPASS_BASE_URL)
    .description('ClinePass API base URL used by `kind: clinepass`.'),
  apiKeyEnv: z
    .string()
    .default(DEFAULT_CLINEPASS_KEY_ENV)
    .description('Credential reference or environment variable holding the API key; never store the key here.'),
  url: z
    .string()
    .description('Absolute URL read by `kind: json`.'),
  authHeader: z
    .string()
    .default('Authorization')
    .description('Request header carrying the credential for `kind: json`.'),
  authPrefix: z
    .string()
    .default('Bearer ')
    .description('Prefix written before the credential in `authHeader`.'),
  balancePath: z
    .string()
    .default('data.balance')
    .description('Dot path of the balance amount in the `kind: json` document.'),
  currencyPath: z
    .string()
    .default('data.currency')
    .description('Dot path of the currency code in the `kind: json` document.'),
  expiresPath: z
    .string()
    .default('data.expiresAt')
    .description('Dot path of the paid-period end timestamp in the `kind: json` document.'),
  timeoutMs: z
    .number()
    .default(DEFAULT_TIMEOUT_MS)
    .description('Per-request timeout for this provider.'),
})

export const Config = z.object({
  enabled: z.boolean().default(true).description('Publish the balances route while true.'),
  refreshSeconds: z
    .number()
    .min(MIN_REFRESH_SECONDS)
    .default(DEFAULT_REFRESH_SECONDS)
    .description('How long one provider summary is reused before the next read refreshes it.'),
  providers: z
    .array(ProviderSpec)
    .default([
      {
        id: 'clinebot',
        kind: 'clinepass',
        baseUrl: DEFAULT_CLINEPASS_BASE_URL,
        apiKeyEnv: DEFAULT_CLINEPASS_KEY_ENV,
      },
      {
        id: 'provod-ai',
        kind: 'json',
        url: 'https://api.provod.ai/v1/balance',
        apiKeyEnv: 'PROVOD_AI_API_KEY',
        balancePath: 'availableBalance',
        currencyPath: 'currency',
      },
      {
        id: 'provod-image',
        kind: 'json',
        url: 'https://api.provod.ai/v1/balance',
        apiKeyEnv: 'PROVOD_IMAGE_API_KEY',
        balancePath: 'availableBalance',
        currencyPath: 'currency',
      },
      {
        id: 'plusvibe-api',
        kind: 'json',
        url: 'https://gw.plusvibeapi.ru/v1/balance',
        apiKeyEnv: 'PLUSVIBE_API_API_KEY',
        balancePath: 'balance',
        currencyPath: 'currency',
      },
    ])
    .description('Providers whose account summary the Web GUI displays.'),
})

export const inject = ['webServer']
export const name = 'provider-status'

/** Reject requests another site initiated; the route only answers its own Web GUI. */
function isTrustedRequest(request) {
  const value = request?.headers?.['sec-fetch-site']
  const site = Array.isArray(value) ? value[0] : value
  return site !== 'cross-site'
}

function writeJson(response, statusCode, body) {
  try {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(body))
  } catch {
    /* the socket is already gone */
  }
}

export function apply(ctx, config) {
  if (config.enabled === false) return

  const specs = config.providers ?? []
  const refreshMs = Math.max(MIN_REFRESH_SECONDS, config.refreshSeconds) * 1000
  const records = new Map()
  const inflight = new Map()

  /**
   * Resolve a provider credential through the credential service, then the
   * process environment.
   * @param reference - credential reference or environment variable name.
   * @returns the secret value, or an empty string while unconfigured.
   */
  async function resolveKey(reference) {
    const name = String(reference ?? '').trim()
    if (name === '') return ''
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(name)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') {
          return resolved.value
        }
      } catch {
        /* fall through to the process environment */
      }
    }
    return typeof process !== 'undefined' ? String(process.env[name] ?? '') : ''
  }

  /**
   * Refresh every stale provider summary, sharing one in-flight read per provider.
   * @param force - refresh providers whose record is still fresh.
   */
  async function ensureFresh(force) {
    await Promise.all(
      specs.map(async (spec) => {
        const cached = records.get(spec.id)
        // A failure is retried on the short interval: a read that raced the
        // Credentials service or a provider hiccup must not stick for the whole
        // successful-read lifetime.
        const maxAge = cached !== undefined && cached.ok === true ? refreshMs : FAILED_RETRY_MS
        if (force !== true && cached !== undefined && Date.now() - cached.checkedAt < maxAge) return
        const running = inflight.get(spec.id)
        if (running !== undefined) return running
        const operation = probeProvider(spec, { resolveKey })
          .then((record) => {
            records.set(spec.id, record)
          })
          .catch(() => {})
          .finally(() => {
            if (inflight.get(spec.id) === operation) inflight.delete(spec.id)
          })
        inflight.set(spec.id, operation)
        return operation
      }),
    )
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (request, response) => {
          if (!isTrustedRequest(request)) {
            writeJson(response, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (request.method !== 'GET') {
            writeJson(response, 405, { ok: false, error: 'GET only' })
            return
          }
          const fresh = String(request.url ?? '').includes('fresh=1')
          await ensureFresh(fresh)
          writeJson(response, 200, {
            ok: true,
            updatedAt: Date.now(),
            providers: specs.map((spec) => records.get(spec.id) ?? {
              ok: false,
              id: spec.id,
              label: spec.label ?? null,
              kind: spec.kind ?? 'clinepass',
              error: 'pending',
              checkedAt: 0,
            }),
          })
        },
      }),
    'provider-status: balance route',
  )

  ctx.effect(() => {
    ensureFresh(false)
    return () => {}
  }, 'provider-status: first read')
}
