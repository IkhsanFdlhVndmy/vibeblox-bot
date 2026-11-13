// =====================================================================
// FITUR BARU VIBEBLOX — pintu masuk tunggal
// index.js hanya memanggil fungsi-fungsi kecil dari sini (FX.xxx), supaya alur lama tetap utuh.
// Semua fitur punya saklar ON/OFF: /pengaturan
// =====================================================================
const { EmbedBuilder, MessageFlags } = require('discord.js');
const CFG = require('./config');

module.exports = function setupFitur(ctx) {
    const h = ctx.h;
    const core = require('./core')(ctx);
    const riwayat = require('./riwayat')(ctx, core);
    const eligible = require('./eligible')(ctx, core);
    const stok = require('./stok')(ctx, core, riwayat);
    const bayar = require('./pembayaran')(ctx, core, riwayat, stok, eligible);
    const payout = require('./payout')(ctx, core, eligible);
    const ops = require('./operasional')(ctx, core, stok);
    const war = require('./war')(ctx, core, bayar);
    bayar.setOnRobuxChanged((channelId, robux) => { war.syncChannel(channelId, robux).catch(() => {}); });
    // Rencana payout muncul SEBELUM Robux dikirim: saat bukti bayar masuk, atau lewat tombol di invoice
    bayar.setPlanButton((id) => payout.planButton(id));
    bayar.setOnWaiting(async (rec, channel) => {
        if (rec.type === 'community') await payout.ensurePlan({ channel, invoiceMessageId: rec.messageId, buyerId: rec.buyerId, robux: rec.robux });
    });

    const settingChoices = Object.keys(CFG.DEFAULT_SETTINGS).map(k => ({ name: CFG.SETTING_LABELS[k] || k, value: k }));
    const commands = [
        {
            name: 'riwayat', description: 'Lihat riwayat belanja (staf bisa cek pembeli lain)',
            options: [{ name: 'user', description: 'Pembeli yang ingin dicek (khusus staf)', type: 6, required: false }]
        },
        {
            name: 'pengaturan', description: '[Vibe Owner] Nyalakan / matikan fitur otomatis bot',
            options: [
                { name: 'fitur', description: 'Fitur yang diubah (kosongkan untuk melihat semua)', type: 3, required: false, choices: settingChoices },
                { name: 'status', description: 'ON atau OFF', type: 3, required: false, choices: [{ name: 'ON', value: 'on' }, { name: 'OFF', value: 'off' }] }
            ]
        },
        {
            name: 'laporan', description: '[Owner/Handler] Lihat laporan penjualan',
            options: [{ name: 'periode', description: 'Periode laporan', type: 3, required: false, choices: [
                { name: 'Hari ini', value: 'hari_ini' }, { name: 'Kemarin', value: 'kemarin' }, { name: '7 hari terakhir', value: 'minggu' }, { name: 'Bulan ini', value: 'bulan' }
            ] }]
        },
        {
            name: 'balas', description: '[Staf] Kirim balasan cepat ke pembeli di tiket ini',
            options: [{ name: 'template', description: 'Pilih template', type: 3, required: true, choices: ops.QUICK_CHOICES }]
        },
        {
            name: 'restock-sold', description: '[Staf] Tandai stok /restock sudah habis oleh Pre-Order (atau batalkan)',
            options: [
                { name: 'status', description: 'Sold out atau batalkan', type: 3, required: false, choices: [
                    { name: 'Sold Out (habis oleh Pre-Order)', value: 'sold' }, { name: 'Batalkan (stok tersedia lagi)', value: 'open' }
                ] },
                { name: 'pesan', description: 'Link/ID pesan /restock (kosongkan = restock aktif terdekat)', type: 3, required: false }
            ]
        },
        {
            name: 'qris-tes', description: '[Owner/Handler] Buat QRIS bernominal untuk uji bayar (hanya terlihat olehmu)',
            options: [{ name: 'nominal', description: 'Nominal Rupiah, contoh 1000', type: 4, required: true, min_value: 1000, max_value: 10000000 }]
        }
    ];
    const commandNames = new Set(commands.map(c => c.name));

    function owns(interaction) {
        if (interaction.isChatInputCommand?.()) return commandNames.has(interaction.commandName);
        const id = interaction.customId || '';
        return id.startsWith('vx_');
    }

    async function handlePengaturan(interaction) {
        if (!core.isOwner(interaction.member)) return interaction.reply({ content: '❌ Khusus Vibe Owner.', flags: MessageFlags.Ephemeral });
        const key = interaction.options.getString('fitur');
        const status = interaction.options.getString('status');
        if (key && status) {
            await core.setSetting(key, status === 'on');
            if (key === 'antrean_bayar' && status === 'on') bayar.scheduleVerifPanel();
        } else if (key || status) {
            return interaction.reply({ content: '❌ Isi **fitur** dan **status** sekaligus, atau kosongkan keduanya untuk melihat daftar.', flags: MessageFlags.Ephemeral });
        }
        const lines = Object.keys(CFG.DEFAULT_SETTINGS).map(k => `${core.isOn(k) ? '🟢 ON ' : '🔴 OFF'} — ${CFG.SETTING_LABELS[k]}`);
        const embed = new EmbedBuilder().setColor(0x4F4580).setTitle('⚙️ Pengaturan Fitur Otomatis').setDescription(lines.join('\n'))
            .setFooter({ text: 'Ubah: /pengaturan fitur:<nama> status:ON/OFF · tersimpan di database' });
        return interaction.reply({ content: key ? `✅ **${CFG.SETTING_LABELS[key]}** sekarang **${status.toUpperCase()}**.` : undefined, embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    async function handleInteraction(interaction) {
        try {
            if (interaction.isChatInputCommand()) {
                const n = interaction.commandName;
                if (n === 'riwayat') return await riwayat.handleCommand(interaction);
                if (n === 'pengaturan') return await handlePengaturan(interaction);
                if (n === 'laporan') return await ops.handleLaporanCommand(interaction);
                if (n === 'balas') return await ops.handleBalas(interaction);
                if (n === 'restock-sold') return await stok.handleRestockSold(interaction);
                if (n === 'qris-tes') {
                    if (!core.isInvoiceStaff(interaction.member)) return interaction.reply({ content: '❌ Khusus Owner dan Handler.', flags: MessageFlags.Ephemeral });
                    return await bayar.qrisTest(interaction);
                }
                return;
            }
            const id = interaction.customId || '';
            if (interaction.isButton()) {
                if (id.startsWith('vx_rw_')) return await riwayat.handleButton(interaction);
                if (id.startsWith('vx_rmd_')) return await stok.handleReminderButton(interaction);
                if (id === 'vx_watch_community') return await stok.handleWatchButton(interaction);
                if (id.startsWith('vx_dr_')) return await bayar.handleDraftButton(interaction);
                if (id.startsWith('vx_po_')) return await payout.handleButton(interaction);
                if (id.startsWith('vx_plan_')) return await payout.handlePlanButton(interaction);
                if (id.startsWith('vx_paid_')) return await bayar.handlePaidButton(interaction);
            }
            if (interaction.isStringSelectMenu() && id.startsWith('vx_rmdsel_')) return await stok.handleReminderSelect(interaction);
            if (interaction.isModalSubmit()) {
                if (id.startsWith('vx_drm_') || id.startsWith('vx_drb_')) return await bayar.handleDraftModal(interaction);
                if (id.startsWith('vx_pom_')) return await payout.handleModal(interaction);
            }
        } catch (e) {
            console.error('[FITUR] Error interaksi', interaction.customId || interaction.commandName, ':', e.message);
            const msg = { content: '❌ Terjadi kesalahan. Coba lagi sebentar.', flags: MessageFlags.Ephemeral };
            if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg.content }).catch(() => {});
            else await interaction.reply(msg).catch(() => {});
        }
    }

    // ---------------- Hook yang dipanggil dari index.js ----------------
    const safe = (name, fn) => async (...args) => {
        try { return await fn(...args); }
        catch (e) { console.error(`[FITUR] ${name} gagal (alur utama tetap jalan):`, e.message); return null; }
    };

    const FX = {
        core, riwayat, eligible, stok, bayar, payout, ops, war,
        commands, owns, handleInteraction,

        // Transaksi
        beginDone: (rec) => riwayat.beginDone(rec),
        abortDone: safe('abortDone', (key) => riwayat.abortDone(key)),
        afterDone: safe('afterDone', async ({ kind, channel, invoiceMessageId, type, buyerId, robux }) => {
            core.stat('transaksi_selesai');
            if (channel?.id) war.onDone(channel.id).catch(() => {});
            if (kind === 'main') {
                await bayar.onInvoiceDone(invoiceMessageId);
                if (type === 'community') payout.onCommunityDone({ channel, invoiceMessageId, buyerId, robux }).catch(() => {});
            }
            h.schedulePanelStockUpdate();
        }),
        recordManual: safe('recordManual', (d) => riwayat.recordManual(d)),
        recordExpense: safe('recordExpense', (d) => riwayat.recordExpense(d)),
        duplicateDoneMessage: (existing) => `⚠️ Invoice ini **sudah pernah tercatat** sebagai selesai${existing?.createdAt ? ` pada <t:${core.ts(existing.createdAt)}:f>` : ''}, jadi tidak dihitung dua kali.\nKalau ternyata total belanja pembeli belum bertambah, koreksi manual dengan /adduangmasuk.`,

        // Tiket
        beforeTicket: async (interaction, type) => {
            try {
                if (type === 'community') {
                    // Jumlah Robux WAJIB angka yang jelas (dipakai War, draft invoice, auto-close). Username boleh apa saja.
                    let raw = '';
                    try { raw = interaction.fields.getTextInputValue('jml_robux'); } catch (e) {}
                    const robux = bayar.parseRobuxStrict(raw);
                    if (!robux) return { block: `❌ **Tiket belum dibuat — jumlah Robux tidak jelas** (\`${String(raw).slice(0, 40)}\`).\nTulis angkanya saja, contoh: \`1000\`, \`1.000\`, \`1k\`, \`1,5k\`, \`1000 robux\`. Lalu kirim form lagi ya.` };
                    const full = await war.quickBlock(); // War penuh -> pesan "melebihi kapasitas" (tombol juga sudah ditutup)
                    if (full) return { block: full };
                    const gate = await eligible.beforeTicket(interaction, type);
                    if (gate?.block) return gate;
                    if (gate?.mode === 'ketat' && robux > CFG.WAR_MAX_ORDER) {
                        return { block: `❌ **Tiket belum dibuat.** Jumlah **${robux.toLocaleString('id-ID')} Robux** melebihi batas saat War (maks **${CFG.WAR_MAX_ORDER.toLocaleString('id-ID')}** per tiket). Kalau salah ketik, kirim form lagi dengan jumlah yang benar.` };
                    }
                    return gate;
                }
                return await eligible.beforeTicket(interaction, type);
            }
            catch (e) { console.error('[FITUR] Cek sebelum tiket gagal (tiket tetap dibuat):', e.message); return {}; }
        },
        inLockCheck: async (interaction, type, gate) => {
            let msg = null;
            try { msg = await eligible.inLockCheck(interaction, type); }
            catch (e) { console.error('[FITUR] Cek username gagal (tiket tetap dibuat):', e.message); }
            if (msg) return msg;
            // War: pesan Robux dari form (di dalam kunci -> tidak bisa rebutan melebihi kapasitas)
            if (type === 'community') {
                try { return await war.reserve(interaction, gate?.mode); }
                catch (e) {
                    console.error('[WAR] Cek kapasitas gagal:', e.message);
                    await war.abort(interaction).catch(() => {}); // jangan sampai pesanan tercatat tanpa tiket
                    return '❌ Sistem sedang sibuk, tiket belum dibuat. Coba kirim form lagi sebentar.';
                }
            }
            return null;
        },
        warAbort: safe('warAbort', async (interaction) => { eligible.lockAbort(interaction); await war.abort(interaction); }),
        // Sebelum masuk antrean tiket: hanya boleh antre kalau tiketnya masih bisa dibuat (War)
        warAdmit: async (interaction, type, gate) => {
            if (type !== 'community') return null;
            try { return await war.admit(interaction, gate?.mode); }
            catch (e) { console.error('[WAR] Cek antrean gagal:', e.message); return null; } // cek pasti tetap di dalam antrean
        },
        warStartTurn: (interaction) => { try { war.startTurn(interaction); } catch (e) {} },
        warDequeue: (interaction) => { try { war.dequeue(interaction); } catch (e) {} },
        ticketExtraFields: (interaction, type) => { try { return eligible.ticketExtraFields(interaction, type); } catch (e) { return {}; } },
        channelNameFor: (type, baseName, gate) => (type === 'community' && gate?.mode === 'preorder' ? `${baseName}-po` : baseName),
        afterTicketCreated: safe('afterTicketCreated', async ({ channel, type, interaction, gate }) => {
            core.stat('tiket_dibuka');
            eligible.lockCreated(interaction, channel.id);
            await war.attach(interaction, channel.id).catch(() => {});
            if (type === 'community') {
                if (gate?.mode === 'preorder') await stok.postPreOrderInfo(channel);
                await eligible.postEligibility(channel, gate);
            }
            await bayar.createDraft(channel, interaction, type);
        }),
        ticketBlocked: () => core.stat('tiket_ditolak_ketat'),

        // /buttonticket & panel tiket
        applyButtonTicket: (config, tipe, rawStatus) => eligible.applyButtonTicket(config, tipe, rawStatus),
        // War mulai / selesai mengikuti /buttonticket Community. Return { error } atau { info }
        warOnButtonTicket: async (tipe, rawStatus) => {
            if (tipe !== 'community') return {};
            try {
                if (rawStatus === 'ketat') {
                    // tombol dibuka SEKARANG; stok awal dari saldo tersimpan (atau dihitung di belakang)
                    const r = await war.start({ fast: true });
                    if (r.pending) return { info: `\n⚔️ War dibuka. Saldo Roblox sedang dibaca di belakang untuk stok awal — form yang masuk tetap tercatat & ikut dihitung.` };
                    if (r.error) return r;
                    const fmt = (n) => Number(n).toLocaleString('id-ID');
                    return { info: r.resumed
                        ? `\n⚔️ War dilanjutkan (pesanan sebelumnya tetap dihitung). Stok awal: **${fmt(r.war.capacity)}** Robux.`
                        : `\n⚔️ War dimulai. Stok awal: **${fmt(r.war.capacity)}** Robux · tiket ditolak & tombol ditutup otomatis saat stok tersisa **${fmt(CFG.WAR_STOP_REMAINING)}**.${r.war.carried ? `\n-# ${r.war.carried} tiket War sebelumnya yang belum ada invoice-nya ikut dihitung.` : ''}${r.war.full ? `\n⚠️ Stok sudah habis untuk tiket yang masih buka → War langsung **penuh**, tombol Community ditutup.` : ''}` };
                }
                if (rawStatus !== 'disable') await war.stop(); // Normal / Pre-Order: tanpa batas stok
            } catch (e) { console.error('[WAR] /buttonticket:', e.message); }
            return {};
        },
        afterButtonTicket: safe('afterButtonTicket', async (tipe, applied, panelChannelId) => {
            if (tipe === 'community') await stok.onCommunityModeChanged(applied.status ? (applied.modeLabel === 'Pre-Order' ? 'preorder' : 'normal') : 'disable', panelChannelId);
        }),
        panelLabel: (id, label, config) => { try { return eligible.panelLabel(id, label, config); } catch (e) { return label; } },
        extraPanelRows: (config) => { try { return stok.extraPanelRows(config); } catch (e) { return []; } },

        // Panel stock
        panelCommunityLine: (num, grp, val, at) => stok.panelCommunityLine(num, grp, val, at),
        panelCommunityBlock: (num, grp, val, at, p) => stok.panelCommunityBlock(num, grp, val, at, p),
        robuxFormText: (raw) => bayar.robuxFormText(raw),
        sellableFunds: (funds) => stok.sellable(funds),
        decoratePanel: safe('decoratePanel', async (summaryLines) => {
            await stok.decoratePanel(summaryLines);
            summaryLines.push(...await war.panelLines().catch(() => []));
        }),
        onFundsUpdated: (data) => { stok.onFundsUpdated(data).catch(() => {}); },

        // Invoice & pembayaran
        prepareInvoice: async (d) => {
            try { return await bayar.prepareInvoice(d); }
            catch (e) { console.error('[FITUR] Kode unik gagal (invoice tetap dibuat tanpa kode):', e.message); return { kode: 0, total: d.price }; }
        },
        applyKodeToEmbed: (embed, price, kode) => { try { return bayar.applyKodeToEmbed(embed, price, kode); } catch (e) { return embed; } },
        afterMainInvoice: safe('afterMainInvoice', (d) => bayar.afterMainInvoice(d)),
        planButton: (id) => payout.planButton(id),
        paidButton: (id) => bayar.paidButton(id),
        isPOInvoice: (inv) => { const name = ctx.client.channels.cache.get(inv.channelId)?.name || inv.channelName; return riwayat.isPO(name); },
        releaseInvoice: safe('releaseInvoice', (messageId) => bayar.onInvoiceCancelled(messageId)),
        onInvoiceCancelled: safe('onInvoiceCancelled', (messageId) => bayar.onInvoiceCancelled(messageId)),
        buildQrisPayment: safe('buildQrisPayment', (msg) => bayar.buildQrisPayment(msg)),
        onTicketMessage: safe('onTicketMessage', (message) => bayar.onTicketMessage(message)),
        onFormEdited: safe('onFormEdited', (channel, d) => bayar.onFormEdited(channel, d)),

        // Lain-lain
        onVouch: () => core.stat('vouch'),
        onRestockCreated: safe('onRestockCreated', (doc, msg) => stok.onRestockCreated(doc, msg)),
        onChannelDelete: safe('onChannelDelete', async (channel) => {
            if (h.TICKET_CATEGORY_IDS.includes(channel.parentId)) core.stat('tiket_ditutup');
            await bayar.onChannelDelete(channel.id);
            await payout.onChannelDelete(channel.id);
            await war.onChannelDelete(channel.id);
            eligible.forgetChannel(channel.id);
        }),
        onMessageDelete: safe('onMessageDelete', (id) => bayar.onMessageDelete(id)),

        async start(mongoose) {
            await core.loadSettings();
            eligible.start();
            stok.start();
            bayar.start();
            payout.start();
            ops.start(mongoose);
            war.boot();
            const runImport = () => riwayat.runImport().catch(() => {});
            setTimeout(runImport, 60 * 1000);
            setInterval(async () => {
                const st = await core.getState('import_v1').catch(() => null);
                if (!st?.finished) runImport();
            }, 10 * 60 * 1000);
            console.log('✅ [FITUR] Fitur otomatis VibeBlox aktif. Cek /pengaturan untuk saklar ON/OFF.');
        }
    };
    return FX;
};
