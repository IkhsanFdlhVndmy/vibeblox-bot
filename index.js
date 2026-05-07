require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const mongoose = require('mongoose');
const User = require('./models/User');
const Store = require('./models/Store');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('📂 Database MongoDB Tersambung!'))
    .catch(err => console.error('❌ Gagal koneksi DB:', err));

client.once('clientReady', () => {
    console.log(`✅ Bot ${client.user.tag} Online!`);
});

// === FUNGSI AUTO ROLE PEMBELI ===
async function updateSpenderRoles(member, spentUang) {
    if (!member) return;

    const roleClient = '1489610714988417145';
    const roleElite = '1489611849245786347';
    const rolePrime = '1490140596298580048';

    try {
        if (spentUang > 0 && !member.roles.cache.has(roleClient)) {
            await member.roles.add(roleClient);
        } else if (spentUang <= 0 && member.roles.cache.has(roleClient)) {
            await member.roles.remove(roleClient); 
        }

        if (spentUang >= 1000000 && !member.roles.cache.has(roleElite)) {
            await member.roles.add(roleElite);
        } else if (spentUang < 1000000 && member.roles.cache.has(roleElite)) {
            await member.roles.remove(roleElite);
        }

        if (spentUang >= 10000000 && !member.roles.cache.has(rolePrime)) {
            await member.roles.add(rolePrime);
        } else if (spentUang < 10000000 && member.roles.cache.has(rolePrime)) {
            await member.roles.remove(rolePrime);
        }
    } catch (err) {
        console.error("Gagal update role (Pastikan posisi Role Bot di atas role Prime/Elite/Client):", err.message);
    }
}

// === FUNGSI GENERATE LEADERBOARD (MAX 10 PAGE) ===
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
        try {
            let fetchedUser = client.users.cache.get(user.userId);
            
            if (!fetchedUser) {
                fetchedUser = await client.users.fetch(user.userId);
            }
            
            namaUser = fetchedUser.username; 
        } catch (err) {
            namaUser = "Akun_Dihapus";
        }

        if (namaUser.length > 12) {
            namaUser = namaUser.substring(0, 12) + '..';
        }

        description += `${rankMedal} **@${namaUser}** — 💸 **Rp ${user.uangMasuk.toLocaleString('id-ID')}**\n`;
        rankIndex++;
    }

    if (description === '') description = 'Belum ada data transaksi pembeli nih.';

    description += `\n\n💰 **Total Amount Server**\n💸 **Rp ${totalAmountServer.toLocaleString('id-ID')}**\n\nTingkatkan transaksimu untuk naik pangkat!`;

    const embed = new EmbedBuilder()
        .setTitle(`🏆 Top Spenders Vibeblox (Hal ${page})`)
        .setColor('#4F4580') // <--- WARNA BERUBAH DI SINI
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

// === FUNGSI AUTO-UPDATE LEADERBOARD ===
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

