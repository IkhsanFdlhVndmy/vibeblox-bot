// =====================================================================
// PEMBAYARAN: kode unik, QRIS bernominal, draft invoice 1 klik, antrean "Sudah Bayar"
// =====================================================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const QR = require('./qris');

const TYPE_LABEL = { community: 'Community', gamepass_after: 'Gamepass After', gamepass_before: 'Gamepass Before', gig: 'GIG', vilog: 'Vilog', robux_plus: 'Robux Plus' };
const DRAFT_TYPE = { community: 'community', robux_plus: 'robux_plus', vilog: 'vilog', gamepass: 'gamepass_after', gig: 'gig' };
// Kata yang boleh diketik staf di kolom "Tipe" (huruf besar/kecil & spasi bebas)
const TYPE_ALIASES = {
    community: 'community', commun: 'community', komunitas: 'community', payout: 'community', c: 'community',
    robux_plus: 'robux_plus', plus: 'robux_plus', send: 'robux_plus', sendplus: 'robux_plus', send_plus: 'robux_plus', send_username: 'robux_plus', visend: 'robux_plus',
    vilog: 'vilog', login: 'vilog', via_login: 'vilog',
    gig: 'gig', gift: 'gig', gift_in_game: 'gig', giftingame: 'gig',
    gamepass_after: 'gamepass_after', gamepass: 'gamepass_after', gp: 'gamepass_after', after: 'gamepass_after', gp_after: 'gamepass_after', gamepassafter: 'gamepass_after',
    gamepass_before: 'gamepass_before', before: 'gamepass_before', gp_before: 'gamepass_before', gamepassbefore: 'gamepass_before'
};
const TYPE_HELP = 'community · plus · vilog · gig · gamepass (after) · before';
function parseType(raw) {
    const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return TYPE_ALIASES[key] || TYPE_ALIASES[key.replace(/_/g, '')] || null;
}
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|bmp)(\?|$)/i;

