// =====================================================================
// RIWAYAT TRANSAKSI: pencatatan per transaksi, impor log lama, /riwayat
// =====================================================================
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

const TYPE_LABEL = { community: 'Community', gamepass_after: 'Gamepass After', gamepass_before: 'Gamepass Before', gig: 'GIG', vilog: 'Vilog', robux_plus: 'Robux Plus' };
const LABEL_TYPE = Object.fromEntries(Object.entries(TYPE_LABEL).map(([k, v]) => [v.toLowerCase(), k]));
const METHOD_LABEL = { qris: 'QRIS', bca: 'BCA', dana: 'Dana', gopay: 'GoPay', lainnya: 'Lainnya' };
const SPENDER_TIERS = [
    [50000000, 'Vibe Immortal'], [25000000, 'Vibe Sovereign'], [10000000, 'Vibe Beast'],
    [5000000, 'Prime'], [1000000, 'Elite'], [1, 'Client']
];
const PAGE_SIZE = 10;
const isPO = (name) => /-po(-done)?$/i.test(name || '') || /-po-/i.test(name || '');

module.exports = function createRiwayat(ctx, core) {
    const { client, models } = ctx;
    const { Transaction, User } = models;

    // ---------------- Pencatatan transaksi baru ----------------
    // Dipanggil SEBELUM uang dicatat. Kunci unik = 1 invoice hanya bisa dihitung 1x.
    async function beginDone(rec) {
        const doc = {
            key: rec.key, source: rec.source, direction: 1,
            buyerId: rec.buyerId || null,
            buyerName: rec.buyerName ? String(rec.buyerName).toLowerCase() : null,
            amount: rec.amount || 0, robux: rec.robux ?? null, type: rec.type || null,
            category: rec.category || null, method: rec.method || null, sumber: rec.sumber || 'utama',
            channelId: rec.channel?.id || null, channelName: rec.channel?.name || null,
            staffId: rec.staffId || null, partnerId: rec.partnerId || null,
            kodeUnik: rec.kodeUnik || 0,
            isPreOrder: isPO(rec.channel?.name),
            poOutstanding: rec.type === 'community' && isPO(rec.channel?.name) && core.isOn('asisten_payout'),
            createdAt: new Date()
        };
        try {
            await Transaction.create(doc);
            return { ok: true };
        } catch (e) {
            if (e?.code === 11000) {
                const existing = await Transaction.findOne({ key: rec.key }).lean().catch(() => null);
                return { duplicate: true, existing };
            }
            // Database bermasalah: JANGAN blokir alur lama (perilaku sama seperti sebelum fitur ini ada)
            console.error('[RIWAYAT] Gagal catat transaksi (alur tetap lanjut):', e.message);
            return { ok: false, error: e.message };
        }
    }
    async function abortDone(key) {
        await Transaction.deleteOne({ key }).catch(e => console.error('[RIWAYAT] Gagal batalkan catatan:', e.message));
    }

    async function recordManual({ id, add, target, amount, sumber, keterangan, staffId }) {
        try {
            await Transaction.create({
                key: `man:${id}`, source: 'manual', direction: add ? 1 : -1,
                buyerId: target?.id || null, buyerName: target?.username ? target.username.toLowerCase() : null,
                amount, category: keterangan || null, sumber: sumber || 'utama', staffId, createdAt: new Date()
            });
        } catch (e) {
            if (e?.code !== 11000) console.error('[RIWAYAT] Gagal catat uang masuk manual:', e.message);
        }
    }
    async function recordExpense({ id, add, amount, keterangan, staffId }) {
        try {
            await Transaction.create({
                key: `exp:${id}`, source: 'expense', direction: add ? 1 : -1,
                amount, category: keterangan || null, staffId, createdAt: new Date()
            });
        } catch (e) {
            if (e?.code !== 11000) console.error('[RIWAYAT] Gagal catat pengeluaran:', e.message);
        }
    }

    // ---------------- Impor log keuangan lama (1x, bisa lanjut setelah restart) ----------------
    const digits = (v) => parseInt(String(v || '').replace(/[^\d]/g, ''), 10) || 0;
    const field = (embed, word) => (embed.fields || []).find(f => (f.name || '').includes(word));
    function parseLegacy(msg) {
        if (msg.author?.id !== client.user.id) return null;
        const e = msg.embeds?.[0];
        if (!e?.title) return null;
        const title = e.title;
        const base = { key: `imp:${msg.id}`, source: 'import', legacy: true, createdAt: msg.createdAt, channelId: null };
        const staffId = msg.interactionMetadata?.user?.id || msg.interaction?.user?.id || null;
        const pembeli = field(e, 'Pembeli')?.value || '';
        const idMatch = pembeli.match(/<@!?(\d+)>/);
        const nameMatch = pembeli.match(/@([\w.]+)\)/);

        if (title === '✅ Uang Masuk Dicatat!') { // Done invoice utama
            const kat = field(e, 'Kategori')?.value || '';
            const [tLabel, mLabel] = kat.split(' - ');
            return { ...base, direction: 1, sumber: 'utama', buyerId: idMatch?.[1] || null, buyerName: nameMatch?.[1]?.toLowerCase() || null,
                amount: digits(field(e, 'Nominal')?.value), category: kat || null,
                type: LABEL_TYPE[(tLabel || '').trim().toLowerCase()] || null, method: (mLabel || '').trim().toLowerCase() || null, note: 'invoice' };
        }
        if (title === '🤝 Uang Masuk Partner Dicatat!') {
            const kat = field(e, 'Kategori')?.value || '';
            const partner = (field(e, 'Partner')?.value || '').match(/<@!?(\d+)>/);
            return { ...base, direction: 1, sumber: 'partner', buyerId: idMatch?.[1] || null, buyerName: null,
                amount: digits(field(e, 'Nominal')?.value), category: kat || null,
                type: LABEL_TYPE[kat.trim().toLowerCase()] || null, partnerId: partner?.[1] || null, note: 'partner' };
        }
        if (title.startsWith('✅ Uang Masuk Dicatat! (')) { // /adduangmasuk
            return { ...base, direction: 1, sumber: title.includes('Partner') ? 'partner' : 'utama',
                buyerId: idMatch?.[1] || null, buyerName: idMatch ? null : pembeli.trim().toLowerCase() || null,
                amount: digits(field(e, 'Nominal')?.value), category: field(e, 'Kategori')?.value || null, staffId, note: 'manual' };
        }
        if (title.startsWith('📉 Revisi Uang Masuk')) { // /minuangmasuk
            return { ...base, direction: -1, sumber: title.includes('Partner') ? 'partner' : 'utama',
                buyerId: idMatch?.[1] || null, buyerName: idMatch ? null : pembeli.trim().toLowerCase() || null,
                amount: digits(field(e, 'Dikurangi')?.value), staffId, note: 'manual' };
        }
        if (title === '💸 Pengeluaran Toko Dicatat!' || title === '📉 Revisi Pengeluaran Toko') {
            return { ...base, source: 'expense', direction: title.startsWith('💸') ? 1 : -1,
                amount: digits(field(e, title.startsWith('💸') ? 'Nominal' : 'Dikurangi')?.value),
                category: field(e, 'Keterangan')?.value || null, staffId, note: 'expense' };
        }
        return null;
    }

    let importRunning = false;
    async function runImport() {
        if (importRunning) return;
        importRunning = true;
        try {
            let state = await core.getState('import_v1');
            if (!state) {
                state = { cutoff: new Date().toISOString(), channels: {}, finished: false };
                await core.setState('import_v1', state);
            }
            if (state.finished) return;
            const cutoffMs = new Date(state.cutoff).getTime();
            const cutoffSnowflake = String((BigInt(cutoffMs) - 1420070400000n) << 22n);

            for (const chId of core.CFG.FINANCE_CHANNELS) {
                const st = state.channels[chId] || { before: null, done: false, count: 0 };
                if (st.done) continue;
                const channel = await client.channels.fetch(chId).catch(e => ({ __err: e }));
                if (!channel || channel.__err) {
                    console.error(`[RIWAYAT] Impor: channel ${chId} tidak bisa dibuka (${channel?.__err?.code || '?'}), dilewati.`);
                    st.done = true; st.error = 'tidak bisa dibuka';
                    state.channels[chId] = st; await core.setState('import_v1', state);
                    continue;
                }
                for (let page = 0; page < 2000 && !st.done; page++) {
                    let batch;
                    try {
                        batch = await channel.messages.fetch({ limit: 100, before: st.before || cutoffSnowflake, cache: false });
                    } catch (e) {
                        console.error(`[RIWAYAT] Impor ${chId} tertunda (akan dilanjutkan):`, e.message);
                        return; // coba lagi di jadwal berikutnya
                    }
                    const docs = [];
                    for (const m of batch.values()) {
                        const d = parseLegacy(m);
                        if (d && d.amount > 0) docs.push(d);
                    }
                    if (docs.length) {
                        try { await Transaction.insertMany(docs, { ordered: false }); }
                        catch (e) { if (e?.code !== 11000 && !e?.writeErrors) throw e; }
                    }
                    st.count += docs.length;
                    if (batch.size < 100) st.done = true;
                    else st.before = batch.last().id;
                    state.channels[chId] = st;
                    await core.setState('import_v1', state);
                    await new Promise(r => setTimeout(r, 1200));
                }
            }
            state.finished = core.CFG.FINANCE_CHANNELS.every(id => state.channels[id]?.done);
            await core.setState('import_v1', state);
            if (state.finished) {
                const total = Object.values(state.channels).reduce((s, c) => s + (c.count || 0), 0);
                console.log(`✅ [RIWAYAT] Impor log keuangan lama selesai: ${total} transaksi.`);
            }
        } catch (e) {
            console.error('[RIWAYAT] Impor gagal (akan dicoba lagi):', e.message);
        } finally {
            importRunning = false;
        }
    }

    // ---------------- /riwayat ----------------
    function filterFor(user) {
        return {
            source: { $ne: 'expense' },
            $or: [{ buyerId: user.id }, { buyerId: null, buyerName: user.username.toLowerCase() }]
        };
    }
    async function buildRiwayat(user, page, viewerIsStaff) {
        const filter = filterFor(user);
        const [userDoc, count, all] = await Promise.all([
            User.findOne({ userId: user.id }).lean(),
            Transaction.countDocuments(filter),
            Transaction.find(filter).select('amount direction type category createdAt legacy').lean()
        ]);
        const spent = userDoc?.uangMasuk || 0;
        const rank = spent > 0 ? (await User.countDocuments({ uangMasuk: { $gt: spent } })) + 1 : null;
        const tier = SPENDER_TIERS.find(([min]) => spent >= min)?.[1] || '-';
        const sumRecords = all.reduce((s, t) => s + t.direction * t.amount, 0);
        const perType = {};
        for (const t of all) {
            const label = TYPE_LABEL[t.type] || (t.category ? t.category.split(' - ')[0] : 'Lainnya');
            perType[label] = (perType[label] || 0) + t.direction * t.amount;
        }
        const first = all.reduce((m, t) => (!m || t.createdAt < m ? t.createdAt : m), null);
        const last = all.reduce((m, t) => (!m || t.createdAt > m ? t.createdAt : m), null);

        const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
        page = Math.min(Math.max(1, page), totalPages);
        const list = await Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean();
        const lines = list.map(t => {
            const sign = t.direction < 0 ? '−' : '';
            const kat = t.type ? `${TYPE_LABEL[t.type]}${t.method ? ` · ${METHOD_LABEL[t.method] || t.method}` : ''}` : (t.category || (t.source === 'manual' ? 'Manual' : '-'));
            const rbx = t.robux ? ` · ${core.fmt(t.robux)} R$` : '';
            return `<t:${core.ts(t.createdAt)}:d> **${sign}${core.rp(t.amount)}** — ${kat}${rbx}${t.legacy ? ' *(lama)*' : ''}`;
        });

        const embed = new EmbedBuilder()
            .setColor(0x4F4580)
            .setTitle(`🧾 Riwayat Belanja — @${user.username}`)
            .setThumbnail(user.displayAvatarURL?.() || null)
            .addFields(
                { name: '💰 Total Belanja', value: `**${core.rp(spent)}**`, inline: true },
                { name: '🏆 Peringkat', value: rank ? `#${rank}` : '-', inline: true },
                { name: '🎖️ Role Spender', value: tier, inline: true },
                { name: '🧮 Jumlah Transaksi', value: `${count}`, inline: true },
                { name: '📅 Pertama / Terakhir', value: first ? `<t:${core.ts(first)}:d> / <t:${core.ts(last)}:d>` : '-', inline: true }
            );
        const typeLines = Object.entries(perType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `• ${k}: ${core.rp(v)}`);
        if (typeLines.length) embed.addFields({ name: '🛒 Per Kategori', value: typeLines.join('\n'), inline: false });
        embed.addFields({ name: `📜 Transaksi (halaman ${page}/${totalPages})`, value: lines.join('\n') || '_Belum ada transaksi tercatat._', inline: false });
        if (viewerIsStaff && Math.abs(sumRecords - spent) > 0 && count > 0) {
            embed.addFields({ name: '🔎 Catatan Staf', value: `Total dari daftar transaksi: ${core.rp(sumRecords)} (selisih ${core.rp(Math.abs(sumRecords - spent))} dengan Total Belanja — biasanya transaksi lama yang tidak tercatat lengkap / pembeli ganti username).`, inline: false });
        }
        const imp = await core.getState('import_v1');
        embed.setFooter({ text: imp?.finished ? 'Data lama diimpor dari log keuangan · jumlah Robux hanya tersedia untuk transaksi baru' : 'Data lama sedang diimpor dari log keuangan, riwayat lama menyusul' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vx_rw_${user.id}_${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
            new ButtonBuilder().setCustomId(`vx_rw_${user.id}_${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
        );
        return { embeds: [embed], components: totalPages > 1 ? [row] : [] };
    }

    async function handleCommand(interaction) {
        const target = interaction.options.getUser('user') || interaction.user;
        const staff = core.isStaff(interaction.member);
        if (target.id !== interaction.user.id && !staff) {
            return interaction.reply({ content: '❌ Kamu hanya bisa melihat riwayat milikmu sendiri.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            return interaction.editReply(await buildRiwayat(target, 1, staff));
        } catch (e) {
            console.error('[RIWAYAT] /riwayat gagal:', e.message);
            return interaction.editReply({ content: '❌ Gagal memuat riwayat. Coba lagi sebentar.' });
        }
    }
    async function handleButton(interaction) {
        const [, , userId, pageStr] = interaction.customId.split('_');
        const staff = core.isStaff(interaction.member);
        if (userId !== interaction.user.id && !staff) {
            return interaction.reply({ content: '❌ Akses ditolak.', flags: MessageFlags.Ephemeral });
        }
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return interaction.reply({ content: '❌ User tidak ditemukan.', flags: MessageFlags.Ephemeral });
        await interaction.deferUpdate();
        return interaction.editReply(await buildRiwayat(user, parseInt(pageStr, 10) || 1, staff));
    }

    return { beginDone, abortDone, recordManual, recordExpense, runImport, parseLegacy, handleCommand, handleButton, buildRiwayat, isPO, TYPE_LABEL, METHOD_LABEL };
};
