// Alarm KESEHATAN BOT -> #alarm-bot (ping Owner & Handler). Memberi tahu owner kalau ada masalah di belakang layar
// (server / Discord / database / log) beserta PENYEBAB & apa yang perlu dilakukan. Semua ada jeda anti-spam.
const fs = require('fs');
const path = require('path');

module.exports = function setupKesehatan(ctx, core) {
    const { client } = ctx;
    const min = (ms) => Math.max(1, Math.round(ms / 60000));
    const recent = new Map(); // key -> [waktu kejadian] (untuk "X kali dalam Y menit")
    function count(key, windowMs) {
        const now = Date.now();
        const arr = (recent.get(key) || []).filter(t => now - t < windowMs);
        arr.push(now);
        recent.set(key, arr);
        return arr.length;
    }

    // ---------- Tiket ----------
    function ticketFailed(err) {
        const code = err?.code;
        let why;
        if (code === 50013) why = 'Bot **tidak punya izin** membuat channel di kategori tiket. Cek izin role bot di kategori tiket.';
        else if (code === 30013) why = 'Server Discord sudah mencapai **batas 500 channel**. Hapus channel/tiket lama.';
        else why = `Discord menolak/timeout setelah 3x percobaan (\`${String(err?.message || err).slice(0, 120)}\`). Biasanya Discord sedang gangguan.`;
        core.alarm('tiket_gagal', `⚠️ **Tiket pembeli gagal dibuat.** ${why}\n-# Pembeli diberi pesan "tiket sudah ditutup".`, 15 * 60 * 1000);
    }
    function categoriesFull() {
        core.alarm('kategori_penuh', '🚨 **Semua kategori tiket PENUH.** Pembeli tidak bisa membuka tiket baru (dapat pesan "sudah ditutup"). Tutup/hapus tiket lama yang sudah selesai.', 30 * 60 * 1000);
    }
    function lateReply() {
        const n = count('telat', 10 * 60 * 1000);
        if (n >= 3) core.alarm('telat', `🐢 **Bot telat menjawab ${n}x dalam 10 menit** (lebih dari 3 detik). Pembeli melihat "This interaction failed" & harus kirim ulang. Penyebab: server bot sedang lambat/berat.`, 60 * 60 * 1000);
    }

    // ---------- Database ----------
    function dbRecovered(downMs) {
        core.alarm('mongo_ok', `✅ **Database MongoDB tersambung lagi** (sambung ulang otomatis) setelah putus ±${min(downMs)} menit. Bot normal kembali.`, 0);
    }
    async function dbGivingUp() {
        await core.alarm('mongo_exit', '🔁 **Database MongoDB putus 15 menit & sambung ulang gagal.** Bot dimatikan & akan dinyalakan lagi oleh ketukan UptimeRobot (±5 menit). Kalau tetap putus, cek cluster & Network Access di cloud.mongodb.com.', 30 * 60 * 1000);
    }

    // ---------- Error di log ----------
    let lastErr = '';
    function processError(err) {
        lastErr = String(err?.stack || err?.message || err).split('\n').slice(0, 2).join(' ').slice(0, 300);
        const n = count('error', 10 * 60 * 1000);
        if (n >= 5) core.alarm('error', `⚠️ **Ada ${n} error tak tertangani dalam 10 menit** di log bot. Error terakhir:\n\`\`\`${lastErr}\`\`\`Kalau fitur terasa macet, restart bot & kirim log ke developer.`, 60 * 60 * 1000);
    }

    // ---------- Server (RAM & lambat) ----------
    let lagTick = Date.now();
    function serverCheck() {
        const rss = process.memoryUsage().rss / 1048576;
        if (rss > 215) core.alarm('ram', `🧠 **RAM bot ${Math.round(rss)} MB** (batas server 256 MB). Kalau penuh, server mematikan bot. Restart bot saat sepi (bukan saat War).`, 2 * 60 * 60 * 1000);
    }
    function lagCheck() {
        const now = Date.now();
        const lag = now - lagTick - 5000;
        lagTick = now;
        if (lag > 3000) {
            const n = count('lag', 10 * 60 * 1000);
            if (n >= 2) core.alarm('lag', `🐢 **Server bot sangat lambat** (tertahan ±${Math.round(lag / 1000)} detik, ${n}x dalam 10 menit). Tombol & form bisa telat dijawab. Biasanya server alwaysdata sedang berat.`, 60 * 60 * 1000);
        }
    }

    // ---------- Koneksi Discord ----------
    let discDownSince = null;
    function watchDiscord() {
        const down = () => { if (!discDownSince) discDownSince = Date.now(); };
        const up = () => {
            if (discDownSince && Date.now() - discDownSince > 2 * 60 * 1000) {
                core.alarm('discord_putus', `📡 **Bot sempat terputus dari Discord ±${min(Date.now() - discDownSince)} menit** dan sudah tersambung lagi. Selama itu bot tidak merespons (biasanya gangguan Discord/jaringan server).`, 30 * 60 * 1000);
            }
            discDownSince = null;
        };
        client.on('shardDisconnect', down);
        client.on('shardReconnecting', down);
        client.on('shardResume', up);
        client.on('shardReady', up);
    }

    // ---------- Bot sempat mati tanpa di-restart owner ----------
    // Detak tiap menit disimpan ke file. Restart lewat 🔄 (SIGTERM) dicatat "rapi"; kalau bot mati mendadak
    // (crash / RAM penuh / server) lalu nyala lagi, owner diberi tahu berapa lama bot mati.
    const BEAT = path.join(__dirname, '..', '.bot-heartbeat.json');
    let exitReason = null;
    function writeBeat(extra = {}) {
        try { fs.writeFileSync(BEAT, JSON.stringify({ at: Date.now(), ...extra })); } catch (e) { /* abaikan */ }
    }
    function markExit(reason) { exitReason = reason; writeBeat({ clean: reason === 'restart', reason }); }
    function checkLastRun() {
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(BEAT, 'utf8')); } catch (e) { /* pertama kali */ }
        writeBeat();
        if (!prev || prev.clean) return;
        const off = Date.now() - (prev.at || Date.now());
        if (prev.reason === 'db') return core.alarm('nyala_lagi', `🔄 **Bot menyala lagi** setelah mematikan diri karena database putus (mati ±${min(off)} menit).`, 0);
        if (off < 3 * 60 * 1000) return; // detak terakhir baru saja -> kemungkinan restart biasa
        core.alarm('nyala_lagi', `🔄 **Bot sempat MATI ±${min(off)} menit tanpa di-restart** (crash, RAM penuh, atau server alwaysdata) dan sekarang sudah menyala lagi lewat ketukan UptimeRobot.\n-# Cek log alwaysdata sekitar jam itu kalau ingin tahu penyebab pastinya.`, 0);
    }

    function start() {
        checkLastRun();
        setInterval(() => { if (!exitReason) writeBeat(); }, 60 * 1000);
        setInterval(serverCheck, 60 * 1000);
        lagTick = Date.now(); // hitung lambat mulai sekarang (bukan sejak bot dimuat)
        setInterval(lagCheck, 5000);
        watchDiscord();
        process.once('SIGTERM', () => { markExit('restart'); process.exit(0); }); // 🔄 di alwaysdata = restart rapi
    }

    return { start, ticketFailed, categoriesFull, lateReply, dbRecovered, dbGivingUp, processError, markExit };
};
