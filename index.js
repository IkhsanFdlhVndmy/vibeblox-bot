require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Options, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');
const User = require('./models/User');
const Store = require('./models/Store');
const RobuxRate = require('./models/RobuxRate');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    // === OPTIMASI RAM 0.25GB ===
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 10,
        PresenceManager: 0,
        VoiceStateManager: 0,
        ThreadManager: 0,
        ReactionManager: 0,
        GuildInviteManager: 0,
        GuildMemberManager: 50,
        UserManager: 50
    }),
    sweepers: {
        messages: { interval: 300, lifetime: 600 },
        users: { interval: 600, filter: () => (user) => user.bot && user.id !== client.user?.id }
    }
});

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('📂 Database MongoDB Tersambung!');
        // Initialize default robux rates jika belum ada
        const defaults = [
            { type: 'community', rate: 108 },
            { type: 'gamepass_after', rate: 110 },
            { type: 'gamepass_before', rate: 77 },
            { type: 'gig', rate: 77 },
            { type: 'vilog', rate: 70000 },
            { type: 'robux_plus', rate: 135 }
        ];
        for (const d of defaults) {
            await RobuxRate.findOneAndUpdate(
                { type: d.type },
                { $setOnInsert: { rate: d.rate } },
                { upsert: true }
            );
        }
    })
    .catch(err => console.error('❌ Gagal koneksi DB:', err));

// =============================================================
// === HELPER: Parse Amount & Format Rupiah ====================
// =============================================================
function parseAmount(input) {
    if (typeof input !== 'string') return NaN;
    const cleaned = input.trim().replace(/\./g, '');
    if (!/^\d+$/.test(cleaned)) return NaN;
    return parseInt(cleaned, 10);
}

function formatRupiah(num) {
    return Number(num || 0).toLocaleString('id-ID');
}

// =============================================================
// === DEBOUNCE LEADERBOARD UPDATE (HEMAT RAM & API CALLS) =====
// =============================================================
let leaderboardTimeout = null;
function scheduleLiveLeaderboardUpdate() {
    if (leaderboardTimeout) clearTimeout(leaderboardTimeout);
    leaderboardTimeout = setTimeout(() => {
        updateLiveLeaderboard();
        leaderboardTimeout = null;
    }, 2000);
}

// =============================================================
// === DAFTAR SLASH COMMANDS ===================================
// =============================================================
const slashCommands = [
    { name: 'setupboard', description: 'Setup panel Leaderboard' },
    {
        name: 'restock', description: 'Countdown restock Robux',
        options: [
            { name: 'amount', description: 'Jumlah Robux (contoh: 55.000)', type: 3, required: true },
            { name: 'days', description: 'Hari (contoh: 5)', type: 4, required: false },
            { name: 'hours', description: 'Jam (contoh: 12)', type: 4, required: false },
            { name: 'minutes', description: 'Menit (contoh: 35)', type: 4, required: false },
            { name: 'seconds', description: 'Detik (contoh: 60)', type: 4, required: false }
        ]
    },
    {
        name: 'adduangmasuk', description: 'Tambah saldo spent pembeli',
        options: [
            { name: 'user', description: 'Pilih User', type: 6, required: true },
            { name: 'amount', description: 'Nominal Rupiah (contoh: 50.000)', type: 3, required: true },
            { name: 'keterangan', description: 'Keterangan/Kategori', type: 3, required: false }
        ]
    },
    {
        name: 'minuangmasuk', description: 'Kurangi saldo spent pembeli',
        options: [
            { name: 'user', description: 'Pilih User', type: 6, required: true },
            { name: 'amount', description: 'Nominal Rupiah (contoh: 50.000)', type: 3, required: true },
            { name: 'keterangan', description: 'Keterangan/Kategori', type: 3, required: false }
        ]
    },
    {
        name: 'adduangkeluar', description: 'Catat pengeluaran toko',
        options: [
            { name: 'amount', description: 'Nominal Rupiah (contoh: 150.000)', type: 3, required: true },
            { name: 'keterangan', description: 'Keterangan Pengeluaran', type: 3, required: false }
        ]
    },
    {
        name: 'minuangkeluar', description: 'Revisi/kurangi pengeluaran toko',
        options: [
            { name: 'amount', description: 'Nominal Rupiah (contoh: 150.000)', type: 3, required: true },
            { name: 'keterangan', description: 'Keterangan Revisi', type: 3, required: false }
        ]
    },
    { name: 'summary', description: 'Lihat laporan keuangan (Profit/Minus)' },
    {
        name: 'anonymous', description: 'Sembunyikan nama user dari Leaderboard',
        options: [{ name: 'user', description: 'Pilih User', type: 6, required: true }]
    },
    {
        name: 'unanonymous', description: 'Tampilkan kembali nama user di Leaderboard',
        options: [{ name: 'user', description: 'Pilih User', type: 6, required: true }]
    },
    { name: 'qris', description: 'Tampilkan QRIS pembayaran VibeBlox' },
    { name: 'bca', description: 'Tampilkan info rekening BCA VibeBlox' },
    { name: 'dana', description: 'Tampilkan info pembayaran Dana VibeBlox' },
    { name: 'gopay', description: 'Tampilkan info pembayaran GoPay VibeBlox' },
    { name: 'vouch', description: 'Template vouch (hanya terlihat olehmu)' },
    { name: 'linkcommunity', description: 'Tampilkan link grup komunitas Roblox' },
    {
        name: 'robux', description: 'Kalkulator harga Robux',
        options: [
            {
                name: 'type', description: 'Pilih tipe pembelian', type: 3, required: true,
                choices: [
                    { name: 'Community', value: 'community' },
                    { name: 'Gamepass After', value: 'gamepass_after' },
                    { name: 'Gamepass Before', value: 'gamepass_before' },
                    { name: 'GIG', value: 'gig' },
                    { name: 'Vilog', value: 'vilog' },
                    { name: 'Robux Plus', value: 'robux_plus' }
                ]
            },
            { name: 'amount', description: 'Jumlah Robux yang ingin dibeli', type: 4, required: true }
        ]
    },
    {
        name: 'hargarobux', description: 'Ubah rate harga Robux per type',
        options: [
            {
                name: 'type', description: 'Pilih tipe yang ingin diubah', type: 3, required: true,
                choices: [
                    { name: 'Community', value: 'community' },
                    { name: 'Gamepass After', value: 'gamepass_after' },
                    { name: 'Gamepass Before', value: 'gamepass_before' },
                    { name: 'GIG', value: 'gig' },
                    { name: 'Vilog', value: 'vilog' },
                    { name: 'Robux Plus', value: 'robux_plus' }
                ]
            },
            { name: 'rate', description: 'Rate baru (per 1 Robux / per 500 Robux untuk Vilog)', type: 4, required: true }
        ]
    },
    {
        name: 'invoice', description: 'Buat invoice pembelian Robux',
        options: [
            { name: 'user', description: 'Pilih pembeli', type: 6, required: true },
            {
                name: 'type', description: 'Tipe pembelian', type: 3, required: true,
                choices: [
                    { name: 'Community', value: 'community' },
                    { name: 'Gamepass After', value: 'gamepass_after' },
                    { name: 'Gamepass Before', value: 'gamepass_before' },
                    { name: 'GIG', value: 'gig' },
                    { name: 'Vilog', value: 'vilog' },
                    { name: 'Robux Plus', value: 'robux_plus' }
                ]
            },
            { name: 'amount', description: 'Jumlah Robux', type: 4, required: true }
        ]
    }
];

