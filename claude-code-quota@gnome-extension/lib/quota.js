// Fetching quota through the Claude Code CLI.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {parseUsage, parseJsonOutput} from './parse.js';
import {_} from './i18n.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const HOME = GLib.get_home_dir();
const AUTH_TTL_MS = 30 * 60000;

function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function isDir(path) {
    return GLib.file_test(path, GLib.FileTest.IS_DIR);
}

function listDir(path) {
    const out = [];
    if (!isDir(path))
        return out;
    try {
        const en = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            out.push(info.get_name());
        en.close(null);
    } catch (e) {
        // ignore unreadable directories
    }
    return out;
}

function compareVersionsDesc(a, b) {
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] || 0) - (pa[i] || 0);
        if (d)
            return d;
    }
    return 0;
}

/** Locate the claude binary (the shell's PATH usually lacks nvm/bun dirs). */
export function findClaude(configured = '') {
    if (configured)
        return fileExists(configured) ? configured : null;

    const inPath = GLib.find_program_in_path('claude');
    if (inPath)
        return inPath;

    const candidates = [
        `${HOME}/.local/bin/claude`,
        `${HOME}/.claude/local/claude`,
        `${HOME}/.npm-global/bin/claude`,
        `${HOME}/.bun/bin/claude`,
        `${HOME}/.volta/bin/claude`,
        `${HOME}/.local/share/pnpm/claude`,
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        '/opt/claude-code/bin/claude',
    ];
    const nvmDir = `${HOME}/.nvm/versions/node`;
    for (const v of listDir(nvmDir).sort(compareVersionsDesc))
        candidates.push(`${nvmDir}/${v}/bin/claude`);
    const fnmDir = `${HOME}/.local/share/fnm/node-versions`;
    for (const v of listDir(fnmDir).sort(compareVersionsDesc))
        candidates.push(`${fnmDir}/${v}/installation/bin/claude`);

    return candidates.find(fileExists) ?? null;
}

/**
 * All candidate profiles: ~/.claude-profiles/* then ~/.claude (as "default"),
 * then extra "name=dir" entries. `dir: null` means the default config dir.
 */
export function detectProfiles(extra = []) {
    const profiles = [];
    const profRoot = `${HOME}/.claude-profiles`;
    for (const name of listDir(profRoot).sort()) {
        const dir = `${profRoot}/${name}`;
        if (isDir(dir))
            profiles.push({name, dir});
    }
    if (isDir(`${HOME}/.claude`))
        profiles.push({name: 'default', dir: null});
    for (const entry of extra) {
        const idx = entry.indexOf('=');
        const name = (idx > 0 ? entry.slice(0, idx) : GLib.path_get_basename(entry)).trim();
        let dir = (idx > 0 ? entry.slice(idx + 1) : entry).trim();
        if (!dir)
            continue;
        if (dir.startsWith('~/'))
            dir = `${HOME}/${dir.slice(2)}`;
        if (isDir(dir) && !profiles.some(p => p.dir === dir))
            profiles.push({name, dir});
    }
    return profiles;
}

