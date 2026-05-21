require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Options, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');
const User = require('./models/User');
const Store = require('./models/Store');

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
    .then(() => console.log('📂 Database MongoDB Tersambung!'))
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
            .setDescription(`**📦 VIBEBLOX RESTOCK INCOMING!**\nHalo Vibies! Robux kita bakal segera restock di Community. jangan sampai kehabisan!\n# <:robux:1497884445494087752> ${formattedAmount} Robux\n## ⏳ <t:${unixTimestamp}:R>\n*(Tepatnya pada: <t:${unixTimestamp}:F>)*`)
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

            let replyMsg = '';

            if (command === 'adduangmasuk') {
                userData.uangMasuk += amount;
                storeData.totalUangMasuk += amount;
                replyMsg = `✅ **Uang Masuk Dicatat!**\n👤 Pembeli: ${target.username}\n💰 Nominal: **Rp ${formatRupiah(amount)}**\n🛒 Kategori: ${kategori}\n📊 Total spent user: **Rp ${formatRupiah(userData.uangMasuk)}**`;
            } else {
                const bisaDikurang = Math.min(userData.uangMasuk, amount);
                userData.uangMasuk = Math.max(0, userData.uangMasuk - amount);
                storeData.totalUangMasuk = Math.max(0, storeData.totalUangMasuk - bisaDikurang);
                replyMsg = `📉 **Revisi Uang Masuk**\n👤 Pembeli: ${target.username}\n🔻 Dikurangi: **Rp ${formatRupiah(amount)}**\n📊 Total spent user: **Rp ${formatRupiah(userData.uangMasuk)}**`;
            }

            await userData.save();
            await storeData.save();

            const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
            await updateSpenderRoles(targetMember, userData);
            scheduleLiveLeaderboardUpdate();

            return interaction.reply({ content: replyMsg });
        }

        // --- ADD / MIN UANG KELUAR ---
        else if (command === 'adduangkeluar' || command === 'minuangkeluar') {

            const rawAmount = interaction.options.getString('amount');
            const amount = parseAmount(rawAmount);
            const keterangan = interaction.options.getString('keterangan') || 'Restock / Modal Toko';

            if (isNaN(amount) || amount <= 0) {
                return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 150.000).', flags: MessageFlags.Ephemeral });
            }

            let replyMsg = '';

            if (command === 'adduangkeluar') {
                storeData.totalUangKeluar += amount;
                replyMsg = `💸 **Pengeluaran Toko Dicatat!**\n💰 Nominal: **Rp ${formatRupiah(amount)}**\n📝 Ket: ${keterangan}`;
            } else {
                storeData.totalUangKeluar = Math.max(0, storeData.totalUangKeluar - amount);
                replyMsg = `📉 **Revisi Pengeluaran Toko**\n🔻 Dikurangi: **Rp ${formatRupiah(amount)}**\n📝 Ket: ${keterangan}`;
            }

            await storeData.save();
            return interaction.reply({ content: replyMsg });
        }

        // --- SUMMARY ---
        else if (command === 'summary') {
            const income = storeData.totalUangMasuk;
            const expense = storeData.totalUangKeluar;
            const profit = income - expense;

            let profitTitle = "", profitStatus = "", embedColor = 0;

            if (profit > 0) {
                profitTitle = "✨ KEUNTUNGAN BERSIH (PROFIT)";
                profitStatus = `📈 **Rp ${formatRupiah(profit)}**`;
                embedColor = 3066993;
            } else if (profit < 0) {
                const absProfit = Math.abs(profit);
                profitTitle = "⚠️ KERUGIAN / MINUS";
                profitStatus = `📉 **-Rp ${formatRupiah(absProfit)}**`;
                embedColor = 15158332;
            } else {
                profitTitle = "⚖️ BALIK MODAL (BREAK EVEN)";
                profitStatus = "**Rp 0**";
                embedColor = 9807270;
            }

            const summaryEmbed = new EmbedBuilder()
                .setTitle("📊 Laporan Keuangan Vibeblox")
                .setColor(embedColor)
                .addFields(
                    { name: "🟢 Total Pemasukan", value: `Rp ${formatRupiah(income)}`, inline: true },
                    { name: "🔴 Total Pengeluaran", value: `Rp ${formatRupiah(expense)}`, inline: true },
                    { name: "\u200B", value: "───────────────────────", inline: false },
                    { name: profitTitle, value: profitStatus, inline: false }
                )
                .setFooter({ text: "Data Keuangan Internal Store" })
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
