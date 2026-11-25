// Claude Code Quota — GNOME Shell extension
// Reads quota via `claude -p /usage --output-format json` (a local command, costs no tokens)
// and shows it in the top panel.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {QuotaFetcher, openTerminal} from './lib/quota.js';
import {History, sameReset} from './lib/history.js';
import {formatDuration, formatClock, limitModel, parseThresholds} from './lib/parse.js';
import {Ring, Bar, Sparkline, COLORS, levelOf} from './lib/widgets.js';
import {_, setLanguage} from './lib/i18n.js';

const USAGE_URL = 'https://claude.ai/settings/usage';
const MAX_BACKOFF_SEC = 1800;
const STALE_REFRESH_MS = 60e3;
const WINDOW_MS = {session: 5 * 3600e3, week: 7 * 86400e3};

function limitLabel(l) {
    if (l.key === 'session')
        return _('Session (5h)');
    if (l.key === 'week_all')
        return _('Week (all models)');
    const model = limitModel(l.rawName);
    return model ? _('Week ({0})', model) : l.rawName;
}

function resetLabel(l) {
    if (l.resetAt)
        return _('resets in {0} ({1})', formatDuration(l.resetAt - Date.now()), formatClock(l.resetAt));
    return l.resetText ? _('resets {0}', l.resetText) : '';
}

