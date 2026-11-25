# Claude Code Quota

Hiển thị quota Claude Code (session 5h / tuần) trên thanh panel của desktop Linux.

Dữ liệu lấy qua `claude -p /usage --output-format json --no-session-persistence`. Đây là lệnh local nên **không tốn token**.

Gồm 2 phần:

| Thành phần | Dùng cho |
|---|---|
| `claude-code-quota@gnome-extension/` | GNOME Shell 45–50 (Ubuntu, Fedora, Pop!_OS, Arch/CachyOS bản GNOME, RHEL 10…) |
| `cli/claude-quota` | Waybar, Polybar, i3blocks, XFCE Genmon, KDE Plasma, terminal |

## Tính năng (GNOME extension)

- **Panel**: vòng tròn hiển thị % session (vòng trong là % tuần) kèm chữ `B 19%·8%  V 12%·10%`. Màu đổi theo ngưỡng (xanh / vàng / đỏ).
- **Menu**:
  - Thanh tiến độ cho từng limit. Vạch trắng trên thanh là phần thời gian đã trôi qua trong chu kỳ: phần màu vượt vạch nghĩa là đang dùng nhanh hơn tốc độ đều.
  - Thời gian còn lại tới lúc reset.
  - Dự báo tốc độ dùng, ví dụ `~13%/h · chạm 100% lúc 20:36 — trước khi reset!`.
  - Biểu đồ lịch sử (6h đến 7 ngày).
- **Thông báo**:
  - Khi vượt ngưỡng (mặc định 80% và 95%).
  - Khi limit được reset.
  - Khi dự báo sẽ chạm 100% trong vòng 1 giờ tới, trước lúc reset.
  - Mỗi mức chỉ báo một lần.
- **Nhiều profile**:
  - Tự dò `~/.claude` và `~/.claude-profiles/*` (theo kiểu `CLAUDE_CONFIG_DIR`).
  - Gộp các profile trùng tài khoản (theo `claude auth status`).
  - Có thể ẩn profile hoặc thêm profile ở thư mục khác.
- **Thao tác nhanh**:
  - Copy tóm tắt.
  - Mở `claude` trong terminal với đúng profile.
  - Mở trang usage trên claude.ai.
- **Ổn định**:
  - Đọc output linh hoạt, chịu được thay đổi nhỏ về định dạng.
  - Khi lỗi vẫn giữ số liệu cũ và ghi rõ "cách đây X phút".
  - Lỗi liên tiếp thì giãn dần thời gian thử lại (backoff, tối đa 30 phút).
  - Mỗi lệnh có timeout.
  - Làm mới khi mở menu nếu dữ liệu cũ hơn 1 phút, và sau khi máy thức dậy từ chế độ ngủ.
- **Cài đặt** (Preferences): chu kỳ, profile, kiểu hiển thị, vị trí trên panel, ngưỡng màu, thông báo, ngôn ngữ (English / Tiếng Việt).

## Cài đặt GNOME extension

```bash
make install            # biên dịch schema + symlink vào ~/.local/share/gnome-shell/extensions
# X11: Alt+F2 → r → Enter   |   Wayland: đăng xuất / đăng nhập
gnome-extensions enable claude-code-quota@gnome-extension
make prefs              # mở cửa sổ Cài đặt
```

Bản copy thay vì symlink: `./install.sh --copy`.
Đóng gói zip (để cài trên máy khác hoặc đăng lên extensions.gnome.org): `make pack`. Cài từ file zip:

```bash
gnome-extensions install --force dist/claude-code-quota@gnome-extension.shell-extension.zip
```

Lịch sử và trạng thái thông báo được lưu ở `~/.cache/claude-code-quota/history.json`.

## CLI cho desktop khác

```bash
make install-cli        # → ~/.local/bin/claude-quota
claude-quota            # dạng đọc được
claude-quota -f short   # ✳ B 19%·8%  V 12%·10%
claude-quota -f json
claude-quota -p bizfly  # chỉ một profile
```

Kết quả được cache 55 giây (`--max-age`), nên status bar gọi dày cũng không chạy `claude` liên tục.

**Waybar** (`~/.config/waybar/config`):

```json
"custom/claude": {
  "exec": "claude-quota -f waybar",
  "return-type": "json",
  "interval": 60,
  "on-click": "xdg-open https://claude.ai/settings/usage"
}
```

CSS gợi ý: `#custom-claude.warning { color: #fcaf3e; } #custom-claude.critical { color: #ef2929; }`

**Polybar**:

```ini
[module/claude]
type = custom/script
exec = claude-quota -f polybar
interval = 60
```

**i3blocks**:

```ini
[claude]
command=claude-quota -f i3blocks
interval=60
```

**XFCE**: thêm plugin *Generic Monitor* với lệnh `claude-quota -f genmon`, chu kỳ 60 giây.

**KDE Plasma** (CachyOS, Kubuntu…): cài widget *Command Output* từ "Get New Widgets", lệnh `claude-quota -f short`, chu kỳ 60000 ms.

## Phát triển

```bash
make test     # unit test phần parse (node) + kiểm tra cú pháp CLI
make lint     # kiểm tra cú pháp các file JS
journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude-code-quota   # log
```

Cấu trúc:

```
claude-code-quota@gnome-extension/
  extension.js      panel indicator, menu, thông báo, lên lịch làm mới
  prefs.js          cửa sổ Cài đặt (libadwaita)
  lib/parse.js      parse output /usage, dự báo (thuần JS, test được bằng node)
  lib/quota.js      dò claude/profile, chạy lệnh, mở terminal
  lib/history.js    lịch sử + trạng thái thông báo
  lib/widgets.js    vòng tròn / thanh tiến độ / biểu đồ (cairo)
  lib/i18n.js       chuỗi tiếng Anh → tiếng Việt
  schemas/          GSettings schema
cli/claude-quota    CLI Python cho Waybar/Polybar/KDE/XFCE
tests/              unit test
```

Sau khi sửa code extension, cần reload GNOME Shell. GNOME không nạp lại được module ES đã sửa khi shell đang chạy.
# claude-code-quota
