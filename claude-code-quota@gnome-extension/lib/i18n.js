// Tiny runtime-switchable i18n (English source strings → Vietnamese).
// Used instead of gettext so the language can be changed from Preferences
// independently of the session locale.

import GLib from 'gi://GLib';

const VI = {
    // panel / menu
    'Session (5h)': 'Session (5h)',
    'Week (all models)': 'Tuần (tất cả)',
    'Week ({0})': 'Tuần ({0})',
    'Not updated yet': 'Chưa cập nhật',
    'Updating…': 'Đang cập nhật…',
    'Updated at {0}': 'Cập nhật lúc {0}',
    'Refresh': 'Làm mới',
    'Open usage page on claude.ai': 'Mở trang usage trên claude.ai',
    'Settings': 'Cài đặt',
    'resets in {0} ({1})': 'reset sau {0} ({1})',
    'resets {0}': 'reset {0}',
    '~{0}%/h · hits 100% at {1} — before reset!': '~{0}%/h · chạm 100% lúc {1} — trước khi reset!',
    '~{0}%/h · would hit 100% at {1}': '~{0}%/h · dự kiến chạm 100% lúc {1}',
    'Data from {0} ago (last refresh failed)': 'Dữ liệu cách đây {0} (lần làm mới gần nhất lỗi)',
    'Retrying in {0}': 'Thử lại sau {0}',
    'Open Claude Code in a terminal with this profile': 'Mở Claude Code trong terminal với profile này',
    'Copy summary': 'Copy tóm tắt',
    'Copied quota summary': 'Đã copy tóm tắt quota',
    'Last {0}h': '{0}h qua',
    'No history yet': 'Chưa có lịch sử',
    'Collecting history — the chart appears after a few minutes': 'Đang thu thập lịch sử — biểu đồ sẽ hiện sau vài phút',
    'History: last {0}': 'Lịch sử {0} qua',
    'warning levels': 'ngưỡng cảnh báo',
    'Cannot find the `claude` binary. Set its path in Settings.': 'Không tìm thấy binary `claude`. Đặt đường dẫn trong Cài đặt.',
    'No Claude Code profile found': 'Không tìm thấy profile Claude Code nào',
    'Could not read quota': 'Không đọc được quota',
    'No terminal emulator found. Set one in Settings.': 'Không tìm thấy terminal. Đặt trong Cài đặt.',
    'Failed to launch: {0}': 'Không chạy được: {0}',
    // notifications
    'Claude Code quota: {0}': 'Quota Claude Code: {0}',
    '{0} has reached {1}% ({2}).': '{0} đã dùng {1}% ({2}).',
    'Resets in {0}.': 'Reset sau {0}.',
    '{0} has been reset — quota available again.': '{0} đã được reset — quota dùng lại được.',
    'At the current rate ({0}%/h), {1} will hit 100% at {2}, before it resets at {3}.':
        'Với tốc độ hiện tại ({0}%/h), {1} sẽ chạm 100% lúc {2}, trước khi reset lúc {3}.',
    // prefs
    'General': 'Chung',
    'Data': 'Dữ liệu',
    'Refresh interval (seconds)': 'Chu kỳ làm mới (giây)',
    'Longer automatically when errors repeat (backoff)': 'Tự giãn ra khi lỗi liên tiếp (backoff)',
    'Command timeout (seconds)': 'Timeout mỗi lệnh (giây)',
    'Path to claude': 'Đường dẫn tới claude',
    'Empty = auto-detect. Detected: {0}': 'Để trống = tự dò. Đang dùng: {0}',
    'not found': 'không tìm thấy',
    'Language': 'Ngôn ngữ',
    'Reopen this window to apply the language': 'Mở lại cửa sổ này để áp dụng ngôn ngữ',
    'Automatic': 'Tự động',
    'Profiles': 'Profile',
    'Auto-detected from ~/.claude and ~/.claude-profiles/*. Duplicate accounts are merged.':
        'Tự dò từ ~/.claude và ~/.claude-profiles/*. Tài khoản trùng được gộp lại.',
    'Extra profiles': 'Profile bổ sung',
    'name=/path/to/config-dir, separated by ;': 'tên=/đường/dẫn/config-dir, cách nhau bởi ;',
    'Terminal command': 'Lệnh terminal',
    'Empty = auto-detect, e.g. "gnome-terminal --" or "kitty"': 'Để trống = tự dò, vd "gnome-terminal --" hoặc "kitty"',
    'Advanced': 'Nâng cao',
    'Appearance': 'Giao diện',
    'Panel': 'Panel',
    'Display style': 'Kiểu hiển thị',
    'Text': 'Chữ',
    'Ring': 'Vòng tròn',
    'Ring + text': 'Vòng tròn + chữ',
    'Show weekly % next to session %': 'Hiện % tuần cạnh % session',
    'Profile shown on panel': 'Profile hiện trên panel',
    'All': 'Tất cả',
    'Position': 'Vị trí',
    'Left': 'Trái',
    'Center': 'Giữa',
    'Right': 'Phải',
    'Colors': 'Màu sắc',
    'Warning level (%)': 'Ngưỡng vàng (%)',
    'Critical level (%)': 'Ngưỡng đỏ (%)',
    'History chart range': 'Khoảng thời gian biểu đồ',
    '{0} hours': '{0} giờ',
    '{0} days': '{0} ngày',
    'Notifications': 'Thông báo',
    'Enable notifications': 'Bật thông báo',
    'Thresholds (%)': 'Ngưỡng cảnh báo (%)',
    'Comma separated, e.g. 80, 95': 'Cách nhau bởi dấu phẩy, vd 80, 95',
    'Notify when a limit resets': 'Báo khi limit được reset',
    'Only after it had crossed the first threshold': 'Chỉ khi trước đó đã vượt ngưỡng đầu tiên',
    'Notify on burn-rate forecast': 'Báo theo dự báo tốc độ dùng',
    'When 100% is predicted within the next hour, before the reset': 'Khi dự báo chạm 100% trong vòng 1 giờ tới, trước lúc reset',
};

let _lang = 'en';

export function setLanguage(pref) {
    if (pref === 'vi' || pref === 'en') {
        _lang = pref;
        return;
    }
    _lang = 'en';
    for (const name of GLib.get_language_names()) {
        if (name.startsWith('vi')) {
            _lang = 'vi';
            return;
        }
        if (name.startsWith('en'))
            return;
    }
}

export function getLanguage() {
    return _lang;
}

/** Translate and substitute {0}, {1}, … */
export function _(s, ...args) {
    const t = (_lang === 'vi' && VI[s]) || s;
    return t.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
}
