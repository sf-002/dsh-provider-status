# dsh-provider-status

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts the
**current model provider and its money** where you already look: in the composer statistics
row, next to the token rate and cache-hit figures, and beside every provider in the model
picker.

```
2 turns 2 steps · 92 tok/s   ·   22.5K tok · Cache hit 50%   ·   ClineBot (ClinePass) · 2 дн.   ·   6%
                                                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                                               this plugin
```

Switch the model to another provider and the pill switches with it — days left for a
subscription, rubles or dollars for a prepaid balance. Hovering shows the plan, its price,
the period end and the rolling usage windows; clicking forces a re-read.

## Features

- **Current provider, always visible** — resolved from the session's own model selection, so
  it follows `/model` and the composer picker immediately.
- **Two kinds of "money"** — remaining subscription days (plan period end) or a prepaid
  balance amount, whichever the provider exposes.
- **Same typography as the shipped pills** — the pill borrows the harness's own font-size and
  line-height custom properties, so it sits on the same baseline at every content font size.
- **Self-refreshing** — a 60 s poll, an immediate re-read on provider change, and a 20 s retry
  after any failed read. A hiccup never leaves a permanent dash.
- **Honest dashes** — a provider without a configured source shows `—`, and its tooltip says
  why (`no data source`, `credential not configured`, `request timed out`, …).
- **Credentials stay on the Host** — the API keys are read from DeepSeek Harness Credentials
  (or the environment) inside the Host process; the browser only receives amounts and dates.

## Supported sources

| Kind | What it reads |
|---|---|
| `clinepass` | `GET /users/me/plan` → plan name, price, `currentPeriodStart/End`; plus `/users/me/plan/usage-limits` for the 5-hour / weekly / monthly windows |
| `json` | any JSON document, with the amount, currency and period end taken from dot paths (`data.balance`, `data.currency`, `data.expiresAt`) |

Verified against:

| Provider | Endpoint | Shape |
|---|---|---|
| ClinePass (`clinebot`) | `https://api.cline.bot/api/v1/users/me/plan` | `currentPeriodEnd`, `plan.displayName`, `plan.pricePerSeatCents` |
| Provod (`provod-ai`, `provod-image`) | `https://api.provod.ai/v1/balance` | `availableBalance`, `currency` |
| PlusVibe (`plusvibe-api`) | `https://gw.plusvibeapi.ru/v1/balance` | `balance`, `currency` |

## Install

```sh
dsh plugin --profile desktop add dsh-provider-status
```

From a checkout instead of npm:

```sh
git clone https://github.com/sf-002/dsh-provider-status
dsh plugin --profile desktop add "file:C:/path/to/dsh-provider-status"
```

Restart the profile afterwards (the Host half is a Node module loaded once), then reload the
Web GUI window.

## Configure

The plugin works with no configuration for ClinePass, Provod and PlusVibe. To point it at
other providers, add a row to the profile's `cordis.patch.yml`:

```yaml
- id: provider-status
  name: dsh-provider-status
  config:
    refreshSeconds: 120
    providers:
      - id: clinebot                # provider id exactly as the model catalog reports it
        kind: clinepass
        baseUrl: https://api.cline.bot/api/v1
        apiKeyEnv: CLINEBOT_API_KEY # credential reference or environment variable name
      - id: provod-ai
        kind: json
        url: https://api.provod.ai/v1/balance
        apiKeyEnv: PROVOD_AI_API_KEY
        balancePath: availableBalance
        currencyPath: currency
```

| Field | Meaning |
|---|---|
| `enabled` | Publish the balances route (default `true`). |
| `refreshSeconds` | Reuse one successful read for this long (≥ 15, default 120). Failed reads are retried every 20 s. |
| `providers[].id` | Provider id from the model catalog; records are keyed by it. |
| `providers[].label` | Display name used until the model catalog reports one. |
| `providers[].kind` | `clinepass` or `json`. |
| `providers[].apiKeyEnv` | Credentials reference or environment variable holding the key. |
| `providers[].baseUrl` | API base for `clinepass`. |
| `providers[].url`, `authHeader`, `authPrefix` | Where and how to fetch a `json` document. |
| `providers[].balancePath`, `currencyPath`, `expiresPath` | Dot paths inside that document. |
| `providers[].timeoutMs` | Per-request timeout (default 10000). |

## How it works

**Host half** (`lib/index.js`, readers in `lib/probe.js`) owns one read-only route,
`GET /dsh-provider-status/state`. It resolves each configured provider, caches the outcome
(successes for `refreshSeconds`, failures for 20 s), and publishes only what the UI prints:
plan name, period end, price, usage percentages and a balance amount. Cross-site requests are
refused, and no credential ever leaves the process.

**Client half** (`lib/client.js`):

- the pill registers into the official `conversation.composer.dock` slot (`id: provider-status`,
  `order: 1`), so it renders inside the same flex row as the shipped statistics and the context
  meter — no shipped UI is replaced;
- the current provider comes from the client service `modelDirectories`
  (`current.provider` plus the catalog group name), so the pill follows model switches;
- picker captions decorate the `[data-menu-group-heading]` elements of the shipped `MenuGroup`
  primitive. The picker has no slot for a provider sub-label, so this part is a DOM decoration:
  idempotent, removed when the plugin unloads, and it never touches headings that do not match
  a known provider.

## Limitations

- **Picker captions are DOM decoration.** A large redesign of `MenuGroup` would break the
  `[data-menu-group-heading]` selector; the pill itself is slot-based and unaffected.
- **No DeepSeek Account balance yet.** `ctx.deepseekAccount.getBalance` needs its
  `AccountClientMetadata` contract audited; today it shows `—`.
- **One read per provider per interval.** There is no push channel from the providers, so the
  figure can lag by up to `refreshSeconds`.
- **Amounts are formatted client-side** with `Intl.NumberFormat`, so the currency placement
  follows the GUI locale, not the provider's.

## Tests

```sh
node --test test/
```

`test/probe.test.mjs` covers the readers (dot paths, timestamps, usage windows, HTTP failures,
timeouts) with a fake `fetch`; `test/client.test.mjs` loads the real client bundle against stub
React/DOM/loader objects and checks the pill, the picker caption and its idempotence.

## License

MIT — see [LICENSE](LICENSE).
