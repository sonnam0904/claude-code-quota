// Preferences window (libadwaita).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {detectProfiles, findClaude} from './lib/quota.js';
import {_, setLanguage} from './lib/i18n.js';

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    if (subtitle)
        row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, Math.round(row.value)));
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    settings.bind(key, row, 'active', 0);
    return row;
}

function comboRow(settings, key, title, choices /* [[value, label]] */, subtitle) {
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? '',
        model: Gtk.StringList.new(choices.map(c => c[1])),
    });
    const cur = choices.findIndex(c => c[0] === settings.get_string(key));
    row.selected = cur >= 0 ? cur : 0;
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    return row;
}

function entryRow(title, text, onApply) {
    const row = new Adw.EntryRow({title, text, show_apply_button: true});
    row.connect('apply', () => onApply(row.text));
    return row;
}

export default class ClaudeQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        setLanguage(settings.get_string('language'));
        window.set_default_size(640, 720);
        window.search_enabled = true;

        window.add(this._generalPage(settings, window));
        window.add(this._appearancePage(settings));
        window.add(this._notificationsPage(settings));
    }

    _generalPage(s, window) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        // --- data
        const data = new Adw.PreferencesGroup({title: _('Data')});
        data.add(spinRow(s, 'refresh-interval', _('Refresh interval (seconds)'),
            _('Longer automatically when errors repeat (backoff)'), 30, 3600, 10));
        data.add(spinRow(s, 'command-timeout', _('Command timeout (seconds)'), null, 5, 300, 5));

        const detected = findClaude('') ?? _('not found');
        const pathRow = entryRow(_('Path to claude'), s.get_string('claude-path'), t => s.set_string('claude-path', t.trim()));
        data.add(pathRow);
        const pathHint = new Adw.ActionRow({
            subtitle: _('Empty = auto-detect. Detected: {0}', detected),
            activatable: false,
        });
        pathHint.add_css_class('dim-label');
        data.add(pathHint);

        const langRow = comboRow(s, 'language', _('Language'), [
            ['auto', _('Automatic')], ['en', 'English'], ['vi', 'Tiếng Việt'],
        ]);
        langRow.connect('notify::selected', () => {
            // The panel menu switches immediately; this window keeps its labels until reopened.
            setLanguage(s.get_string('language'));
            window.add_toast?.(new Adw.Toast({title: _('Reopen this window to apply the language'), timeout: 3}));
        });
        data.add(langRow);
        page.add(data);

        // --- profiles
        const prof = new Adw.PreferencesGroup({
            title: _('Profiles'),
            description: _('Auto-detected from ~/.claude and ~/.claude-profiles/*. Duplicate accounts are merged.'),
        });
        const hidden = new Set(s.get_strv('hidden-profiles'));
        for (const p of detectProfiles(s.get_strv('extra-profiles'))) {
            const row = new Adw.SwitchRow({title: p.name, subtitle: p.dir ?? '~/.claude', active: !hidden.has(p.name)});
            row.connect('notify::active', () => {
                const h = new Set(s.get_strv('hidden-profiles'));
                if (row.active)
                    h.delete(p.name);
                else
                    h.add(p.name);
                s.set_strv('hidden-profiles', [...h]);
            });
            prof.add(row);
        }
        const extraRow = entryRow(_('Extra profiles'), s.get_strv('extra-profiles').join('; '), t =>
            s.set_strv('extra-profiles', t.split(';').map(x => x.trim()).filter(Boolean)));
        prof.add(extraRow);
        const extraHint = new Adw.ActionRow({subtitle: _('name=/path/to/config-dir, separated by ;'), activatable: false});
        extraHint.add_css_class('dim-label');
        prof.add(extraHint);
        page.add(prof);

        // --- advanced
        const adv = new Adw.PreferencesGroup({title: _('Advanced')});
        adv.add(entryRow(_('Terminal command'), s.get_string('terminal'), t => s.set_string('terminal', t.trim())));
        const termHint = new Adw.ActionRow({subtitle: _('Empty = auto-detect, e.g. "gnome-terminal --" or "kitty"'), activatable: false});
        termHint.add_css_class('dim-label');
        adv.add(termHint);
        page.add(adv);

        return page;
    }

    _appearancePage(s) {
        const page = new Adw.PreferencesPage({title: _('Appearance'), icon_name: 'applications-graphics-symbolic'});

        const panel = new Adw.PreferencesGroup({title: _('Panel')});
        panel.add(comboRow(s, 'panel-mode', _('Display style'), [
            ['both', _('Ring + text')], ['text', _('Text')], ['ring', _('Ring')],
        ]));
        panel.add(switchRow(s, 'panel-show-weekly', _('Show weekly % next to session %')));
        const names = detectProfiles(s.get_strv('extra-profiles')).map(p => p.name);
        panel.add(comboRow(s, 'panel-profile', _('Profile shown on panel'),
            [['', _('All')], ...names.map(n => [n, n])]));
        panel.add(comboRow(s, 'panel-position', _('Position'), [
            ['right', _('Right')], ['center', _('Center')], ['left', _('Left')],
        ]));
        page.add(panel);

        const colors = new Adw.PreferencesGroup({title: _('Colors')});
        colors.add(spinRow(s, 'warn-level', _('Warning level (%)'), null, 1, 100, 5));
        colors.add(spinRow(s, 'crit-level', _('Critical level (%)'), null, 1, 100, 5));
        const hours = [6, 12, 24, 48, 72, 168];
        const chartRow = new Adw.ComboRow({
            title: _('History chart range'),
            model: Gtk.StringList.new(hours.map(h => (h < 48 ? _('{0} hours', h) : _('{0} days', h / 24)))),
        });
        const curH = hours.indexOf(s.get_int('chart-hours'));
        chartRow.selected = curH >= 0 ? curH : 2;
        chartRow.connect('notify::selected', () => s.set_int('chart-hours', hours[chartRow.selected]));
        colors.add(chartRow);
        page.add(colors);

        return page;
    }

    _notificationsPage(s) {
        const page = new Adw.PreferencesPage({title: _('Notifications'), icon_name: 'preferences-system-notifications-symbolic'});
        const g = new Adw.PreferencesGroup({title: _('Notifications')});
        g.add(switchRow(s, 'notify-enabled', _('Enable notifications')));
        const dependent = [
            entryRow(_('Thresholds (%)'), s.get_string('notify-thresholds'), t => s.set_string('notify-thresholds', t)),
            new Adw.ActionRow({subtitle: _('Comma separated, e.g. 80, 95'), activatable: false, css_classes: ['dim-label']}),
            switchRow(s, 'notify-reset', _('Notify when a limit resets'), _('Only after it had crossed the first threshold')),
            switchRow(s, 'notify-forecast', _('Notify on burn-rate forecast'),
                _('When 100% is predicted within the next hour, before the reset')),
        ];
        for (const row of dependent) {
            s.bind('notify-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            g.add(row);
        }
        page.add(g);
        return page;
    }
}
