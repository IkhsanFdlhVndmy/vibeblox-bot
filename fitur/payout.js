// =====================================================================
// ASISTEN PAYOUT COMMUNITY: rencana pembagian (batas 9.999/username/community), multi username,
// verifikasi "Robux sudah masuk" dari audit log Spend Group Funds. Staf TETAP yang mengirim di Roblox.
// =====================================================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');

const DAY = 24 * 60 * 60 * 1000;
const LEDGER_DAYS = 21;
const CHECK_DELAYS = [30e3, 2 * 60e3, 5 * 60e3, 10 * 60e3]; // jeda cek ulang (audit log Roblox kadang telat)

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

    // ---------------- Hitung rencana ----------------
    async function computePlan(recipients) {
        const funds = h.getPanelFunds().data;
        const used = {}; // num -> jumlah yang sudah dialokasikan di rencana ini
        const allocations = [];
        const notes = [];
        let shortfall = 0;
        for (const rcp of recipients) {
            const check = await eligible.checkUsername(rcp.username, 20000);
            if (check.status !== 'ok') {
                notes.push(`⚠️ \`${rcp.username}\`: ${check.status === 'notfound' ? 'username tidak ditemukan di Roblox' : 'gagal dicek (Roblox lambat), tekan 🔄 Hitung Ulang'}`);
                shortfall += rcp.amount;
                continue;
            }
            const names = [check.user.name.toLowerCase(), (check.user.displayName || '').toLowerCase()].filter(Boolean);
            const candidates = [];
            for (const row of check.rows) {
                if (row.status !== 'eligible') continue;
                const num = row.num;
                const saldo = typeof funds[num] === 'number' ? funds[num] : null;
                if (saldo === null) continue;
                const sell = Math.max(0, saldo - CFG.STOCK_RESERVE - (used[num] || 0));
                const L = ledgers[num];
                const r10 = L.ready ? received(num, names, Date.now() - CFG.PAYOUT_RISK_DAYS * DAY) : 0;
                const r20 = L.ready ? received(num, names, Date.now() - CFG.PAYOUT_LOOKBACK_DAYS * DAY) : 0;
                const cap = Math.max(0, CFG.PAYOUT_CAP - r10);
                const rank = !L.ready ? 1.5 : (r20 === 0 ? 0 : (r10 === 0 ? 1 : 2));
                candidates.push({ num, sell, cap, r10, r20, rank, ready: L.ready });
            }
            candidates.sort((a, b) => a.rank - b.rank || b.sell - a.sell);
            let left = rcp.amount;
            for (const c of candidates) {
                if (left <= 0) break;
                const amt = Math.min(left, c.cap, c.sell);
                if (amt <= 0) continue;
                let note = '';
                if (!c.ready) note = 'riwayat payout belum termuat — cek /cek-transaksi';
                else if (c.r10 > 0) note = `sudah terima ${fmt(c.r10)} R$ dalam ${CFG.PAYOUT_RISK_DAYS} hari`;
                else if (c.r20 > 0) note = `pernah payout ${fmt(c.r20)} R$ ${CFG.PAYOUT_RISK_DAYS}-${CFG.PAYOUT_LOOKBACK_DAYS} hari lalu`;
                allocations.push({ num: c.num, username: check.user.name, amount: amt, note });
                used[c.num] = (used[c.num] || 0) + amt;
                left -= amt;
            }
            if (left > 0) {
                shortfall += left;
                const elig = check.rows.filter(r => r.status === 'eligible').map(r => `C${r.num}`).join(', ') || 'tidak ada';
                notes.push(`⚠️ \`${check.user.name}\` kurang **${fmt(left)} R$** — community eligible: ${elig}; batas ${fmt(CFG.PAYOUT_CAP)}/community atau saldo (sisa wajib ${fmt(CFG.STOCK_RESERVE)}) tidak cukup.`);
            }
        }
        return { allocations, shortfall, notes };
    }

    const STATUS = {
        planned: ['📤 Rencana Payout', 0x5865F2],
        checking: ['🔎 Mengecek payout di Roblox…', 0xFEE75C],
        verified: ['✅ Payout Terverifikasi', 0x57F287],
        mismatch: ['⚠️ Payout Belum Cocok', 0xED4245],
        manual: ['✔️ Payout Ditandai Selesai (manual)', 0x57F287]
    };
    function planPayload(plan, notes = []) {
        const [title, color] = STATUS[plan.status] || STATUS.planned;
        const byNum = (n) => `C${n} ${h.RESTOCK_COMMUNITIES[n]?.name || ''}`.trim();
        const allocLines = plan.allocations.map(a => `• **${byNum(a.num)}** → \`${a.username}\` : **${fmt(a.amount)} R$**${a.note ? `\n  -# ⚠️ ${a.note}` : ''}`);
        const embed = new EmbedBuilder().setColor(color).setTitle(`${title}${plan.isPreOrder ? ' (Pre-Order)' : ''}`)
            .setDescription([
                `Total pesanan: **${fmt(plan.robux)} R$** · penerima: ${plan.recipients.map(r => `\`${r.username}\` ${fmt(r.amount)}`).join(', ')}`,
                '',
                allocLines.join('\n') || '_Belum ada pembagian yang bisa disarankan._',
                plan.shortfall > 0 ? `\n🔴 **Belum terbagi: ${fmt(plan.shortfall)} R$**` : '',
                ...(notes.length ? ['', ...notes] : [])
            ].filter(x => x !== undefined).join('\n').slice(0, 4000))
            .setFooter({ text: `Saran saja — staf tetap yang kirim di Roblox · batas ${fmt(CFG.PAYOUT_CAP)}/username/community · sisa wajib ${fmt(CFG.STOCK_RESERVE)}` })
            .setTimestamp();
        if (['verified', 'mismatch', 'checking'].includes(plan.status) && plan.found?.length) {
            embed.addFields({ name: '🔎 Terdeteksi di audit log Roblox', value: plan.found.map(f => `• ${byNum(f.num)} → \`${f.username}\` : ${fmt(f.amount)} R$`).join('\n').slice(0, 1024) + `\n**Total: ${fmt(plan.foundTotal)} / ${fmt(plan.robux)} R$**`, inline: false });
        }
        const done = ['verified', 'manual'].includes(plan.status);
        const id = plan.invoiceMessageId;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vx_po_sent_${id}`).setLabel(plan.status === 'mismatch' ? '🔁 Cek Lagi' : '✅ Sudah Dikirim').setStyle(ButtonStyle.Success).setDisabled(done || plan.status === 'checking'),
            new ButtonBuilder().setCustomId(`vx_po_split_${id}`).setLabel('👥 Beberapa Username').setStyle(ButtonStyle.Secondary).setDisabled(done),
            new ButtonBuilder().setCustomId(`vx_po_recalc_${id}`).setLabel('🔄 Hitung Ulang').setStyle(ButtonStyle.Secondary).setDisabled(done),
            new ButtonBuilder().setCustomId(`vx_po_manual_${id}`).setLabel('✔️ Tandai Selesai').setStyle(ButtonStyle.Secondary).setDisabled(done)
        );
        return { embeds: [embed], components: [row] };
    }
    async function editPlanMessage(plan, notes) {
        if (!plan.messageId) return;
        const ch = await client.channels.fetch(plan.channelId).catch(() => null);
        if (ch) await ch.messages.edit(plan.messageId, planPayload(plan, notes)).catch(() => {});
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

    // Dipanggil setelah invoice Community di-Done
    async function onCommunityDone({ channel, invoiceMessageId, buyerId, robux }) {
        if (!core.isOn('asisten_payout') || !robux) return;
        try {
            const username = await formUsername(channel);
            const isPreOrder = /-po/i.test(channel.name || '');
            const recipients = username ? [{ username, amount: robux }] : [];
            const plan = await PayoutPlan.findOneAndUpdate(
                { invoiceMessageId },
                { $setOnInsert: { invoiceMessageId, channelId: channel.id, buyerId, robux, recipients, status: 'planned', doneAt: new Date(), isPreOrder } },
                { upsert: true, new: true }
            );
            if (plan.messageId) return;
            let notes = [];
            if (recipients.length && !isPreOrder) {
                const res = await computePlan(recipients);
                plan.allocations = res.allocations; plan.shortfall = res.shortfall; notes = res.notes;
            } else if (!recipients.length) {
                notes = ['⚠️ Username Roblox tidak ditemukan di form. Tekan **👥 Beberapa Username** untuk mengisi penerima.'];
                plan.shortfall = robux;
            } else {
                notes = ['📦 Pre-Order: rencana dihitung saat stok sudah masuk — tekan **🔄 Hitung Ulang** saat siap kirim.'];
            }
            const msg = await h.discordRetry(() => channel.send(planPayload(plan, notes)));
            plan.messageId = msg.id;
            await plan.save();
        } catch (e) { console.error('[PAYOUT] Gagal membuat rencana payout:', e.message); }
    }

    async function handleButton(interaction) {
        const parts = interaction.customId.split('_'); // vx_po_<aksi>_<invoiceMsgId>
        const action = parts[2], id = parts[3];
        if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner dan Handler.', flags: MessageFlags.Ephemeral });
        const plan = await PayoutPlan.findOne({ invoiceMessageId: id });
        if (!plan) return interaction.reply({ content: '❌ Rencana payout tidak ditemukan.', flags: MessageFlags.Ephemeral });

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
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (!plan.recipients.length) return interaction.editReply({ content: '❌ Isi penerima dulu lewat **👥 Beberapa Username**.' });
            await refreshAll('normal').catch(() => {});
            const res = await computePlan(plan.recipients);
            plan.allocations = res.allocations; plan.shortfall = res.shortfall; plan.status = 'planned';
            await plan.save();
            await editPlanMessage(plan, res.notes);
            return interaction.editReply({ content: '✅ Rencana dihitung ulang dengan saldo & riwayat terbaru.' });
        }
        if (action === 'manual') {
            plan.status = 'manual'; await plan.save();
            await Transaction.updateOne({ key: `inv:${id}` }, { $set: { poOutstanding: false } }).catch(() => {});
            await editPlanMessage(plan);
            h.schedulePanelStockUpdate();
            return interaction.reply({ content: '✔️ Ditandai selesai.', flags: MessageFlags.Ephemeral });
        }
        if (action === 'sent') {
            if (!plan.recipients.length) return interaction.reply({ content: '❌ Isi penerima dulu lewat **👥 Beberapa Username**.', flags: MessageFlags.Ephemeral });
            plan.status = 'checking'; plan.checkAttempts = 0; plan.nextCheckAt = new Date(Date.now() + CHECK_DELAYS[0]);
            await plan.save();
            await editPlanMessage(plan);
            return interaction.reply({ content: '🔎 Oke, bot akan mengecek audit log Roblox beberapa kali dalam ±15 menit ke depan.', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: '❌ Aksi tidak dikenal.', flags: MessageFlags.Ephemeral });
    }

    async function handleModal(interaction) {
        const id = interaction.customId.replace('vx_pom_', '');
        if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner dan Handler.', flags: MessageFlags.Ephemeral });
        const plan = await PayoutPlan.findOne({ invoiceMessageId: id });
        if (!plan) return interaction.reply({ content: '❌ Rencana tidak ditemukan.', flags: MessageFlags.Ephemeral });
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
        const res = await computePlan(recipients);
        plan.recipients = recipients; plan.allocations = res.allocations; plan.shortfall = res.shortfall; plan.status = 'planned';
        await plan.save();
        await editPlanMessage(plan, res.notes);
        return interaction.editReply({ content: '✅ Penerima diperbarui & rencana dihitung ulang.' });
    }

    // ---------------- Verifikasi otomatis (tahan restart) ----------------
    let verifying = false;
    async function verifyTick() {
        if (verifying || !client.isReady()) return;
        verifying = true;
        try {
            const due = await PayoutPlan.find({ status: 'checking', nextCheckAt: { $lte: new Date() } }).limit(5);
            if (!due.length) return;
            await refreshAll('normal');
            // Payout yang sudah "dipakai" tiket lain (username sama) tidak dihitung lagi untuk rencana ini
            const others = await PayoutPlan.find({ status: { $in: ['verified', 'checking', 'mismatch'] }, claimedKeys: { $exists: true } }).select('invoiceMessageId claimedKeys').lean();
            for (const plan of due) {
                const since = new Date(plan.doneAt).getTime() - 5 * 60 * 1000;
                const claimedByOthers = new Set(others.filter(o => o.invoiceMessageId !== plan.invoiceMessageId).flatMap(o => o.claimedKeys || []));
                const found = [];
                const keys = [];
                let ok = true;
                for (const r of plan.recipients) {
                    const u = await eligible.resolveUser(r.username).catch(() => null);
                    const names = u ? [u.name.toLowerCase(), (u.displayName || '').toLowerCase()] : [r.username.toLowerCase()];
                    // ambil payout dari yang paling awal sejak Done, sampai jumlahnya cukup
                    const entries = [];
                    for (const num of Object.keys(ledgers)) {
                        if (!ledgers[num].ready) continue;
                        for (const x of ledgers[num].entries) if (x.ts >= since && names.includes(x.name) && !claimedByOthers.has(`${num}:${x.key}`)) entries.push({ num, ...x });
                    }
                    entries.sort((a, b) => a.ts - b.ts);
                    let sum = 0;
                    const per = {};
                    for (const x of entries) {
                        if (sum >= r.amount) break;
                        sum += x.amount; per[x.num] = (per[x.num] || 0) + x.amount; keys.push(`${x.num}:${x.key}`);
                    }
                    for (const [num, amt] of Object.entries(per)) found.push({ num, username: u?.name || r.username, amount: amt });
                    if (sum < r.amount) ok = false;
                }
                plan.claimedKeys = keys;
                const notReady = Object.values(ledgers).some(L => !L.ready);
                plan.found = found;
                plan.foundTotal = found.reduce((s, f) => s + f.amount, 0);
                plan.checkAttempts += 1;
                if (ok) {
                    plan.status = 'verified';
                    await Transaction.updateOne({ key: `inv:${plan.invoiceMessageId}` }, { $set: { poOutstanding: false } }).catch(() => {});
                    h.schedulePanelStockUpdate();
                    core.stat('payout_terverifikasi');
                } else if (plan.checkAttempts >= CHECK_DELAYS.length) {
                    plan.status = 'mismatch';
                    core.alarm(`payout_${plan.invoiceMessageId}`, `⚠️ **Payout belum cocok** di <#${plan.channelId}>: terdeteksi ${fmt(plan.foundTotal)} dari ${fmt(plan.robux)} R$${notReady ? ' (sebagian riwayat community belum termuat)' : ''}. Cek salah username / nominal.`, 24 * 60 * 60 * 1000);
                } else {
                    plan.nextCheckAt = new Date(Date.now() + CHECK_DELAYS[plan.checkAttempts]);
                }
                await plan.save();
                await editPlanMessage(plan);
            }
        } catch (e) {
            console.error('[PAYOUT] Verifikasi error:', e.message);
        } finally { verifying = false; }
    }

    async function onChannelDelete(channelId) {
        await PayoutPlan.updateMany({ channelId, status: { $in: ['planned', 'checking'] } }, { $set: { status: 'manual' } }).catch(() => {});
    }

    function start() {
        setTimeout(() => refreshAll('low').catch(() => {}), 60000);
        setInterval(() => refreshAll('low').catch(() => {}), 4 * 60 * 1000);
        setInterval(verifyTick, 30 * 1000);
    }

    return { start, refreshAll, computePlan, onCommunityDone, handleButton, handleModal, verifyTick, onChannelDelete, ledgers, planPayload, parseEntry };
};
