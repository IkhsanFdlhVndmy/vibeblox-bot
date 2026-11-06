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
    async function start() {
        const cur = await getWar();
        if (cur.active) {
            // sudah War: lanjutkan sesi yang sama (pesanan tetap dihitung), buka lagi kalau sebelumnya penuh
            const war = { ...cur, full: false };
            await core.setState('war', war);
            return { war, resumed: true };
        }
        const snap = await h.readyStockSnapshot();
        if (!snap) return { error: '❌ Saldo community belum bisa dibaca dari Roblox, jadi kapasitas War tidak bisa dihitung. Coba lagi sebentar.' };
        const war = { active: true, session: Date.now(), capacity: snap.sisa, full: false };
        // Tiket War sebelumnya yang MASIH BUKA & BELUM ada invoice-nya: Robux-nya masih dijanjikan ke pembeli,
        // tapi belum masuk "ter-invoice" -> ikut dihitung di War baru supaya tidak oversell.
        // (Yang sudah ada invoice-nya sudah terpotong lewat ter-invoice; yang sudah Done saldonya sudah berkurang.)
        const old = await WarReservation.find({ released: false, done: false, channelId: { $ne: null } }).lean();
        let carried = 0;
        for (const r of old) {
            if (!client.channels.cache.get(r.channelId)) continue;
            if (await h.hasActiveInvoice(r.channelId)) continue;
            await WarReservation.updateOne({ _id: r._id }, { $set: { session: war.session } });
            carried++;
        }
        war.carried = carried;
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

    // Sebelum kunci (jawaban cepat untuk yang telat saat sudah penuh)
    async function quickBlock() {
        const war = await getWar();
        return war.active && war.full ? FULL_MSG : null;
    }

    // DI DALAM kunci antrean tiket. Return pesan tolak, atau null (Robux sudah dipesan untuk tiket ini)
    async function reserve(interaction, mode) {
        if (mode && mode !== 'ketat') return null; // Normal / Pre-Order: tanpa batas stok
        const war = await getWar();
        if (!war.active) return null;
        if (war.full) return FULL_MSG;
        let raw = '';
        try { raw = interaction.fields.getTextInputValue('jml_robux'); } catch (e) { return null; }
        const robux = bayar.parseRobux(raw);
        if (!robux) return '❌ **Tiket tidak dibuat.** Jumlah Robux di form tidak terbaca. Tulis angkanya saja, contoh: `1000`.';
        const used = (await totals(war.session)).robux;
        const left = limitOf(war) - used;
        if (robux > left) {
            if (left <= 0) await markFull(war);
            return FULL_MSG;
        }
        await WarReservation.create({ key: interaction.id, session: war.session, userId: interaction.user.id, robux });
        interaction.__warKey = interaction.id;
        if (left - robux <= 0) await markFull(war);
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

    async function markFull(war) {
        const fresh = await getWar();
        if (!fresh.active || fresh.full || fresh.session !== war.session) return;
        await core.setState('war', { ...fresh, full: true, fullAt: Date.now() });
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
                ? `└ 🔴 **Penuh** — tombol Community ditutup${left > 0 ? ` · ada yang batal, sisa \`${fmt(left)}\` (buka: /buttonticket War)` : ''}`
                : `└ 🟢 Sisa: \`${fmt(left)} Robux\` · tutup otomatis saat stok sisa ${fmt(CFG.WAR_STOP_REMAINING)}`
        ];
    }

    return { getWar, start, stop, quickBlock, reserve, abort, attach, onDone, onChannelDelete, panelLines, FULL_MSG };
};