// === EVENT: BACA CHAT MASUK ===
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const vouchChannelId = '1488903383963406507'; 
    if (message.channel.id === vouchChannelId) {
        try {
            await message.react('1502074502228738098'); 
        } catch (err) {
            console.error('Bot gagal ngasih reaction:', err);
        }
    }

    const prefix = '!'; 
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'setupboard') {
        if (!message.member.permissions.has('Administrator')) return;
        
        const boardData = await generateLeaderboard(1);
        const sentMessage = await message.channel.send(boardData);

        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });

        storeData.leaderboardChannelId = message.channel.id;
        storeData.leaderboardMessageId = sentMessage.id;
        await storeData.save();

        await message.delete().catch(() => {});
        return; 
    }

    const allowedChannel = '1489665490770067678';
    if (message.channel.id !== allowedChannel) return;

    const allowedRoles = ['1489612423521374309', '1489612221544665231'];
    const hasRole = message.member.roles.cache.some(role => allowedRoles.includes(role.id));
    
    if (!hasRole) {
        return message.reply('❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.');
    }

    const validCommands = ['adduangmasuk', 'minuangmasuk', 'adduangkeluar', 'minuangkeluar', 'summary'];
    if (!validCommands.includes(command)) return;

    try {
        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });

        if (command === 'adduangmasuk' || command === 'minuangmasuk') {
            const target = message.mentions.users.first();
            const amount = parseInt(args[1]);
            const kategori = args.slice(2).join(' ') || 'Tidak ada kategori';

            if (!target || isNaN(amount)) return message.reply(`❌ Format salah! Contoh: \`!${command} @user 50000 Beli Gamepass\``);
            if (amount <= 0) return message.reply('❌ Nominal gak boleh minus atau nol!');

            let userData = await User.findOne({ userId: target.id });
            if (!userData) userData = new User({ userId: target.id });

            if (command === 'adduangmasuk') {
                userData.uangMasuk += amount;
                storeData.totalUangMasuk += amount;
                await userData.save();
                await storeData.save();
                message.reply(`✅ **Uang Masuk Dicatat!**\n👤 Pembeli: ${target.username}\n💰 Nominal: **Rp ${amount.toLocaleString('id-ID')}**\n🛒 Kategori: ${kategori}\n📊 Total spent user: **Rp ${userData.uangMasuk.toLocaleString('id-ID')}**`);
            } else if (command === 'minuangmasuk') {
                const bisaDikurang = Math.min(userData.uangMasuk, amount);
                userData.uangMasuk = Math.max(0, userData.uangMasuk - amount);
                storeData.totalUangMasuk = Math.max(0, storeData.totalUangMasuk - bisaDikurang);
                await userData.save();
                await storeData.save();
                message.reply(`📉 **Revisi Uang Masuk**\n👤 Pembeli: ${target.username}\n🔻 Dikurangi: **Rp ${amount.toLocaleString('id-ID')}**\n📊 Total spent user: **Rp ${userData.uangMasuk.toLocaleString('id-ID')}**`);
            }

            const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
            await updateSpenderRoles(targetMember, userData.uangMasuk);
            await updateLiveLeaderboard();
        }

        else if (command === 'adduangkeluar' || command === 'minuangkeluar') {
            const amount = parseInt(args[0]);
            const keterangan = args.slice(1).join(' ') || 'Restock / Modal Toko';

            if (isNaN(amount)) return message.reply(`❌ Format salah! Contoh: \`!${command} 150000 Restock dari Web A\``);
            if (amount <= 0) return message.reply('❌ Nominal gak boleh minus atau nol!');

            if (command === 'adduangkeluar') {
                storeData.totalUangKeluar += amount;
                await storeData.save();
                message.reply(`💸 **Pengeluaran Toko Dicatat!**\n💰 Nominal: **Rp ${amount.toLocaleString('id-ID')}**\n📝 Ket: ${keterangan}\n📊 Total Keluar: **Rp ${storeData.totalUangKeluar.toLocaleString('id-ID')}**`);
            } else if (command === 'minuangkeluar') {
                storeData.totalUangKeluar = Math.max(0, storeData.totalUangKeluar - amount);
                await storeData.save();
                message.reply(`📉 **Revisi Pengeluaran Toko**\n🔻 Dikurangi: **Rp ${amount.toLocaleString('id-ID')}**\n📝 Ket: ${keterangan}\n📊 Total Keluar: **Rp ${storeData.totalUangKeluar.toLocaleString('id-ID')}**`);
            }
        }

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

            message.reply({ embeds: [summaryEmbed] });
        }

    } catch (err) {
        console.error(err);
        message.reply('❌ Waduh, database-nya lagi ngambek nih.');
    }
});

// === SISTEM ANTI-SPAM (DISABLE BUTTON SAAT LOADING) ===
const isUpdating = new Set();

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('lb_page_')) {
        // Kalau tombol udah diklik dan lagi proses, abaikan klik selanjutnya secara mutlak
        if (isUpdating.has(interaction.message.id)) return;
        
        isUpdating.add(interaction.message.id);

        try {
            // 1. Ambil format tombol saat ini, lalu matikan dan ganti labelnya jadi "Loading..."
            const disabledRows = interaction.message.components.map(row => {
                return ActionRowBuilder.from(row).setComponents(
                    row.components.map(btn => ButtonBuilder.from(btn).setDisabled(true).setLabel('Loading...'))
                );
            });

            // 2. Update pesan seketika (ini bakal ngerespon interaksi ke Discord di bawah 1 detik)
            await interaction.update({ components: disabledRows });

            // 3. Bot tarik data (proses yang memakan waktu)
            const page = parseInt(interaction.customId.split('_')[2]);
            const boardData = await generateLeaderboard(page);

            // 4. Timpa pesannya dengan data list baru & tombol yang udah nyala/normal lagi
            await interaction.editReply(boardData); 

        } catch (err) {
            console.error("Kendala saat pindah halaman:", err.message);
        } finally {
            // Buka gemboknya setelah kelar
            isUpdating.delete(interaction.message.id);
        }
    }
});

client.login(process.env.TOKEN);

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot VibeBlox lagi nongkrong 24/7 nih!');
});

app.listen(port, () => {
    console.log(`🌐 Web server nyala di port ${port}`);
});
