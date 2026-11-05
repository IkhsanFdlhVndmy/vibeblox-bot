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
    // ikon Robux: cincin segi enam (sudut membulat) + segi enam isi dengan lubang kotak di tengah
    robuxIcon(cx, cy, size, fg) {
        const R = size / 2;                      // jari-jari luar (titik sudut)
        const sdHex = (x, y, ap) => {           // segi enam ujung-atas, ap = jarak tengah ke sisi
            let px = Math.abs(y), py = Math.abs(x); // tukar sumbu -> ujung di atas
            const kx = -0.866025404, ky = 0.5, kz = 0.577350269;
            const d = Math.min(kx * px + ky * py, 0) * 2;
            px -= d * kx; py -= d * ky;
            const qx = px - Math.max(-kz * ap, Math.min(kz * ap, px)), qy = py - ap;
            return Math.hypot(qx, qy) * Math.sign(qy);
        };
        const sdBox = (x, y, h) => { const dx = Math.abs(x) - h, dy = Math.abs(y) - h; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0); };
        const round = R * 0.14;
        const apOut = R * 0.866 - round, ring = R * 0.17;
        const apIn = R * 0.866 * 0.66 - round;
        const hole = R * 0.2;
        const inside = (x, y) => {
            const o = sdHex(x, y, apOut) - round;
            if (o <= 0 && o > -ring) return true;                  // cincin luar
            const n = sdHex(x, y, apIn) - round;
            return n <= 0 && sdBox(x, y, hole - R * 0.04) - R * 0.04 > 0; // isi dalam, berlubang kotak
        };
        const S = 4, x0 = Math.floor(cx - R - 1), x1 = Math.ceil(cx + R + 1), y0 = Math.floor(cy - R - 1), y1 = Math.ceil(cy + R + 1);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            let n = 0;
            for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(x + (sx + 0.5) / S - cx, y + (sy + 0.5) / S - cy)) n++;
            if (n) this.blend(x, y, fg, n / (S * S));
        }
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

// Teks di tengah vertikal (pakai tinggi huruf kapital Inter ≈ 0,73 em)
function textMid(cv, font, text, x, midY, c) {
    const f = atlas().fonts[font];
    const cap = Math.round((f.asc + f.desc) * 0.6);
    return cv.text(font, text, x, Math.round(midY + cap / 2 - f.asc), c);
}
function chevron(cv, x, midY, size, c) {
    const w = size, h = size * 0.55, t = size * 0.16;
    cv.polygon([[x, midY - h / 2], [x + t, midY - h / 2], [x + w / 2, midY + h / 2 - t * 1.2], [x + w - t, midY - h / 2], [x + w, midY - h / 2], [x + w / 2, midY + h / 2]], c);
}

// Desain mengikuti tampilan "Dana Grup" milik owner. items: [{ robux: 101356 }, ...] — satu baris per community.
// Angka = saldo ASLI grup (diambil bot dari Roblox), bukan angka ketikan.
function danaGrupPng(items) {
    if (!items?.length) return null;
    const C = { page: [17, 18, 20], card: [29, 30, 34], white: [255, 255, 255], grey: [200, 201, 205], blue: [51, 95, 255], chipOn: [217, 218, 221], chipOnTxt: [25, 26, 30], chipOff: [40, 41, 46] };
    const PAD = 40, LW = 680, LH = 320, GAP = 52, RW = 668, RH = 274, ROWGAP = 32;
    const W = PAD + LW + GAP + RW + PAD;
    const rowsH = items.length * LH + (items.length - 1) * ROWGAP;
    const H = PAD + rowsH + 52 + 72 + PAD;
    const cv = new Canvas(W, H, C.page);

    items.forEach((it, i) => {
        const y = PAD + i * (LH + ROWGAP);
        // kartu kiri: Dana Grup
        const lx = PAD;
        cv.roundRect(lx, y, LW, LH, 26, C.card);
        cv.text('title', 'Dana Grup', lx + 40, y + 30, C.white);
        cv.text('subr', 'Robux di akun grupmu', lx + 40, y + 92, C.grey);
        const iconMid = y + 194;
        cv.robuxIcon(lx + 40 + 23, iconMid, 48, C.white);
        const end = textMid(cv, 'amt', commas(it.robux), lx + 102, iconMid, C.white);
        chevron(cv, end + 22, iconMid + 2, 20, C.grey);
        textMid(cv, 'usd', usd(it.robux), lx + 92, y + 262, C.white);
        // kartu kanan: Kirim Pembayaran Sekali
        const rx = PAD + LW + GAP;
        cv.roundRect(rx, y, RW, RH, 26, C.card);
        cv.text('title', 'Kirim Pembayaran Sekali', rx + 36, y + 30, C.white);
        cv.text('subr', 'Berikan Robux kepada kolaboratormu', rx + 36, y + 92, C.grey);
        const bw = Math.round(cv.measure('btn', 'Kirim Robux')) + 52;
        cv.roundRect(rx + 36, y + 160, bw, 76, 16, C.blue);
        textMid(cv, 'btn', 'Kirim Robux', rx + 36 + 26, y + 160 + 38, C.white);
    });

    // tombol bawah: Grup / Pengalaman virtual
    const cy = PAD + rowsH + 52;
    let cx = PAD;
    for (const [label, on] of [['Grup', true], ['Pengalaman virtual', false]]) {
        const w = Math.round(cv.measure('chip', label)) + 56;
        cv.roundRect(cx, cy, w, 72, 36, on ? C.chipOn : C.chipOff);
        textMid(cv, 'chip', label, cx + 28, cy + 36, on ? C.chipOnTxt : C.white);
        cx += w + 24;
    }
    return cv.png();
}

module.exports = { danaGrupPng };
