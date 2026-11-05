// =====================================================================
// QRIS BERNOMINAL: QRIS statis VibeBlox + nominal invoice, DIPERIKSA ULANG sebelum dikirim.
// Kalau satu pemeriksaan saja gagal -> TIDAK dipakai (bot kembali ke gambar QRIS statis lama).
// =====================================================================

function parseTLV(str) {
    const out = [];
    let i = 0;
    while (i < str.length) {
        const tag = str.substr(i, 2);
        const len = parseInt(str.substr(i + 2, 2), 10);
        if (!/^\d{2}$/.test(tag) || isNaN(len) || i + 4 + len > str.length) throw new Error('Format QRIS rusak');
        out.push([tag, str.substr(i + 4, len)]);
        i += 4 + len;
    }
    return out;
}

function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (tag, value) => `${tag}${String(value.length).padStart(2, '0')}${value}`;

// QRIS statis -> QRIS dengan nominal (tag 54), CRC dihitung ulang
function buildDynamicQris(staticPayload, amount) {
    if (!Number.isInteger(amount) || amount <= 0 || amount > 99999999) throw new Error('Nominal tidak valid');
    if (crc16(staticPayload.slice(0, -4)) !== staticPayload.slice(-4)) throw new Error('CRC QRIS asli tidak valid');
    const tags = parseTLV(staticPayload).filter(([t]) => t !== '63' && t !== '54');
    let body = '';
    let inserted = false;
    for (const [t, v] of tags) {
        if (!inserted && Number(t) > 54) { body += tlv('54', String(amount)); inserted = true; }
        body += tlv(t, t === '01' ? '12' : v); // 12 = QR dinamis (sekali pakai per nominal)
    }
    if (!inserted) body += tlv('54', String(amount));
    body += '6304';
    return body + crc16(body);
}

// Pemeriksaan menyeluruh: CRC, nominal, merchant & NMID harus sama persis dengan QRIS asli
function verifyDynamicQris(dynamicPayload, staticPayload, amount, nmid, merchantName) {
    const problems = [];
    if (crc16(dynamicPayload.slice(0, -4)) !== dynamicPayload.slice(-4)) problems.push('CRC tidak cocok');
    let d, s;
    try { d = Object.fromEntries(parseTLV(dynamicPayload)); s = Object.fromEntries(parseTLV(staticPayload)); }
    catch (e) { return [e.message]; }
    if (d['54'] !== String(amount)) problems.push(`nominal ${d['54']} ≠ ${amount}`);
    for (const tag of ['26', '51', '52', '53', '58', '59', '60', '61']) {
        if ((s[tag] || null) !== (d[tag] || null)) problems.push(`tag ${tag} berubah`);
    }
    if (nmid && !(d['51'] || '').includes(nmid)) problems.push('NMID tidak cocok');
    if (merchantName && d['59'] !== merchantName) problems.push('nama merchant tidak cocok');
    if (d['01'] !== '12') problems.push('bukan QR dinamis');
    return problems;
}

// Gambar QR (tanpa library tambahan, lihat qrcode-lite.js — sudah diuji dibaca ulang oleh pembaca QR independen)
async function renderPng(payload) {
    const { toPngBuffer } = require('./qrcode-lite');
    return toPngBuffer(payload, { ecl: 'M', scale: 8, border: 4 });
}

async function makeQris(staticPayload, amount, nmid, merchantName) {
    const payload = buildDynamicQris(staticPayload, amount);
    const problems = verifyDynamicQris(payload, staticPayload, amount, nmid, merchantName);
    if (problems.length) throw new Error(`Pemeriksaan QRIS gagal: ${problems.join(', ')}`);
    const buffer = await renderPng(payload);
    return { payload, buffer };
}

module.exports = { parseTLV, crc16, buildDynamicQris, verifyDynamicQris, renderPng, makeQris };
