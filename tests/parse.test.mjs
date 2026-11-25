// Run: node --test tests/
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    parseUsage, parseReset, limitKey, limitModel, forecast, parseThresholds, parseJsonOutput, formatDuration,
} from '../claude-code-quota@gnome-extension/lib/parse.js';

const NOW = new Date(2026, 10, 25, 11, 0); // Nov 25 2026 11:00 local

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 15% used · resets Nov 25, 1:29pm (Asia/Ho_Chi_Minh)
Current week (all models): 6% used · resets Dec 1, 3pm (Asia/Ho_Chi_Minh)
Current week (Fable): 0% used · resets Dec 2, 7:59am (Asia/Ho_Chi_Minh)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 7d · 441 requests · 6 sessions
  63%  Start fresh when you switch tasks · run /clear
  Top skills: /cafef-lich-su-kien-search-test 4%`;

test('parses the real /usage output', () => {
    const l = parseUsage(SAMPLE, NOW);
    assert.deepEqual(l.map(x => [x.key, x.percent]), [['session', 15], ['week_all', 6], ['week_fable', 0]]);
    assert.equal(new Date(l[0].resetAt).getHours(), 13);
    assert.equal(new Date(l[0].resetAt).getMinutes(), 29);
    assert.equal(new Date(l[1].resetAt).getMonth(), 11);
    assert.equal(new Date(l[1].resetAt).getHours(), 15);
    assert.equal(l[0].resetText, 'Nov 25, 1:29pm');
});

test('ignores non-limit lines', () => {
    assert.equal(parseUsage('Top skills: /foo 4%\n  63%  Start fresh', NOW).length, 0);
});

test('tolerates format variations', () => {
    const l = parseUsage([
        'Current session: 42.5 % used - resets in 2h 30m',
        'Current week (Opus): 7% • resets at 13:45',
        'Current week (all models): 12%',
    ].join('\n'), NOW);
    assert.deepEqual(l.map(x => [x.key, x.percent]), [['session', 42.5], ['week_opus', 7], ['week_all', 12]]);
    assert.equal(l[0].resetAt, NOW.getTime() + 150 * 60000);
    assert.equal(new Date(l[1].resetAt).getHours(), 13);
    assert.equal(l[2].resetAt, null);
});

test('parseReset variants', () => {
    assert.equal(parseReset('Dec 1, 3pm', NOW).getHours(), 15);
    assert.equal(parseReset('Jan 2, 9am', NOW).getFullYear(), 2027); // rolls over the year
    assert.equal(parseReset('Dec 2, 2026, 7:59am (UTC)', NOW).getDate(), 2);
    assert.equal(parseReset('12am', NOW).getHours(), 0);
    assert.equal(parseReset('9:00am', NOW).getDate(), 26); // past today → tomorrow
    assert.equal(parseReset('in 3d 4h', NOW).getTime(), NOW.getTime() + (3 * 24 + 4) * 3600e3);
    assert.equal(parseReset('garbage', NOW), null);
    assert.equal(parseReset('', NOW), null);
});

test('limitKey / limitModel', () => {
    assert.equal(limitKey('Current session'), 'session');
    assert.equal(limitKey('Current week (all models)'), 'week_all');
    assert.equal(limitKey('Current week (Sonnet 4.5)'), 'week_sonnet_4_5');
    assert.equal(limitModel('Current week (Fable)'), 'Fable');
    assert.equal(limitModel('Current week (all models)'), null);
});

test('forecast', () => {
    const t0 = NOW.getTime();
    const pts = [0, 10, 20, 30].map(m => ({t: t0 + m * 60000, p: 10 + m}));  // +1%/min
    const f = forecast(pts, t0 + 30 * 60000);
    assert.ok(Math.abs(f.ratePerHour - 60) < 1e-6);
    assert.equal(f.eta, t0 + 90 * 60000);
    assert.equal(forecast(pts.map(p => ({...p, p: 10})), t0 + 30 * 60000), null); // flat
    assert.equal(forecast(pts.slice(0, 1), t0), null);
});

test('parseThresholds', () => {
    assert.deepEqual(parseThresholds('95, 80;80 abc 150 0'), [80, 95]);
});

test('parseJsonOutput tolerates noise', () => {
    assert.deepEqual(parseJsonOutput('warning: x\n{"a":1}\n'), {a: 1});
    assert.throws(() => parseJsonOutput('boom'), /boom/);
});

test('formatDuration', () => {
    assert.equal(formatDuration(125 * 60000), '2h05m');
    assert.equal(formatDuration(3 * 86400e3 + 4 * 3600e3), '3d 4h');
    assert.equal(formatDuration(-5), '0m');
});