client.once('ready', async () => {
    console.log(`✅ Bot ${client.user.tag} Online!`);

    try {
        await client.application.commands.set(slashCommands);
        console.log('✅ Slash Commands berhasil didaftarkan!');
    } catch (err) {
        console.error('❌ Gagal mendaftarkan Slash Commands:', err);
    }
});

// === FUNGSI AUTO ROLE PEMBELI ===
async function updateSpenderRoles(member, userData) {
    if (!member || !userData) return;

    const roleClient = '1489610714988417145';
    const roleElite = '1489611849245786347';
    const rolePrime = '1490140596298580048';
    const spentUang = userData.uangMasuk;
    const isAnon = userData.isAnonymous;

    try {
        if (spentUang > 0 && !member.roles.cache.has(roleClient)) {
            await member.roles.add(roleClient);
        } else if (spentUang <= 0 && member.roles.cache.has(roleClient)) {
            await member.roles.remove(roleClient);
        }

        if (spentUang >= 1000000 && !isAnon && !member.roles.cache.has(roleElite)) {
            await member.roles.add(roleElite);
        } else if ((spentUang < 1000000 || isAnon) && member.roles.cache.has(roleElite)) {
            await member.roles.remove(roleElite);
        }

        if (spentUang >= 10000000 && !isAnon && !member.roles.cache.has(rolePrime)) {
            await member.roles.add(rolePrime);
        } else if ((spentUang < 10000000 || isAnon) && member.roles.cache.has(rolePrime)) {
            await member.roles.remove(rolePrime);
        }
    } catch (err) {
        console.error("Gagal update role:", err.message);
    }
}

