// Gambar kartu "Dana Grup" (saldo community) untuk pengumuman restock — TANPA library tambahan.
// Huruf diambil dari assets/inter-atlas.bin (font Inter, lisensi OFL — lihat assets/Inter-OFL.txt).
// Angka yang digambar = saldo ASLI dari Roblox (bukan angka ketikan), jadi gambarnya jujur.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('./qrcode-lite');

let ATLAS = null;
function atlas() {
    if (ATLAS) return ATLAS;
    const buf = fs.readFileSync(path.join(__dirname, 'assets', 'inter-atlas.bin'));
    const metaLen = buf.readUInt32BE(0);
    const meta = JSON.parse(buf.slice(4, 4 + metaLen).toString('utf8'));
    ATLAS = { fonts: meta.fonts, px: zlib.inflateSync(buf.slice(4 + metaLen)) };
    return ATLAS;
}

const COLOR = {
    page: [17, 18, 22],
    card: [31, 32, 36],
    white: [255, 255, 255],
    sub: [190, 192, 198],
    green: [87, 242, 135]
};

class Canvas {
    constructor(w, h, bg) {
        this.w = w; this.h = h;
        this.px = Buffer.alloc(w * h * 3);
        for (let i = 0; i < w * h; i++) { this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2]; }
    }
    blend(x, y, c, a) {
        if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        if (a > 1) a = 1;
        const i = (y * this.w + x) * 3;
        for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(this.px[i + k] * (1 - a) + c[k] * a);
    }
    roundRect(x0, y0, w, h, r, c) {
        for (let y = y0; y < y0 + h; y++) {
            for (let x = x0; x < x0 + w; x++) {
                const cx = x < x0 + r ? x0 + r : (x >= x0 + w - r ? x0 + w - r - 1 : x);
                const cy = y < y0 + r ? y0 + r : (y >= y0 + h - r ? y0 + h - r - 1 : y);
                const d = Math.hypot(x - cx, y - cy);
                this.blend(x, y, c, Math.max(0, Math.min(1, r + 0.5 - d)));
            }
        }
    }
    polygon(pts, c) {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
        const minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
        const inside = (px, py) => {
            let r = false;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                const [xi, yi] = pts[i], [xj, yj] = pts[j];
                if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) r = !r;
            }
            return r;
        };
        const S = 4;
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                let n = 0;
                for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) n++;
                if (n) this.blend(x, y, c, n / (S * S));
            }
        }
    }
    // ikon Robux sederhana: segi enam bercincin + segi enam kecil di tengah
    robuxIcon(cx, cy, size, fg, bg) {
        const hex = (r) => Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 180 * (60 * i - 90); return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
        const R = size / 2;
        this.polygon(hex(R), fg);
        this.polygon(hex(R * 0.72), bg);
        this.polygon(hex(R * 0.36), fg);
    }
    measure(font, text) {
        const f = atlas().fonts[font];
        let w = 0;
        for (const ch of text) w += (f.g[ch] || f.g['?'])[0];
        return w;
    }
    // y = posisi ATAS teks
    text(font, text, x, y, c) {
        const A = atlas(), f = A.fonts[font];
        const base = y + f.asc;
        let pen = x;
        for (const ch of text) {
            const [adv, xo, yo, w, h, off] = f.g[ch] || f.g['?'];
            const gx = Math.round(pen + xo), gy = Math.round(base + yo);
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                const a = A.px[off + j * w + i];
                if (a) this.blend(gx + i, gy + j, c, a / 255);
            }
            pen += adv;
        }
        return pen;
    }
    fit(font, text, maxW) {
        if (this.measure(font, text) <= maxW) return text;
        let t = text;
        while (t.length > 1 && this.measure(font, t + '…') > maxW) t = t.slice(0, -1);
        return t + '…';
    }
    png() {
        const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
        for (let y = 0; y < this.h; y++) {
            raw[y * (this.w * 3 + 1)] = 0;
            this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
        }
        const chunk = (type, data) => {
            const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
            const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
            const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
            return Buffer.concat([len, td, crc]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
        ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
        ]);
    }
}

const commas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const usd = (robux) => { const v = (robux * 0.0038).toFixed(2).split('.'); return `$${commas(v[0])}.${v[1]}`; };

// items: [{ label: 'C1 · BEJIRLAH', robux: 101356 }, ...]
function danaGrupPng(items) {
    if (!items?.length) return null;
    const PAD = 28, GAP = 28, CW = 680, CH = 320, TH = 340;
    const n = items.length;
    const cols = n === 1 ? 1 : 2;
    const withTotal = n > 1;
    // jumlah ganjil -> kartu total mengisi slot kosong di sebelah kartu terakhir; genap -> kartu total lebar di bawah
    const totalInGrid = withTotal && n % 2 === 1;
    const slots = n + (totalInGrid ? 1 : 0);
    const rows = Math.ceil(slots / cols);
    const W = PAD * 2 + CW * cols + GAP * (cols - 1);
    const H = PAD * 2 + rows * CH + (rows - 1) * GAP + (withTotal && !totalInGrid ? GAP + TH : 0);
    const cv = new Canvas(W, H, COLOR.page);

    const card = (x, y, w, h, title, sub, robux, big) => {
        cv.roundRect(x, y, w, h, 28, COLOR.card);
        cv.text('title', title, x + 40, y + 34, COLOR.white);
        cv.text('sub', cv.fit('sub', sub, w - 80), x + 40, y + 92, COLOR.sub);
        const icon = big ? 66 : 54;
        const amountFont = big ? 'big' : 'amount';
        const amountTop = big ? y + 146 : y + 140;
        const f = atlas().fonts[amountFont];
        const capMid = amountTop + f.asc - Math.round(f.asc * 0.36);
        cv.robuxIcon(x + 40 + icon / 2, capMid, icon, COLOR.white, COLOR.card);
        cv.text(amountFont, commas(robux), x + 40 + icon + 18, amountTop, COLOR.white);
        cv.text('usd', usd(robux), x + 56, y + h - 80, COLOR.white);
    };

    items.forEach((it, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        card(PAD + c * (CW + GAP), PAD + r * (CH + GAP), CW, CH, 'Dana Grup', it.label, it.robux, false);
    });
    if (withTotal) {
        const total = items.reduce((s, it) => s + it.robux, 0);
        const sub = items.map(it => it.label.split(' ')[0]).join(' + ');
        if (totalInGrid) {
            const c = n % cols, r = Math.floor(n / cols);
            card(PAD + c * (CW + GAP), PAD + r * (CH + GAP), CW, CH, 'Total Dana Grup', sub, total, false);
        } else {
            const y = PAD + rows * CH + (rows - 1) * GAP + GAP;
            card(PAD, y, W - PAD * 2, TH, 'Total Dana Grup', sub, total, true);
        }
    }
    return cv.png();
}

module.exports = { danaGrupPng };
