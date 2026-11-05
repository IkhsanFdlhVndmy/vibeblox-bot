// =====================================================================
// OPERASIONAL: tiket tanpa kabar, laporan harian/mingguan/bulanan, alarm, balasan cepat
// =====================================================================
const { EmbedBuilder, MessageFlags } = require('discord.js');

const TYPE_LABEL = { community: 'Community', gamepass_after: 'Gamepass After', gamepass_before: 'Gamepass Before', gig: 'GIG', vilog: 'Vilog', robux_plus: 'Robux Plus' };
const METHOD_LABEL = { qris: 'QRIS', bca: 'BCA', dana: 'Dana', gopay: 'GoPay', lainnya: 'Lainnya' };
const STAT_LABEL = {
    tiket_dibuka: '🎫 Tiket dibuka', tiket_ditutup: '🔒 Tiket ditutup', tiket_mati_ditutup: '💤 Tiket tanpa kabar ditutup',
    invoice_dibuat: '🧾 Invoice dibuat', invoice_batal: '❌ Invoice dibatalkan', bukti_bayar: '📸 Bukti bayar masuk',
    vouch: '🗣️ Vouch masuk', tiket_ditolak_ketat: '⛔ Tiket ditolak (mode Ketat)'
};

const QUICK_REPLIES = {
    antre: 'Halo! Pesanan kamu sudah kami terima dan sedang **dalam antrean**. Mohon ditunggu ya, admin akan segera memproses 🙏',
    bukti: 'Setelah transfer, kirim **screenshot bukti pembayaran** di tiket ini ya. Pastikan nominalnya **persis** sama dengan **Total Bayar** (termasuk kode unik) 🙏',
    username: 'Mohon kirim **username Roblox** (bukan display name) yang benar ya. Contoh: `vibeblox123`.',
    eligible: 'Untuk Robux Community, username wajib sudah **join community kami minimal 14 hari**. Cek status kapan saja dengan `/cek-eligible` di <#1504349336559947818>.',
    terkirim_commun: '✅ **Robux sudah dikirim** lewat payout community! Cek di Roblox → menu Robux → **My Transactions**. Terima kasih sudah order di VibeBlox 💜',
    selesai: '✅ Pesanan kamu **sudah selesai diproses**. Silakan dicek ya! Terima kasih sudah order di VibeBlox 💜',
    vouch: 'Jangan lupa kirim **vouch** di <#1488903383963406507> ya, teksnya sudah ada di atas tinggal salin 🙏',
    po: 'Pesanan ini **Pre-Order**: Robux dikirim setelah stok masuk. Admin akan mengabari di tiket ini begitu stok siap 🙏'
};
const QUICK_CHOICES = [
    { name: 'Sedang antre', value: 'antre' }, { name: 'Minta bukti bayar', value: 'bukti' },
    { name: 'Minta username yang benar', value: 'username' }, { name: 'Syarat eligible 14 hari', value: 'eligible' },
    { name: 'Robux Community terkirim', value: 'terkirim_commun' }, { name: 'Pesanan selesai', value: 'selesai' },
    { name: 'Ingatkan vouch', value: 'vouch' }, { name: 'Info Pre-Order', value: 'po' }
];