// =============================================================
// === FUNGSI GENERATE LEADERBOARD =============================
// =============================================================
async function generateLeaderboard(page) {
    if (page > 10) page = 10;
    if (page < 1) page = 1;

    const limit = 10;
    const skip = (page - 1) * limit;

    // .lean() = return plain object, HEMAT RAM (tidak bikin Mongoose Document)
    const users = await User.find({ uangMasuk: { $gt: 0 } }).sort({ uangMasuk: -1 }).skip(skip).limit(limit).lean();
    const totalUsers = await User.countDocuments({ uangMasuk: { $gt: 0 } });

    const calculatedPages = Math.ceil(totalUsers / limit) || 1;
    const totalPages = Math.min(calculatedPages, 10);

    const storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' }).lean();
    const totalAmountServer = storeData ? storeData.totalUangMasuk : 0;

    let listText = '';

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const rank = skip + i + 1;
        let rankMedal;

        if (rank === 1) rankMedal = '🥇';
        else if (rank === 2) rankMedal = '🥈';
        else if (rank === 3) rankMedal = '🥉';
        else rankMedal = `\`#${rank}\``;

        let namaUser = "Unknown";

        if (user.isAnonymous) {
            namaUser = "Anonymous";
        } else {
            try {
                let fetchedUser = client.users.cache.get(user.userId);
                if (!fetchedUser) fetchedUser = await client.users.fetch(user.userId);
                namaUser = fetchedUser.username;
            } catch (err) {
                namaUser = "Akun_Dihapus";
            }
            if (namaUser.length > 12) namaUser = namaUser.substring(0, 12) + '..';
        }

        listText += `${rankMedal} **@${namaUser}** — 💸 Rp ${formatRupiah(user.uangMasuk)}\n`;
    }

    if (listText === '') listText = '_Belum ada data transaksi pembeli._';

    const embed = new EmbedBuilder()
        .setColor(0x4F4580)
        .setTitle('🏆 Top Spenders Vibeblox')
        .setDescription(listText)
        .addFields(
            { name: '💰 Total Amount Server', value: `**Rp ${formatRupiah(totalAmountServer)}**`, inline: false }
        )
        .setFooter({ text: `Halaman ${page}/${totalPages} • Tingkatkan transaksimu untuk naik pangkat!` })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`lb_prev_${page}`)
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page <= 1),
            new ButtonBuilder()
                .setCustomId(`lb_next_${page}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page >= totalPages)
        );

    return { embeds: [embed], components: [row] };
}

async function updateLiveLeaderboard() {
    try {
        const storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' }).lean();
        if (!storeData || !storeData.leaderboardMessageId || !storeData.leaderboardChannelId) return;

        const channel = await client.channels.fetch(storeData.leaderboardChannelId);
        if (!channel) return;

        const message = await channel.messages.fetch(storeData.leaderboardMessageId);
        if (!message) return;

        const boardData = await generateLeaderboard(1);
        await message.edit(boardData);
    } catch (err) {
        console.error("Leaderboard gagal update:", err.message);
    }
}

// === EVENT: BACA CHAT TEXT BIASA (KHUSUS VOUCH) ===
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const vouchChannelId = '1488903383963406507';
    if (message.channel.id === vouchChannelId) {
        try {
            await message.react('1502074502228738098');
        } catch (err) {}
    }
});

// === EVENT: INTERAKSI SLASH COMMANDS & BUTTON ===
const isUpdating = new Set();
let linkCommunityActive = false;

client.on('interactionCreate', async (interaction) => {
    // ----- BUTTON LEADERBOARD PAGINATION -----
    if (interaction.isButton() && (interaction.customId.startsWith('lb_prev_') || interaction.customId.startsWith('lb_next_'))) {
        // Anti-spam: kalau masih proses, ignore
        const msgId = interaction.message.id;
        if (isUpdating.has(msgId)) {
            return interaction.deferUpdate().catch(() => {});
        }
        isUpdating.add(msgId);

        try {
            // Step 1: Disable tombol + tampilkan Loading (acknowledge interaction sekaligus)
            const disabledRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('lb_loading_prev')
                        .setLabel('Loading...')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('lb_loading_next')
                        .setLabel('Loading...')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                );
            await interaction.update({ components: [disabledRow] });

            // Step 2: Hitung halaman tujuan
            const parts = interaction.customId.split('_');
            const direction = parts[1]; // 'prev' atau 'next'
            const currentPage = parseInt(parts[2]);
            const targetPage = direction === 'next' ? currentPage + 1 : currentPage - 1;

            // Step 3: Generate & update
            const boardData = await generateLeaderboard(targetPage);
            await interaction.editReply(boardData);
        } catch (err) {
            console.error("Button pagination error:", err.message);
        } finally {
            isUpdating.delete(msgId);
        }
        return;
    }

    // ----- INVOICE BUTTONS -----
    if (interaction.isButton() && interaction.customId.startsWith('inv_')) {
        const allowedRolesInv = ['1489612423521374309', '1489612221544665231'];
        const hasRoleInv = interaction.member.roles.cache.some(role => allowedRolesInv.includes(role.id));
        if (!hasRoleInv) {
            return interaction.reply({ content: '❌ Hanya Owner dan Handler yang bisa memencet tombol ini.', flags: MessageFlags.Ephemeral });
        }

        const parts = interaction.customId.split('_');
        const action = parts[1]; // cancel, bca, qris, dana, gopay, done

        // --- CANCEL: hapus pesan invoice ---
        if (action === 'cancel') {
            await interaction.deferUpdate();
            try { await interaction.message.delete(); } catch (e) {}
            return;
        }

        // --- PAYMENT BUTTONS: tampilkan embed metode pembayaran ---
        if (action === 'bca') {
            const embed = new EmbedBuilder().setColor(0x003D79).setTitle('🏦 Transfer Bank BCA VibeBlox')
                .addFields({ name: '👤 Atas Nama', value: '**Angel Vinny Vincentia Pelawi**' }, { name: '🔢 No. Rekening', value: '**8205363625**' }, { name: '🏦 Bank', value: '**BCA**' })
                .setFooter({ text: 'VibeBlox Payment' }).setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }
        if (action === 'qris') {
            const embed = new EmbedBuilder().setColor(0x4F4580).setTitle('💳 Pembayaran QRIS VibeBlox')
                .setDescription('Silakan scan QRIS di bawah ini untuk melakukan pembayaran.')
                .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1500317889872269324/1777300289337-1.png?ex=6a1c40ab&is=6a1aef2b&hm=be36eb1b73fd7c0448b6e5b989cac3eb5a15bd6cc88caefec52c55704cb534b6&')
                .setFooter({ text: 'VibeBlox Payment' }).setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }
        if (action === 'dana') {
            const embed = new EmbedBuilder().setColor(0x108EE9).setTitle('💙 Pembayaran Dana VibeBlox')
                .addFields({ name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**' }, { name: '📱 Nomor Dana', value: '**08119931329**' }, { name: '💳 Platform', value: '**Dana**' })
                .setFooter({ text: 'VibeBlox Payment' }).setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }
        if (action === 'gopay') {
            const embed = new EmbedBuilder().setColor(0x00AED6).setTitle('💚 Pembayaran GoPay VibeBlox')
                .addFields({ name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**' }, { name: '📱 Nomor GoPay', value: '**08119931329**' }, { name: '💳 Platform', value: '**GoPay**' })
                .setFooter({ text: 'VibeBlox Payment' }).setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // --- DONE: mulai flow ephemeral ---
        if (action === 'done') {
            const msgId = interaction.message.id;
            if (isUpdating.has(`inv_done_${msgId}`)) {
                return interaction.reply({ content: '⏳ Proses Done sedang berlangsung...', flags: MessageFlags.Ephemeral });
            }
            isUpdating.add(`inv_done_${msgId}`);

            try {
                // Disable Done button (loading state)
                const currentComponents = interaction.message.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => {
                        if (btn.data.custom_id && btn.data.custom_id.startsWith('inv_done')) {
                            btn.setDisabled(true).setLabel('⏳ Processing...');
                        }
                    });
                    return newRow;
                });
                await interaction.update({ components: currentComponents });

                // Step 1: Pilih Tipe Transaksi (ephemeral)
                const typeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`invf_type_community_${msgId}`).setLabel('Community').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`invf_type_gamepass_before_${msgId}`).setLabel('GP Before').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`invf_type_gamepass_after_${msgId}`).setLabel('GP After').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`invf_type_gig_${msgId}`).setLabel('GIG').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`invf_type_vilog_${msgId}`).setLabel('Vilog').setStyle(ButtonStyle.Primary)
                );
                const typeRow2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`invf_type_robux_plus_${msgId}`).setLabel('Robux Plus').setStyle(ButtonStyle.Primary)
                );
                const cancelRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`invf_cancel_${msgId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
                );

                const typeEmbed = new EmbedBuilder().setColor(0x4F4580).setTitle('📋 Pilih Tipe Transaksi').setDescription('Pilih salah satu tipe di bawah:');
                await interaction.followUp({ embeds: [typeEmbed], components: [typeRow, typeRow2, cancelRow], flags: MessageFlags.Ephemeral });
            } catch (err) {
                console.error("Invoice Done error:", err.message);
                isUpdating.delete(`inv_done_${msgId}`);
                // Re-enable Done button
                try {
                    const origComponents = interaction.message.components.map(row => {
                        const newRow = ActionRowBuilder.from(row);
                        newRow.components.forEach(btn => {
                            if (btn.data.custom_id && btn.data.custom_id.startsWith('inv_done')) {
                                btn.setDisabled(false).setLabel('✅ Done');
                            }
                        });
                        return newRow;
                    });
                    await interaction.message.edit({ components: origComponents });
                } catch (e) {}
            }
            return;
        }
        return;
    }

    // ----- INVOICE FLOW BUTTONS (ephemeral steps) -----
    if (interaction.isButton() && interaction.customId.startsWith('invf_')) {
        const allowedRolesInv = ['1489612423521374309', '1489612221544665231'];
        const hasRoleInv = interaction.member.roles.cache.some(role => allowedRolesInv.includes(role.id));
        if (!hasRoleInv) {
            return interaction.reply({ content: '❌ Hanya Owner dan Handler.', flags: MessageFlags.Ephemeral });
        }

        const customId = interaction.customId;
        const lastUnderscoreIdx = customId.lastIndexOf('_');
        const invoiceMsgId = customId.substring(lastUnderscoreIdx + 1);

        // Helper: re-enable Done button on invoice message
        const reEnableDone = async () => {
            isUpdating.delete(`inv_done_${invoiceMsgId}`);
            try {
                const invoiceMsg = await interaction.channel.messages.fetch(invoiceMsgId);
                const origComponents = invoiceMsg.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => {
                        if (btn.data.custom_id && btn.data.custom_id.startsWith('inv_done')) {
                            btn.setDisabled(false).setLabel('✅ Done');
                        }
                    });
                    return newRow;
                });
                await invoiceMsg.edit({ components: origComponents });
            } catch (e) {}
        };

        // --- CANCEL at any step ---
        if (customId.startsWith('invf_cancel_')) {
            await interaction.update({ content: '❌ Proses dibatalkan.', embeds: [], components: [] });
            await reEnableDone();
            return;
        }

        // --- Step 1 result: Tipe Transaksi dipilih ---
        if (customId.startsWith('invf_type_')) {
            // Parse type from customId: invf_type_{typeName}_{msgId}
            const withoutPrefix = customId.replace('invf_type_', '');
            const typeValue = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));

            const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };

            // Step 2: Pilih Metode Pembayaran
            const payRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`invf_pay_qris_${typeValue}_${invoiceMsgId}`).setLabel('QRIS').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`invf_pay_bca_${typeValue}_${invoiceMsgId}`).setLabel('BCA').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`invf_pay_dana_${typeValue}_${invoiceMsgId}`).setLabel('Dana').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`invf_pay_gopay_${typeValue}_${invoiceMsgId}`).setLabel('GoPay').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`invf_pay_lainnya_${typeValue}_${invoiceMsgId}`).setLabel('Lainnya').setStyle(ButtonStyle.Secondary)
            );
            const cancelRow2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`invf_cancel_${invoiceMsgId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
            );

            const payEmbed = new EmbedBuilder().setColor(0x4F4580).setTitle('💳 Pilih Metode Pembayaran')
                .setDescription(`Tipe: **${typeNames[typeValue] || typeValue}**\nPilih metode pembayaran:`);

            await interaction.update({ embeds: [payEmbed], components: [payRow, cancelRow2] });
            return;
        }

        // --- Step 2 result: Metode Pembayaran dipilih → Konfirmasi ---
        if (customId.startsWith('invf_pay_')) {
            // Parse: invf_pay_{method}_{typeValue}_{msgId}
            const withoutPrefix = customId.replace('invf_pay_', '');
            const segmentBeforeMsgId = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));
            const method = segmentBeforeMsgId.substring(0, segmentBeforeMsgId.indexOf('_'));
            const typeValue = segmentBeforeMsgId.substring(segmentBeforeMsgId.indexOf('_') + 1);

            const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };
            const methodNames = { 'qris': 'QRIS', 'bca': 'BCA', 'dana': 'Dana', 'gopay': 'GoPay', 'lainnya': 'Lainnya' };

            const confirmEmbed = new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ Konfirmasi')
                .setDescription(`Tipe: **${typeNames[typeValue] || typeValue}**\nMetode: **${methodNames[method] || method}**\n\nApakah kamu yakin ingin menyelesaikan invoice ini?`);

            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`invf_confirm_yes_${method}_${typeValue}_${invoiceMsgId}`).setLabel('✅ Yakin').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`invf_confirm_no_${invoiceMsgId}`).setLabel('❌ Tidak').setStyle(ButtonStyle.Danger)
            );

            await interaction.update({ embeds: [confirmEmbed], components: [confirmRow] });
            return;
        }

        // --- Konfirmasi: TIDAK ---
        if (customId.startsWith('invf_confirm_no_')) {
            await interaction.update({ content: '❌ Proses dibatalkan.', embeds: [], components: [] });
            await reEnableDone();
            return;
        }

        // --- Konfirmasi: YAKIN ---
        if (customId.startsWith('invf_confirm_yes_')) {
            // Parse: invf_confirm_yes_{method}_{typeValue}_{msgId}
            const withoutPrefix = customId.replace('invf_confirm_yes_', '');
            const msgIdPart = invoiceMsgId;
            const beforeMsgId = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));
            const method = beforeMsgId.substring(0, beforeMsgId.indexOf('_'));
            const typeValue = beforeMsgId.substring(beforeMsgId.indexOf('_') + 1);

            const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };
            const methodNames = { 'qris': 'QRIS', 'bca': 'BCA', 'dana': 'Dana', 'gopay': 'GoPay', 'lainnya': 'Lainnya' };

            await interaction.update({ content: '⏳ Memproses...', embeds: [], components: [] });

            try {
                // Fetch invoice message to get data from embed
                const invoiceMsg = await interaction.channel.messages.fetch(msgIdPart);
                const invoiceEmbed = invoiceMsg.embeds[0];

                // Parse userId and totalHarga from embed fields
                let targetUserId = null;
                let totalHarga = 0;

                if (invoiceEmbed && invoiceEmbed.fields) {
                    for (const field of invoiceEmbed.fields) {
                        if (field.name.includes('Pembeli') && field.value.includes('<@')) {
                            const match = field.value.match(/<@(\d+)>/);
                            if (match) targetUserId = match[1];
                        }
                        if (field.name.includes('Total Harga') || field.name.includes('Total Bayar')) {
                            const numMatch = field.value.replace(/[^\d]/g, '');
                            if (numMatch) totalHarga = parseInt(numMatch);
                        }
                    }
                }

                if (!targetUserId || !totalHarga) {
                    await interaction.editReply({ content: '❌ Gagal membaca data invoice.' });
                    await reEnableDone();
                    return;
                }

                // Database logic (same as /adduangmasuk)
                let userData = await User.findOne({ userId: targetUserId });
                if (!userData) userData = new User({ userId: targetUserId });
                userData.uangMasuk += totalHarga;
                await userData.save();

                let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
                if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });
                storeData.totalUangMasuk += totalHarga;
                await storeData.save();

                // Auto role update
                const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                await updateSpenderRoles(targetMember, userData);
                scheduleLiveLeaderboardUpdate();

                // Update invoice embed to green (done)
                const doneEmbed = EmbedBuilder.from(invoiceEmbed)
                    .setColor(0x57F287)
                    .setFooter({ text: '✅ Invoice Selesai • VibeBlox' });

                // Disable all buttons
                const disabledComponents = invoiceMsg.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => btn.setDisabled(true));
                    return newRow;
                });

                await invoiceMsg.edit({ embeds: [doneEmbed], components: disabledComponents });

                // Send history to #store-finance
                const financeChannelId = '1489665490770067678';
                const kategori = `${typeNames[typeValue] || typeValue} - ${methodNames[method] || method}`;

                const historyEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Uang Masuk Dicatat!')
                    .addFields(
                        { name: '👤 Pembeli', value: `<@${targetUserId}>`, inline: true },
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: true },
                        { name: '🛒 Kategori', value: kategori, inline: true },
                        { name: '📊 Total spent user', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();

                try {
                    const financeChannel = await client.channels.fetch(financeChannelId);
                    if (financeChannel) await financeChannel.send({ embeds: [historyEmbed] });
                } catch (e) { console.error("Gagal kirim ke store-finance:", e.message); }

                await interaction.editReply({ content: '✅ Invoice selesai! Pencatatan berhasil.' });
            } catch (err) {
                console.error("Invoice confirm error:", err.message);
                await interaction.editReply({ content: '❌ Terjadi error saat memproses invoice.' });
                await reEnableDone();
            } finally {
                isUpdating.delete(`inv_done_${msgIdPart}`);
            }
            return;
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;

    // --- SETUP BOARD ---
    if (command === 'setupboard') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ Anda tidak memiliki izin Administrator.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const boardData = await generateLeaderboard(1);
        const sentMessage = await interaction.channel.send(boardData);

        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });

        storeData.leaderboardChannelId = interaction.channel.id;
        storeData.leaderboardMessageId = sentMessage.id;
        await storeData.save();

        return interaction.editReply({ content: '✅ Panel Leaderboard berhasil dipasang di channel ini!' });
    }

    // --- RESTOCK COUNTDOWN ---
    if (command === 'restock') {
        if (!interaction.member.roles.cache.has('1489612423521374309')) {
            return interaction.reply({ content: '❌ Sori, command ini khusus Owner.', flags: MessageFlags.Ephemeral });
        }

        // Defer dulu agar tidak "outdated" saat proses build embed
        await interaction.deferReply();

        const rawAmount = interaction.options.getString('amount');
        const amount = parseAmount(rawAmount);

        if (isNaN(amount) || amount <= 0) {
            return interaction.editReply({ content: '❌ Nominal Robux tidak valid! Pastikan hanya memakai angka dan titik (contoh: 55.000).' });
        }

        const days = interaction.options.getInteger('days') || 0;
        const hours = interaction.options.getInteger('hours') || 0;
        const minutes = interaction.options.getInteger('minutes') || 0;
        const seconds = interaction.options.getInteger('seconds') || 0;

        const ms = (days * 86400000) + (hours * 3600000) + (minutes * 60000) + (seconds * 1000);

        if (ms <= 0) {
            return interaction.editReply({ content: '❌ Durasi tidak valid! Masukkan minimal salah satu: days, hours, minutes, atau seconds.' });
        }

        const futureTime = new Date(Date.now() + ms);
        const unixTimestamp = Math.floor(futureTime.getTime() / 1000);

        const formattedAmount = amount >= 1000 ? Math.floor(amount / 1000) + 'K+' : formatRupiah(amount);

        const restockEmbed = new EmbedBuilder()
            .setColor(0x4F4580)
            .setDescription(`**📦 VIBEBLOX RESTOCK INCOMING!**\nHalo Vibies! Robux kita bakal segera restock di Community. jangan sampai telat!\n# <:robux:1497884445494087752> ${formattedAmount} Robux\n## ⏳ <t:${unixTimestamp}:R>\n*(Tepatnya pada: <t:${unixTimestamp}:F>)*`)
            .setFooter({ text: 'VibeBlox Auto-Notifier' })
            .setTimestamp();

        await interaction.editReply({ content: '@everyone', embeds: [restockEmbed] });
        const replyMessage = await interaction.fetchReply();

        if (ms <= 2147483647) {
            setTimeout(async () => {
                try {
                    const finishedEmbed = new EmbedBuilder()
                        .setColor(0x57F287)
                        .setDescription(`**✅ RESTOCK SELESAI!**\nRobux sudah masuk ke Community VibeBlox! Langsung sikat sebelum diborong yang lain!\n# <:robux:1497884445494087752> ${formattedAmount} Robux\n## 🎉 STOK READY!`)
                        .setFooter({ text: 'VibeBlox Restock Complete' })
                        .setTimestamp();

                    await replyMessage.edit({ content: '@everyone', embeds: [finishedEmbed] });
                    await interaction.channel.send(`🚨 Panggilan buat @everyone! Stok **${formattedAmount} Robux** resmi mendarat! Gas merapat ke tiket sekarang!`);
                } catch (err) {
                    console.error("Gagal update pesan saat Restock selesai:", err);
                }
            }, ms);
        }

        return;
    }

    // --- QRIS ---
    if (command === 'qris') {
        const allowedRolesQris = ['1489612423521374309', '1489612221544665231'];
        const hasRoleQris = interaction.member.roles.cache.some(role => allowedRolesQris.includes(role.id));
        if (!hasRoleQris) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const qrisEmbed = new EmbedBuilder()
            .setColor(0x4F4580)
            .setTitle('💳 Pembayaran QRIS VibeBlox')
            .setDescription('Silakan scan QRIS di bawah ini untuk melakukan pembayaran.')
            .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1500317889872269324/1777300289337-1.png?ex=6a1c40ab&is=6a1aef2b&hm=be36eb1b73fd7c0448b6e5b989cac3eb5a15bd6cc88caefec52c55704cb534b6&')
            .setFooter({ text: 'VibeBlox Payment' })
            .setTimestamp();

        return interaction.editReply({ embeds: [qrisEmbed] });
    }

    // --- BCA ---
    if (command === 'bca') {
        const allowedRolesBca = ['1489612423521374309', '1489612221544665231'];
        const hasRoleBca = interaction.member.roles.cache.some(role => allowedRolesBca.includes(role.id));
        if (!hasRoleBca) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const bcaEmbed = new EmbedBuilder()
            .setColor(0x003D79)
            .setTitle('🏦 Transfer Bank BCA VibeBlox')
            .addFields(
                { name: '👤 Atas Nama', value: '**Angel Vinny Vincentia Pelawi**', inline: false },
                { name: '🔢 Nomor Rekening', value: '**8205363625**', inline: false },
                { name: '🏦 Bank', value: '**BCA**', inline: false }
            )
            .setFooter({ text: 'VibeBlox Payment' })
            .setTimestamp();

        return interaction.editReply({ embeds: [bcaEmbed] });
    }

    // --- DANA ---
    if (command === 'dana') {
        const allowedRolesDana = ['1489612423521374309', '1489612221544665231'];
        const hasRoleDana = interaction.member.roles.cache.some(role => allowedRolesDana.includes(role.id));
        if (!hasRoleDana) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const danaEmbed = new EmbedBuilder()
            .setColor(0x108EE9)
            .setTitle('💙 Pembayaran Dana VibeBlox')
            .addFields(
                { name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**', inline: false },
                { name: '📱 Nomor Dana', value: '**08119931329**', inline: false },
                { name: '💳 Platform', value: '**Dana**', inline: false }
            )
            .setFooter({ text: 'VibeBlox Payment' })
            .setTimestamp();

        return interaction.editReply({ embeds: [danaEmbed] });
    }

    // --- GOPAY ---
    if (command === 'gopay') {
        const allowedRolesGopay = ['1489612423521374309', '1489612221544665231'];
        const hasRoleGopay = interaction.member.roles.cache.some(role => allowedRolesGopay.includes(role.id));
        if (!hasRoleGopay) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const gopayEmbed = new EmbedBuilder()
            .setColor(0x00AED6)
            .setTitle('💚 Pembayaran GoPay VibeBlox')
            .addFields(
                { name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**', inline: false },
                { name: '📱 Nomor GoPay', value: '**08119931329**', inline: false },
                { name: '💳 Platform', value: '**GoPay**', inline: false }
            )
            .setFooter({ text: 'VibeBlox Payment' })
            .setTimestamp();

        return interaction.editReply({ embeds: [gopayEmbed] });
    }

    // --- VOUCH TEMPLATE (Ephemeral - hanya terlihat oleh pengguna) ---
    if (command === 'vouch') {
        const allowedRolesVouch = ['1489612423521374309', '1489612221544665231'];
        const hasRoleVouch = interaction.member.roles.cache.some(role => allowedRolesVouch.includes(role.id));
        if (!hasRoleVouch) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        return interaction.reply({
            content: '+vouch robux @axel 3000 Robux Payout Instant',
            flags: MessageFlags.Ephemeral
        });
    }

    // --- LINK COMMUNITY ---
    if (command === 'linkcommunity') {
        if (linkCommunityActive) {
            return interaction.reply({ content: '⏳ Command ini sedang digunakan oleh user lain. Coba lagi nanti.', flags: MessageFlags.Ephemeral });
        }
        linkCommunityActive = true;

        await interaction.deferReply();

        await interaction.editReply({ content: '**Link Grup Komunitas:**\nKomunitas 1:\nhttps://www.roblox.com/communities/1064667246/BEJIRLAH-Community\n\nKomunitas 2:\nhttps://www.roblox.com/id/communities/1108229986/Vandamoy' });
        linkCommunityActive = false;
        return;
    }

    // --- ROBUX CALCULATOR ---
    if (command === 'robux') {
        const allowedRolesRobux = ['1489612423521374309', '1489612221544665231'];
        const hasRoleRobux = interaction.member.roles.cache.some(role => allowedRolesRobux.includes(role.id));
        if (!hasRoleRobux) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const type = interaction.options.getString('type');
        const amount = interaction.options.getInteger('amount');

        if (amount <= 0) {
            return interaction.editReply({ content: '❌ Jumlah Robux harus lebih dari 0!' });
        }

        // Ambil rate dari database
        const rateData = await RobuxRate.findOne({ type }).lean();
        if (!rateData) {
            return interaction.editReply({ content: '❌ Rate untuk tipe ini belum diatur. Hubungi admin.' });
        }

        const typeNames = {
            'community': 'Community',
            'gamepass_after': 'Gamepass After',
            'gamepass_before': 'Gamepass Before',
            'gig': 'GIG',
            'vilog': 'Vilog',
            'robux_plus': 'Robux Plus'
        };

        let totalHarga = 0;
        let detailCalc = '';

        if (type === 'vilog') {
            // Vilog: kelipatan 500 robux
            if (amount % 500 !== 0) {
                return interaction.editReply({ content: '❌ Untuk tipe **Vilog**, jumlah Robux harus kelipatan **500**!\n*(Contoh: 500, 1000, 1500, 2000, ...)*' });
            }
            const kelipatan = amount / 500;
            totalHarga = kelipatan * rateData.rate;
            const parts = [];
            for (let i = 0; i < kelipatan; i++) {
                parts.push(`Rp ${formatRupiah(rateData.rate)}`);
            }
            detailCalc = `${kelipatan}x Rp ${formatRupiah(rateData.rate)} (per 500 Robux)\n= ${parts.join(' + ')}`;
        } else {
            // Type lainnya: rate * amount
            totalHarga = rateData.rate * amount;
            detailCalc = `Rp ${formatRupiah(rateData.rate)} × ${formatRupiah(amount)} Robux`;
        }

        const robuxEmbed = new EmbedBuilder()
            .setColor(0x4F4580)
            .setTitle('🧮 Kalkulator Robux VibeBlox')
            .addFields(
                { name: '📦 Tipe', value: `**${typeNames[type]}**`, inline: true },
                { name: '<:robux:1497884445494087752> Jumlah Robux', value: `**${formatRupiah(amount)} R$**`, inline: true },
                { name: '\u200B', value: '───────────────────────', inline: false },
                { name: '📝 Perhitungan', value: detailCalc, inline: false },
                { name: '💰 Total Harga', value: `## Rp ${formatRupiah(totalHarga)}`, inline: false }
            )
            .setFooter({ text: 'VibeBlox Robux Calculator' })
            .setTimestamp();

        return interaction.editReply({ embeds: [robuxEmbed] });
    }

    // --- HARGA ROBUX (UPDATE RATE) ---
    if (command === 'hargarobux') {
        const allowedRolesHarga = ['1489612423521374309', '1489612221544665231'];
        const hasRoleHarga = interaction.member.roles.cache.some(role => allowedRolesHarga.includes(role.id));
        if (!hasRoleHarga) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const type = interaction.options.getString('type');
        const newRate = interaction.options.getInteger('rate');

        if (newRate <= 0) {
            return interaction.editReply({ content: '❌ Rate harus lebih dari 0!' });
        }

        const typeNames = {
            'community': 'Community',
            'gamepass_after': 'Gamepass After',
            'gamepass_before': 'Gamepass Before',
            'gig': 'GIG',
            'vilog': 'Vilog',
            'robux_plus': 'Robux Plus'
        };

        // Ambil rate lama
        const oldData = await RobuxRate.findOne({ type }).lean();
        const oldRate = oldData ? oldData.rate : 0;

        // Update rate
        await RobuxRate.findOneAndUpdate(
            { type },
            { rate: newRate },
            { upsert: true }
        );

        let rateDescription = '';
        if (type === 'vilog') {
            rateDescription = `Rp ${formatRupiah(oldRate)} → **Rp ${formatRupiah(newRate)}** /500 Robux`;
        } else {
            rateDescription = `Rp ${formatRupiah(oldRate)} → **Rp ${formatRupiah(newRate)}** /1 Robux`;
        }

        const updateEmbed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Rate Harga Robux Diperbarui!')
            .addFields(
                { name: '📦 Tipe', value: `**${typeNames[type]}**`, inline: true },
                { name: '💱 Perubahan Rate', value: rateDescription, inline: false }
            )
            .setFooter({ text: 'VibeBlox Rate Manager' })
            .setTimestamp();

        return interaction.editReply({ embeds: [updateEmbed] });
    }

    // --- INVOICE ---
    if (command === 'invoice') {
        const allowedRolesInvoice = ['1489612423521374309', '1489612221544665231'];
        const hasRoleInvoice = interaction.member.roles.cache.some(role => allowedRolesInvoice.includes(role.id));
        if (!hasRoleInvoice) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const target = interaction.options.getUser('user');
        const type = interaction.options.getString('type');
        const amount = interaction.options.getInteger('amount');

        if (amount <= 0) {
            return interaction.editReply({ content: '❌ Jumlah Robux harus lebih dari 0!' });
        }

        const rateData = await RobuxRate.findOne({ type }).lean();
        if (!rateData) {
            return interaction.editReply({ content: '❌ Rate untuk tipe ini belum diatur.' });
        }

        const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };

        let totalHarga = 0;
        let detailCalc = '';

        if (type === 'vilog') {
            if (amount % 500 !== 0) {
                return interaction.editReply({ content: '❌ Untuk tipe **Vilog**, jumlah Robux harus kelipatan **500**!' });
            }
            const kelipatan = amount / 500;
            totalHarga = kelipatan * rateData.rate;
            detailCalc = `${kelipatan}x Rp ${formatRupiah(rateData.rate)} (per 500 Robux)`;
        } else {
            totalHarga = rateData.rate * amount;
            detailCalc = `Rp ${formatRupiah(rateData.rate)} × ${formatRupiah(amount)} Robux`;
        }

        const invoiceEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🧾 Invoice VibeBlox')
            .addFields(
                { name: '👤 Pembeli', value: `<@${target.id}>`, inline: true },
                { name: '📦 Tipe', value: `**${typeNames[type]}**`, inline: true },
                { name: '<:robux:1497884445494087752> Jumlah Robux', value: `**${formatRupiah(amount)} R$**`, inline: true },
                { name: '📝 Perhitungan', value: detailCalc, inline: false },
                { name: '💰 Total Bayar', value: `## Rp ${formatRupiah(totalHarga)}`, inline: false }
            )
            .setFooter({ text: '⏳ Belum Selesai • VibeBlox Invoice' })
            .setTimestamp();

        const sentReply = await interaction.editReply({ embeds: [invoiceEmbed], components: [] });
        const invoiceMsgId = sentReply.id;

        // Add buttons with message ID reference
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inv_cancel_${invoiceMsgId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`inv_bca_${invoiceMsgId}`).setLabel('BCA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_qris_${invoiceMsgId}`).setLabel('QRIS').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_dana_${invoiceMsgId}`).setLabel('DANA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_gopay_${invoiceMsgId}`).setLabel('GOPAY').setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inv_done_${invoiceMsgId}`).setLabel('✅ Done').setStyle(ButtonStyle.Success)
        );

        await interaction.editReply({ embeds: [invoiceEmbed], components: [row1, row2] });
        return;
    }

    // --- SECURITY FILTER UNTUK COMMAND KEUANGAN ---
    const allowedChannel = '1489665490770067678';
    if (interaction.channel.id !== allowedChannel) {
        return interaction.reply({ content: '❌ Command ini hanya bisa digunakan di channel Finance.', flags: MessageFlags.Ephemeral });
    }

    const allowedRoles = ['1489612423521374309', '1489612221544665231'];
    const hasRole = interaction.member.roles.cache.some(role => allowedRoles.includes(role.id));
    if (!hasRole) {
        return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
    }

    try {
        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });

        // --- ANONYMOUS & UNANONYMOUS ---
        if (command === 'anonymous' || command === 'unanonymous') {
            const target = interaction.options.getUser('user');

            let userData = await User.findOne({ userId: target.id });
            if (!userData) userData = new User({ userId: target.id });

            userData.isAnonymous = (command === 'anonymous');
            await userData.save();

            const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
            await updateSpenderRoles(targetMember, userData);
            scheduleLiveLeaderboardUpdate();

            const msgText = command === 'anonymous'
                ? `🥷 **Berhasil!** Akun ${target.username} disembunyikan menjadi **Anonymous** di Leaderboard.`
                : `👁️ **Berhasil!** Akun ${target.username} ditampilkan kembali di Leaderboard.`;
            return interaction.reply({ content: msgText });
        }

        // --- ADD / MIN UANG MASUK ---
        else if (command === 'adduangmasuk' || command === 'minuangmasuk') {
            const target = interaction.options.getUser('user');

            const rawAmount = interaction.options.getString('amount');
            const amount = parseAmount(rawAmount);
            const kategori = interaction.options.getString('keterangan') || 'Tidak ada kategori';

            if (isNaN(amount) || amount <= 0) {
                return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 50.000).', flags: MessageFlags.Ephemeral });
            }

            let userData = await User.findOne({ userId: target.id });
            if (!userData) userData = new User({ userId: target.id });

            let embed;

            if (command === 'adduangmasuk') {
                userData.uangMasuk += amount;
                storeData.totalUangMasuk += amount;

                embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Uang Masuk Dicatat!')
                    .addFields(
                        { name: '👤 Pembeli', value: target.username, inline: true },
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(amount)}**`, inline: true },
                        { name: '🛒 Kategori', value: kategori, inline: true },
                        { name: '📊 Total spent user', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();
            } else {
                const bisaDikurang = Math.min(userData.uangMasuk, amount);
                userData.uangMasuk = Math.max(0, userData.uangMasuk - amount);
                storeData.totalUangMasuk = Math.max(0, storeData.totalUangMasuk - bisaDikurang);

                embed = new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle('📉 Revisi Uang Masuk')
                    .addFields(
                        { name: '👤 Pembeli', value: target.username, inline: true },
                        { name: '🔻 Dikurangi', value: `**Rp ${formatRupiah(amount)}**`, inline: true },
                        { name: '📊 Total spent user', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();
            }

            await userData.save();
            await storeData.save();

            const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
            await updateSpenderRoles(targetMember, userData);
            scheduleLiveLeaderboardUpdate();

            return interaction.reply({ embeds: [embed] });
        }

        // --- ADD / MIN UANG KELUAR ---
        else if (command === 'adduangkeluar' || command === 'minuangkeluar') {

            const rawAmount = interaction.options.getString('amount');
            const amount = parseAmount(rawAmount);
            const keterangan = interaction.options.getString('keterangan') || 'Restock / Modal Toko';

            if (isNaN(amount) || amount <= 0) {
                return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 150.000).', flags: MessageFlags.Ephemeral });
            }

            let embed;

            if (command === 'adduangkeluar') {
                storeData.totalUangKeluar += amount;

                embed = new EmbedBuilder()
                    .setColor(0xFF0026)
                    .setTitle('💸 Pengeluaran Toko Dicatat!')
                    .addFields(
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(amount)}**`, inline: true },
                        { name: '📝 Keterangan', value: keterangan, inline: true },
                        { name: '📊 Total pengeluaran', value: `**Rp ${formatRupiah(storeData.totalUangKeluar)}**`, inline: false }
                    )
                    .setTimestamp();
            } else {
                storeData.totalUangKeluar = Math.max(0, storeData.totalUangKeluar - amount);

                embed = new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle('📉 Revisi Pengeluaran Toko')
                    .addFields(
                        { name: '🔻 Dikurangi', value: `**Rp ${formatRupiah(amount)}**`, inline: true },
                        { name: '📝 Keterangan', value: keterangan, inline: true },
                        { name: '📊 Total pengeluaran', value: `**Rp ${formatRupiah(storeData.totalUangKeluar)}**`, inline: false }
                    )
                    .setTimestamp();
            }

            await storeData.save();
            return interaction.reply({ embeds: [embed] });
        }

        // --- SUMMARY ---
        else if (command === 'summary') {
            const income = storeData.totalUangMasuk;
            const expense = storeData.totalUangKeluar;
            const profit = income - expense;

            let profitLine = '';

            if (profit > 0) {
                profitLine = `📈 **+Rp ${formatRupiah(profit)}** (PROFIT)`;
            } else if (profit < 0) {
                profitLine = `📉 **-Rp ${formatRupiah(Math.abs(profit))}** (MINUS)`;
            } else {
                profitLine = `⚖️ **Rp 0** (BREAK EVEN)`;
            }

            const summaryEmbed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('📊 Laporan Keuangan Vibeblox')
                .addFields(
                    { name: '🟢 Total Pemasukan', value: `**Rp ${formatRupiah(income)}**`, inline: true },
                    { name: '🔴 Total Pengeluaran', value: `**Rp ${formatRupiah(expense)}**`, inline: true },
                    { name: '\u200B', value: '───────────────────────', inline: false },
                    { name: '💵 Profit / Loss', value: profitLine, inline: false }
                )
                .setFooter({ text: 'Data Keuangan Internal Store' })
                .setTimestamp();

            return interaction.reply({ embeds: [summaryEmbed] });
        }

    } catch (err) {
        console.error(err);
        if (!interaction.replied && !interaction.deferred) {
            return interaction.reply({ content: '❌ Waduh, database-nya lagi ngambek nih.', flags: MessageFlags.Ephemeral });
        }
    }
});

client.login(process.env.TOKEN);

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot VibeBlox lagi nongkrong 24/7 nih!'));
app.listen(port);
