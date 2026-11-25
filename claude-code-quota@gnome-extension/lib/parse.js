// Pure JS helpers (no gi:// imports) so they can be unit-tested with node.

const MONTHS = {jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11};

/** Stable key for a limit, e.g. "session", "week_all", "week_fable". */
export function limitKey(rawName) {
    const n = rawName.toLowerCase();
    if (/session/.test(n))
        return 'session';
    const m = n.match(/week\w*\s*\((.+)\)/);
    if (m)
        return /all/.test(m[1]) ? 'week_all' : `week_${m[1].trim().replace(/\W+/g, '_')}`;
    if (/week/.test(n))
        return 'week_all';
    return n.replace(/\W+/g, '_');
}

/** Model name inside "Current week (Fable)" → "Fable"; null for non-model limits. */
export function limitModel(rawName) {
    const m = rawName.match(/\(([^)]+)\)/);
    if (!m || /all/i.test(m[1]))
        return null;
    return m[1].trim();
}

/**
 * Parse a reset description into a Date.
 * Supports: "Nov 25, 1:29pm", "Dec 1, 3pm", "Dec 2, 2026, 7:59am", "1:29pm", "13:29",
 *           "in 2h 30m", "in 3d 4h", optional trailing "(Time/Zone)".
 */
export function parseReset(text, now = new Date()) {
    if (!text)
        return null;
    const clean = text.replace(/\s*\(.*?\)\s*$/, '').replace(/^(at|on)\s+/i, '').trim();

    // Relative: "in 2h 30m", "2d 3h", "45m"
    const rel = clean.match(/^(?:in\s+)?(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:(?:ou)?rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/i);
    if (rel && (rel[1] || rel[2] || rel[3])) {
        const ms = ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60000;
        return new Date(now.getTime() + ms);
    }

    const m = clean.match(/^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m)
        return null;
    let hour = Number(m[4]);
    const minute = Number(m[5] ?? 0);
    if (m[6]) {
        hour %= 12;
        if (m[6].toLowerCase() === 'pm')
            hour += 12;
    } else if (m[5] === undefined) {
        return null; // bare number without am/pm or minutes is ambiguous
    }
    if (hour > 23 || minute > 59)
        return null;

    let d;
    if (m[1]) {
        const month = MONTHS[m[1].toLowerCase()];
        if (month === undefined)
            return null;
        const year = m[3] ? Number(m[3]) : now.getFullYear();
        d = new Date(year, month, Number(m[2]), hour, minute);
        if (!m[3] && d.getTime() < now.getTime() - 180 * 86400e3)
            d.setFullYear(d.getFullYear() + 1);
    } else {
        d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
        if (d < now)
            d.setDate(d.getDate() + 1);
    }
    return d;
}

// "Current session: 15% used · resets Nov 25, 1:29pm (Asia/Ho_Chi_Minh)"
// Tolerates: "15.5 %", missing "used", separators · • - – | ,  and "resets at/on/in".
const LINE_RE = /^\s*([A-Za-z][^:：%]{1,60}?)\s*[:：]\s*(\d+(?:[.,]\d+)?)\s*%(?:\s*(?:used|utilized|consumed))?(?:\s*[·•|,–-]?\s*resets?\s*(.+?))?\s*$/i;

/** Parse the text printed by `/usage` into [{rawName, key, percent, resetText, resetAt}]. */
export function parseUsage(text, now = new Date()) {
    const limits = [];
    const seen = new Set();
    for (const line of String(text).split('\n')) {
        const m = line.match(LINE_RE);
        if (!m)
            continue;
        const rawName = m[1].trim();
        // Only keep lines that look like quota limits.
        if (!/session|week|day|month|limit|opus|sonnet|fable|haiku|model/i.test(rawName))
            continue;
        const key = limitKey(rawName);
        if (seen.has(key))
            continue;
        seen.add(key);
        const resetText = m[3] ? m[3].replace(/\s*\(.*?\)\s*$/, '').trim() : '';
        const resetAt = parseReset(m[3], now);
        limits.push({
            rawName,
            key,
            percent: Math.max(0, Number(m[2].replace(',', '.'))),
            resetText,
            resetAt: resetAt ? resetAt.getTime() : null,
        });
    }
    return limits;
}

/** Extract the first JSON object from a string (tolerates leading noise). */
export function parseJsonOutput(text) {
    const s = String(text ?? '');
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i < 0 || j < i)
        throw new Error(s.trim().split('\n')[0] || 'empty output');
    return JSON.parse(s.slice(i, j + 1));
}

export function formatDuration(ms) {
    let mins = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(mins / 1440);
    mins -= days * 1440;
    const hours = Math.floor(mins / 60);
    mins -= hours * 60;
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h${String(mins).padStart(2, '0')}m`;
    return `${mins}m`;
}

export function formatClock(ts, now = new Date()) {
    const date = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.toDateString() === now.toDateString())
        return time;
    return `${time} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

/**
 * Linear-regression forecast of when `percent` reaches 100.
 * samples: [{t, p}] sorted by t, all belonging to the current reset window.
 * Returns null when not enough data or usage isn't growing.
 */
export function forecast(samples, now = Date.now(), {minSpanMs = 10 * 60000, windowMs = 90 * 60000} = {}) {
    const pts = samples.filter(s => s.t >= now - windowMs && s.t <= now + 60000);
    if (pts.length < 2)
        return null;
    const span = pts[pts.length - 1].t - pts[0].t;
    if (span < minSpanMs)
        return null;
    const n = pts.length;
    const mt = pts.reduce((a, s) => a + s.t, 0) / n;
    const mp = pts.reduce((a, s) => a + s.p, 0) / n;
    let num = 0, den = 0;
    for (const s of pts) {
        num += (s.t - mt) * (s.p - mp);
        den += (s.t - mt) ** 2;
    }
    if (den === 0)
        return null;
    const slope = num / den; // percent per ms
    if (slope <= 1e-9)
        return null;
    const last = pts[n - 1];
    const eta = last.t + (100 - last.p) / slope;
    return {ratePerHour: slope * 3600000, eta};
}

/** Parse "80, 95" → [80, 95] sorted, unique, within (0,100]. */
export function parseThresholds(str) {
    return [...new Set(String(str).split(/[,;\s]+/).map(Number).filter(n => n > 0 && n <= 100))]
        .sort((a, b) => a - b);
}
