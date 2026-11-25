// Small cairo-drawn widgets: panel ring, progress bar, history sparkline.
// Sizes are set through CSS (style) so St applies the display scale factor;
// drawing code works in physical pixels from get_surface_size().

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

export const COLORS = {
    ok: [0.54, 0.89, 0.20],
    warn: [0.99, 0.69, 0.24],
    crit: [0.94, 0.16, 0.16],
    muted: [0.6, 0.6, 0.6],
    claude: [0.85, 0.47, 0.34],
    week: [0.40, 0.65, 0.98],
};

export function levelOf(percent, warn, crit) {
    if (percent == null || percent < 0)
        return 'muted';
    if (percent >= crit)
        return 'crit';
    if (percent >= warn)
        return 'warn';
    return 'ok';
}

function setColor(cr, rgb, a = 1) {
    cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], a);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function sized(w, h) {
    return {style: `width: ${w}px; height: ${h}px;`, y_align: Clutter.ActorAlign.CENTER};
}

/** Circular gauge; outer ring = primary %, optional inner ring = secondary %. */
export const Ring = GObject.registerClass(
class Ring extends St.DrawingArea {
    _init(size = 22) {
        super._init(sized(size, size));
        this._p = -1;
        this._p2 = -1;
        this._color = COLORS.muted;
    }

    setValue(percent, color, secondary = -1) {
        this._p = percent;
        this._p2 = secondary;
        this._color = color;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2, cy = h / 2;
        const hasInner = this._p2 >= 0;
        const lw = Math.max(2, Math.min(w, h) * (hasInner ? 0.15 : 0.18));
        const r = Math.min(w, h) / 2 - lw / 2;
        cr.setLineCap(1); // ROUND

        const arc = (radius, width, percent, color) => {
            cr.setLineWidth(width);
            setColor(cr, [1, 1, 1], 0.2);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();
            if (percent > 0) {
                setColor(cr, color);
                cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(percent, 100) / 100);
                cr.stroke();
            }
        };

        arc(r, lw, this._p, this._color);
        if (hasInner) {
            const lw2 = lw * 0.85;
            const r2 = r - lw / 2 - lw2 / 2 - Math.max(1, lw * 0.35);
            if (r2 > lw2)
                arc(r2, lw2, this._p2, COLORS.week);
        }
        cr.$dispose();
    }
});

/** Horizontal progress bar. */
export const Bar = GObject.registerClass(
class Bar extends St.DrawingArea {
    _init(width = 200, height = 12) {
        super._init(sized(width, height));
        this._p = 0;
        this._color = COLORS.muted;
        this._marker = null;
    }

    setValue(percent, color, markerPercent = null) {
        this._p = percent;
        this._color = color;
        this._marker = markerPercent;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        setColor(cr, [1, 1, 1], 0.18);
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.fill();
        const fw = w * Math.max(0, Math.min(this._p, 100)) / 100;
        if (fw > 0) {
            setColor(cr, this._color);
            roundedRect(cr, 0, 0, Math.max(fw, h), h, h / 2);
            cr.fill();
        }
        if (this._marker != null && this._marker > 0 && this._marker < 100) {
            // time elapsed in the current window
            const x = Math.round(w * this._marker / 100);
            const mw = Math.max(2, Math.round(h / 5));
            setColor(cr, [1, 1, 1], 0.85);
            cr.rectangle(x - mw / 2, 0, mw, h);
            cr.fill();
        }
        cr.$dispose();
    }
});

/** Line chart of several series over a time range; y in [0,100]. */
export const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init(width = 420, height = 72) {
        super._init(sized(width, height));
        this._series = [];
        this._from = 0;
        this._to = 1;
        this._levels = [];
    }

    /** series: [{points: [{t,p}], color}]; levels: [{p, color}] dashed reference lines */
    setData(series, from, to, levels) {
        this._series = series;
        this._from = from;
        this._to = to;
        this._levels = levels;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const scale = h / 72;
        const fontSize = Math.round(10 * Math.max(1, scale));
        const labelW = fontSize * 2.6;          // room for "100%"
        const pad = Math.round(4 * scale);
        const x0 = pad, x1 = w - labelW - pad;
        const X = t => x0 + (x1 - x0) * (t - this._from) / Math.max(1, this._to - this._from);
        const Y = p => h - pad - (h - 2 * pad) * Math.min(Math.max(p, 0), 100) / 100;

        setColor(cr, [1, 1, 1], 0.06);
        roundedRect(cr, 0, 0, w, h, 6 * scale);
        cr.fill();

        cr.selectFontFace('Sans', 0, 0);
        cr.setFontSize(fontSize);
        cr.setLineWidth(Math.max(1, scale));
        for (const lv of this._levels) {
            const y = Math.round(Y(lv.p)) + 0.5;
            cr.setDash([3 * scale, 4 * scale], 0);
            setColor(cr, lv.color, 0.55);
            cr.moveTo(x0, y);
            cr.lineTo(x1, y);
            cr.stroke();
            cr.setDash([], 0);
            setColor(cr, lv.color, 0.9);
            cr.moveTo(x1 + 4 * scale, y + fontSize / 3);
            cr.showText(`${lv.p}%`);
        }

        cr.setLineWidth(2 * Math.max(1, scale));
        cr.setLineJoin(1);
        for (const s of this._series) {
            const pts = s.points.filter(q => q.t >= this._from);
            if (!pts.length)
                continue;
            setColor(cr, s.color);
            cr.moveTo(X(pts[0].t), Y(pts[0].p));
            for (let i = 1; i < pts.length; i++) {
                // break the line across long gaps (e.g. machine asleep)
                if (pts[i].t - pts[i - 1].t > 30 * 60000)
                    cr.moveTo(X(pts[i].t), Y(pts[i].p));
                else
                    cr.lineTo(X(pts[i].t), Y(pts[i].p));
            }
            cr.stroke();
            const last = pts[pts.length - 1];
            cr.arc(X(last.t), Y(last.p), 3 * Math.max(1, scale), 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    }
});