module.exports = function createOperasional(ctx, core, stok) {
    const { client, models, h } = ctx;
    const { Ticket, Transaction, DailyStat, InvoiceRecord, InvoiceTracker, TicketVouch, PayoutPlan } = models;
    const CFG = core.CFG;
    const fmt = core.fmt, rp = core.rp;

    // ---------------- Tiket tanpa kabar ----------------
    let idleRunning = false;
    async function idleSweep() {
        if (idleRunning || !client.isReady() || !core.isOn('tiket_mati')) return;
        idleRunning = true;
        try {
            const tickets = await Ticket.find({}).lean();
            let closedThisRound = 0;
            for (const t of tickets) {
                try {
                    if (closedThisRound >= 3) break; // jangan menutup banyak sekaligus
                    if (t.autoClose?.state && t.autoClose.state !== 'cancelled') continue; // diurus auto-close
                    if (t.idle?.cancelled) continue;
                    const channel = client.channels.cache.get(t.channelId);
                    if (!channel || !h.TICKET_CATEGORY_IDS.includes(channel.parentId)) continue;
                    if (/-po/i.test(channel.name)) continue; // Pre-Order bisa lama menunggu stok
                    const created = t.createdAt ? new Date(t.createdAt).getTime() : channel.createdTimestamp;
                    if (Date.now() - created < CFG.IDLE_TICKET_MS) continue;
                    const lastId = channel.lastMessageId;
                    const lastTs = lastId ? core.snowflakeTime(lastId) : created;
                    if (!t.idle?.warnedAt && Date.now() - lastTs < CFG.IDLE_TICKET_MS) continue; // cek cepat tanpa request

                    // Tiket yang pernah punya invoice / sudah Done tidak diurus fitur ini (diurus auto-close vouch)
                    const [hasRecord, hasTracker, hasVouch] = await Promise.all([
                        InvoiceRecord.exists({ channelId: t.channelId }), InvoiceTracker.exists({ channelId: t.channelId }), TicketVouch.exists({ channelId: t.channelId })
                    ]);
                    if (hasRecord || hasTracker || hasVouch) continue;
                    const msgs = [...(await channel.messages.fetch({ limit: 100, cache: false })).values()];
                    if (msgs.some(m => h.acIsInvoiceMessage(m))) continue;
                    const lastHuman = msgs.filter(m => !m.author.bot).sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
                    const lastHumanTs = lastHuman ? lastHuman.createdTimestamp : created;

                    if (t.idle?.warnedAt) {
                        const warned = new Date(t.idle.warnedAt).getTime();
                        if (lastHumanTs > warned) { await Ticket.updateOne({ channelId: t.channelId }, { $set: { 'idle.warnedAt': null } }); continue; }
                        if (Date.now() - warned < CFG.IDLE_CLOSE_AFTER_WARN_MS) continue;
                        const r = await h.acWithLock(t.channelId, async () => {
                            const fresh = await Ticket.findOne({ channelId: t.channelId });
                            if (!fresh || (fresh.autoClose?.state && fresh.autoClose.state !== 'cancelled') || !fresh.idle?.warnedAt) return { ok: false };
                            return h.closeTicketWithTranscript(channel, fresh, {
                                closedByText: '🤖 Otomatis (tiket tanpa kabar 12 jam)',
                                strictAttachments: true,
                                beforeDelete: async (lastMessageId) => {
                                    const newer = [...(await channel.messages.fetch({ limit: 50, after: lastMessageId, cache: false })).values()];
                                    if (newer.some(m => !m.author.bot)) return 'ada pesan baru di tiket';
                                    if (newer.some(m => h.acIsInvoiceMessage(m))) return 'ada invoice baru';
                                    return null;
                                }
                            });
                        });
                        if (r && r.ok) { closedThisRound++; core.stat('tiket_mati_ditutup'); }
                        else if (r && r.activity) await Ticket.updateOne({ channelId: t.channelId }, { $set: { 'idle.warnedAt': null } });
                        await new Promise(res => setTimeout(res, 3000));
                        continue;
                    }
                    if (Date.now() - lastHumanTs < CFG.IDLE_TICKET_MS) continue;
                    await h.discordRetry(() => channel.send({
                        content: `<@${t.creatorId}> 💤 Tiket ini **tidak ada kabar selama 12 jam**. Tiket akan **ditutup otomatis <t:${Math.floor((Date.now() + CFG.IDLE_CLOSE_AFTER_WARN_MS) / 1000)}:R>** jika tidak ada balasan.\nMasih ada keperluan? Cukup balas pesan apa saja di sini.`,
                        allowedMentions: { users: [t.creatorId] }
                    }));
                    await Ticket.updateOne({ channelId: t.channelId }, { $set: { 'idle.warnedAt': new Date() } });
                } catch (e) {
                    console.error(`[TIKET MATI] Gagal proses ${t.channelId}:`, e.message);
                }
            }
        } catch (e) {
            console.error('[TIKET MATI] Sweep error:', e.message);
        } finally { idleRunning = false; }
    }

    // ---------------- Laporan ----------------
    async function periodData(startMs, endMs) {
        const tx = await Transaction.find({ createdAt: { $gte: new Date(startMs), $lt: new Date(endMs) } }).lean();
        const income = tx.filter(t => t.source !== 'expense');
        const expense = tx.filter(t => t.source === 'expense');
        const sum = (arr) => arr.reduce((s, t) => s + (t.direction || 1) * (t.amount || 0), 0);
        const sales = income.filter(t => (t.source === 'invoice' || t.source === 'partner' || t.legacy) && t.direction > 0);
        const by = (arr, keyFn) => {
            const m = {};
            for (const t of arr) { const k = keyFn(t); if (!k) continue; m[k] = (m[k] || 0) + (t.direction || 1) * (t.amount || 0); }
            return Object.entries(m).sort((a, b) => b[1] - a[1]);
        };
        const robuxByType = {};
        for (const t of income) if (t.robux && t.type) robuxByType[t.type] = (robuxByType[t.type] || 0) + t.robux * (t.direction || 1);
        const topBuyers = by(income, t => t.buyerId ? `<@${t.buyerId}>` : (t.buyerName ? `@${t.buyerName}` : null)).slice(0, 5);
        const days = [];
        for (let d = startMs; d < endMs; d += 86400000) days.push(core.dayKey(new Date(d)));
        const stats = await DailyStat.find({ day: { $in: days } }).lean();
        const counters = {};
        for (const s of stats) for (const [k, v] of Object.entries(s.counters || {})) counters[k] = (counters[k] || 0) + v;
        return {
            omzet: sum(income), expense: sum(expense), count: sales.length,
            avg: sales.length ? Math.round(sales.reduce((s, t) => s + t.amount, 0) / sales.length) : 0,
            max: sales.reduce((m, t) => Math.max(m, t.amount), 0),
            utama: sum(income.filter(t => t.sumber !== 'partner')), partner: sum(income.filter(t => t.sumber === 'partner')),
            manual: sum(income.filter(t => t.source === 'manual')),
            byType: by(income, t => TYPE_LABEL[t.type] || (t.source === 'manual' ? 'Manual' : null)),
            byMethod: by(income, t => METHOD_LABEL[t.method] || null),
            robuxByType, topBuyers, counters
        };
    }
    const pct = (now, before) => (!before ? (now ? ' 🆕' : '') : ` (${now >= before ? '▲' : '▼'} ${Math.abs(Math.round((now - before) / Math.abs(before) * 100))}%)`);

    async function buildReport(kind, key, late = false) {
        // kind: harian | mingguan | bulanan ; key: dayKey hari terakhir periode
        let startKey = key, title;
        if (kind === 'harian') title = `📊 Laporan Harian — ${key}`;
        if (kind === 'mingguan') { startKey = core.addDays(key, -6); title = `📅 Laporan Mingguan — ${startKey} s/d ${key}`; }
        if (kind === 'bulanan') { startKey = `${key.slice(0, 7)}-01`; title = `🗓️ Laporan Bulanan — ${key.slice(0, 7)}`; }
        const start = core.dayStart(startKey).getTime();
        const end = core.dayStart(core.addDays(key, 1)).getTime();
        const len = end - start;
        let prevStart = start - len, prevEnd = start;
        if (kind === 'bulanan') { const pk = core.addDays(startKey, -1); prevStart = core.dayStart(`${pk.slice(0, 7)}-01`).getTime(); prevEnd = start; }
        const [cur, prev] = await Promise.all([periodData(start, end), periodData(prevStart, prevEnd)]);
        const prevLabel = kind === 'harian' ? 'kemarin' : (kind === 'mingguan' ? 'minggu lalu' : 'bulan lalu');

        const embed = new EmbedBuilder().setColor(0x4F4580).setTitle(`${title}${late ? ' (terlambat — bot sempat offline)' : ''}`).setTimestamp();
        embed.addFields(
            { name: '💰 Omzet', value: `**${rp(cur.omzet)}**${pct(cur.omzet, prev.omzet)}\n-# ${prevLabel}: ${rp(prev.omzet)}`, inline: true },
            { name: '💸 Uang Keluar', value: `${rp(cur.expense)}`, inline: true },
            { name: '📈 Omzet − Uang Keluar', value: `**${rp(cur.omzet - cur.expense)}**`, inline: true },
            { name: '🧾 Transaksi Selesai', value: `${cur.count}${pct(cur.count, prev.count)}`, inline: true },
            { name: '📊 Rata-rata / Terbesar', value: `${rp(cur.avg)} / ${rp(cur.max)}`, inline: true },
            { name: '🏪 Utama / Partner', value: `${rp(cur.utama)} / ${rp(cur.partner)}${cur.manual ? `\n-# termasuk manual ${rp(cur.manual)}` : ''}`, inline: true }
        );
        if (cur.byType.length) embed.addFields({ name: '🛒 Per Tipe', value: cur.byType.map(([k, v]) => `• ${k}: ${rp(v)}${cur.robuxByType[Object.keys(TYPE_LABEL).find(t => TYPE_LABEL[t] === k)] ? ` · ${fmt(cur.robuxByType[Object.keys(TYPE_LABEL).find(t => TYPE_LABEL[t] === k)])} R$` : ''}`).join('\n').slice(0, 1024), inline: true });
        if (cur.byMethod.length) embed.addFields({ name: '💳 Per Metode Bayar', value: cur.byMethod.map(([k, v]) => `• ${k}: ${rp(v)}`).join('\n').slice(0, 1024), inline: true });
        if (cur.topBuyers.length) embed.addFields({ name: '🏆 Pembeli Terbesar', value: cur.topBuyers.map(([k, v], i) => `${i + 1}. ${k} — ${rp(v)}`).join('\n').slice(0, 1024), inline: false });
        const cl = Object.entries(STAT_LABEL).filter(([k]) => cur.counters[k]).map(([k, l]) => `${l}: **${cur.counters[k]}**`);
        if (cl.length) embed.addFields({ name: '⚙️ Operasional', value: cl.join('\n'), inline: false });

        if (kind === 'harian') {
            try {
                const funds = h.getPanelFunds().data, pending = h.getPendingCache();
                const lines = Object.entries(h.RESTOCK_COMMUNITIES).map(([n, g]) => {
                    const f = funds[n]; const p = pending[n]?.pending;
                    return `**C${n} ${g.name}**\n└ Saldo ${typeof f === 'number' ? `${fmt(f)} · Jual ${fmt(stok.sellable(f))}` : '?'}${typeof p === 'number' ? ` · Pending ${fmt(p)}` : ''}`;
                });
                const po = await stok.poStatus();
                const [openTickets, pendingVouch, waiting, openInv] = await Promise.all([
                    Ticket.countDocuments({}), TicketVouch.countDocuments({ vouched: false }), InvoiceRecord.countDocuments({ status: 'waiting' }),
                    InvoiceRecord.countDocuments({ status: 'open' })
                ]);
                embed.addFields(
                    { name: '📦 Stok Community (saat laporan)', value: `${lines.join('\n')}\n**PO:** kuota ${fmt(po.quota)} · terpakai ${fmt(po.used)} · sisa ${fmt(po.left)}`.slice(0, 1024), inline: false },
                    { name: '📌 Masih Terbuka', value: `🎫 Tiket aktif: **${openTickets}**\n🧾 Invoice belum dibayar: **${openInv}**\n🟡 Menunggu verifikasi: **${waiting}**\n🗣️ Belum vouch: **${pendingVouch}**`, inline: false }
                );
            } catch (e) { /* bagian snapshot opsional */ }
        }
        return embed;
    }

    let reportRunning = false;
    async function reportTick() {
        if (reportRunning || !client.isReady() || !core.isOn('laporan')) return;
        reportRunning = true;
        try {
            const now = new Date();
            const w = core.wibDate(now);
            const passed = w.getUTCHours() > CFG.REPORT_HOUR || (w.getUTCHours() === CFG.REPORT_HOUR && w.getUTCMinutes() >= CFG.REPORT_MINUTE);
            const today = core.dayKey(now);
            const target = passed ? today : core.addDays(today, -1);
            let last = await core.getState('report_last_day');
            if (!last) { last = target; await core.setState('report_last_day', last); } // pertama kali dipasang: mulai dari laporan berikutnya
            let guard = 0;
            while (last < target && guard++ < 3) {
                const day = core.addDays(last, 1);
                const late = day !== today;
                await core.sendTo(CFG.CHANNEL_LAPORAN, { embeds: [await buildReport('harian', day, late)] });
                const wd = new Date(core.dayStart(day).getTime() + 7 * 3600000).getUTCDay(); // 0 = Minggu
                if (wd === 0) await core.sendTo(CFG.CHANNEL_LAPORAN, { embeds: [await buildReport('mingguan', day, late)] });
                if (core.addDays(day, 1).slice(8) === '01') await core.sendTo(CFG.CHANNEL_LAPORAN, { embeds: [await buildReport('bulanan', day, late)] });
                last = day;
                await core.setState('report_last_day', last);
            }
            if (last < target) await core.setState('report_last_day', target); // bot mati >3 hari: lewati sisanya
        } catch (e) {
            console.error('[LAPORAN] Gagal kirim laporan:', e.message);
        } finally { reportRunning = false; }
    }

    async function handleLaporanCommand(interaction) {
        if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner dan Handler.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const periode = interaction.options.getString('periode') || 'hari_ini';
        const today = core.dayKey();
        let embed;
        if (periode === 'hari_ini') embed = await buildReport('harian', today);
        else if (periode === 'kemarin') embed = await buildReport('harian', core.addDays(today, -1));
        else if (periode === 'minggu') embed = await buildReport('mingguan', today);
        else embed = await buildReport('bulanan', today);
        return interaction.editReply({ embeds: [embed] });
    }

    // ---------------- Alarm ----------------
    async function cookieCheck() {
        if (!core.isOn('alarm') || !client.isReady()) return;
        try {
            await h.rbxRun({ priority: 'low', gapAfter: 500, run: () => h.axios.get('https://users.roblox.com/v1/users/authenticated', { headers: { Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` } }) });
            core.clearAlarm('cookie');
        } catch (e) {
            if (e.response?.status === 401) core.alarm('cookie', '🚨 **Cookie akun dummy Roblox MATI / kedaluwarsa.** Panel stock, cek eligible, cek transaksi & asisten payout tidak akan jalan. Ganti `ROBLOX_COOKIE` di `.env` lalu restart bot.', 3 * 60 * 60 * 1000);
        }
    }
    let wasPaused = false;
    const pauseTimes = [];
    function rateLimitWatch() {
        const p = h.rbxIsPaused();
        if (p && !wasPaused) {
            pauseTimes.push(Date.now());
            while (pauseTimes.length && Date.now() - pauseTimes[0] > 60 * 60 * 1000) pauseTimes.shift();
            if (pauseTimes.length >= 3) core.alarm('ratelimit', `⚠️ Akun dummy kena **rate limit Roblox ${pauseTimes.length}x dalam 1 jam**. Bot otomatis mengerem, tapi kalau sering terjadi kurangi pemakaian /cek-transaksi berturut-turut.`, 2 * 60 * 60 * 1000);
        }
        wasPaused = p;
    }
    let dbDownTimer = null;
    function watchMongo(mongoose) {
        mongoose.connection.on('disconnected', () => {
            if (dbDownTimer) return;
            dbDownTimer = setTimeout(() => { core.alarm('mongo', '🚨 **Database MongoDB terputus lebih dari 2 menit.** Sebagian besar fitur bot macet sampai tersambung lagi.', 60 * 60 * 1000); }, 2 * 60 * 1000);
        });
        mongoose.connection.on('reconnected', () => { if (dbDownTimer) { clearTimeout(dbDownTimer); dbDownTimer = null; } core.clearAlarm('mongo'); });
    }

    // ---------------- Balasan cepat ----------------
    async function handleBalas(interaction) {
        if (!core.isStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus staf.', flags: MessageFlags.Ephemeral });
        const key = interaction.options.getString('template');
        let text = QUICK_REPLIES[key];
        if (!text) return interaction.reply({ content: '❌ Template tidak dikenal.', flags: MessageFlags.Ephemeral });
        const ticket = await Ticket.findOne({ channelId: interaction.channel.id }).lean().catch(() => null);
        if (key === 'po') {
            const r = await stok.nearestRestock();
            text += `\n🕐 Estimasi stok masuk: ${stok.etaText(r)}`;
        }
        const mention = ticket?.creatorId ? `<@${ticket.creatorId}> ` : '';
        await interaction.channel.send({ content: `${mention}${text}`, allowedMentions: { users: ticket?.creatorId ? [ticket.creatorId] : [] } });
        return interaction.reply({ content: '✅ Terkirim.', flags: MessageFlags.Ephemeral });
    }

    function start(mongoose) {
        setInterval(idleSweep, 10 * 60 * 1000);
        setTimeout(idleSweep, 3 * 60 * 1000);
        setInterval(reportTick, 60 * 1000);
        setTimeout(reportTick, 40 * 1000);
        setInterval(cookieCheck, 15 * 60 * 1000);
        setTimeout(cookieCheck, 90 * 1000);
        setInterval(rateLimitWatch, 15 * 1000);
        if (mongoose) watchMongo(mongoose);
    }

    return { start, idleSweep, buildReport, reportTick, handleLaporanCommand, handleBalas, cookieCheck, periodData, QUICK_CHOICES };
};