export async function runClaude(claudePath, args, configDir, timeoutSec, cancellable) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_cwd(GLib.get_tmp_dir());
    const binDir = GLib.path_get_dirname(claudePath);
    launcher.setenv('PATH', `${binDir}:${GLib.getenv('PATH') ?? '/usr/local/bin:/usr/bin:/bin'}`, true);
    launcher.setenv('NO_COLOR', '1', true);
    if (configDir)
        launcher.setenv('CLAUDE_CONFIG_DIR', configDir, true);
    else
        launcher.unsetenv('CLAUDE_CONFIG_DIR');

    const proc = launcher.spawnv([claudePath, ...args]);
    // Own cancellable so a timeout also stops waiting on pipes that a
    // leftover grandchild process might keep open.
    const callCancel = new Gio.Cancellable();
    const parentId = cancellable ? cancellable.connect(() => callCancel.cancel()) : 0;
    let timedOut = false;
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
        timedOut = true;
        proc.force_exit();
        callCancel.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, callCancel);
        if (timedOut)
            throw new Error(`timeout after ${timeoutSec}s`);
        return {ok: proc.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''};
    } catch (e) {
        if (timedOut)
            throw new Error(`timeout after ${timeoutSec}s`);
        proc.force_exit(); // no-op if it already exited
        throw e;
    } finally {
        if (!timedOut)
            GLib.source_remove(timer);
        if (parentId)
            cancellable.disconnect(parentId);
    }
}

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class QuotaFetcher {
    constructor() {
        this._authCache = new Map(); // dir → {at, auth}
    }

    async _auth(claude, p, timeout, cancellable) {
        const k = p.dir ?? '';
        const c = this._authCache.get(k);
        if (c && Date.now() - c.at < AUTH_TTL_MS)
            return c.auth;
        let auth = null;
        try {
            const r = await runClaude(claude, ['auth', 'status'], p.dir, timeout, cancellable);
            auth = parseJsonOutput(r.stdout);
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }
        if (auth)
            this._authCache.set(k, {at: Date.now(), auth});
        return auth;
    }

    /**
     * @returns {Promise<Array<{id, name, dir, auth, limits, error}>>}
     * Throws only for global problems (binary missing, no profiles, cancelled).
     */
    async fetch({claudePath, hidden = [], extra = [], timeout = 60, cancellable = null}) {
        const claude = findClaude(claudePath);
        if (!claude)
            throw new Error(_('Cannot find the `claude` binary. Set its path in Settings.'));
        const profiles = detectProfiles(extra).filter(p => !hidden.includes(p.name));
        if (!profiles.length)
            throw new Error(_('No Claude Code profile found'));

        const withAuth = await Promise.all(profiles.map(async p =>
            ({...p, auth: await this._auth(claude, p, timeout, cancellable)})));

        const seen = new Set();
        const accounts = [];
        for (const p of withAuth) {
            if (p.auth && p.auth.loggedIn === false)
                continue;
            const id = p.auth?.email ? `${p.auth.email}|${p.auth.orgId ?? ''}` : `dir:${p.dir ?? 'default'}`;
            if (seen.has(id))
                continue;
            seen.add(id);
            accounts.push({...p, id});
        }

        return Promise.all(accounts.map(async acc => {
            try {
                const r = await runClaude(claude,
                    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
                    acc.dir, timeout, cancellable);
                const j = parseJsonOutput(r.stdout || r.stderr);
                const text = String(j.result ?? '');
                if (j.is_error)
                    throw new Error(text || 'error');
                const limits = parseUsage(text);
                if (!limits.length)
                    throw new Error(text.split('\n').find(l => l.trim())?.trim() || _('Could not read quota'));
                return {...acc, limits, error: null};
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                // A changed auth state could be the reason; re-check next time.
                this._authCache.delete(acc.dir ?? '');
                return {...acc, limits: [], error: e.message};
            }
        }));
    }
}

// ---------------------------------------------------------------- terminal

const TERMINALS = [
    ['ptyxis', ['--']],
    ['gnome-terminal', ['--']],
    ['kgx', ['-e']],
    ['konsole', ['-e']],
    ['xfce4-terminal', ['-x']],
    ['tilix', ['-e']],
    ['alacritty', ['-e']],
    ['kitty', []],
    ['wezterm', ['start', '--']],
    ['foot', []],
    ['xterm', ['-e']],
    ['x-terminal-emulator', ['-e']],
];

/** Open an interactive `claude` for a profile in a terminal emulator. */
export function openTerminal(claudePath, profileDir, terminalSetting = '') {
    const claude = findClaude(claudePath);
    if (!claude)
        throw new Error(_('Cannot find the `claude` binary. Set its path in Settings.'));

    let prefix = null;
    if (terminalSetting.trim()) {
        prefix = GLib.shell_parse_argv(terminalSetting.trim())[1];
    } else {
        for (const [bin, args] of TERMINALS) {
            const path = GLib.find_program_in_path(bin);
            if (path) {
                prefix = [path, ...args];
                break;
            }
        }
    }
    if (!prefix)
        throw new Error(_('No terminal emulator found. Set one in Settings.'));

    const envArgs = profileDir ? ['env', `CLAUDE_CONFIG_DIR=${profileDir}`] : ['env', '-u', 'CLAUDE_CONFIG_DIR'];
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.set_cwd(HOME);
    launcher.spawnv([...prefix, ...envArgs, claude]);
}
