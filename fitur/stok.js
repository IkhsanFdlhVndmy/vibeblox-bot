// =====================================================================
// STOK: sisa minimal per community, alarm menipis, kuota Pre-Order (dari Robux pending),
// estimasi masuk (dari /restock), tombol "Ingatkan Saya"
// =====================================================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');

const OFFSETS = {
    d1: { label: '1 hari sebelum stok masuk', ms: 24 * 60 * 60 * 1000 },
    h1: { label: '1 jam sebelum stok masuk', ms: 60 * 60 * 1000 },
    m10: { label: '10 menit sebelum stok masuk', ms: 10 * 60 * 1000 },
    ready: { label: 'Saat stok sudah masuk', ms: 0 }
};

module.exports = function createStok(ctx, core, riwayat) {
    const { client, models, h } = ctx;
    const { InvoiceTracker, Transaction, Restock, StockReminder } = models;
    const CFG = core.CFG;
    const fmt = core.fmt;

    const sellable = (funds) => Math.max(0, (Number(funds) || 0) - CFG.STOCK_RESERVE);

    // Tampilan per community di Panel Stock — dibuat pendek supaya enak dibaca di HP:
    //   🔴 C1 · BEJIRLAH
    //   Saldo 781 · Jual 0 · Pending 85.001
    function panelCommunityBlock(num, grp, val, fundsAt, p) {
        const low = typeof val === 'number' && val < CFG.STOCK_LOW;
        const head = `${low ? '🔴' : '🟢'} **C${num} · ${grp.name}**`;
        let saldo;
        if (val === null || val === undefined) saldo = fundsAt ? 'Saldo ⚠️ gagal' : 'Saldo …';
        else saldo = `Saldo ${fmt(val)} · Jual **${fmt(sellable(val))}**`;
        let pend = 'Pending …';
        if (p && typeof p.pending === 'number') pend = `Pending ${fmt(p.pending)}${p.ok ? '' : '*'}`;
        else if (p) pend = 'Pending ⚠️';
        const refund = p?.refundedCount > 0 ? `\n-# ↩️ ${p.refundedCount}x dana dikembalikan${p.refundedAmount > 0 ? ` (${fmt(p.refundedAmount)})` : ''}` : '';
        return `${head}\n${saldo} · ${pend}${refund}\n`;
    }
    function panelCommunityLine(num, grp, val, fundsAt) { return panelCommunityBlock(num, grp, val, fundsAt, null); }

    function isPOChannel(channelId, storedName) {
        const name = client.channels.cache.get(channelId)?.name || storedName;
        return riwayat.isPO(name);
    }

    async function nearestRestock() {
        return Restock.findOne({ status: 'pending' }).sort({ arrivalTimestamp: 1 }).lean().catch(() => null);
    }
    function etaText(restock) {
        if (!restock) return 'akan diinformasikan admin';
        if (new Date(restock.arrivalTimestamp).getTime() <= Date.now()) return 'sedang diproses, sebentar lagi masuk';
        const t = core.ts(restock.arrivalTimestamp);
        return `<t:${t}:F> (<t:${t}:R>)`;
    }

    function etaShort(restock) {
        if (!restock) return 'belum dijadwalkan';
        if (new Date(restock.arrivalTimestamp).getTime() <= Date.now()) return 'sedang diproses';
        const t = core.ts(restock.arrivalTimestamp);
        return `<t:${t}:d> <t:${t}:t> (<t:${t}:R>)`;
    }

    async function poStatus() {
        const pending = h.getPendingCache();
        let quota = 0, pendingKnown = false;
        for (const num of Object.keys(h.RESTOCK_COMMUNITIES)) {
            const p = pending[num];
            if (p && typeof p.pending === 'number') { quota += p.pending; pendingKnown = true; }
        }
        const active = await InvoiceTracker.find({}).lean().catch(() => []);
        const activePO = active.filter(i => isPOChannel(i.channelId, i.channelName)).reduce((s, i) => s + (i.amount || 0), 0);
        const owed = await Transaction.find({ type: 'community', poOutstanding: true }).select('robux').lean().catch(() => []);
        const owedSum = owed.reduce((s, t) => s + (t.robux || 0), 0);
        const used = activePO + owedSum;
        return { quota, pendingKnown, activePO, owed: owedSum, used, left: quota - used };
    }

    // Tambahan baris di Panel Stock (dipanggil saat panel dibangun)
    async function decoratePanel(summaryLines) {
        try {
            const po = await poStatus();
            const restock = await nearestRestock();
            summaryLines.push('');
            summaryLines.push('**📦 Pre-Order** (dari pending)');
            summaryLines.push(`Kuota **${po.pendingKnown ? fmt(po.quota) : '…'}** · Terpakai **${fmt(po.used)}**`);
            summaryLines.push(`${po.left < 0 ? '🔴 Kuota PO penuh' : '🟢 Sisa PO'}: **${po.pendingKnown ? fmt(po.left) : '…'}**`);
            summaryLines.push(`🕐 Masuk: ${etaShort(restock)}`);
        } catch (e) {
            console.error('[STOK] Gagal hitung PO untuk panel:', e.message);
        }
    }

    // Alarm saldo menipis (dipanggil tiap saldo diperbarui)
    // Status "menipis" disimpan di database -> restart bot TIDAK mengirim ulang alarm yang sama
    let lowState = null;
    async function loadLowState() {
        const v = await core.getState('stok_menipis').catch(() => null);
        lowState = new Set(Array.isArray(v) ? v : []);
    }
    let lowBusy = false;
    async function onFundsUpdated(data) {
        if (lowBusy) return;
        lowBusy = true;
        try {
            if (!lowState) await loadLowState();
            const newlyLow = [];
            let changed = false;
            for (const [num, grp] of Object.entries(h.RESTOCK_COMMUNITIES)) {
                const v = data[num];
                if (typeof v !== 'number') continue;
                if (v < CFG.STOCK_LOW && !lowState.has(num)) { lowState.add(num); newlyLow.push(`• **C${num} ${grp.name}:** ${fmt(v)}`); changed = true; }
                else if (v >= CFG.STOCK_LOW + 200 && lowState.has(num)) { lowState.delete(num); changed = true; }
            }
            if (changed) await core.setState('stok_menipis', [...lowState]).catch(() => {});
            if (newlyLow.length) {
                // 1 pesan untuk semua community yang baru menipis (tidak spam)
                core.alarm(`low_${Date.now()}`, `🔴 **Saldo community menipis** (di bawah ${fmt(CFG.STOCK_LOW)} Robux):\n${newlyLow.join('\n')}\nJangan beri invoice dari community ini dulu.`, 0);
            }
        } finally { lowBusy = false; }
    }

    // Peringatan untuk staf saat membuat invoice Community yang melebihi stok
    async function invoiceStockWarning(channel, amount) {
        try {
            const funds = h.getPanelFunds().data;
            let totalSellable = 0;
            for (const num of Object.keys(h.RESTOCK_COMMUNITIES)) if (typeof funds[num] === 'number') totalSellable += sellable(funds[num]);
            const active = await InvoiceTracker.find({}).lean();
            const po = riwayat.isPO(channel.name);
            if (po) {
                const st = await poStatus();
                if (st.pendingKnown && st.left < 0) return `⚠️ **Kuota Pre-Order terlampaui** ${fmt(-st.left)} Robux (kuota dari Robux pending ${fmt(st.quota)}, terpakai ${fmt(st.used)}).`;
                return null;
            }
            const readyInvoiced = active.filter(i => !isPOChannel(i.channelId, i.channelName)).reduce((s, i) => s + (i.amount || 0), 0);
            if (readyInvoiced > totalSellable) {
                return `⚠️ **Stok ready tidak cukup:** total invoice aktif ${fmt(readyInvoiced)} Robux, stok bisa dijual ${fmt(totalSellable)} Robux (sudah dikurangi sisa wajib ${fmt(CFG.STOCK_RESERVE)}/community). Pertimbangkan /pre-order.`;
            }
        } catch (e) { /* peringatan saja, tidak kritikal */ }
        return null;
    }

    // Info untuk pembeli di tiket Pre-Order
    async function postPreOrderInfo(channel) {
        const restock = await nearestRestock();
        const st = await poStatus().catch(() => null);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📦 Pre-Order Robux Community')
            .setDescription(`Tiket ini adalah **Pre-Order**. Robux dikirim setelah stok masuk.\n\n🕐 **Estimasi stok masuk:** ${etaText(restock)}\n${st?.pendingKnown ? `📦 **Sisa kuota PO saat ini:** ${fmt(Math.max(0, st.left))} Robux` : ''}`)
            .setTimestamp();
        await h.discordRetry(() => channel.send({ embeds: [embed] })).catch(() => {});
    }

    // ---------------- Ingatkan Saya: restock ----------------
    function reminderRow(restockMessageId) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vx_rmd_${restockMessageId}`).setLabel('🔔 Ingatkan Saya').setStyle(ButtonStyle.Primary)
        );
    }
    async function onRestockCreated(restockDoc, message) {
        if (!core.isOn('ingatkan_saya') || !message) return;
        await message.edit({ components: [reminderRow(restockDoc.messageId)] }).catch(e => console.error('[STOK] Gagal pasang tombol Ingatkan Saya:', e.message));
    }
    async function handleReminderButton(interaction) {
        const msgId = interaction.customId.replace('vx_rmd_', '');
        const restock = await Restock.findOne({ messageId: msgId }).lean();
        if (restock?.soldOut) return interaction.reply({ content: '🔴 Stok restock ini sudah **habis dipesan lewat Pre-Order**. Pantau pengumuman restock berikutnya ya!', flags: MessageFlags.Ephemeral });
        if (!restock || restock.status !== 'pending') return interaction.reply({ content: '✅ Stok restock ini sudah masuk.', flags: MessageFlags.Ephemeral });
        const existing = await StockReminder.findOne({ userId: interaction.user.id, target: msgId }).lean();
        const menu = new StringSelectMenuBuilder().setCustomId(`vx_rmdsel_${msgId}`).setPlaceholder('Pilih kapan mau diingatkan').setMinValues(0).setMaxValues(4)
            .addOptions(Object.entries(OFFSETS).map(([k, o]) => ({ label: o.label, value: k, default: !!existing?.offsets?.includes(k) })));
        return interaction.reply({
            content: `🔔 Stok masuk <t:${core.ts(restock.arrivalTimestamp)}:F>. Pilih kapan kamu mau diingatkan lewat DM (bisa lebih dari satu, kosongkan untuk berhenti):`,
            components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral
        });
    }
    async function handleReminderSelect(interaction) {
        const msgId = interaction.customId.replace('vx_rmdsel_', '');
        const values = interaction.values.filter(v => OFFSETS[v]);
        if (!values.length) {
            await StockReminder.deleteOne({ userId: interaction.user.id, target: msgId });
            return interaction.update({ content: '🔕 Pengingat dibatalkan.', components: [] });
        }
        await StockReminder.updateOne({ userId: interaction.user.id, target: msgId }, { $set: { offsets: values }, $setOnInsert: { sent: [] } }, { upsert: true });
        return interaction.update({ content: `✅ Kamu akan diingatkan lewat DM: ${values.map(v => OFFSETS[v].label.toLowerCase()).join(', ')}.\n-# Pastikan DM dari member server ini tidak kamu tutup.`, components: [] });
    }

    async function dmMany(userIds, payload, fallbackChannelId) {
        const failed = [];
        for (const uid of userIds) {
            try {
                const u = await client.users.fetch(uid);
                await u.send(payload);
            } catch (e) { failed.push(uid); }
            await new Promise(r => setTimeout(r, 400));
        }
        if (failed.length && fallbackChannelId) {
            for (let i = 0; i < failed.length; i += 40) {
                const chunk = failed.slice(i, i + 40);
                await core.sendTo(fallbackChannelId, { content: `🔔 ${chunk.map(id => `<@${id}>`).join(' ')}\n${payload.content || ''}\n-# (DM kalian tertutup, jadi diingatkan di sini)`, allowedMentions: { users: chunk } }).catch(() => {});
            }
        }
    }

    let tickRunning = false;
    async function reminderTick() {
        if (tickRunning || !client.isReady()) return;
        tickRunning = true;
        try {
            const reminders = await StockReminder.find({ target: { $ne: 'community_open' } }).lean();
            const byTarget = {};
            for (const r of reminders) (byTarget[r.target] = byTarget[r.target] || []).push(r);
            for (const [msgId, list] of Object.entries(byTarget)) {
                const restock = await Restock.findOne({ messageId: msgId }).lean();
                if (!restock || restock.soldOut) { await StockReminder.deleteMany({ target: msgId }); continue; } // sold out oleh PO -> tidak ada DM
                const arrival = new Date(restock.arrivalTimestamp).getTime();
                const now = Date.now();
                for (const key of Object.keys(OFFSETS)) {
                    const due = arrival - OFFSETS[key].ms;
                    const isReady = key === 'ready';
                    if (isReady ? restock.status !== 'completed' : now < due) continue;
                    const users = list.filter(r => r.offsets.includes(key) && !r.sent.includes(key)).map(r => r.userId);
                    if (!users.length) continue;
                    // Tandai DULU (anti dobel kalau bot restart di tengah)
                    await StockReminder.updateMany({ target: msgId, userId: { $in: users } }, { $addToSet: { sent: key } });
                    // Basi (bot mati lama / stok sudah masuk) -> jangan kirim, bisa bikin salah paham
                    const stale = isReady ? (now - arrival > 3 * 60 * 60 * 1000) : (now - due > 15 * 60 * 1000 || restock.status === 'completed');
                    if (stale) continue;
                    const content = isReady
                        ? `✅ **Robux Community sudah READY!** Stok restock (${formatComm(restock.communities)}) sudah masuk. Langsung buka tiket sebelum kehabisan 🚀`
                        : `🔔 **Pengingat restock:** stok Robux Community (${formatComm(restock.communities)}) masuk <t:${core.ts(arrival)}:R> (<t:${core.ts(arrival)}:F>).`;
                    await dmMany(users, { content }, restock.channelId);
                }
                if (restock.status === 'completed') {
                    const remaining = await StockReminder.find({ target: msgId }).lean();
                    if (remaining.every(r => r.offsets.every(o => r.sent.includes(o)))) {
                        await StockReminder.deleteMany({ target: msgId });
                    }
                }
            }
            // Lepas tombol dari pengumuman restock yang sudah selesai
            const doneRestocks = await Restock.find({ status: 'completed', updatedAt: { $gt: new Date(Date.now() - 6 * 60 * 60 * 1000) } }).lean();
            for (const r of doneRestocks) {
                if (r.soldOut || removedButtons.has(r.messageId)) continue;
                removedButtons.add(r.messageId);
                const ch = await client.channels.fetch(r.channelId).catch(() => null);
                if (ch) await ch.messages.edit(r.messageId, { components: [] }).catch(() => {});
            }
        } catch (e) {
            console.error('[STOK] Pengingat restock error:', e.message);
        } finally { tickRunning = false; }
    }
    const removedButtons = new Set();
    function formatComm(nums) { return (nums || []).map(n => `C${n} ${h.RESTOCK_COMMUNITIES[n]?.name || ''}`.trim()).join(', '); }

    // ---------------- Ingatkan Saya: tiket Community dibuka lagi ----------------
    function extraPanelRows(config) {
        if (!core.isOn('ingatkan_saya')) return [];
        const enabled = config.buttonStates?.get ? config.buttonStates.get('community') !== false : true;
        if (enabled) return [];
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vx_watch_community').setLabel('🔔 Ingatkan saat Robux Community dibuka').setStyle(ButtonStyle.Secondary)
        )];
    }
    async function handleWatchButton(interaction) {
        const existing = await StockReminder.findOne({ userId: interaction.user.id, target: 'community_open' }).lean();
        if (existing) {
            await StockReminder.deleteOne({ _id: existing._id });
            return interaction.reply({ content: '🔕 Pengingat dibatalkan.', flags: MessageFlags.Ephemeral });
        }
        await StockReminder.create({ userId: interaction.user.id, target: 'community_open', offsets: ['open'] });
        return interaction.reply({ content: '✅ Kamu akan diberi tahu lewat DM saat tiket **Robux Community** dibuka lagi. (Tekan tombol lagi untuk membatalkan.)', flags: MessageFlags.Ephemeral });
    }
    async function onCommunityModeChanged(newMode, panelChannelId) {
        if (newMode === 'disable') return;
        const list = await StockReminder.find({ target: 'community_open' }).lean();
        if (!list.length) return;
        await StockReminder.deleteMany({ target: 'community_open', _id: { $in: list.map(l => l._id) } });
        const label = newMode === 'preorder' ? ' (Pre-Order)' : '';
        dmMany(list.map(l => l.userId), { content: `✅ **Tiket Robux Community${label} sudah dibuka lagi!**${panelChannelId ? ` Buka tiket di <#${panelChannelId}>.` : ''}` }, null)
            .catch(() => {});
    }

    // ---------------- /restock-sold: tandai stok restock habis oleh Pre-Order ----------------
    function soldRow() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vx_rmd_sold').setLabel('🔴 Sold Out (Pre-Order)').setStyle(ButtonStyle.Danger).setDisabled(true)
        );
    }
    async function handleRestockSold(interaction) {
        if (!core.isStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner, Handler, dan Partner.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const status = interaction.options.getString('status') || 'sold';
        const raw = (interaction.options.getString('pesan') || '').trim();
        const msgId = raw ? (raw.match(/(\d{17,20})\/?$/) || [])[1] : null;
        if (raw && !msgId) return interaction.editReply({ content: '❌ Isi `pesan` dengan link / ID pesan /restock. Kosongkan untuk restock aktif terdekat.' });
        const restock = msgId
            ? await Restock.findOne({ messageId: msgId })
            : await Restock.findOne({ status: 'pending' }).sort({ arrivalTimestamp: 1 });
        if (!restock) return interaction.editReply({ content: '❌ Tidak ada /restock aktif yang ditemukan.' });
        if (restock.status !== 'pending') return interaction.editReply({ content: '❌ Restock ini sudah masuk (countdown selesai).' });
        const sold = status === 'sold';
        restock.soldOut = sold;
        restock.soldOutAt = sold ? new Date() : null;
        await restock.save();
        let removed = 0;
        if (sold) removed = (await StockReminder.deleteMany({ target: restock.messageId })).deletedCount || 0;
        const ch = await client.channels.fetch(restock.channelId).catch(() => null);
        if (ch) {
            await ch.messages.edit(restock.messageId, {
                embeds: [h.buildRestockPendingEmbed(restock)],
                components: sold ? [soldRow()] : (core.isOn('ingatkan_saya') ? [reminderRow(restock.messageId)] : [])
            }).catch(e => console.error('[STOK] Gagal ubah tampilan restock:', e.message));
        }
        const link = `https://discord.com/channels/${restock.guildId || interaction.guildId}/${restock.channelId}/${restock.messageId}`;
        return interaction.editReply({ content: sold
            ? `🔴 Restock **${fmt(restock.amount)} Robux** ditandai **SOLD OUT (Pre-Order)**.\n• Tampilan countdown berubah jadi SOLD OUT, tombol Ingatkan Saya dimatikan\n• ${removed} pengingat DM dibatalkan\n• Saat stok masuk **tidak** ada pengumuman @everyone\n${link}`
            : `✅ Status SOLD OUT dibatalkan — countdown & tombol Ingatkan Saya aktif lagi.\n${link}` });
    }

    function start() {
        setInterval(reminderTick, 60 * 1000);
        setTimeout(reminderTick, 30000);
    }

    return {
        start, sellable, panelCommunityLine, panelCommunityBlock, decoratePanel, onFundsUpdated, invoiceStockWarning, poStatus, postPreOrderInfo,
        onRestockCreated, handleRestockSold, handleReminderButton, handleReminderSelect, reminderTick, extraPanelRows, handleWatchButton, onCommunityModeChanged,
        nearestRestock, etaText, OFFSETS
    };
};
