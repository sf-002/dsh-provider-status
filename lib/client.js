/**
 * Provider status — Client half.
 *
 * Adds one pill to the composer statistics row (`conversation.composer.dock`) that
 * names the session's current provider and prints its balance or the days left in
 * its paid period, and captions every provider heading of the model picker with the
 * same figure. Balances come from the Host route the Host half registers.
 */
window.__ModuleLoader__.load({
	id: "dsh-provider-status",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let React = require('react');

		const NS = 'sf-002-provider-status';
		const ENDPOINT = '/api/plugins/sf-002-provider-status/state';
		const STYLE_ID = 'sf-002-provider-status-css';
		const POLL_MS = 60000;
		/** One retry after a poll that left any provider unread. */
		const RETRY_MS = 20000;
		const EMPTY_LIST = Object.freeze([]);
		/** Usage-limit window types this plugin names; anything else prints verbatim. */
		const WINDOW_LABELS = new Set(['five_hour', '5-hour', 'weekly', 'monthly']);

		//#region dictionaries
		const en = {
			'days.left': '{days}d left',
			'days.last': 'last day',
			'days.expired': 'expired',
			'value.unknown': '—',
			'tooltip.noSource': 'no data source for this provider',
			'error.no-credential': 'credential not configured',
			'error.timeout': 'request timed out',
			'error.fetchFailed': 'could not read balances: {reason}',
			'tooltip.until': 'until {date}',
			'tooltip.perMonth': '{price}/mo',
			'tooltip.refresh': 'Click to refresh',
			'window.five_hour': '5h',
			'window.5-hour': '5h',
			'window.weekly': 'week',
			'window.monthly': 'month',
		};
		const ru = {
			'days.left': '{days} дн.',
			'days.last': 'последний день',
			'days.expired': 'истекла',
			'value.unknown': '—',
			'tooltip.noSource': 'нет источника данных для этого провайдера',
			'error.no-credential': 'ключ не настроен',
			'error.timeout': 'истекло время ожидания',
			'error.fetchFailed': 'не удалось прочитать балансы: {reason}',
			'tooltip.until': 'до {date}',
			'tooltip.perMonth': '{price}/мес',
			'tooltip.refresh': 'Нажмите, чтобы обновить',
			'window.five_hour': '5 ч',
			'window.5-hour': '5 ч',
			'window.weekly': 'неделя',
			'window.monthly': 'месяц',
		};
		//#endregion

		//#region styles
		function ensureCss() {
			if (typeof document === 'undefined') return () => {};
			const existing = document.getElementById(STYLE_ID);
			if (existing !== null) return () => {};
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.dataset.dshPlugin = NS;
			style.textContent = [
				// Typography copied from the shipped statistics pills: the row container
				// carries the size, the pill only inherits it, so both sit on one baseline.
				'.dshps-root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}',
				'.dshps-pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
				'.dshps-pill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
				'.dshps-pill:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
				'.dshps-label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
				'.dshps-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
				'.dshps-value-unknown{opacity:.6}',
				'.dshps-caption{margin-left:8px;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap}',
			].join('\n');
			document.head.appendChild(style);
			return () => {
				style.remove();
			};
		}
		//#endregion

		//#region balances route state
		const listeners = new Set();
		let snapshot = Object.freeze({ status: 'idle', providers: EMPTY_LIST, updatedAt: 0, error: null });
		let generation = 0;

		function publish(next) {
			snapshot = Object.freeze(next);
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					/* one consumer's failure must not stop the rest */
				}
			}
		}

		const balanceStore = {
			getSnapshot: () => snapshot,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};

		async function loadBalances(force) {
			const current = ++generation;
			try {
				const response = await fetch(force === true ? `${ENDPOINT}?fresh=1` : ENDPOINT, {
					headers: { accept: 'application/json' },
					cache: 'no-store',
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body = await response.json();
				if (current !== generation) return;
				publish({
					status: 'ready',
					providers: Array.isArray(body?.providers) ? body.providers : EMPTY_LIST,
					updatedAt: Number(body?.updatedAt) || Date.now(),
					error: null,
				});
			} catch (error) {
				if (current !== generation) return;
				try {
					console.error('[data-sf-002-provider-status] balances fetch failed:', String(error?.message ?? error));
				} catch {
					/* logging must never break rendering */
				}
				publish({
					status: 'error',
					providers: snapshot.providers,
					updatedAt: snapshot.updatedAt,
					error: String(error?.message ?? error),
				});
			}
		}
		//#endregion

		//#region formatting
		const groupNames = new Map();

		function rememberGroups(groups) {
			if (!Array.isArray(groups)) return;
			let changed = false;
			for (const group of groups) {
				if (group === null || typeof group !== 'object') continue;
				if (typeof group.id !== 'string' || typeof group.name !== 'string') continue;
				if (groupNames.get(group.id) === group.name) continue;
				groupNames.set(group.id, group.name);
				changed = true;
			}
			if (changed) decorateCaptions();
		}

		function money(amount, currency) {
			const code = typeof currency === 'string' && currency.trim() !== '' ? currency.trim().toUpperCase() : null;
			if (code !== null && /^[A-Z]{3}$/.test(code)) {
				try {
					return new Intl.NumberFormat(undefined, {
						style: 'currency',
						currency: code,
						minimumFractionDigits: 2,
						maximumFractionDigits: Math.abs(amount) >= 100 ? 0 : 2,
					}).format(amount);
				} catch {
					/* unknown currency code: fall through to the plain form */
				}
			}
			const text = amount.toFixed(Math.abs(amount) >= 100 ? 0 : 2);
			return code === null ? text : `${text} ${code}`;
		}

		function formatDate(iso) {
			const time = Date.parse(iso ?? '');
			if (!Number.isFinite(time)) return null;
			try {
				return new Date(time).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
			} catch {
				return new Date(time).toISOString().slice(0, 10);
			}
		}

		function daysLeftOf(entry) {
			const time = Date.parse(entry?.periodEnd ?? '');
			if (!Number.isFinite(time)) return null;
			return Math.max(0, Math.ceil((time - Date.now()) / 86400000));
		}

		function daysLeftText(days, t) {
			if (days === 0) return t('days.expired');
			if (days === 1) return t('days.last');
			return t('days.left', { days });
		}

		/** Short figure printed after the provider name: money, days left, or both. */
		function shortText(entry, t) {
			if (entry === null || entry === undefined) return null;
			if (entry.ok !== true) return null;
			const parts = [];
			if (typeof entry.balance === 'number' && Number.isFinite(entry.balance)) {
				parts.push(money(entry.balance, entry.currency));
			} else if (typeof entry.balanceText === 'string' && entry.balanceText !== '') {
				parts.push(entry.balanceText);
			}
			const days = daysLeftOf(entry);
			if (days !== null) parts.push(daysLeftText(days, t));
			return parts.length === 0 ? null : parts.join(' · ');
		}

		/** Full summary for the native tooltip. */
		function longText(entry, t) {
			if (entry === null || entry === undefined) return null;
			const lines = [];
			if (entry.ok !== true) {
				const reason = entry.error === 'no-credential'
					? t('error.no-credential')
					: entry.error === 'timeout'
						? t('error.timeout')
						: typeof entry.error === 'string' ? entry.error : t('value.unknown');
				lines.push(reason);
			} else {
				if (typeof entry.planName === 'string' && entry.planName !== '') lines.push(entry.planName);
				const head = [];
				if (typeof entry.priceCents === 'number' && entry.priceCents > 0) {
					head.push(t('tooltip.perMonth', { price: money(entry.priceCents / 100, entry.currency ?? 'USD') }));
				}
				const date = formatDate(entry.periodEnd);
				if (date !== null) head.push(t('tooltip.until', { date }));
				if (head.length > 0) lines.push(head.join(' · '));
				const windows = Array.isArray(entry.windows) ? entry.windows : [];
				if (windows.length > 0) {
					lines.push(windows.filter((window) => window !== null && typeof window === 'object').map((window) => {
						const raw = typeof window.type === 'string' ? window.type : '';
						const label = WINDOW_LABELS.has(raw) ? t(`window.${raw}`) : raw;
						return `${label}: ${window.percentUsed ?? 0}%`;
					}).join(' · '));
				}
				if (typeof entry.balance === 'number' && Number.isFinite(entry.balance)) {
					lines.push(money(entry.balance, entry.currency));
				}
			}
			lines.push(t('tooltip.refresh'));
			return lines.join('\n');
		}

		/**
		 * Pick the record that belongs to the Session's own provider. A known
		 * provider never borrows another provider's figures: an unconfigured
		 * provider shows its name without a value instead.
		 * @param providers - every record the Host published.
		 * @param current - the Session's selection, or null while unknown.
		 * @returns the matching record, or null when this provider has none.
		 */
		function pickEntry(providers, current) {
			if (!Array.isArray(providers) || providers.length === 0) return null;
			const providerId = current === null || current === undefined ? null : current.provider;
			if (typeof providerId === 'string') {
				return providers.find((entry) => entry?.id === providerId) ?? null;
			}
			return providers.length === 1 ? providers[0] : null;
		}

		function providerName(entry, current, groups) {
			const providerId = current !== null && current !== undefined && typeof current.provider === 'string'
				? current.provider
				: entry?.id;
			if (Array.isArray(groups)) {
				const group = groups.find((candidate) => candidate?.id === providerId);
				if (group !== undefined && typeof group.name === 'string' && group.name !== '') return group.name;
			}
			const known = typeof providerId === 'string' ? groupNames.get(providerId) : undefined;
			if (typeof known === 'string' && known !== '') return known;
			if (typeof entry?.label === 'string' && entry.label !== '') return entry.label;
			return typeof providerId === 'string' ? providerId : '';
		}
		//#endregion

		//#region statistics pill
		const EMPTY_DIRECTORY_STATE = Object.freeze({ current: null, groups: EMPTY_LIST, failures: EMPTY_LIST });
		const EMPTY_DIRECTORY = Object.freeze({
			getSnapshot: () => EMPTY_DIRECTORY_STATE,
			subscribe: () => () => {},
		});

		function ProviderStatusPill(props) {
			const t = props.t;
			const useDirectory = props.useDirectory ?? (() => EMPTY_DIRECTORY_STATE);
			const current = useDirectory((state) => state.current);
			const groups = useDirectory((state) => state.groups);
			const state = React.useSyncExternalStore(balanceStore.subscribe, balanceStore.getSnapshot, balanceStore.getSnapshot);

			React.useEffect(() => {
				rememberGroups(groups);
			}, [groups]);

			// The Session switched models: re-read so the newly selected provider
			// shows its own figures instead of waiting for the next poll.
			const currentProvider = current === null || current === undefined ? null : current.provider;
			React.useEffect(() => {
				loadBalances(false);
			}, [currentProvider]);

			const entry = pickEntry(state.providers, current);
			const name = providerName(entry, current, groups);
			if (name === '') return null;
			const short = entry === null ? null : shortText(entry, t);
			/** A dash must explain itself: an unknown fetch failure, a provider
			 * the Host knows nothing about, or the entry's own error. */
			const tooltip = entry === null
				? (!Array.isArray(state.providers) || state.providers.length === 0
					? t('error.fetchFailed', { reason: state.error ?? t('value.unknown') })
					: t('tooltip.noSource'))
				: longText(entry, t);

			return React.createElement('span', { className: 'dshps-root' },
				React.createElement('button', {
					type: 'button',
					className: 'dshps-pill',
					title: tooltip ?? undefined,
					'aria-label': tooltip === null ? name : `${name} · ${tooltip.replace(/\n/g, ', ')}`,
					onClick: () => {
						loadBalances(true);
					},
				},
					React.createElement('span', { className: 'dshps-label' },
						name,
						React.createElement('span', { className: 'dshps-sep', 'aria-hidden': true }, '·'),
						React.createElement('span', {
							className: short === null ? 'dshps-value-unknown' : undefined,
						}, short ?? t('value.unknown')),
					),
				),
			);
		}
		//#endregion

		//#region model picker captions
		let captionTimer = 0;
		let decorating = false;
		let captionTag = null;

		/** Label of one menu group heading, without the caption this plugin appended. */
		function headingLabel(heading, badge) {
			const full = String(heading.textContent ?? '');
			if (badge === null) return full.trim();
			const suffix = String(badge.textContent ?? '');
			const cut = suffix !== '' && full.endsWith(suffix) ? full.slice(0, full.length - suffix.length) : full;
			return cut.trim();
		}

		function captionFor(label, t) {
			if (label === '') return null;
			for (const entry of snapshot.providers) {
				if (entry === null || typeof entry !== 'object') continue;
				const names = [entry.id, entry.label, typeof entry.id === 'string' ? groupNames.get(entry.id) : undefined];
				if (!names.some((candidate) => typeof candidate === 'string' && candidate !== '' && candidate === label)) continue;
				const short = shortText(entry, t);
				if (short === null) return null;
				return { key: `${entry.id}|${short}`, text: ` · ${short}`, title: longText(entry, t) };
			}
			return null;
		}

		/** Append one caption to every provider heading currently in the document. */
		function decorateCaptions() {
			if (typeof document === 'undefined' || captionTag === null || decorating) return;
			decorating = true;
			try {
				const t = captionTag;
				for (const heading of document.querySelectorAll('[data-menu-group-heading]')) {
					const badge = heading.querySelector(':scope > [data-sf-002-provider-status]');
					const wanted = captionFor(headingLabel(heading, badge), t);
					if (wanted === null) {
						if (badge !== null) badge.remove();
						continue;
					}
					if (badge !== null && badge.dataset.sf002ProviderStatus === wanted.key) {
						if (badge.textContent !== wanted.text) badge.textContent = wanted.text;
						continue;
					}
					if (badge !== null) badge.remove();
					const caption = document.createElement('span');
					caption.dataset.sf002ProviderStatus = wanted.key;
					caption.className = 'dshps-caption';
					caption.textContent = wanted.text;
					if (wanted.title !== null) caption.title = wanted.title;
					heading.appendChild(caption);
				}
			} finally {
				decorating = false;
			}
		}

		function scheduleCaptions() {
			if (typeof document === 'undefined') return;
			if (captionTimer !== 0) return;
			captionTimer = window.setTimeout(() => {
				captionTimer = 0;
				decorateCaptions();
			}, 16);
		}

		/** Keep picker captions in step with the menus React mounts and with fresh balances. */
		function installPickerCaptions(t) {
			if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
			const root = document.documentElement ?? document.body;
			if (root === null || root === undefined) return () => {};
			captionTag = t;
			const observer = new MutationObserver(() => {
				scheduleCaptions();
			});
			observer.observe(root, { childList: true, subtree: true, characterData: true });
			const unsubscribe = balanceStore.subscribe(() => {
				scheduleCaptions();
			});
			decorateCaptions();
			return () => {
				observer.disconnect();
				unsubscribe();
				if (captionTimer !== 0) {
					window.clearTimeout(captionTimer);
					captionTimer = 0;
				}
				captionTag = null;
				for (const caption of document.querySelectorAll('[data-sf-002-provider-status]')) caption.remove();
			};
		}
		//#endregion

		/**
		 * Run one activation step in isolation. This plugin is a decoration: no
		 * registration of it may abort the Web boot, so a failing step is logged
		 * and skipped instead of thrown.
		 * @param label - the step named in the log line.
		 * @param operation - the step body.
		 * @returns whatever the step returned, or undefined when it failed.
		 */
		function step(label, operation) {
			try {
				return operation();
			} catch (error) {
				console.error(`[data-sf-002-provider-status] ${label} failed:`, error);
				return undefined;
			}
		}

		function apply(ctx) {
			step('dictionaries', () => ctx.effect(() => {
				const disposers = [];
				for (const [locale, dictionary] of [['en', en], ['ru', ru]]) {
					try {
						disposers.push(ctx.locale.register(NS, locale, dictionary));
					} catch (error) {
						console.warn(`[data-sf-002-provider-status] failed to register the ${locale} dictionary:`, error);
					}
				}
				return () => {
					for (const dispose of disposers) {
						try {
							dispose();
						} catch {
							/* the locale service is already gone */
						}
					}
				};
			}, 'sf-002-provider-status: dictionaries'));

			const t = step('locale binding', () => ctx.locale.bind(NS)) ?? ((key) => key);

			step('stylesheet', () => {
				const removeCss = ensureCss();
				ctx.effect(() => removeCss, 'sf-002-provider-status: stylesheet');
			});

			step('balance polling', () => ctx.effect(() => {
				let retryTimer = 0;
				let disposed = false;
				const refresh = async (force) => {
					await loadBalances(force);
					if (disposed) return;
					const failed = balanceStore.getSnapshot().providers.some((entry) => entry?.ok !== true);
					if (failed && retryTimer === 0) {
						retryTimer = window.setTimeout(() => {
							retryTimer = 0;
							refresh(true);
						}, RETRY_MS);
					}
				};
				refresh(false);
				const timer = window.setInterval(() => {
					refresh(false);
				}, POLL_MS);
				return () => {
					disposed = true;
					window.clearInterval(timer);
					if (retryTimer !== 0) window.clearTimeout(retryTimer);
				};
			}, 'sf-002-provider-status: balance polling'));

			step('picker captions', () => ctx.effect(() => installPickerCaptions(t), 'sf-002-provider-status: picker captions'));

			step('slot registration', () => ctx.inject(['slots'], (scope) => {
				scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
					name: 'conversation.composer.dock',
					id: 'provider-status',
					order: 1,
					locale: NS,
					inject: (sessionId) => {
						let source = EMPTY_DIRECTORY;
						try {
							const models = typeof scope.get === 'function' ? scope.get('modelDirectories') : undefined;
							if (models !== undefined && typeof models?.directoryFor === 'function' && typeof sessionId === 'string') {
								const directory = models.directoryFor(sessionId);
								const loading = directory?.load?.();
								if (loading !== undefined && typeof loading.catch === 'function') loading.catch(() => {});
								const value = directory?.store?.getSnapshot?.();
								if (value !== undefined && value !== null) {
									rememberGroups(value.groups);
									source = directory.store;
								}
							}
						} catch {
							/* a session without a directory keeps the inert source */
						}
						return { hooks: { directory: source } };
					},
				}, ProviderStatusPill));
			}));
		}

		exports.apply = apply;
		exports.inject = ['slots', 'locale'];
		return module.exports;
	},
});
