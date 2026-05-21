require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Options } = require('discord.js');
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
    // === OPTIMASI SUPER (TETAP DIPERTAHANKAN) ===
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 15, 
        PresenceManager: 0, 
        VoiceStateManager: 0, 
        ThreadManager: 0, 
        ReactionManager: 0, 
        GuildInviteManager: 0 
    }),
});

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('📂 Database MongoDB Tersambung!'))
    .catch(err => console.error('❌ Gagal koneksi DB:', err));

// === DAFTAR SLASH COMMANDS ===
// PERUBAHAN: Tipe 'amount' diubah dari 4 (Integer) jadi 3 (String) biar bisa pakai titik
const slashCommands = [
    { name: 'setupboard', description: 'Setup panel Leaderboard' },
    { 
        name: 'restock', description: 'Countdown restock Robux',
        options: [
            { name: 'amount', description: 'Jumlah Robux (contoh: 55.000)', type: 3, required: true },
            { name: 'hari', description: 'Berapa hari lagi? (contoh: 5)', type: 4, required: true }
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

client.once('clientReady', async () => {
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

// === FUNGSI GENERATE LEADERBOARD ===
async function generateLeaderboard(page) {
    if (page > 10) page = 10;

    const limit = 10; 
    const skip = (page - 1) * limit;

    const users = await User.find({ uangMasuk: { $gt: 0 } }).sort({ uangMasuk: -1 }).skip(skip).limit(limit);
    const totalUsers = await User.countDocuments({ uangMasuk: { $gt: 0 } }); 
    
    const calculatedPages = Math.ceil(totalUsers / limit) || 1;
    const totalPages = Math.min(calculatedPages, 10);

    let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
    let totalAmountServer = storeData ? storeData.totalUangMasuk : 0;

    let description = '';
    let rankIndex = 0;
    
    for (const user of users) {
        const rank = skip + rankIndex + 1;
        let rankMedal = `**#${rank}**`;
        
        if (rank === 1) rankMedal = '🥇';
        else if (rank === 2) rankMedal = '🥈';
        else if (rank === 3) rankMedal = '🥉';

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

        description += `${rankMedal} **@${namaUser}** — 💸 **Rp ${user.uangMasuk.toLocaleString('id-ID')}**\n`;
        rankIndex++;
    }

    if (description === '') description = 'Belum ada data transaksi pembeli nih.';

    description += `\n\n💰 **Total Amount Server**\n💸 **Rp ${totalAmountServer.toLocaleString('id-ID')}**\n\nTingkatkan transaksimu untuk naik pangkat!`;

    const embed = new EmbedBuilder()
        .setTitle(`🏆 Top Spenders Vibeblox (Hal ${page})`)
        .setColor('#4F4580') 
        .setDescription(description);

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`lb_page_${page - 1}`)
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page <= 1),
            new ButtonBuilder()
                .setCustomId(`lb_page_${page + 1}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page >= totalPages) 
        );

    return { embeds: [embed], components: [row] };
}

async function updateLiveLeaderboard() {
    try {
        const storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
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
    if (interaction.isButton() && interaction.customId.startsWith('lb_page_')) {
        if (isUpdating.has(interaction.message.id)) return;
        isUpdating.add(interaction.message.id);

        try {
            const disabledRows = interaction.message.components.map(row => {
                return ActionRowBuilder.from(row).setComponents(
                    row.components.map(btn => ButtonBuilder.from(btn).setDisabled(true).setLabel('Loading...'))
                );
            });
            await interaction.update({ components: disabledRows });

            const page = parseInt(interaction.customId.split('_')[2]);
            const boardData = await generateLeaderboard(page);

            await interaction.editReply(boardData); 
        } catch (err) {
            console.error(err);
        } finally {
            isUpdating.delete(interaction.message.id);
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;

    // --- SETUP BOARD ---
    if (command === 'setupboard') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ Anda tidak memiliki izin Administrator.', ephemeral: true });
        }
        
        const boardData = await generateLeaderboard(1);
        const sentMessage = await interaction.channel.send(boardData);

        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });

        storeData.leaderboardChannelId = interaction.channel.id;
        storeData.leaderboardMessageId = sentMessage.id;
        await storeData.save();

        return interaction.reply({ content: '✅ Panel Leaderboard berhasil dipasang di channel ini!', ephemeral: true });
    }

    // --- RESTOCK COUNTDOWN SUPER HIGHLIGHT ---
    if (command === 'restock') {
        if (!interaction.member.roles.cache.has('1489612423521374309')) {
            return interaction.reply({ content: '❌ Sori, command ini khusus Owner.', ephemeral: true });
        }

        // Ambil data string (misal "55.000") lalu bersihkan titiknya jadi angka (55000)
        const rawAmount = interaction.options.getString('amount');
        const amount = parseInt(rawAmount.replace(/\./g, ''), 10);
        
        // Validasi kalau yang diinput ternyata bukan angka
        if (isNaN(amount) || amount <= 0) {
            return interaction.reply({ content: '❌ Nominal Robux tidak valid! Pastikan hanya memakai angka dan titik (contoh: 55.000).', ephemeral: true });
        }

        const days = interaction.options.getInteger('hari'); 

        const ms = days * 24 * 60 * 60 * 1000; 
        const futureTime = new Date(Date.now() + ms);
        const unixTimestamp = Math.floor(futureTime.getTime() / 1000);

        const formattedAmount = amount >= 1000 ? Math.floor(amount / 1000) + 'K+' : amount.toLocaleString('id-ID');

        const restockEmbed = new EmbedBuilder()
            .setColor('#4F4580')
            .setDescription(`**📦 VIBEBLOX RESTOCK INCOMING!**\nHalo warga VibeBlox! Amunisi Robux kita bakal segera mendarat di server. Pasang alarm kalian dan jangan sampai kehabisan pas udah turun!\n\n# <:robux:1497884445494087752> ${formattedAmount} Robux\n\n## ⏳ <t:${unixTimestamp}:R>\n*(Tepatnya mendarat pada: <t:${unixTimestamp}:F>)*`)
            .setFooter({ text: 'VibeBlox Auto-Notifier' })
            .setTimestamp();

        const replyMessage = await interaction.reply({ content: '@everyone', embeds: [restockEmbed], fetchReply: true });

        if (ms <= 2147483647) {
            setTimeout(async () => {
                try {
                    const finishedEmbed = new EmbedBuilder()
                        .setColor('#4F4580')
                        .setDescription(`**✅ RESTOCK SELESAI!**\nPenantian berakhir! Amunisi Robux udah masuk sepenuhnya ke gudang VibeBlox. Langsung aja sikat sekarang sebelum diborong yang lain!\n\n# <:robux:1497884445494087752> ${formattedAmount} Robux\n\n## 🎉 STOK READY!`)
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
        return interaction.reply({ content: '❌ Command ini hanya bisa digunakan di channel Finance.', ephemeral: true });
    }

    const allowedRoles = ['1489612423521374309', '1489612221544665231'];
    const hasRole = interaction.member.roles.cache.some(role => allowedRoles.includes(role.id));
    if (!hasRole) {
        return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', ephemeral: true });
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
            await updateLiveLeaderboard();

            const msgText = command === 'anonymous' 
                ? `🥷 **Berhasil!** Akun ${target.username} disembunyikan menjadi **Anonymous** di Leaderboard.` 
                : `👁️ **Berhasil!** Akun ${target.username} ditampilkan kembali di Leaderboard.`;
            return interaction.reply({ content: msgText });
        }

        // --- ADD / MIN UANG MASUK ---
        else if (command === 'adduangmasuk' || command === 'minuangmasuk') {
            const target = interaction.options.getUser('user');
            
            // Konversi dari string "50.000" jadi angka 50000 murni
            const rawAmount = interaction.options.getString('amount');
            const amount = parseInt(rawAmount.replace(/\./g, ''), 10);
            const kategori = interaction.options.getString('keterangan') || 'Tidak ada kategori';

            if (isNaN(amount) || amount <= 0) return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 50.000).', ephemeral: true });

            let userData = await User.findOne({ userId: target.id });
            if (!userData) userData = new User({ userId: target.id });

            let replyMessage = '';

            if (command === 'adduangmasuk') {
                userData.uangMasuk += amount;
                storeData.totalUangMasuk += amount;
                replyMessage = `✅ **Uang Masuk Dicatat!**\n👤 Pembeli: ${target.username}\n💰 Nominal: **Rp ${amount.toLocaleString('id-ID')}**\n🛒 Kategori: ${kategori}\n📊 Total spent user: **Rp ${userData.uangMasuk.toLocaleString('id-ID')}**`;
            } else {
                const bisaDikurang = Math.min(userData.uangMasuk, amount);
                userData.uangMasuk = Math.max(0, userData.uangMasuk - amount);
                storeData.totalUangMasuk = Math.max(0, storeData.totalUangMasuk - bisaDikurang);
                replyMessage = `📉 **Revisi Uang Masuk**\n👤 Pembeli: ${target.username}\n🔻 Dikurangi: **Rp ${amount.toLocaleString('id-ID')}**\n📊 Total spent user: **Rp ${userData.uangMasuk.toLocaleString('id-ID')}**`;
            }

            await userData.save();
            await storeData.save();

            const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
            await updateSpenderRoles(targetMember, userData);
            await updateLiveLeaderboard();

            return interaction.reply({ content: replyMessage });
        }

        // --- ADD / MIN UANG KELUAR ---
        else if (command === 'adduangkeluar' || command === 'minuangkeluar') {
            
            // Konversi dari string "150.000" jadi angka 150000 murni
            const rawAmount = interaction.options.getString('amount');
            const amount = parseInt(rawAmount.replace(/\./g, ''), 10);
            const keterangan = interaction.options.getString('keterangan') || 'Restock / Modal Toko';

            if (isNaN(amount) || amount <= 0) return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 150.000).', ephemeral: true });

            let replyMessage = '';

            if (command === 'adduangkeluar') {
                storeData.totalUangKeluar += amount;
                replyMessage = `💸 **Pengeluaran Toko Dicatat!**\n💰 Nominal: **Rp ${amount.toLocaleString('id-ID')}**\n📝 Ket: ${keterangan}`;
            } else {
                storeData.totalUangKeluar = Math.max(0, storeData.totalUangKeluar - amount);
                replyMessage = `📉 **Revisi Pengeluaran Toko**\n🔻 Dikurangi: **Rp ${amount.toLocaleString('id-ID')}**\n📝 Ket: ${keterangan}`;
            }

            await storeData.save();
            return interaction.reply({ content: replyMessage });
        }

        // --- SUMMARY ---
        else if (command === 'summary') {
            const income = storeData.totalUangMasuk;
            const expense = storeData.totalUangKeluar;
            const profit = income - expense;

            let profitTitle = "", profitStatus = "", embedColor = 0;

            if (profit > 0) {
                profitTitle = "✨ KEUNTUNGAN BERSIH (PROFIT)";
                profitStatus = `📈 **Rp ${profit.toLocaleString('id-ID')}**`;
                embedColor = 3066993; 
            } else if (profit < 0) {
                const absProfit = Math.abs(profit);
                profitTitle = "⚠️ KERUGIAN / MINUS";
                profitStatus = `📉 **-Rp ${absProfit.toLocaleString('id-ID')}**`;
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
                    { name: "🟢 Total Pemasukan", value: `Rp ${income.toLocaleString('id-ID')}`, inline: true },
                    { name: "🔴 Total Pengeluaran", value: `Rp ${expense.toLocaleString('id-ID')}`, inline: true },
                    { name: "\u200B", value: "───────────────────────", inline: false },
                    { name: profitTitle, value: profitStatus, inline: false }
                )
                .setFooter({ text: "Data Keuangan Internal Store" })
                .setTimestamp();

            return interaction.reply({ embeds: [summaryEmbed] });
        }

    } catch (err) {
        console.error(err);
        return interaction.reply({ content: '❌ Waduh, database-nya lagi ngambek nih.', ephemeral: true });
    }
});

client.login(process.env.TOKEN);

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot VibeBlox lagi nongkrong 24/7 nih!'));
app.listen(port);
