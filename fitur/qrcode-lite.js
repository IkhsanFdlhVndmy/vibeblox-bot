// =====================================================================
// Pembuat gambar QR Code (PNG) TANPA library tambahan — tidak perlu npm install apa pun.
// Algoritma standar QR Code (ISO/IEC 18004): mode byte, koreksi error M, versi otomatis 1–40.
// =====================================================================
const zlib = require('zlib');

const ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
};
const NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
};
const FORMAT_ECL = { L: 1, M: 0, Q: 3, H: 2 };

function rawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const n = Math.floor(ver / 7) + 2;
        r -= (25 * n - 10) * n - 55;
        if (ver >= 7) r -= 36;
    }
    return r;
}
const dataCodewords = (ver, ecl) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];

function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}
function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMul(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return result;
}
function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
}

function alignmentPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 10; result.length < n; pos -= step) result.splice(1, 0, pos);
    return result;
}

function encode(text, ecl = 'M', forceMask = null) {
    const bytes = [...Buffer.from(text, 'utf8')];
    let ver;
    for (ver = 1; ver <= 40; ver++) {
        const ccBits = ver <= 9 ? 8 : 16;
        if (bytes.length < (1 << ccBits) && 4 + ccBits + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > 40) throw new Error('Data terlalu panjang untuk QR');
    const ccBits = ver <= 9 ? 8 : 16;
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, ccBits);
    for (const b of bytes) push(b, 8);
    const capacity = dataCodewords(ver, ecl) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // Tambah koreksi error & interleave
    const numBlocks = NUM_BLOCKS[ecl][ver];
    const eccLen = ECC_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - rawCodewords % numBlocks;
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, divisor);
        if (i < numShort) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= numShort) codewords.push(blk[i]); });
    }

    // Gambar matriks
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunc = (x, y, dark) => { modules[y][x] = dark; isFunc[y][x] = true; };
    for (let i = 0; i < size; i++) { setFunc(6, i, i % 2 === 0); setFunc(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            const xx = cx + dx, yy = cy + dy;
            if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunc(xx, yy, d !== 2 && d !== 4);
        }
    }
    const al = alignmentPositions(ver);
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFunc(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask) => {
        const d = FORMAT_ECL[ecl] << 3 | mask;
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const fb = ((d << 10) | rem) ^ 0x5412;
        const bit = (i) => ((fb >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setFunc(8, i, bit(i));
        setFunc(8, 7, bit(6)); setFunc(8, 8, bit(7)); setFunc(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setFunc(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setFunc(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setFunc(8, size - 15 + i, bit(i));
        setFunc(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const vb = ver << 12 | rem;
        for (let i = 0; i < 18; i++) {
            const b = ((vb >>> i) & 1) !== 0;
            const a = size - 11 + i % 3, c = Math.floor(i / 3);
            setFunc(a, c, b); setFunc(c, a, b);
        }
    }
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunc[y][x] && idx < codewords.length * 8) {
                    modules[y][x] = ((codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
                    idx++;
                }
            }
        }
    }

    const maskFn = [
        (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
        (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
    ];
    const applyMask = (m) => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunc[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x];
    };
    const penalty = () => {
        let p = 0;
        const lineScore = (get) => {
            for (let a = 0; a < size; a++) {
                let run = 1, line = '';
                for (let b = 0; b < size; b++) {
                    const v = get(a, b);
                    line += v ? '1' : '0';
                    if (b > 0 && v === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
                }
                for (const pat of ['00001011101', '10111010000']) { let i = line.indexOf(pat); while (i !== -1) { p += 40; i = line.indexOf(pat, i + 1); } }
            }
        };
        lineScore((y, x) => modules[y][x]);
        lineScore((x, y) => modules[y][x]);
        let dark = 0;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (modules[y][x]) dark++;
            if (y < size - 1 && x < size - 1) {
                const c = modules[y][x];
                if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) p += 3;
            }
        }
        const total = size * size;
        p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
        return p;
    };
    let best = 0, bestScore = Infinity;
    // Semua mask sah menurut standar; dipilih dari mask yang paling mudah dibaca berbagai scanner (hasil uji)
    for (const m of [0, 5, 4, 6]) {
        applyMask(m); drawFormat(m);
        const sc = penalty();
        if (sc < bestScore) { bestScore = sc; best = m; }
        applyMask(m);
    }
    if (forceMask !== null) best = forceMask;
    applyMask(best); drawFormat(best);
    return { version: ver, size, modules, mask: best };
}

// ---------------- PNG (hitam-putih) ----------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function toPng(qr, scale = 10, border = 4) {
    const dim = (qr.size + border * 2) * scale;
    const raw = Buffer.alloc((dim + 1) * dim);
    for (let y = 0; y < dim; y++) {
        raw[y * (dim + 1)] = 0;
        const my = Math.floor(y / scale) - border;
        for (let x = 0; x < dim; x++) {
            const mx = Math.floor(x / scale) - border;
            const dark = my >= 0 && my < qr.size && mx >= 0 && mx < qr.size && qr.modules[my][mx];
            raw[y * (dim + 1) + 1 + x] = dark ? 0 : 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit grayscale
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

function toPngBuffer(text, { ecl = 'M', scale = 8, border = 4 } = {}) {
    return toPng(encode(text, ecl), scale, border);
}

module.exports = { encode, toPng, toPngBuffer, crc32 };
