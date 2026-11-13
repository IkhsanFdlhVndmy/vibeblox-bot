// =====================================================================
// ASISTEN PAYOUT COMMUNITY: rencana pembagian (batas 9.999/username/community), multi username,
// verifikasi "Robux sudah masuk" dari audit log Spend Group Funds. Staf TETAP yang mengirim di Roblox.
// =====================================================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');

const DAY = 24 * 60 * 60 * 1000;
const LEDGER_DAYS = 21;

module.exports = function createPayout(ctx, core, eligible) {
    const { client, models, h } = ctx;
    const { PayoutPlan, Transaction, Ticket } = models;
    const CFG = core.CFG;
    const fmt = core.fmt;
    const axios = h.axios;

    // ---------------- Buku catatan payout per community (audit log) ----------------
    const ledgers = {}; // num -> { entries: [{ts, name, amount}], ready, newestTs, lastOk }
    for (const num of Object.keys(h.RESTOCK_COMMUNITIES)) ledgers[num] = { entries: [], ready: false, newestTs: 0, lastOk: 0 };
    let refreshing = null;

    function parseEntry(e) {
        const ts = new Date(e.created).getTime();
        const desc = e.description?.ItemDescription || '';
        const out = [];
        const re = /([A-Za-z0-9_]+)\s*\(([\d,]+)\)/g;
        let m;
        let idx = 0;
        while ((m = re.exec(desc)) !== null) out.push({ ts, name: m[1].toLowerCase(), amount: parseInt(m[2].replace(/,/g, ''), 10) || 0, key: `${ts}:${m[1].toLowerCase()}:${idx++}` });
        return { ts, items: out };
    }
    async function fetchPage(groupId, cursor, priority) {
        return h.rbxRun({
            priority, gapAfter: 700,
            run: async () => {
                if (h.rbxIsPaused()) throw new Error('RBX_PAUSED');
                const url = `https://groups.roblox.com/v1/groups/${groupId}/audit-log?actionType=${encodeURIComponent('Spend Group Funds')}&limit=100&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
                const res = await axios.get(url, { headers: { Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` } });
                return res.data || {};
            }
        });
    }
    async function refreshLedger(num, priority = 'low') {
        const L = ledgers[num];
        const grp = h.RESTOCK_COMMUNITIES[num];
        const full = !L.ready;
        const stopBefore = full ? Date.now() - LEDGER_DAYS * DAY : L.newestTs;
        const fresh = [];
        let newest = L.newestTs, cursor = '', complete = false;
        for (let page = 0; page < (full ? 80 : 15); page++) {
            const data = await fetchPage(grp.groupId, cursor, priority);
            const entries = Array.isArray(data.data) ? data.data : [];
            let reached = false;
            for (const e of entries) {
                const p = parseEntry(e);
                if (!p.ts) continue;
                if (p.ts <= stopBefore) { reached = true; break; }
                if (p.ts > newest) newest = p.ts;
                fresh.push(...p.items);
            }
            if (reached || !data.nextPageCursor || !entries.length) { complete = true; break; }
            cursor = data.nextPageCursor;
        }
        if (!complete) {
            if (full) { console.error(`[PAYOUT] Riwayat payout Community ${num} terlalu banyak, verifikasi otomatis tidak tersedia.`); return; }
            L.ready = false; L.entries = []; L.newestTs = 0;
            return refreshLedger(num, priority);
        }
        const cutoff = Date.now() - LEDGER_DAYS * DAY;
        L.entries = [...fresh, ...L.entries].filter(x => x.ts >= cutoff);
        L.newestTs = Math.max(newest, L.newestTs);
        L.lastOk = Date.now();
        L.ready = true;
    }
    async function refreshAll(priority = 'low') {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            for (const num of Object.keys(ledgers)) {
                try { await refreshLedger(num, priority); }
                catch (e) { if (e.message !== 'RBX_PAUSED') console.error(`[PAYOUT] Gagal baca payout Community ${num}:`, e.response?.status || e.message); }
                if (ledgers[num].ready && Date.now() - ledgers[num].lastOk > 30 * 60 * 1000) { ledgers[num].ready = false; ledgers[num].entries = []; ledgers[num].newestTs = 0; }
            }
        })().finally(() => { refreshing = null; });
        return refreshing;
    }
    function received(num, names, sinceMs) {
        return ledgers[num].entries.filter(x => x.ts >= sinceMs && names.includes(x.name)).reduce((s, x) => s + x.amount, 0);
    }
    function oldestTs(num, names, sinceMs) {
        let t = 0;
        for (const x of ledgers[num].entries) if (x.ts >= sinceMs && names.includes(x.name) && (!t || x.ts < t)) t = x.ts;
        return t;
    }

    // ---------------- Opsi payout per username ----------------
    // Untuk tiap username: community mana saja yang BISA dipakai & berapa maksimal yang bisa dikirim.
    // Staf yang memilih sendiri. Bot tidak mengecek / memverifikasi pengiriman.
    async function computeOptions(recipients) {
        const funds = h.getPanelFunds().data;
        const out = [];
        for (const raw of recipients) {
            // recipients dari database adalah subdokumen Mongoose: "...rcp" TIDAK membawa username/amount
            // (itu penyebab jumlah per username tampil 0 R$) -> ambil field-nya secara eksplisit
            const rcp = { username: String(raw.username || ''), amount: Number(raw.amount) || 0 };
            const check = await eligible.checkUsername(rcp.username, 20000);
            if (check.status !== 'ok') { out.push({ ...rcp, status: check.status }); continue; }
            const names = [check.user.name.toLowerCase(), (check.user.displayName || '').toLowerCase()].filter(Boolean);
            const options = [], pending = [], notJoin = [];
            for (const row of check.rows) {
                const label = `C${row.num} ${row.name}`;
                if (row.status === 'notjoin') { notJoin.push(`C${row.num}`); continue; }
                if (row.status === 'pending') { pending.push({ label, at: row.eligibleAt }); continue; }
                if (row.status !== 'eligible') { pending.push({ label, unknown: true }); continue; }
                const saldo = typeof funds[row.num] === 'number' ? funds[row.num] : null;
                const sell = saldo === null ? 0 : Math.max(0, saldo - CFG.STOCK_RESERVE);
                const L = ledgers[row.num];
                const since = Date.now() - CFG.PAYOUT_WINDOW_DAYS * DAY;
                const got = L.ready ? received(row.num, names, since) : 0;
                const first = got > 0 ? oldestTs(row.num, names, since) : 0;
                const cap = Math.max(0, CFG.PAYOUT_CAP - got);
                options.push({ label, num: row.num, max: Math.min(cap, sell), sell, cap, got, resetAt: first ? first + CFG.PAYOUT_WINDOW_DAYS * DAY : 0, ready: L.ready, saldoKnown: saldo !== null });
            }
            // urutan: yang bisa kirim > belum pernah terima dalam 15 hari > sudah pernah terima; lalu yang bisa kirim paling banyak
            const rank = (o) => (!o.ready ? 1 : (o.got === 0 ? 0 : 2));
            options.sort((a, b) => (b.max > 0) - (a.max > 0) || rank(a) - rank(b) || b.max - a.max);
            out.push({ ...rcp, status: 'ok', name: check.user.name, options, pending, notJoin });
        }
        return out;
    }

    function recipientBlock(r) {
        const head = `👤 **\`${r.name || r.username}\`** — ${fmt(r.amount)} R$`;
        if (r.status === 'notfound') return `${head}\n🔴 Username tidak ditemukan di Roblox`;
        if (r.status !== 'ok') return `${head}\n⚠️ Gagal dicek (Roblox lambat) — tekan 🔄 Perbarui`;
        const lines = [head];
        for (const o of r.options) {
            const icon = o.max >= r.amount ? '🟢' : (o.max > 0 ? '🟡' : '🔴');
            let why = '';
            if (o.max === 0) why = !o.saldoKnown ? ' (saldo belum termuat)' : (o.sell === 0 ? ' (saldo kurang)' : ' (sudah capai batas 9.999)');
            lines.push(`${icon} ${o.label} · bisa **${fmt(o.max)}**${why}`);
            if (!o.ready) lines.push('└ riwayat payout belum termuat');
            else if (o.got > 0) lines.push(`└ sudah terima ${fmt(o.got)} dalam ${CFG.PAYOUT_WINDOW_DAYS} hari terakhir${o.resetAt ? ` · mulai berkurang <t:${Math.floor(o.resetAt / 1000)}:R>` : ''}`);
        }
        for (const p of r.pending) lines.push(p.unknown ? `❔ ${p.label} · status sedang dimuat` : `⏳ ${p.label} · eligible <t:${Math.floor(p.at / 1000)}:R>`);
        if (r.notJoin.length) lines.push(`❌ Belum join: ${r.notJoin.join(' · ')}`);
        if (!r.options.length && !r.pending.length) lines.push('🔴 Belum eligible di community mana pun');
        return lines.join('\n');
    }

    function planPayload(plan, options) {
        const done = plan.status === 'done';
        const blocks = (options || []).map(recipientBlock);
        const embed = new EmbedBuilder().setColor(done ? 0x99AAB5 : 0x5865F2)
            .setTitle(`📤 Opsi Payout${plan.isPreOrder ? ' (Pre-Order)' : ''}${done ? ' — ✅ invoice selesai' : ''}`)
            .setDescription([
                `Pesanan **${fmt(plan.robux)} R$**`,
                '',
                blocks.join('\n\n') || '⚠️ Username belum ada — tekan **👥 Beberapa Username**'
            ].join('\n').slice(0, 4000));
        if (done) return { embeds: [embed], components: [] };
        embed.setFooter({ text: 'Pembeli & staf bisa mengubah username lewat tombol 👥 Beberapa Username' });
        const id = plan.invoiceMessageId;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vx_po_split_${id}`).setLabel('👥 Beberapa Username').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`vx_po_recalc_${id}`).setLabel('🔄 Perbarui').setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [row] };
    }
    async function editPlanMessage(plan) {
        if (!plan.messageId) return;
        const ch = await client.channels.fetch(plan.channelId).catch(() => null);
        if (!ch) return;
        const options = plan.status === 'done' ? null : await computeOptions(plan.recipients);
        if (plan.status === 'done') {
            // invoice selesai: pesan opsi payout dihapus, di tiket tinggal pesan vouch
            await ch.messages.delete(plan.messageId).catch(() => {});
            return;
        }
        await ch.messages.edit(plan.messageId, planPayload(plan, options)).catch(() => {});
    }

    // Form tiket mengikuti penerima di rencana payout (1 atau beberapa username)
    async function syncFormRecipients(channel, recipients) {
        try {
            if (!recipients.length) return;
            await Ticket.updateOne({ channelId: channel.id }, { $set: { robloxUsername: eligible.norm(recipients[0].username) } });
            eligible.setChannelUsername(channel.id, recipients[0].username); // daftar username di memori ikut
            const msgs = await channel.messages.fetch({ limit: 5, after: channel.id });
            const form = [...msgs.values()].find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title?.startsWith('🎫 Order Tiket'));
            if (!form) return;
            const value = recipients.length === 1 ? `\`${recipients[0].username}\`` : recipients.map(r => `\`${r.username}\` · ${fmt(r.amount)} R$`).join('\n');
            const fields = form.embeds[0].fields.map(f => (f.name.includes('Username Roblox') ? { name: f.name, value, inline: f.inline } : f));
            await form.edit({ embeds: [EmbedBuilder.from(form.embeds[0]).setFields(fields)] });
        } catch (e) { /* tampilan saja */ }
    }

    async function formUsername(channel) {
        const t = await Ticket.findOne({ channelId: channel.id }).lean().catch(() => null);
        if (t?.robloxUsername) return t.robloxUsername;
        try {
            const msgs = await channel.messages.fetch({ limit: 5, after: channel.id });
            const form = msgs.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith('🎫 Order Tiket'));
            const f = form?.embeds[0]?.fields?.find(x => x.name.includes('Username Roblox'));
            return f ? f.value.replace(/`/g, '').trim() : null;
        } catch (e) { return null; }
    }

    // Membuat / menampilkan Rencana Payout untuk 1 invoice Community (SEBELUM Robux dikirim).
    // Dipicu otomatis saat pembeli mengirim bukti bayar, atau lewat tombol "📤 Rencana Payout" di invoice.
    async function ensurePlan({ channel, invoiceMessageId, buyerId, robux }) {
        if (!core.isOn('asisten_payout') || !robux) return null;
        const username = await formUsername(channel);
        const isPreOrder = /-po/i.test(channel.name || '');
        const recipients = username ? [{ username, amount: robux }] : [];
        const plan = await PayoutPlan.findOneAndUpdate(
            { invoiceMessageId },
            { $setOnInsert: { invoiceMessageId, channelId: channel.id, buyerId, robux, recipients, status: 'planned', doneAt: new Date(), isPreOrder } },
            { upsert: true, returnDocument: 'after' }
        );
        if (plan.messageId) return plan;
        const options = recipients.length ? await computeOptions(recipients) : [];
        const msg = await h.discordRetry(() => channel.send(planPayload(plan, options)));
        plan.messageId = msg.id;
        await plan.save();
        return plan;
    }

    // Invoice Done = Robux sudah dikirim -> opsi payout cukup ditandai selesai (tidak ada pengecekan audit log)
    async function onCommunityDone({ invoiceMessageId }) {
        try {
            const plan = await PayoutPlan.findOne({ invoiceMessageId });
            if (!plan || plan.status === 'done') return;
            plan.status = 'done';
            await plan.save();
            await editPlanMessage(plan);
        } catch (e) { console.error('[PAYOUT] Gagal menandai opsi payout selesai:', e.message); }
    }

    // Yang boleh mengubah opsi payout: staf invoice (Owner/Handler) ATAU pembeli tiket itu sendiri
    async function isBuyer(interaction, buyerId) {
        const uid = interaction.user?.id;
        if (!uid) return false;
        if (buyerId && buyerId === uid) return true;
        const t = await Ticket.findOne({ channelId: interaction.channel?.id || interaction.channelId }).lean().catch(() => null);
        return !!t && t.creatorId === uid;
    }
    const recalcAt = new Map(); // invoiceMessageId -> waktu terakhir pembeli menekan 🔄 Perbarui
    const NO_ACCESS = '❌ Opsi payout hanya bisa diubah oleh pembeli tiket ini atau staf.';

    // Tombol "📤 Rencana Payout" di invoice Community
    function planButton(invoiceMessageId) {
        return new ButtonBuilder().setCustomId(`vx_plan_${invoiceMessageId}`).setLabel('📤 Opsi Payout').setStyle(ButtonStyle.Primary);
    }
    async function handlePlanButton(interaction) {
        if (!core.isOn('asisten_payout')) return interaction.reply({ content: '❌ Asisten payout sedang OFF (/pengaturan).', flags: MessageFlags.Ephemeral });
        const id = interaction.customId.replace('vx_plan_', '');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const embed = interaction.message?.embeds?.[0];
        const robux = parseInt(String((embed?.fields || []).find(f => f.name.includes('Jumlah Robux'))?.value || '').replace(/[^\d]/g, ''), 10) || 0;
        const buyerId = (String((embed?.fields || []).find(f => f.name.includes('Pembeli'))?.value || '').match(/<@!?(\d+)>/) || [])[1] || null;
        if (!core.isInvoiceStaff(interaction.member) && !(await isBuyer(interaction, buyerId))) return interaction.editReply({ content: NO_ACCESS });
        if (!robux) return interaction.editReply({ content: '❌ Jumlah Robux di invoice tidak terbaca.' });
        const plan = await ensurePlan({ channel: interaction.channel, invoiceMessageId: id, buyerId, robux });
        if (!plan?.messageId) return interaction.editReply({ content: '❌ Gagal membuat opsi payout.' });
        return interaction.editReply({ content: `📤 Opsi payout: https://discord.com/channels/${interaction.guildId || interaction.guild?.id}/${interaction.channel.id}/${plan.messageId}` });
    }

    async function handleButton(interaction) {
        const parts = interaction.customId.split('_'); // vx_po_<aksi>_<invoiceMsgId>
        const action = parts[2], id = parts[3];
        const plan = await PayoutPlan.findOne({ invoiceMessageId: id });
        if (!plan) return interaction.reply({ content: '❌ Opsi payout tidak ditemukan.', flags: MessageFlags.Ephemeral });
        if (!core.isInvoiceStaff(interaction.member) && !(await isBuyer(interaction, plan.buyerId))) return interaction.reply({ content: NO_ACCESS, flags: MessageFlags.Ephemeral });
        if (plan.status === 'done' && ['split', 'recalc'].includes(action)) return interaction.reply({ content: '✅ Invoice ini sudah selesai, opsi payout tidak bisa diubah lagi.', flags: MessageFlags.Ephemeral });

        if (action === 'split') {
            const modal = new ModalBuilder().setCustomId(`vx_pom_${id}`).setTitle('Bagi ke Beberapa Username');
            const t = new TextInputBuilder().setCustomId('daftar').setLabel(`1 baris = username jumlah (total ${plan.robux})`).setStyle(TextInputStyle.Paragraph).setRequired(true)
                .setPlaceholder('usn1 5000\nusn2 3000');
            const cur = plan.recipients.map(r => `${r.username} ${r.amount}`).join('\n');
            if (cur) t.setValue(cur);
            modal.addComponents(new ActionRowBuilder().addComponents(t));
            return interaction.showModal(modal);
        }
        if (action === 'recalc') {
            if (!core.isInvoiceStaff(interaction.member)) {
                // pembeli: maks 1x per 60 detik (cek ke Roblox tidak boleh di-spam, apalagi saat War)
                const last = recalcAt.get(id) || 0;
                if (Date.now() - last < 60000) return interaction.reply({ content: `⏳ Baru saja diperbarui. Coba lagi <t:${Math.ceil((last + 60000) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
                recalcAt.set(id, Date.now());
                if (recalcAt.size > 500) recalcAt.clear();
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (!plan.recipients.length) return interaction.editReply({ content: '❌ Isi username dulu lewat **👥 Beberapa Username**.' });
            await refreshAll('normal').catch(() => {});
            await editPlanMessage(plan);
            return interaction.editReply({ content: '✅ Opsi diperbarui dengan saldo & riwayat terbaru.' });
        }
        return interaction.reply({ content: 'ℹ️ Tombol ini sudah tidak dipakai. Cukup tekan **✅ Done** di invoice setelah Robux dikirim.', flags: MessageFlags.Ephemeral });
    }

    async function handleModal(interaction) {
        const id = interaction.customId.replace('vx_pom_', '');
        const plan = await PayoutPlan.findOne({ invoiceMessageId: id });
        if (!plan) return interaction.reply({ content: '❌ Rencana tidak ditemukan.', flags: MessageFlags.Ephemeral });
        const staff = core.isInvoiceStaff(interaction.member);
        if (!staff && !(await isBuyer(interaction, plan.buyerId))) return interaction.reply({ content: NO_ACCESS, flags: MessageFlags.Ephemeral });
        if (plan.status === 'done') return interaction.reply({ content: '✅ Invoice ini sudah selesai, opsi payout tidak bisa diubah lagi.', flags: MessageFlags.Ephemeral });
        const lines = interaction.fields.getTextInputValue('daftar').split('\n').map(l => l.trim()).filter(Boolean);
        const recipients = [];
        for (const l of lines) {
            const m = l.match(/^@?([A-Za-z0-9_]{3,20})[\s:=,-]+([\d.,]+)\s*(?:r\$|robux)?$/i);
            if (!m) return interaction.reply({ content: `❌ Format salah di baris: \`${l}\`. Contoh: \`usn1 5000\``, flags: MessageFlags.Ephemeral });
            recipients.push({ username: m[1], amount: parseInt(m[2].replace(/[.,]/g, ''), 10) });
        }
        const total = recipients.reduce((s, r) => s + r.amount, 0);
        if (total !== plan.robux) return interaction.reply({ content: `❌ Total ${fmt(total)} R$ tidak sama dengan pesanan ${fmt(plan.robux)} R$.`, flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const before = plan.recipients.map(r => `${r.username} ${r.amount}`).join(' · ');
        plan.recipients = recipients;
        await plan.save();
        await editPlanMessage(plan);
        await syncFormRecipients(interaction.channel, recipients);
        if (!staff) {
            // diubah pembeli -> staf melihat perubahannya di tiket (supaya tidak kirim ke username lama)
            const after = recipients.map(r => `\`${r.username}\` ${fmt(r.amount)} R$`).join(' · ');
            await interaction.channel.send({ content: `✏️ <@${interaction.user.id}> mengubah username payout → ${after}${before ? `\n-# sebelumnya: ${before}` : ''}`, allowedMentions: { parse: [] } }).catch(() => {});
        }
        return interaction.editReply({ content: '✅ Username diperbarui & form tiket ikut diperbarui.' });
    }

    async function onChannelDelete(channelId) {
        await PayoutPlan.updateMany({ channelId, status: { $ne: 'done' } }, { $set: { status: 'done' } }).catch(() => {});
    }

    function start() {
        setTimeout(() => refreshAll('low').catch(() => {}), 60000);
        setInterval(() => refreshAll('low').catch(() => {}), 4 * 60 * 1000);
    }

    return { start, refreshAll, computeOptions, ensurePlan, planButton, handlePlanButton, onCommunityDone, handleButton, handleModal, onChannelDelete, ledgers, planPayload, parseEntry };
};