module.exports = function createPembayaran(ctx, core, riwayat, stok, eligible) {
    const { client, models, h } = ctx;
    const { InvoiceRecord, InvoiceDraft, RobuxRate, InvoiceTracker, Ticket } = models;
    const CFG = core.CFG;
    const fmt = core.fmt;

    // ---------------- Kode unik ----------------
    async function allocKode() {
        const used = new Set((await InvoiceRecord.find({ codeActive: true }).select('kodeUnik').lean()).map(r => r.kodeUnik));
        const ranges = [[CFG.KODE_UNIK_MIN, CFG.KODE_UNIK_MAX], [CFG.KODE_UNIK_MAX + 1, 299]];
        for (const [a, b] of ranges) {
            const free = [];
            for (let k = a; k <= b; k++) if (!used.has(k)) free.push(k);
            if (free.length) return free;
        }
        return [];
    }

    // Dipanggil saat invoice dibuat (ID pesan sudah diketahui). Return { kode, total }
    async function prepareInvoice({ messageId, channel, buyerId, type, robux, price }) {
        const base = { messageId, channelId: channel.id, buyerId, type, robux, price, total: price, kodeUnik: 0, codeActive: false, status: 'open' };
        if (core.isOn('kode_unik')) {
            for (let attempt = 0; attempt < 6; attempt++) {
                const free = await allocKode();
                if (!free.length) break;
                const kode = free[Math.floor(Math.random() * free.length)];
                try {
                    await InvoiceRecord.create({ ...base, kodeUnik: kode, total: price + kode, codeActive: true });
                    return { kode, total: price + kode };
                } catch (e) {
                    if (e?.code !== 11000) { console.error('[BAYAR] Gagal simpan kode unik:', e.message); break; }
                    // bentrok dengan invoice lain yang dibuat bersamaan -> coba kode lain
                }
            }
        }
        try { await InvoiceRecord.create(base); } catch (e) { if (e?.code !== 11000) console.error('[BAYAR] Gagal simpan data invoice:', e.message); }
        return { kode: 0, total: price };
    }
    function applyKodeToEmbed(embed, price, kode) {
        if (!kode) return embed;
        // PENTING: isi field "Total Bayar" harus tetap 1 angka saja (dibaca ulang oleh tombol QRIS & Done)
        const total = price + kode;
        const fields = [];
        for (const f of embed.data.fields || []) {
            if (f.name.includes('Perhitungan')) {
                // hitungan dibuat jelas sampai ke angka akhir, supaya pembeli tidak bingung kenapa ada tambahan
                fields.push({ name: f.name, value: `${f.value} = Rp ${fmt(price)}\n+ Rp ${fmt(kode)} *(angka penanda pembayaranmu)*`, inline: f.inline });
            } else if (f.name.includes('Total Bayar')) {
                fields.push({ name: f.name, value: `**Rp ${fmt(total)}**`, inline: f.inline });
                fields.push({ name: '📌 Penting', value: `Transfer **tepat Rp ${fmt(total)}** ya (jangan dibulatkan), supaya pembayaranmu langsung dikenali admin 🙏`, inline: false });
            } else fields.push(f);
        }
        embed.setFields(fields);
        return embed;
    }
    async function closeRecord(messageId, status) {
        const rec = await InvoiceRecord.findOneAndUpdate(
            { messageId, status: { $in: ['open', 'waiting'] } },
            { $set: { status, codeActive: false, closedAt: new Date() } },
            { new: false }
        ).lean().catch(() => null);
        if (rec?.status === 'waiting') scheduleVerifPanel();
        return rec;
    }
    const onInvoiceDone = (messageId) => closeRecord(messageId, 'done');
    const onInvoiceCancelled = async (messageId) => { const r = await closeRecord(messageId, 'cancelled'); if (r) core.stat('invoice_batal'); return r; };
    async function getRecord(messageId) { return InvoiceRecord.findOne({ messageId }).lean().catch(() => null); }

    // ---------------- Setelah invoice utama berhasil dibuat ----------------
    async function afterMainInvoice({ channel, messageId, type, robux }) {
        markDraftUsed(channel.id).catch(() => {});
        core.stat('invoice_dibuat');
        if (type === 'community') return stok.invoiceStockWarning(channel, robux);
        return null;
    }

    // ---------------- QRIS bernominal ----------------
    function totalFromEmbed(embed) {
        const f = (embed?.fields || []).find(x => x.name.includes('Total Bayar') || x.name.includes('Total Harga'));
        if (!f) return 0;
        const firstLine = String(f.value).split('\n')[0];
        return parseInt(firstLine.replace(/[^\d]/g, ''), 10) || 0;
    }
    async function buildQrisPayment(invoiceMessage) {
        if (!core.isOn('qris_otomatis')) return null;
        try {
            const amount = totalFromEmbed(invoiceMessage.embeds?.[0]);
            if (!amount) return null;
            const rec = await getRecord(invoiceMessage.id);
            if (rec && rec.total && rec.total !== amount) {
                console.error(`[QRIS] Nominal invoice (${amount}) beda dengan data (${rec.total}) -> pakai QRIS statis`);
                return null;
            }
            const { buffer } = await QR.makeQris(CFG.QRIS_PAYLOAD, amount, CFG.QRIS_NMID, CFG.QRIS_MERCHANT_NAME);
            const name = `qris-vibeblox-${amount}.png`;
            const embed = new EmbedBuilder().setColor(0x4F4580).setTitle('💳 Pembayaran QRIS VibeBlox')
                .setDescription(`Scan QRIS di bawah ini. **Nominal sudah terisi otomatis:**\n# Rp ${fmt(amount)}\nSebelum bayar, pastikan di aplikasimu tertulis penerima **${CFG.QRIS_MERCHANT_NAME}** dan nominal **Rp ${fmt(amount)}**.`)
                .setImage(`attachment://${name}`)
                .setFooter({ text: `VibeBlox Payment · NMID ${CFG.QRIS_NMID}` })
                .setTimestamp();
            return { embeds: [embed], files: [new AttachmentBuilder(buffer, { name })] };
        } catch (e) {
            console.error('[QRIS] QRIS otomatis gagal, pakai QRIS statis:', e.message);
            return null;
        }
    }
    async function qrisTest(interaction) {
        const amount = interaction.options.getInteger('nominal');
        try {
            const { buffer, payload } = await QR.makeQris(CFG.QRIS_PAYLOAD, amount, CFG.QRIS_NMID, CFG.QRIS_MERCHANT_NAME);
            const name = `qris-tes-${amount}.png`;
            const embed = new EmbedBuilder().setColor(0xFEE75C).setTitle('🧪 QRIS Tes (hanya terlihat olehmu)')
                .setDescription(`Nominal: **Rp ${fmt(amount)}**\nScan dengan aplikasi e-wallet/m-banking. Pastikan penerima **${CFG.QRIS_MERCHANT_NAME}** & nominal sama, bayar, lalu cek uangnya masuk di Dana Bisnis.\n\nSetelah berhasil, aktifkan dengan \`/pengaturan fitur:QRIS bernominal otomatis status:ON\`.\n-# Pemeriksaan otomatis: CRC ✅ · nominal ✅ · merchant & NMID ✅ · baca ulang gambar ✅\n-# Kode: \`${payload.slice(0, 40)}…\``)
                .setImage(`attachment://${name}`);
            return interaction.reply({ embeds: [embed], files: [new AttachmentBuilder(buffer, { name })], flags: MessageFlags.Ephemeral });
        } catch (e) {
            return interaction.reply({ content: `❌ QRIS tes gagal dibuat: ${e.message}`, flags: MessageFlags.Ephemeral });
        }
    }

    // ---------------- Antrean "Sudah Bayar" ----------------
    function isImage(att) {
        return (att.contentType || '').startsWith('image/') || IMAGE_EXT.test(att.name || '') || IMAGE_EXT.test(att.url || '');
    }
    let newProofCount = 0;
    async function markWaiting(rec, message) {
        const upd = await InvoiceRecord.findOneAndUpdate(
            { _id: rec._id, status: 'open' },
            { $set: { status: 'waiting', proofAt: message.createdAt, proofMessageId: message.id, proofUrl: message.url } },
            { new: true }
        ).lean();
        if (!upd) return false;
        const ch = message.channel;
        try {
            const inv = await ch.messages.fetch(rec.messageId);
            if (inv?.embeds?.[0] && !/^✅/.test(inv.embeds[0].footer?.text || '')) {
                await inv.edit({ embeds: [EmbedBuilder.from(inv.embeds[0]).setColor(0xFEE75C).setFooter({ text: '🟡 Menunggu Verifikasi Pembayaran • VibeBlox Invoice' })] });
            }
        } catch (e) { /* tampilan saja */ }
        return true;
    }
    async function onTicketMessage(message) {
        if (!core.isOn('antrean_bayar') || !message.guild || message.author?.bot) return;
        if (!h.TICKET_CATEGORY_IDS.includes(message.channel?.parentId)) return;
        const images = [...(message.attachments?.values?.() || [])].filter(isImage);
        if (!images.length) return;
        if (core.isStaff(message.member)) return;
        const open = await InvoiceRecord.find({ channelId: message.channel.id, status: 'open' }).lean();
        if (!open.length) {
            const cancelled = await InvoiceRecord.findOne({ channelId: message.channel.id, status: 'cancelled', closedAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }).lean();
            if (cancelled) {
                core.sendTo(CFG.CHANNEL_VERIFIKASI, { content: `⚠️ Ada gambar (kemungkinan bukti bayar) di <#${message.channel.id}> untuk invoice yang **sudah dibatalkan** (Rp ${fmt(cancelled.total)}). Mohon dicek. ${message.url}` }).catch(() => {});
            }
            return;
        }
        let changed = false;
        for (const rec of open) if (await markWaiting(rec, message)) changed = true;
        if (changed) {
            newProofCount++;
            core.stat('bukti_bayar');
            scheduleVerifPanel();
        }
    }

    let panelTimer = null;
    function scheduleVerifPanel() {
        if (panelTimer) clearTimeout(panelTimer);
        panelTimer = setTimeout(() => { panelTimer = null; rebuildVerifPanel().catch(e => console.error('[BAYAR] Panel verifikasi gagal:', e.message)); }, 3000);
    }
    let panelBusy = false;
    async function rebuildVerifPanel() {
        if (panelBusy) { scheduleVerifPanel(); return; }
        panelBusy = true;
        try {
            const waiting = await InvoiceRecord.find({ status: 'waiting' }).sort({ proofAt: 1 }).lean();
            const lines = waiting.map((r, i) => `**${i + 1}.** <#${r.channelId}> · **Rp ${fmt(r.total)}**\n└ ${r.kodeUnik ? `kode ${r.kodeUnik} · ` : ''}<@${r.buyerId}> · <t:${core.ts(r.proofAt)}:R> · [bukti](${r.proofUrl})`);
            let desc = '';
            let shown = 0;
            for (const l of lines) { if (desc.length + l.length + 2 > 3900) break; desc += (desc ? '\n\n' : '') + l; shown++; }
            if (shown < lines.length) desc += `\n…dan ${lines.length - shown} lainnya`;
            const embed = new EmbedBuilder().setColor(waiting.length ? 0xFEE75C : 0x57F287)
                .setTitle(`🟡 Menunggu Verifikasi Pembayaran (${waiting.length})`)
                .setDescription(desc || '✅ Tidak ada pembayaran yang menunggu verifikasi.')
                .setFooter({ text: 'Urut dari yang bayar paling dulu · otomatis hilang setelah invoice Done / dibatalkan' })
                .setTimestamp();
            const state = await core.getState('verif_panel');
            const ch = await client.channels.fetch(CFG.CHANNEL_VERIFIKASI).catch(() => null);
            if (!ch) return;
            let ok = false;
            if (state?.messageId) {
                try { await ch.messages.edit(state.messageId, { embeds: [embed] }); ok = true; }
                catch (e) { if (e?.code !== 10008) throw e; }
            }
            if (!ok) {
                const m = await ch.send({ embeds: [embed] });
                await core.setState('verif_panel', { messageId: m.id });
            }
        } finally { panelBusy = false; }
    }
    async function flushPing() {
        if (!newProofCount) return;
        const n = newProofCount; newProofCount = 0;
        try {
            const prev = await core.getState('verif_ping');
            const ch = await client.channels.fetch(CFG.CHANNEL_VERIFIKASI).catch(() => null);
            if (!ch) return;
            if (prev?.messageId) await ch.messages.delete(prev.messageId).catch(() => {});
            const m = await ch.send({ content: `${CFG.PING_ROLES.map(r => `<@&${r}>`).join(' ')} 🟡 **${n} pembayaran baru** menunggu verifikasi (lihat daftar di atas).`, allowedMentions: { roles: CFG.PING_ROLES } });
            await core.setState('verif_ping', { messageId: m.id });
        } catch (e) { console.error('[BAYAR] Gagal kirim ping verifikasi:', e.message); }
    }
    async function waitingAlarm() {
        const old = await InvoiceRecord.find({ status: 'waiting', proofAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) } }).lean().catch(() => []);
        if (old.length) core.alarm('verif_lama', `⏰ **${old.length} pembayaran** menunggu verifikasi lebih dari 15 menit. Cek <#${CFG.CHANNEL_VERIFIKASI}>.`, 30 * 60 * 1000);
    }

    // Saat bot nyala: cari bukti bayar yang dikirim selama bot mati
    async function catchUpProofs() {
        if (!core.isOn('antrean_bayar')) return;
        const open = await InvoiceRecord.find({ status: 'open', messageId: { $not: /^tmp:/ } }).lean().catch(() => []);
        let found = 0;
        for (const rec of open) {
            try {
                const ch = await client.channels.fetch(rec.channelId).catch(() => null);
                if (!ch) continue;
                const msgs = await ch.messages.fetch({ after: rec.messageId, limit: 50, cache: false });
                const sorted = [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                for (const m of sorted) {
                    if (m.author.bot || ![...m.attachments.values()].some(isImage)) continue;
                    const member = m.member || await ch.guild.members.fetch(m.author.id).catch(() => null);
                    if (core.isStaff(member)) continue;
                    if (await markWaiting(rec, m)) { found++; break; }
                }
                await new Promise(r => setTimeout(r, 800));
            } catch (e) { /* lanjut tiket lain */ }
        }
        if (found) { newProofCount += found; scheduleVerifPanel(); console.log(`✅ [BAYAR] ${found} bukti bayar susulan masuk antrean.`); }
    }
    // Bersihkan data invoice yang pesannya sudah hilang (dihapus saat bot mati)
    async function cleanupStale() {
        const list = await InvoiceRecord.find({ status: { $in: ['open', 'waiting'] }, updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }).limit(50).lean().catch(() => []);
        for (const rec of list) {
            if (rec.messageId.startsWith('tmp:')) { await closeRecord(rec.messageId, 'cancelled'); continue; }
            let gone = false;
            const ch = await client.channels.fetch(rec.channelId).catch(e => { if (e?.code === 10003) gone = true; return null; });
            if (ch) await ch.messages.fetch(rec.messageId).catch(e => { if (e?.code === 10008) gone = true; });
            if (gone) await closeRecord(rec.messageId, 'cancelled');
            else await InvoiceRecord.updateOne({ _id: rec._id }, { $set: { updatedAt: new Date() } }).catch(() => {});
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // ---------------- Draft invoice ----------------
    async function priceFor(type, robux, customTotal) {
        if (!TYPE_LABEL[type]) return { error: `Tipe \`${type}\` tidak dikenal.` };
        if (!Number.isInteger(robux) || robux <= 0) return { error: 'Jumlah Robux belum valid.' };
        const rateData = await RobuxRate.findOne({ type }).lean();
        if (!rateData) return { error: 'Rate untuk tipe ini belum diatur.' };
        if (type === 'vilog' && robux % 500 !== 0) return { error: 'Untuk Vilog, jumlah Robux harus kelipatan 500.' };
        let price, detail;
        if (type === 'vilog') { const k = robux / 500; price = k * rateData.rate; detail = `${k}x Rp ${fmt(rateData.rate)} (per 500 Robux)`; }
        else { price = rateData.rate * robux; detail = `Rp ${fmt(rateData.rate)} × ${fmt(robux)} Robux`; }
        if (customTotal && customTotal > 0) { price = customTotal; detail = `Harga khusus (diatur staf): Rp ${fmt(customTotal)}`; }
        return { price, detail };
    }
    function parseRobux(raw) {
        const s = String(raw || '').toLowerCase().replace(/\s/g, '');
        const k = s.match(/^(\d+(?:[.,]\d+)?)k$/);
        if (k) return Math.round(parseFloat(k[1].replace(',', '.')) * 1000);
        const n = parseInt(s.replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) ? n : 0;
    }
    async function draftPayload(draft) {
        const p = await priceFor(draft.type, draft.robux, draft.customTotal);
        const embed = new EmbedBuilder().setColor(0x99AAB5).setTitle('📝 Draft Pesanan (belum ditagih)') // JANGAN pakai kata "invoice" di judul: auto-close menganggap judul ber-"invoice" sebagai tagihan aktif
            .addFields(
                { name: '👤 Pembeli', value: `<@${draft.buyerId}>`, inline: true },
                { name: '📦 Tipe', value: `**${TYPE_LABEL[draft.type] || draft.type}**`, inline: true },
                { name: '💎 Jumlah Robux', value: `**${fmt(draft.robux)} R$**`, inline: true },
                { name: '📝 Perhitungan', value: p.error ? `⚠️ ${p.error}` : p.detail, inline: false },
                { name: '💰 Perkiraan Total', value: p.error ? '-' : `**Rp ${fmt(p.price)}**${core.isOn('kode_unik') ? ' + kode unik' : ''}`, inline: false }
            )
            .setFooter({ text: 'Staf mengecek pesanan dulu, lalu invoice dikirim. Belum perlu bayar.' });
        if (draft.used) {
            embed.setColor(0x57F287).setTitle('📝 Draft Pesanan — ✅ sudah ditagih');
            return { embeds: [embed], components: [] };
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vx_dr_ok_${draft.channelId}`).setLabel('✅ Buat Invoice').setStyle(ButtonStyle.Success).setDisabled(!!p.error),
            new ButtonBuilder().setCustomId(`vx_dr_edit_${draft.channelId}`).setLabel('✏️ Ubah (Staf)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`vx_dr_buyer_${draft.channelId}`).setLabel('📝 Ubah Pesanan').setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [row] };
    }
    async function refreshDraftMessage(draft, channel) {
        if (!draft?.messageId) return;
        const ch = channel || await client.channels.fetch(draft.channelId).catch(() => null);
        if (!ch) return;
        await ch.messages.edit(draft.messageId, await draftPayload(draft)).catch(() => {});
    }
    async function createDraft(channel, interaction, ticketType) {
        if (!core.isOn('draft_invoice')) return;
        const type = DRAFT_TYPE[ticketType];
        if (!type) return;
        let robux = 0;
        try { robux = parseRobux(interaction.fields.getTextInputValue('jml_robux')); } catch (e) {}
        try {
            const draft = await InvoiceDraft.findOneAndUpdate(
                { channelId: channel.id },
                { $setOnInsert: { channelId: channel.id, buyerId: interaction.user.id, type, robux, used: false } },
                { upsert: true, new: true }
            ).lean();
            if (!draft || draft.messageId) return;
            const sent = await h.discordRetry(async () => channel.send(await draftPayload(draft)));
            await InvoiceDraft.updateOne({ channelId: channel.id }, { $set: { messageId: sent.id } });
        } catch (e) { console.error('[DRAFT] Gagal membuat draft invoice:', e.message); }
    }
    async function markDraftUsed(channelId, by = null) {
        const d = await InvoiceDraft.findOneAndUpdate({ channelId, used: false }, { $set: { used: true, usedBy: by } }, { new: true }).lean();
        if (d) await refreshDraftMessage(d);
    }

    // Membuat invoice dari draft (SAMA dengan /invoice: tampilan, tombol, panel stock, tag pembeli)
    async function createInvoiceFromDraft(interaction, draft) {
        const channel = interaction.channel;
        const p = await priceFor(draft.type, draft.robux, draft.customTotal);
        if (p.error) return { error: p.error };
        if (channel.name.endsWith('-done')) channel.setName(channel.name.replace('-done', '')).catch(() => {});

        const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('🧾 Invoice VibeBlox')
            .addFields(
                { name: '👤 Pembeli', value: `<@${draft.buyerId}>`, inline: true },
                { name: '📦 Tipe', value: `**${TYPE_LABEL[draft.type]}**`, inline: true },
                { name: '<:robux:1497884445494087752> Jumlah Robux', value: `**${fmt(draft.robux)} R$**`, inline: true },
                { name: '📝 Perhitungan', value: p.detail, inline: false },
                { name: '💰 Total Bayar', value: `**Rp ${fmt(p.price)}**`, inline: false }
            )
            .setFooter({ text: '⏳ Belum Selesai • VibeBlox Invoice' })
            .setTimestamp();

        const msg = await h.discordRetry(() => channel.send({ embeds: [embed] }));
        const pay = await prepareInvoice({ messageId: msg.id, channel, buyerId: draft.buyerId, type: draft.type, robux: draft.robux, price: p.price });
        applyKodeToEmbed(embed, p.price, pay.kode);
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inv_bca_${msg.id}`).setLabel('BCA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_qris_${msg.id}`).setLabel('QRIS').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_dana_${msg.id}`).setLabel('DANA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_gopay_${msg.id}`).setLabel('GOPAY').setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inv_cancel_${msg.id}`).setLabel('❌ Close').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`inv_done_${draft.type}_${msg.id}`).setLabel('✅ Done').setStyle(ButtonStyle.Success)
        );
        try {
            await h.discordRetry(() => msg.edit({ embeds: [embed], components: [row1, row2] }));
        } catch (e) {
            await msg.delete().catch(() => {});
            await closeRecord(msg.id, 'cancelled');
            return { error: 'Gangguan koneksi Discord, invoice dibatalkan. Coba lagi.' };
        }
        h.autoCloseDisarm(channel.id, 'ada invoice baru').catch(() => {});
        channel.send({
            content: `🔔 <@${draft.buyerId}> invoice kamu sudah dibuat! Silakan cek detail di atas & lakukan pembayaran sesuai **Total Bayar**.`,
            reply: { messageReference: msg.id, failIfNotExists: false },
            allowedMentions: { users: [draft.buyerId], repliedUser: false }
        }).catch(() => {});
        if (draft.type === 'community') {
            try {
                await InvoiceTracker.create({ messageId: msg.id, channelId: channel.id, channelName: channel.name, amount: draft.robux, createdBy: interaction.user.id });
                h.schedulePanelStockUpdate();
            } catch (e) { console.error('[DRAFT] Gagal catat InvoiceTracker:', e.message); }
        }
        core.stat('invoice_dibuat');
        const warning = draft.type === 'community' ? await stok.invoiceStockWarning(channel, draft.robux) : null;
        return { ok: true, messageId: msg.id, warning };
    }

    async function handleDraftButton(interaction) {
        const parts = interaction.customId.split('_'); // vx_dr_<aksi>_<channelId>
        const action = parts[2];
        const channelId = parts[3];
        const draft = await InvoiceDraft.findOne({ channelId }).lean();
        if (!draft) return interaction.reply({ content: '❌ Draft tidak ditemukan.', flags: MessageFlags.Ephemeral });
        if (draft.used) return interaction.reply({ content: '✅ Invoice untuk draft ini sudah dibuat.', flags: MessageFlags.Ephemeral });

        if (action === 'ok') {
            if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Hanya Owner dan Handler yang bisa membuat invoice.', flags: MessageFlags.Ephemeral });
            const claimed = await InvoiceDraft.findOneAndUpdate({ channelId, used: false }, { $set: { used: true, usedBy: interaction.user.id } }, { new: true }).lean();
            if (!claimed) return interaction.reply({ content: '✅ Invoice sudah dibuat oleh staf lain.', flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            let res;
            try { res = await createInvoiceFromDraft(interaction, claimed); }
            catch (e) { res = { error: e.message }; }
            if (res.error) {
                await InvoiceDraft.updateOne({ channelId }, { $set: { used: false, usedBy: null } });
                return interaction.editReply({ content: `❌ ${res.error}` });
            }
            await refreshDraftMessage(claimed, interaction.channel);
            return interaction.editReply({ content: `✅ Invoice dibuat.${res.warning ? `\n\n${res.warning}` : ''}` });
        }
        if (action === 'edit') {
            if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner dan Handler.', flags: MessageFlags.Ephemeral });
            const modal = new ModalBuilder().setCustomId(`vx_drm_${channelId}`).setTitle('Ubah Draft Pesanan');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tipe').setLabel('Tipe (community/plus/vilog/gig/gamepass)').setStyle(TextInputStyle.Short).setRequired(true).setValue(draft.type).setPlaceholder(TYPE_HELP)),
                new ActionRowBuilder().addComponents((() => { const t = new TextInputBuilder().setCustomId('jumlah').setLabel('Jumlah Robux').setStyle(TextInputStyle.Short).setRequired(true); if (draft.robux) t.setValue(String(draft.robux)); return t; })()),
                new ActionRowBuilder().addComponents((() => { const t = new TextInputBuilder().setCustomId('harga').setLabel('Harga total khusus (kosong = pakai rate)').setStyle(TextInputStyle.Short).setRequired(false); if (draft.customTotal) t.setValue(String(draft.customTotal)); return t; })())
            );
            return interaction.showModal(modal);
        }
        if (action === 'buyer') {
            const ticket = await Ticket.findOne({ channelId }).lean();
            const isOwner = ticket?.creatorId === interaction.user.id;
            if (!isOwner && !core.isStaff(interaction.member)) return interaction.reply({ content: '❌ Hanya pembuat tiket yang bisa mengubah pesanan.', flags: MessageFlags.Ephemeral });
            const modal = new ModalBuilder().setCustomId(`vx_drb_${channelId}`).setTitle('Ubah Pesanan');
            const rows = [];
            if (['community', 'robux_plus', 'vilog', 'gig'].includes(ticket?.ticketType)) {
                const input = new TextInputBuilder().setCustomId('username').setLabel('Username Roblox').setStyle(TextInputStyle.Short).setRequired(true);
                if (ticket.robloxUsername) input.setValue(ticket.robloxUsername);
                rows.push(new ActionRowBuilder().addComponents(input));
            }
            const jml = new TextInputBuilder().setCustomId('jumlah').setLabel('Jumlah Robux').setStyle(TextInputStyle.Short).setRequired(true);
            if (draft.robux) jml.setValue(String(draft.robux));
            rows.push(new ActionRowBuilder().addComponents(jml));
            modal.addComponents(...rows);
            return interaction.showModal(modal);
        }
        return interaction.reply({ content: '❌ Aksi tidak dikenal.', flags: MessageFlags.Ephemeral });
    }

    async function handleDraftModal(interaction) {
        const isStaffModal = interaction.customId.startsWith('vx_drm_');
        const channelId = interaction.customId.slice(7);
        const draft = await InvoiceDraft.findOne({ channelId }).lean();
        if (!draft || draft.used) return interaction.reply({ content: '❌ Draft sudah tidak bisa diubah (invoice sudah dibuat).', flags: MessageFlags.Ephemeral });
        const robux = parseRobux(interaction.fields.getTextInputValue('jumlah'));
        if (!robux) return interaction.reply({ content: '❌ Jumlah Robux tidak valid.', flags: MessageFlags.Ephemeral });

        if (isStaffModal) {
            if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner dan Handler.', flags: MessageFlags.Ephemeral });
            const type = parseType(interaction.fields.getTextInputValue('tipe'));
            if (!type) return interaction.reply({ content: '❌ Tipe tidak dikenal. Ketik salah satu:\n• `community`\n• `plus` (Robux Send Username)\n• `vilog`\n• `gig` (Gift In-Game)\n• `gamepass` atau `after` (Gamepass After)\n• `before` (Gamepass Before)', flags: MessageFlags.Ephemeral });
            const hargaRaw = interaction.fields.getTextInputValue('harga') || '';
            const customTotal = hargaRaw.trim() ? parseInt(hargaRaw.replace(/[^\d]/g, ''), 10) || null : null;
            const updated = await InvoiceDraft.findOneAndUpdate({ channelId, used: false }, { $set: { type, robux, customTotal } }, { new: true }).lean();
            if (!updated) return interaction.reply({ content: '❌ Draft sudah dipakai.', flags: MessageFlags.Ephemeral });
            await refreshDraftMessage(updated, interaction.channel);
            return interaction.reply({ content: '✅ Draft diperbarui.', flags: MessageFlags.Ephemeral });
        }

        // Pembeli mengubah pesanan sendiri (hanya selama invoice belum dibuat)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ticket = await Ticket.findOne({ channelId });
        let newUsername = null;
        try { newUsername = interaction.fields.getTextInputValue('username').trim(); } catch (e) {}
        if (newUsername && ticket) {
            const normName = eligible.norm(newUsername);
            if (ticket.ticketType === 'community' && core.isOn('batas_username') && normName !== ticket.robloxUsername) {
                const other = await Ticket.findOne({ ticketType: 'community', robloxUsername: normName, channelId: { $ne: channelId } }).lean();
                if (other) return interaction.editReply({ content: `❌ Username \`${newUsername}\` sudah punya tiket Community aktif: <#${other.channelId}>.` });
            }
            ticket.robloxUsername = normName;
            await ticket.save();
        }
        const updated = await InvoiceDraft.findOneAndUpdate({ channelId, used: false }, { $set: { robux } }, { new: true }).lean();
        if (!updated) return interaction.editReply({ content: '❌ Invoice sudah dibuat, hubungi staf untuk perubahan.' });
        await updateFormFields(interaction.channel, newUsername, robux);
        await refreshDraftMessage(updated, interaction.channel);
        if (newUsername && ticket?.ticketType === 'community') eligible.postEligibility(interaction.channel, { username: newUsername }).catch(() => {});
        return interaction.editReply({ content: '✅ Pesanan diperbarui. Staf akan mengecek sebelum invoice dibuat.' });
    }

    async function updateFormFields(channel, username, robux) {
        try {
            const messages = await channel.messages.fetch({ limit: 5, after: channel.id });
            const formMsg = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith('🎫 Order Tiket'));
            if (!formMsg) return;
            const fields = formMsg.embeds[0].fields.map(f => {
                if (username && f.name.includes('Username Roblox')) return { name: f.name, value: `\`${username}\``, inline: f.inline };
                if (robux && f.name.includes('Jumlah Robux')) return { name: f.name, value: `**${robux} R$**`, inline: f.inline };
                return f;
            });
            await formMsg.edit({ embeds: [EmbedBuilder.from(formMsg.embeds[0]).setFields(fields)] });
        } catch (e) { /* tampilan saja */ }
    }

    // Dipanggil setelah /editform berhasil
    async function onFormEdited(channel, { username, robux }) {
        try {
            if (username) {
                const ticket = await Ticket.findOne({ channelId: channel.id });
                if (ticket) { ticket.robloxUsername = eligible.norm(username); await ticket.save(); }
                if (ticket?.ticketType === 'community') eligible.postEligibility(channel, { username }).catch(() => {});
            }
            if (robux) {
                const d = await InvoiceDraft.findOneAndUpdate({ channelId: channel.id, used: false }, { $set: { robux } }, { new: true }).lean();
                if (d) await refreshDraftMessage(d, channel);
            }
        } catch (e) { console.error('[DRAFT] Sinkron editform gagal:', e.message); }
    }

    async function onChannelDelete(channelId) {
        const res = await InvoiceRecord.updateMany({ channelId, status: { $in: ['open', 'waiting'] } }, { $set: { status: 'cancelled', codeActive: false, closedAt: new Date() } }).catch(() => null);
        await InvoiceDraft.deleteOne({ channelId }).catch(() => {});
        if (res?.modifiedCount) scheduleVerifPanel();
    }
    async function onMessageDelete(messageId) {
        const rec = await InvoiceRecord.findOne({ messageId, status: { $in: ['open', 'waiting'] } }).lean().catch(() => null);
        if (rec) await onInvoiceCancelled(messageId);
        await InvoiceDraft.updateOne({ messageId }, { $set: { messageId: null } }).catch(() => {});
    }

    function start() {
        setTimeout(() => { catchUpProofs().catch(() => {}); scheduleVerifPanel(); }, 25000);
        setInterval(flushPing, 60 * 1000);
        setInterval(() => { waitingAlarm().catch(() => {}); }, 5 * 60 * 1000);
        setInterval(() => { cleanupStale().catch(() => {}); }, 30 * 60 * 1000);
    }

    return {
        start, prepareInvoice, applyKodeToEmbed, onInvoiceDone, onInvoiceCancelled, getRecord, afterMainInvoice,
        buildQrisPayment, qrisTest, onTicketMessage, rebuildVerifPanel, scheduleVerifPanel, flushPing, catchUpProofs, cleanupStale,
        createDraft, markDraftUsed, handleDraftButton, handleDraftModal, onFormEdited, onChannelDelete, onMessageDelete,
        createInvoiceFromDraft, priceFor, parseRobux, parseType, totalFromEmbed, isImage
    };
};