// St.BoxLayout:vertical is deprecated in GNOME 48+ in favour of :orientation.
function vbox() {
    const box = new St.BoxLayout({x_expand: true});
    if (box.orientation !== undefined)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function elapsedPercent(l) {
    if (!l.resetAt)
        return null;
    const win = l.key === 'session' ? WINDOW_MS.session : WINDOW_MS.week;
    return 100 * (1 - (l.resetAt - Date.now()) / win);
}

/** Data shared across indicator re-creations (e.g. when the panel position changes). */
class QuotaState {
    constructor() {
        this.fetcher = new QuotaFetcher();
        this.history = new History();
        this.accounts = [];      // [{id, name, dir, auth, limits, error, stale, dataAt}]
        this.lastGood = new Map(); // id → {limits, at}
        this.lastUpdate = null;
        this.globalError = null;
        this.failStreak = 0;
    }
}

const QuotaIndicator = GObject.registerClass(
class QuotaIndicator extends PanelMenu.Button {
    _init(ext, settings, state) {
        super._init(0.5, 'Claude Code Quota');
        this._ext = ext;
        this._settings = settings;
        this._state = state;
        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._timerId = 0;
        this._nextAt = 0;

        this._panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box claude-quota-panel'});
        this.add_child(this._panelBox);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statusItem.label.add_style_class_name('claude-quota-sub');
        this.menu.addMenuItem(this._statusItem);

        this._refreshItem = this.menu.addAction(_('Refresh'), () => this.refresh(), 'view-refresh-symbolic');
        this._usageItem = this.menu.addAction(_('Open usage page on claude.ai'), () => {
            try {
                Gio.AppInfo.launch_default_for_uri(USAGE_URL, null);
            } catch (e) {
                Main.notify('Claude Code Quota', _('Failed to launch: {0}', e.message));
            }
        }, 'web-browser-symbolic');
        this._settingsItem = this.menu.addAction(_('Settings'), () => ext.openPreferences(), 'preferences-system-symbolic');

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            const age = this._state.lastUpdate ? Date.now() - this._state.lastUpdate : Infinity;
            if (age > STALE_REFRESH_MS && !this._busy)
                this.refresh();
            else
                this._render();
        });

        // Refresh shortly after resuming from suspend.
        this._sleepSub = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager', 'PrepareForSleep',
            '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [sleeping] = params.deepUnpack();
                if (!sleeping)
                    this._scheduleNext(15);
            });

        this._render();
        if (this._state.lastUpdate && Date.now() - this._state.lastUpdate < this._interval() * 1000)
            this._scheduleNext(this._interval() - Math.floor((Date.now() - this._state.lastUpdate) / 1000));
        else
            this.refresh();
    }

    _interval() {
        return Math.max(30, this._settings.get_int('refresh-interval'));
    }

    _scheduleNext(delaySec) {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        delaySec = Math.max(1, Math.round(delaySec));
        this._nextAt = Date.now() + delaySec * 1000;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySec, () => {
            this._timerId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    reschedule() {
        this._scheduleNext(this._interval());
    }

    relabel() {
        this._refreshItem.label.text = _('Refresh');
        this._usageItem.label.text = _('Open usage page on claude.ai');
        this._settingsItem.label.text = _('Settings');
        this._render();
    }

    async refresh() {
        if (this._busy || this._destroyed)
            return;
        this._busy = true;
        this._statusItem.label.text = _('Updating…');
        const st = this._state;
        try {
            const results = await st.fetcher.fetch({
                claudePath: this._settings.get_string('claude-path'),
                hidden: this._settings.get_strv('hidden-profiles'),
                extra: this._settings.get_strv('extra-profiles'),
                timeout: this._settings.get_int('command-timeout'),
                cancellable: this._cancellable,
            });
            const now = Date.now();
            st.accounts = results.map(acc => {
                if (!acc.error) {
                    st.lastGood.set(acc.id, {limits: acc.limits, at: now});
                    st.history.add(acc.id, acc.limits, now);
                    this._notify(acc);
                    return {...acc, stale: false, dataAt: now};
                }
                const good = st.lastGood.get(acc.id);
                return good
                    ? {...acc, limits: good.limits, stale: true, dataAt: good.at}
                    : {...acc, stale: false, dataAt: null};
            });
            st.history.save();
            st.globalError = null;
            st.lastUpdate = now;
            st.failStreak = results.length && results.every(a => a.error) ? st.failStreak + 1 : 0;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            st.globalError = e.message;
            st.failStreak++;
            console.warn(`[claude-code-quota] ${e.message}`);
        } finally {
            this._busy = false;
        }
        if (this._destroyed)
            return;
        const backoff = st.failStreak > 0
            ? Math.min(this._interval() * 2 ** st.failStreak, MAX_BACKOFF_SEC)
            : this._interval();
        this._scheduleNext(backoff);
        this._render();
    }

    // ------------------------------------------------------------ notifications

    _notify(acc) {
        const s = this._settings;
        if (!s.get_boolean('notify-enabled'))
            return;
        const thresholds = parseThresholds(s.get_string('notify-thresholds'));
        const minT = thresholds[0] ?? 101;
        const history = this._state.history;
        const title = _('Claude Code quota: {0}', acc.name);

        for (const l of acc.limits) {
            const ns = history.notifyState(acc.id, l.key);
            const name = limitLabel(l);

            // Window changed (reset happened)?
            const wasReset = (ns.reset != null && l.resetAt != null && !sameReset(ns.reset, l.resetAt) &&
                              l.percent < ns.lastPercent) || l.percent + 30 < ns.lastPercent;
            if (wasReset) {
                if (s.get_boolean('notify-reset') && ns.lastPercent >= minT)
                    Main.notify(title, _('{0} has been reset — quota available again.', name));
                ns.level = 0;
                ns.forecastFor = null;
            }

            // Threshold crossed
            const reached = thresholds.filter(t => l.percent >= t).pop() ?? 0;
            if (reached > ns.level) {
                let body = _('{0} has reached {1}% ({2}).', name, Math.round(l.percent), acc.auth?.email ?? acc.name);
                if (l.resetAt)
                    body += ` ${_('Resets in {0}.', formatDuration(l.resetAt - Date.now()))}`;
                Main.notify(title, body);
                ns.level = reached;
            } else if (reached < ns.level) {
                ns.level = reached;
            }

            // Burn-rate forecast
            if (s.get_boolean('notify-forecast') && l.resetAt && !sameReset(ns.forecastFor, l.resetAt)) {
                const f = history.forecast(acc.id, l);
                if (f && f.eta < l.resetAt && f.eta - Date.now() < 3600e3 && l.percent < 100) {
                    Main.notify(title, _('At the current rate ({0}%/h), {1} will hit 100% at {2}, before it resets at {3}.',
                        f.ratePerHour.toFixed(1), name, formatClock(f.eta), formatClock(l.resetAt)));
                    ns.forecastFor = l.resetAt;
                }
            }

            ns.reset = l.resetAt;
            ns.lastPercent = l.percent;
        }
    }

    // ------------------------------------------------------------ rendering

    _levels() {
        return [this._settings.get_int('warn-level'), this._settings.get_int('crit-level')];
    }

    _render() {
        if (this._destroyed)
            return;
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        const s = this._settings;
        const [warn, crit] = this._levels();
        const mode = s.get_string('panel-mode');
        const showWeekly = s.get_boolean('panel-show-weekly');
        const only = s.get_string('panel-profile');
        const st = this._state;

        this._panelBox.destroy_all_children();

        if (!st.accounts.length || st.globalError) {
            const icon = new St.Label({text: '✳', y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-quota-logo'});
            this._panelBox.add_child(icon);
            this._panelBox.add_child(new St.Label({
                text: st.globalError ? '!' : '…',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: `claude-quota-label claude-quota-${st.globalError ? 'crit' : 'muted'}`,
            }));
            return;
        }

        let accounts = st.accounts;
        if (only && accounts.some(a => a.name === only))
            accounts = accounts.filter(a => a.name === only);
        const multi = accounts.length > 1;

        if (mode === 'text') {
            this._panelBox.add_child(new St.Label({
                text: '✳', y_align: Clutter.ActorAlign.CENTER, style_class: 'claude-quota-logo',
            }));
        }

        accounts.forEach((acc, i) => {
            const session = acc.limits.find(l => l.key === 'session') ?? acc.limits[0];
            const week = acc.limits.find(l => l.key === 'week_all') ?? acc.limits.find(l => l.key.startsWith('week'));
            const max = acc.limits.length ? Math.max(...acc.limits.map(l => l.percent)) : -1;
            const level = acc.error && !acc.stale ? 'crit' : (acc.stale ? 'muted' : levelOf(max, warn, crit));

            const group = new St.BoxLayout({style_class: 'claude-quota-group'});
            if (i > 0)
                group.add_style_class_name('claude-quota-group-sep');

            if (mode !== 'text') {
                const ring = new Ring(22);
                ring.setValue(session?.percent ?? 0, COLORS[levelOf(session?.percent, warn, crit)],
                    showWeekly && week ? week.percent : -1);
                if (acc.stale || (acc.error && !acc.limits.length))
                    ring.opacity = 110;
                group.add_child(ring);
            }

            if (mode !== 'ring' || multi) {
                let txt;
                if (!acc.limits.length)
                    txt = '!';
                else if (mode === 'ring')
                    txt = '';
                else {
                    txt = `${Math.round(session.percent)}%`;
                    if (showWeekly && week)
                        txt += `·${Math.round(week.percent)}%`;
                }
                if (acc.stale)
                    txt += '?';
                const prefix = multi ? acc.name.charAt(0).toUpperCase() : '';
                const text = [prefix, txt].filter(Boolean).join(mode === 'ring' ? '' : ' ');
                if (text) {
                    group.add_child(new St.Label({
                        text,
                        y_align: Clutter.ActorAlign.CENTER,
                        style_class: `claude-quota-label claude-quota-${level}`,
                    }));
                }
            }
            this._panelBox.add_child(group);
        });
    }

    _renderMenu() {
        const st = this._state;
        const [warn, crit] = this._levels();
        this._section.removeAll();

        if (st.globalError) {
            const it = new PopupMenu.PopupMenuItem(`⚠ ${st.globalError}`, {reactive: false});
            it.label.add_style_class_name('claude-quota-crit');
            it.label.clutter_text.line_wrap = true;
            this._section.addMenuItem(it);
        }

        st.accounts.forEach((acc, idx) => {
            if (idx > 0)
                this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._section.addMenuItem(this._headerItem(acc));

            if (acc.error) {
                const msg = acc.stale
                    ? `⚠ ${acc.error}\n${_('Data from {0} ago (last refresh failed)', formatDuration(Date.now() - acc.dataAt))}`
                    : `⚠ ${acc.error}`;
                const it = new PopupMenu.PopupMenuItem(msg, {reactive: false});
                it.label.add_style_class_name(acc.stale ? 'claude-quota-warn' : 'claude-quota-crit');
                it.label.add_style_class_name('claude-quota-sub');
                it.label.clutter_text.line_wrap = true;
                this._section.addMenuItem(it);
            }

            for (const l of acc.limits) {
                this._section.addMenuItem(this._limitItem(l, acc.stale, warn, crit));
                const f = acc.stale ? null : st.history.forecast(acc.id, l);
                if (f && l.percent < 100) {
                    const before = l.resetAt && f.eta < l.resetAt;
                    if (before || f.eta - Date.now() < 7 * 86400e3) {
                        const txt = before
                            ? _('~{0}%/h · hits 100% at {1} — before reset!', f.ratePerHour.toFixed(1), formatClock(f.eta))
                            : _('~{0}%/h · would hit 100% at {1}', f.ratePerHour.toFixed(1), formatClock(f.eta));
                        const it = new PopupMenu.PopupMenuItem(`↗ ${txt}`, {reactive: false});
                        it.label.add_style_class_name('claude-quota-forecast');
                        it.label.add_style_class_name(before ? 'claude-quota-crit' : 'claude-quota-sub');
                        this._section.addMenuItem(it);
                    }
                }
            }

            if (acc.limits.length)
                this._section.addMenuItem(this._chartItem(acc, warn, crit));
        });

        if (!this._busy) {
            let status = st.lastUpdate ? _('Updated at {0}', formatClock(st.lastUpdate)) : _('Not updated yet');
            if (st.failStreak > 0 && this._nextAt)
                status += ` · ${_('Retrying in {0}', formatDuration(this._nextAt - Date.now()))}`;
            this._statusItem.label.text = status;
        }
    }

    _headerItem(acc) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const name = new St.Label({text: acc.name, style_class: 'claude-quota-header', y_align: Clutter.ActorAlign.CENTER});
        item.add_child(name);
        const who = [acc.auth?.email, acc.auth?.subscriptionType].filter(Boolean).join(' · ');
        if (who) {
            item.add_child(new St.Label({
                text: who, style_class: 'claude-quota-sub claude-quota-who', y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        item.add_child(new St.Widget({x_expand: true}));

        const mkBtn = (icon, tip, cb) => {
            const b = new St.Button({
                style_class: 'claude-quota-icon-button',
                child: new St.Icon({icon_name: icon, icon_size: 18}),
                can_focus: true,
                accessible_name: tip,
            });
            b.connect('clicked', () => {
                this.menu.close();
                cb();
            });
            item.add_child(b);
        };
        mkBtn('edit-copy-symbolic', _('Copy summary'), () => this._copySummary(acc));
        mkBtn('utilities-terminal-symbolic', _('Open Claude Code in a terminal with this profile'), () => {
            try {
                openTerminal(this._settings.get_string('claude-path'), acc.dir, this._settings.get_string('terminal'));
            } catch (e) {
                Main.notify('Claude Code Quota', _('Failed to launch: {0}', e.message));
            }
        });
        return item;
    }

    _limitItem(l, stale, warn, crit) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const level = stale ? 'muted' : levelOf(l.percent, warn, crit);
        item.add_child(new St.Label({text: limitLabel(l), style_class: 'claude-quota-limit-name', y_align: Clutter.ActorAlign.CENTER}));
        const bar = new Bar(200, 12);
        bar.setValue(l.percent, COLORS[level], elapsedPercent(l));
        item.add_child(bar);
        item.add_child(new St.Label({
            text: `${Math.round(l.percent)}%`,
            style_class: `claude-quota-pct claude-quota-${level}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        item.add_child(new St.Label({text: resetLabel(l), style_class: 'claude-quota-sub', y_align: Clutter.ActorAlign.CENTER}));
        return item;
    }

    _chartItem(acc, warn, crit) {
        const hours = this._settings.get_int('chart-hours');
        const to = Date.now();
        const from = to - hours * 3600e3;
        const h = this._state.history;
        const session = h.series(acc.id, 'session', from);
        const week = h.series(acc.id, 'week_all', from);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox();
        const first = Math.min(session[0]?.t ?? to, week[0]?.t ?? to);
        if (to - first < 10 * 60000) {
            // Not enough data for a meaningful line yet.
            box.add_child(new St.Label({text: `📈 ${_('Collecting history — the chart appears after a few minutes')}`, style_class: 'claude-quota-sub'}));
        } else {
            // Fit the x-axis to the data we have (up to the configured range).
            const start = Math.max(from, first);
            const chart = new Sparkline(420, 72);
            chart.setData([
                {points: week, color: COLORS.week},
                {points: session, color: COLORS.claude},
            ], start, to, [{p: warn, color: COLORS.warn}, {p: crit, color: COLORS.crit}]);
            box.add_child(chart);
            const legend = new St.BoxLayout({style_class: 'claude-quota-legend'});
            legend.add_child(new St.Label({text: `${_('History: last {0}', formatDuration(to - start))}   `, style_class: 'claude-quota-sub'}));
            legend.add_child(new St.Label({text: `━ ${_('Session (5h)')}   `, style_class: 'claude-quota-legend-item', style: 'color: #d97857;'}));
            legend.add_child(new St.Label({text: `━ ${_('Week (all models)')}   `, style_class: 'claude-quota-legend-item', style: 'color: #66a6fa;'}));
            legend.add_child(new St.Label({text: `┄ ${_('warning levels')}`, style_class: 'claude-quota-sub'}));
            box.add_child(legend);
        }
        item.add_child(box);
        return item;
    }

    _copySummary(acc) {
        const lines = [`Claude Code — ${acc.name}${acc.auth?.email ? ` (${acc.auth.email})` : ''}`];
        for (const l of acc.limits) {
            const reset = l.resetAt ? ` · reset ${formatClock(l.resetAt)}` : '';
            lines.push(`${limitLabel(l)}: ${Math.round(l.percent)}%${reset}`);
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, lines.join('\n'));
        Main.notify('Claude Code Quota', _('Copied quota summary'));
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._sleepSub) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSub);
            this._sleepSub = 0;
        }
        super.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._state = new QuotaState();
        setLanguage(this._settings.get_string('language'));
        this._addIndicator();

        this._settingsIds = [
            this._settings.connect('changed::panel-position', () => this._addIndicator()),
            this._settings.connect('changed::language', () => {
                setLanguage(this._settings.get_string('language'));
                this._indicator?.relabel();
            }),
            this._settings.connect('changed::refresh-interval', () => this._indicator?.reschedule()),
            ...['claude-path', 'hidden-profiles', 'extra-profiles'].map(k =>
                this._settings.connect(`changed::${k}`, () => this._indicator?.refresh())),
            ...['panel-mode', 'panel-show-weekly', 'panel-profile', 'warn-level', 'crit-level', 'chart-hours'].map(k =>
                this._settings.connect(`changed::${k}`, () => this._indicator?._render())),
        ];
    }

    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = new QuotaIndicator(this, this._settings, this._state);
        const pos = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, pos === 'right' ? 0 : -1, pos);
    }

    disable() {
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._state = null;
        this._settings = null;
    }
}
