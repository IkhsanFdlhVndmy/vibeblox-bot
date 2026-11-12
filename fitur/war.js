// =====================================================================
// WAR COMMUNITY (mode "Ketat (War)" di /buttonticket)
// - Saat War dimulai: stok yang bisa dijual SAAT ITU dicatat sebagai kapasitas.
// - Setiap form tiket Community: Robux di form dipesan dulu (di dalam kunci antrean tiket -> aman walau
//   puluhan orang kirim form bersamaan). Kalau melebihi kapasitas (sisa minimal 5.000) -> tiket tidak dibuat.
// - Sisa kapasitas habis -> tombol Community ditutup otomatis.
// - Mode lain (Normal / Pre-Order) tidak dibatasi stok.
// =====================================================================
const CFG = require('./config');

module.exports = function setupWar(ctx, core, bayar) {
    const { client, h } = ctx;
    const { TicketConfig } = ctx.models;
    const WarReservation = require('../models/WarReservation');
    const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
    const FULL_MSG = '❌ **Tidak bisa open ticket karena sudah melebihi kapasitas stock.**\nPantau pengumuman restock berikutnya ya!';

    async function getWar() { return (await core.getState('war')) || { active: false }; }

    async function totals(session) {
        const rows = await WarReservation.find({ session, released: false }).select('robux').lean();
        return { robux: rows.reduce((t, r) => t + (r.robux || 0), 0), tickets: rows.length };
    }

    // /buttonticket community -> Ketat (War). Return { war } atau { error }
    // Hanya SATU proses "mulai War" dalam satu waktu (tombol /buttonticket, form pertama, & bot menyala bisa bersamaan)
    let startFlight = null;
    function start(opts = {}) {
        if (!startFlight) startFlight = doStart(opts).finally(() => { startFlight = null; });
        return startFlight;
    }
    // Saldo belum bisa dibaca -> coba terus di belakang (tiap 15 dtk, maks ±5 menit). Form yang masuk
    // selama itu tetap dicatat (sesi 0) dan ikut dihitung begitu War berjalan.
    let bgRetry = null;
    function startInBackground() {
        if (bgRetry) return;
        let n = 0;
        const tick = async () => {
            n++;
            const cfg = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' }).lean().catch(() => null);
            const cur = await getWar().catch(() => ({}));
            if (cfg?.communityMode !== 'ketat' || cur.active) { bgRetry = null; return; }
            const r = await start().catch(() => ({}));
            if (r.war || n >= 20) { bgRetry = null; return; }
            bgRetry = setTimeout(tick, 15000);
        };
        bgRetry = setTimeout(tick, 1000);
    }
    async function doStart(opts) {
        const cur = await getWar();
        if (cur.active) {
            // sudah War: lanjutkan sesi yang sama (pesanan tetap dihitung), buka lagi kalau sebelumnya penuh
            const war = { ...cur, full: false };
            await core.setState('war', war);
            return { war, resumed: true };
        }
        // fast: pakai saldo yang sudah tersimpan (diperbarui otomatis tiap 30 dtk) -> tombol TIDAK menunggu Roblox
        const snap = await h.readyStockSnapshot(!!opts.fast);
        if (!snap) {
            if (opts.fast) { startInBackground(); return { pending: true }; }
            return { error: '❌ Saldo community belum bisa dibaca dari Roblox, jadi kapasitas War tidak bisa dihitung. Coba lagi sebentar.' };
        }
        const war = { active: true, session: Date.now(), capacity: snap.sisa, full: false };
        // Tiket War sebelumnya yang MASIH BUKA & BELUM ada invoice-nya: Robux-nya masih dijanjikan ke pembeli,
        // tapi belum masuk "ter-invoice" -> ikut dihitung di War baru supaya tidak oversell.
        // (Yang sudah ada invoice-nya sudah terpotong lewat ter-invoice; yang sudah Done saldonya sudah berkurang.)
        const old = await WarReservation.find({ released: false, done: false }).lean();
        let carried = 0;
        for (const r of old) {
            if (!r.channelId) {
                // form yang masuk saat War sedang dimulai (sesi 0), tiketnya baru saja dibuat -> ikut dihitung
                if (r.session !== 0) continue;
            } else {
                if (!client.channels.cache.get(r.channelId)) continue;
                if (await h.hasActiveInvoice(r.channelId)) continue;
            }
            await WarReservation.updateOne({ _id: r._id }, { $set: { session: war.session } });
            carried++;
        }
        war.carried = carried;
        // Tiket lama yang masih buka sudah menghabiskan stok -> War langsung penuh (tombol ditutup setelah /buttonticket tersimpan)
        if (carried && limitOf(war) - (await totals(war.session)).robux <= 0) {
            war.full = true; war.fullAt = Date.now();
            setTimeout(() => { markFull(war, true).catch(() => {}); }, 3000);
        }
        await core.setState('war', war);
        h.schedulePanelStockUpdate();
        return { war };
    }
    async function stop() {
        const cur = await getWar();
        if (!cur.active) return;
        await core.setState('war', { ...cur, active: false, full: false, endedAt: Date.now() });
        h.schedulePanelStockUpdate();
    }

    const limitOf = (war) => war.capacity - CFG.WAR_STOP_REMAINING;

    // Sebelum masuk antrean: kalau War sudah penuh -> tolak langsung tanpa ikut antre
    async function quickBlock() {
        const war = await getWar();
        return war.active && war.full ? FULL_MSG : null;
    }

    // DI DALAM kunci antrean tiket. Return pesan tolak, atau null (Robux sudah dipesan untuk tiket ini)
    async function reserve(interaction, mode) {
        if (mode && mode !== 'ketat') return null; // Normal / Pre-Order: tanpa batas stok
        const war = await getWar();
        if (!war.active) {
            if (mode !== 'ketat') return null;
            // mode Ketat tapi sesi War belum ada -> mulai DI BELAKANG (baca saldo Roblox tidak boleh menahan antrean tiket).
            // Pesanan form ini tetap dicatat (sesi 0) dan otomatis ikut dihitung begitu War berjalan.
            let raw0 = '';
            try { raw0 = interaction.fields.getTextInputValue('jml_robux'); } catch (e) {}
            const r0 = bayar.parseRobux(raw0);
            if (r0) {
                await WarReservation.create({ key: interaction.id, session: 0, userId: interaction.user.id, robux: r0 });
                interaction.__warKey = interaction.id;
            }
            startInBackground();
            return null;
        }
        if (war.full) return FULL_MSG;
        // Form TIDAK ditolak karena jumlahnya: tiket langsung dibuat (VPS lambat, jangan bikin pembeli menunggu).
        // Begitu stok tersisa <= 5.000 (boleh sampai minus sedikit) -> tombol ditutup, form berikutnya ditolak.
        // Kelebihan pesanan ditutup manual oleh staf.
        let raw = '';
        try { raw = interaction.fields.getTextInputValue('jml_robux'); } catch (e) {}
        const robux = bayar.parseRobux(raw); // tidak terbaca -> 0 (tiket tetap dibuat, staf cek manual)
        const used = (await totals(war.session)).robux;
        await WarReservation.create({ key: interaction.id, session: war.session, userId: interaction.user.id, robux });
        interaction.__warKey = interaction.id;
        if (limitOf(war) - used - robux <= 0) {
            // tandai penuh SEKARANG (form berikutnya di antrean langsung ditolak),
            // urusan Discord (tutup tombol, info alarm) di belakang supaya antrean tidak tertahan
            await core.setState('war', { ...war, full: true, fullAt: Date.now() });
            markFull(war, true).catch(() => {});
        }
        h.schedulePanelStockUpdate();
        return null;
    }
    // Tiket batal dibuat setelah dipesan (kategori penuh / error Discord) -> kembalikan
    async function abort(interaction) {
        if (!interaction?.__warKey) return;
        await WarReservation.deleteOne({ key: interaction.__warKey }).catch(() => {});
        interaction.__warKey = null;
        h.schedulePanelStockUpdate();
    }
    async function attach(interaction, channelId) {
        if (!interaction?.__warKey) return;
        await WarReservation.updateOne({ key: interaction.__warKey }, { $set: { channelId } }).catch(() => {});
    }
    async function onDone(channelId) {
        const r = await WarReservation.updateMany({ channelId, released: false }, { $set: { done: true } }).catch(() => null);
        if (r?.modifiedCount) h.schedulePanelStockUpdate();
    }
    // Tiket ditutup tanpa ada Done -> pesanan dibatalkan, kapasitas kembali (tombol TIDAK dibuka otomatis)
    async function onChannelDelete(channelId) {
        const r = await WarReservation.updateMany({ channelId, done: false, released: false }, { $set: { released: true } }).catch(() => null);
        if (r?.modifiedCount) h.schedulePanelStockUpdate();
    }

    async function markFull(war, flagged = false) {
        const fresh = await getWar();
        if (!fresh.active || fresh.session !== war.session) return;
        if (fresh.full && !flagged) return;
        if (!fresh.full) await core.setState('war', { ...fresh, full: true, fullAt: Date.now() });
        try {
            const config = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' });
            if (config) { config.buttonStates.set('community', false); await config.save(); }
            await h.refreshTicketPanel();
        } catch (e) { console.error('[WAR] Gagal menutup tombol Community:', e.message); }
        core.sendTo(CFG.CHANNEL_ALARM, { content: `⚔️ **War Community penuh** — sisa stok tinggal ±${fmt(CFG.WAR_STOP_REMAINING)} Robux, tombol Community ditutup otomatis.\n-# Buka lagi dengan /buttonticket (mode apa pun).` }).catch(() => {});
        console.log('[WAR] Kapasitas penuh, tombol Community ditutup.');
    }

    // Baris ringkas untuk /panelstock
    async function panelLines() {
        const war = await getWar();
        if (!war.active) return [];
        const t = await totals(war.session);
        const left = limitOf(war) - t.robux;
        return [
            '',
            `⚔️ **War Community** · mulai <t:${Math.floor(war.session / 1000)}:R>`,
            `└ Stok awal: \`${fmt(war.capacity)}\` · Diisi form: \`${fmt(t.robux)}\` *(${t.tickets} tiket)*`,
            war.full || left <= 0
                ? `└ 🔴 **Penuh** — tombol Community ditutup · ${left < 0 ? `lebih \`${fmt(-left)}\` (tutup manual tiket berlebih)` : `sisa \`${fmt(left)}\` (buka lagi: /buttonticket War)`}`
                : `└ 🟢 Sisa: \`${fmt(left)} Robux\` · tutup otomatis saat stok sisa ${fmt(CFG.WAR_STOP_REMAINING)}`
        ];
    }

    // Saat bot menyala: kalau tombol Community sedang mode Ketat (War) tapi sesi War belum ada
    // (mis. mode Ketat sudah dipasang sebelum fitur War ada) -> War dimulai otomatis begitu saldo terbaca.
    function boot() {
        let tries = 0;
        const attempt = async () => {
            tries++;
            try {
                const cfg = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' }).lean();
                const war = await getWar();
                if (cfg?.communityMode !== 'ketat' || war.active) return;
                const r = await start();
                if (r.error) { if (tries < 20) setTimeout(attempt, 60 * 1000); return; }
                console.log(`[WAR] Mode Ketat aktif saat bot menyala -> War dimulai otomatis (stok awal ${fmt(r.war.capacity)}).`);
            } catch (e) { if (tries < 20) setTimeout(attempt, 60 * 1000); }
        };
        setTimeout(attempt, 20 * 1000);
    }

    return { getWar, start, stop, boot, quickBlock, reserve, abort, attach, onDone, onChannelDelete, panelLines, FULL_MSG };
};
