// Persistent usage history (for charts / forecasts) and notification state.
// Stored in ~/.cache/claude-code-quota/history.json

import GLib from 'gi://GLib';

import {forecast} from './parse.js';

const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-code-quota']);
const FILE = GLib.build_filenamev([DIR, 'history.json']);
const KEEP_MS = 8 * 86400e3;
const MIN_GAP_MS = 50e3;
// Two reset timestamps closer than this are considered the same window
// (the CLI prints minutes, and "resets in" style values drift slightly).
const SAME_RESET_MS = 5 * 60000;

export function sameReset(a, b) {
    if (a == null || b == null)
        return a == null && b == null;
    return Math.abs(a - b) < SAME_RESET_MS;
}

export class History {
    constructor() {
        this._data = {accounts: {}, notify: {}};
        try {
            if (GLib.file_test(FILE, GLib.FileTest.EXISTS)) {
                const [, bytes] = GLib.file_get_contents(FILE);
                const d = JSON.parse(new TextDecoder().decode(bytes));
                this._data.accounts = d.accounts ?? {};
                this._data.notify = d.notify ?? {};
            }
        } catch (e) {
            console.warn(`[claude-code-quota] cannot read history: ${e.message}`);
        }
    }

    save() {
        try {
            GLib.mkdir_with_parents(DIR, 0o700);
            GLib.file_set_contents(FILE, JSON.stringify(this._data));
        } catch (e) {
            console.warn(`[claude-code-quota] cannot write history: ${e.message}`);
        }
    }

    /** Record a sample: {t, v: {key: percent}, r: {key: resetTs}} */
    add(accountId, limits, t = Date.now()) {
        const list = this._data.accounts[accountId] ??= [];
        const sample = {t, v: {}, r: {}};
        for (const l of limits) {
            sample.v[l.key] = l.percent;
            if (l.resetAt)
                sample.r[l.key] = l.resetAt;
        }
        if (list.length && t - list[list.length - 1].t < MIN_GAP_MS)
            list[list.length - 1] = sample;
        else
            list.push(sample);
        const cutoff = t - KEEP_MS;
        while (list.length && list[0].t < cutoff)
            list.shift();
    }

    /** [{t, p}] for one limit since `since`. */
    series(accountId, key, since) {
        return (this._data.accounts[accountId] ?? [])
            .filter(s => s.t >= since && s.v[key] !== undefined)
            .map(s => ({t: s.t, p: s.v[key]}));
    }

    /** Burn-rate forecast for a limit within its current reset window. */
    forecast(accountId, limit, now = Date.now()) {
        const list = this._data.accounts[accountId] ?? [];
        const pts = [];
        for (let i = list.length - 1; i >= 0; i--) {
            const s = list[i];
            if (s.v[limit.key] === undefined)
                continue;
            if (!sameReset(s.r[limit.key] ?? null, limit.resetAt))
                break;
            if (s.v[limit.key] > limit.percent + 0.5)
                break; // went down → earlier window
            pts.unshift({t: s.t, p: s.v[limit.key]});
        }
        const isSession = limit.key === 'session';
        return forecast(pts, now, {
            windowMs: isSession ? 90 * 60000 : 24 * 3600e3,
            minSpanMs: isSession ? 10 * 60000 : 60 * 60000,
        });
    }

    notifyState(accountId, key) {
        return this._data.notify[`${accountId}#${key}`] ??= {level: 0, reset: null, forecastFor: null, lastPercent: 0};
    }
}
