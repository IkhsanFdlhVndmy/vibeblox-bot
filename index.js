require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Options, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');
const User = require('./models/User');
const Store = require('./models/Store');
const RobuxRate = require('./models/RobuxRate');
const Partner = require('./models/Partner'); // <--- TAMBAHKAN INI

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

// === FUNGSI GENERATE LIVE MENU EMBED ===
function buildMenuEmbed(menuType, rate) {
    const embed = new EmbedBuilder().setColor(0x4F4580);
    const authorIcon = 'https://cdn.discordapp.com/attachments/1500317839507062897/1515115963928940706/iconbot.png?ex=6a2dd533&is=6a2c83b3&hm=747d02971654e0e51f924d09f1ad3737bef4e1bf19ba157a6dd1c397093b9ce0&';
    embed.setAuthor({ name: 'VibeBlox', iconURL: authorIcon });

    // Definisi Emoji (a = animasi/GIF)
    const rx = '<:robux:1497884445494087752>'; // Static
    const arr = '<:arrow:1515113279494684762>'; // Static
    const ver = '<a:verified:1502074502228738098>'; // Animasi (GIF)
    const gift = '<:purplegift:1515114763842097175>'; // Static
    const ann = '<a:announcement:1515137458126328003>'; // Animasi (GIF)
    
    // Garis pembatas elegan untuk spacing
    const separator = '──────────────────────────────';

if (menuType === 'howtoorder') {
        embed.setTitle(`${ann} CARA PEMESANAN (HOW TO ORDER)`)
             .setDescription(`Selamat datang di VibeBlox! Silakan ikuti panduan di bawah ini untuk melakukan transaksi.\n\n${separator}\n\n**🛒 DAFTAR HARGA (PRICELIST)**\nKlik tombol di bawah untuk melihat harga sesuai metode:\n• **Robux Via Community**: (Instant, tanpa potongan, wajib join 14 hari)\n• **Robux Via Gamepass**: (Sistem After Tax, terima bersih, pending 5 Hari)\n• **Robux Via Login**: (Robux Instant via login untuk top up, 5-15 menit)\n• **Robux Send Username**: (Robux instant via Send Username, tanpa pending)\n• **Gift In-Game**: (Gift item langsung di dalam Map)\n\n${separator}\n\n**📋 LANGKAH-LANGKAH ORDER**\n1. Tentukan jumlah Robux atau Item dari channel harga.\n2. Buka tiket pembelian kamu.\n3. Beri tahu admin apa yang ingin dibeli.\n4. Selesaikan pembayaran dan kirimkan bukti transfer.\n5. Admin akan memproses pesananmu dengan cepat dan aman! ${ver}`)
             .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1515102392457367562/Frame_61.png?ex=6a2dc88f&is=6a2c770f&hm=1a7cd451fef3f7f7e979de69fc2cb9260d3169bd29e40cfc66d53e4a26f9e33d&');
        return embed;
    }

    const m = [100, 500, 1000, 2000, 5000, 10000];
    let priceList = '';

    if (menuType === 'vilog') {
        const mv = [500, 1000, 1500, 2000, 5000, 10000];
        priceList = `**Rate: Rp ${formatRupiah(rate)} / 500 Robux**\n`;
        mv.forEach(val => priceList += `${val} ${rx} ${arr} Rp ${formatRupiah((val/500)*rate)}\n`);
        priceList += `\n*Note: Minimal pembelian 500 Robux.*`;
        
        embed.setTitle(`${ann} PRICE LIST VIA LOGIN (INSTANT)`)
             .setDescription(`**100% Aman, Clean & Anti-CC** ${ver}\nTop-up Robux langsung masuk tanpa pending. Proses dijamin **100% Legal dan Anti-Phising**. Keamanan privasi kamu adalah prioritas mutlak kami; setelah proses pengisian selesai, **akun akan otomatis di-logout** dari perangkat admin.\n\n${priceList}`)
             .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1515102338266955947/Frame_59.png?ex=6a2dc882&is=6a2c7702&hm=0b73e82c385053de2830cbfa93379cdc67e87fdd6e650130377f99e5bb4b28df&');

    } else if (menuType === 'community') {
        priceList = `**Rate: Rp ${rate} / 1 Robux**\n`;
        m.forEach(val => priceList += `${val} ${rx} ${arr} Rp ${formatRupiah(val*rate)}\n`);
        
        embed.setTitle(`${ann} PRICE LIST VIA PAYOUT COMMUNITY (INSTANT)`)
             .setDescription(`**Pengiriman Robux Langsung (Tanpa Login/Pending)** ${ver}\nRobux dikirim langsung ke saldo akun melalui sistem Payout Community Roblox kami. **SYARAT WAJIB**: Sesuai kebijakan Roblox, kamu **wajib sudah bergabung (Join) di Community kami minimal 14 Hari** agar sistem mengizinkan proses pencairan dana.\n\n**Link Grup Komunitas:**\nKomunitas 1:\nhttps://www.roblox.com/communities/1064667246/BEJIRLAH-Community\n\nKomunitas 2:\nhttps://www.roblox.com/id/communities/1108229986/Vandamoy\n\nKomunitas 3:\nhttps://www.roblox.com/groups/654669898\n\n${priceList}`)
             .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1515102402657915081/Frame_57.png?ex=6a2dc892&is=6a2c7712&hm=59ff55fdb78d365538f8464c291d309c1be584876ee2ff194d350935245ee954&');

    } else if (menuType === 'gamepass_after') {
        priceList = `**Rate: Rp ${rate} / 1 Robux**\n`;
        m.forEach(val => priceList += `${val} ${rx} ${arr} Rp ${formatRupiah(val*rate)}\n`);
        
        embed.setTitle(`${ann} PRICE LIST VIA GAMEPASS (AFTER TAX)`)
             .setDescription(`**Jaminan Terima Bersih & 100% Legal** ${ver}\nPembelian Robux melalui sistem pembuatan Gamepass. Kami **HANYA menjual sistem After Tax (Terima Bersih)**, artinya nominal di bawah adalah **jumlah mutlak yang pasti masuk** ke saldo kamu (Pajakan 30% sepenuhnya kami yang tanggung). Estimasi Robux cair dari status pending adalah **5 Hari (120 Jam)**.\n\n${priceList}`)
             .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1515102379018551316/Frame_58.png?ex=6a2dc88c&is=6a2c770c&hm=71eeb3d6c2ce1f64c4e47ab8e6f56bbbc2e2fc4948d6f004788e47befda1914f&');

    } else if (menuType === 'robux_plus') {
        priceList = `**Rate: Rp ${rate} / 1 Robux**\n`;
        m.forEach(val => priceList += `${val} ${rx} ${arr} Rp ${formatRupiah(val*rate)}\n`);
            
        embed.setTitle(`${ann} PRICE LIST VIA SEND USERNAME`)
             .setDescription(`**Instant & Cepat via Roblox Plus** ${ver}\nRobux dikirim secara instant tanpa pending. Kamu hanya perlu memberikan username Roblox kamu, dan kami akan mengirimkan Robux-nya menggunakan fitur Roblox Plus dengan aman.\n\n${priceList}`)
             .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1515102366720852028/Frame_62.png?ex=6a2dc889&is=6a2c7709&hm=b00a59ff9fd0fdcb73d69a10188c0e37f41841f4ac4d7d7db7820f5a61362925&');

    } else if (menuType === 'gig') {
        priceList = `**Rate: Rp ${rate} / 1 Robux**\n`;
        m.forEach(val => priceList += `${val} Robux ${gift} ${arr} Rp ${formatRupiah(val*rate)}\n`);
        
        embed.setTitle(`${ann} PRICE LIST GIFT IN-GAME (ITEM)`)
             .setDescription(`**Harga Item Termurah Untuk Semua Map & Game Roblox** ${ver}\nPembelian item langsung di dalam server game dengan harga **jauh lebih murah**. Metode ini **berlaku untuk SELURUH map & game di Roblox** yang memiliki fitur "Gift" item. Admin akan join ke server kamu dan membelikan item sesuai nominal pesanan.\n\n${priceList}\n**Custom nominal? Tinggal tanya admin aja!** ✅`)
             .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1515102352980443347/Frame_60.png?ex=6a2dc886&is=6a2c7706&hm=a23232198e220f01660e3affc176796a2ce61536238978eb3d1c14efbbbd9017&');
    }

    return embed;
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
            { 
                name: 'sumber', description: 'Pilih sumber uang masuk', type: 3, required: true,
                choices: [
                    { name: 'Store Utama', value: 'utama' },
                    { name: 'Partner', value: 'partner' }
                ]
            },
            { name: 'keterangan', description: 'Keterangan/Kategori', type: 3, required: false }
        ]
    },
    {
        name: 'minuangmasuk', description: 'Kurangi saldo spent pembeli',
        options: [
            { name: 'user', description: 'Pilih User', type: 6, required: true },
            { name: 'amount', description: 'Nominal Rupiah (contoh: 50.000)', type: 3, required: true },
            { 
                name: 'sumber', description: 'Pilih sumber yang akan dikurangi', type: 3, required: true,
                choices: [
                    { name: 'Store Utama', value: 'utama' },
                    { name: 'Partner', value: 'partner' }
                ]
            },
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
    },
    // --- COMMAND PARTNER BARU ---
    {
        name: 'partnerinvoice', description: 'Buat invoice pembelian Robux khusus Partner',
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
    },
    { name: 'partnersummary', description: 'Lihat laporan keuangan khusus Partner' },
    // ... command invoice sebelumnya ...
    {
        name: 'postmenu', description: 'Posting Live Menu Pricelist',
        options: [
            {
                name: 'type', description: 'Pilih tipe menu yang mau dipost', type: 3, required: true,
                choices: [
                    { name: 'Community Payout', value: 'community' },
                    { name: 'Gamepass', value: 'gamepass_after' },
                    { name: 'Via Login (Vilog)', value: 'vilog' },
                    { name: 'Send Username', value: 'robux_plus' },
                    { name: 'Gift In Game', value: 'gig' },
                    { name: 'How To Order', value: 'howtoorder' }
                ]
            }
        ]
    },
    //cek eligble
    {
        name: 'cek-eligible', 
        description: 'Cek status antrean 14 hari di grup BEJIRLAH & Vandamoy',
        options: [
            { name: 'username', description: 'Username Roblox pembeli', type: 3, required: true }
        ]
    },
    // --- TAMBAHAN BARU: OMEN ---
    {
        name: 'omen', description: 'Tampilkan metode pembayaran Partner Omen',
        options: [
            {
                name: 'metode', description: 'Pilih QRIS atau Bank', type: 3, required: true,
                choices: [
                    { name: 'QRIS', value: 'qris' },
                    { name: 'Bank SeaBank', value: 'bank' }
                ]
            }
        ]
    },
    // --- TAMBAHAN BARU: FORM TICKET ---
    {
        name: 'form',
        description: 'Kirim template form untuk pembeli di ticket'
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

        if (spentUang >= 5000000 && !isAnon && !member.roles.cache.has(rolePrime)) {
            await member.roles.add(rolePrime);
        } else if ((spentUang < 5000000 || isAnon) && member.roles.cache.has(rolePrime)) {
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

    // MENGHITUNG TOTAL SERVER (UTAMA + PARTNER)
    const storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' }).lean();
    const storeTotal = storeData ? storeData.totalUangMasuk : 0;
    
    const partnerData = await Partner.find({}).lean();
    const partnerTotal = partnerData.reduce((acc, curr) => acc + (curr.totalUangMasuk || 0), 0);
    
    const totalAmountServer = storeTotal + partnerTotal;

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
let isCheckingEligible = false;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        
        const parts = interaction.customId.split('_');
        const action = parts[1]; // cancel, bca, qris, dana, gopay, done
        const invoiceMsgId = parts[2];

        // --- HANYA ADMIN/HANDLER YANG BISA CANCEL & DONE ---
        if ((action === 'cancel' || action === 'done') && !hasRoleInv) {
            return interaction.reply({ content: '❌ Hanya Owner dan Handler yang bisa menekan tombol ini.', flags: MessageFlags.Ephemeral });
        }

        // --- CANCEL: hapus pesan invoice ---
        if (action === 'cancel') {
            await interaction.deferUpdate();
            try { await interaction.message.delete(); } catch (e) {}
            return;
        }

        // --- PAYMENT BUTTONS (SEMUA ORANG BISA KLIK, LALU DISABLE TOMBOLNYA ANTI SPAM) ---
        if (['bca', 'qris', 'dana', 'gopay'].includes(action)) {
            // Cek apakah tombol ini udah di-handle (Anti-spam/Interaction Failed Guard)
            if (isUpdating.has(interaction.message.id)) {
                return interaction.reply({ content: '⏳ Mohon tunggu, metode sedang dimuat...', flags: MessageFlags.Ephemeral });
            }
            isUpdating.add(interaction.message.id);

            // 1) Segera berikan response deferUpdate() agar API Discord tidak timeout (menghindari interaction failed)
            await interaction.deferUpdate();

            try {
                // 2) Tampilkan embed metode pembayarannya di bawah invoice
                const embedPay = new EmbedBuilder().setTimestamp();
                if (action === 'bca') {
                    embedPay.setColor(0x003D79).setTitle('🏦 Transfer Bank BCA VibeBlox').addFields({ name: '👤 Atas Nama', value: '**Angel Vinny Vincentia Pelawi**' }, { name: '🔢 No. Rekening', value: '**8205363625**' }, { name: '🏦 Bank', value: '**BCA**' }).setFooter({ text: 'VibeBlox Payment' });
                } else if (action === 'qris') {
                    embedPay.setColor(0x4F4580).setTitle('💳 Pembayaran QRIS VibeBlox').setDescription('Silakan scan QRIS di bawah ini untuk melakukan pembayaran.').setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1500317889872269324/1777300289337-1.png?ex=6a1c40ab&is=6a1aef2b&hm=be36eb1b73fd7c0448b6e5b989cac3eb5a15bd6cc88caefec52c55704cb534b6&').setFooter({ text: 'VibeBlox Payment' });
                } else if (action === 'dana') {
                    embedPay.setColor(0x108EE9).setTitle('💙 Pembayaran Dana VibeBlox').addFields({ name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**' }, { name: '📱 Nomor Dana', value: '**08119931329**' }, { name: '💳 Platform', value: '**Dana**' }).setFooter({ text: 'VibeBlox Payment' });
                } else if (action === 'gopay') {
                    embedPay.setColor(0x00AED6).setTitle('💚 Pembayaran GoPay VibeBlox').addFields({ name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**' }, { name: '📱 Nomor GoPay', value: '**08119931329**' }, { name: '💳 Platform', value: '**GoPay**' }).setFooter({ text: 'VibeBlox Payment' });
                }

                await interaction.followUp({ embeds: [embedPay] });

                // 3) Edit pesan utama (Invoice) untuk men-disable tombol yang baru saja dipencet
                const newComponents = interaction.message.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => {
                        // Jika custom ID tombol sama dengan yang baru saja dipencet, matikan tombolnya
                        if (btn.data.custom_id === interaction.customId) {
                            btn.setDisabled(true);
                        }
                    });
                    return newRow;
                });

                await interaction.message.edit({ components: newComponents });
            } catch (err) {
                console.error("Payment button error:", err);
            } finally {
                // Lepas lock anti-spam setelah selesai proses
                isUpdating.delete(interaction.message.id);
            }
            return;
        }

        // --- DONE: mulai flow ephemeral ---

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

            // Mapping keterangan Vouch sesuai Tipe
            const vouchDescriptions = {
                'community': 'Robux Payout Instant',
                'vilog': 'Robux Via Login',
                'gamepass_after': 'Robux Gamepass After',
                'gamepass_before': 'Robux Gamepass Before',
                'gig': 'Robux Gift in-Game',
                'robux_plus': 'Robux Via Send Username'
            };

            // SEGERA eksekusi update untuk menghindari Interaction Failed (Ram & CPU friendly)
            await interaction.update({ content: '⏳ Memproses transaksi & generate vouch...', embeds: [], components: [] });

            try {
                // Fetch invoice message to get data from embed
                const invoiceMsg = await interaction.channel.messages.fetch(msgIdPart);
                const invoiceEmbed = invoiceMsg.embeds[0];

                let targetUserId = null;
                let totalHarga = 0;
                let amountRobux = 0;
                let adminUserId = interaction.user.id; // Default ID Admin yang klik "Yakin"

                if (invoiceEmbed && invoiceEmbed.fields) {
                    for (const field of invoiceEmbed.fields) {
                        if (field.name.includes('Pembeli') && field.value.includes('<@')) {
                            const match = field.value.match(/<@(\d+)>/);
                            if (match) targetUserId = match[1];
                        }
                        if (field.name.includes('Admin') && field.value.includes('<@')) {
                            const match = field.value.match(/<@(\d+)>/);
                            if (match) adminUserId = match[1];
                        }
                        if (field.name.includes('Total Harga') || field.name.includes('Total Bayar')) {
                            const numMatch = field.value.replace(/[^\d]/g, '');
                            if (numMatch) totalHarga = parseInt(numMatch);
                        }
                        // Tarik otomatis jumlah Robux
                        if (field.name.includes('Jumlah Robux')) {
                            const numMatch = field.value.replace(/[^\d]/g, '');
                            if (numMatch) amountRobux = parseInt(numMatch);
                        }
                    }
                }

                if (!targetUserId || !totalHarga || !amountRobux) {
                    await interaction.editReply({ content: '❌ Gagal membaca data dari invoice.' });
                    isUpdating.delete(`inv_done_${msgIdPart}`);
                    return;
                }

                // 1) EKSEKUSI DATABASE SECARA BERURUTAN (Aman untuk 0.25 CPU)
                let userData = await User.findOne({ userId: targetUserId });
                if (!userData) userData = new User({ userId: targetUserId });
                userData.uangMasuk += totalHarga;
                await userData.save();

                let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
                if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });
                storeData.totalUangMasuk += totalHarga;
                await storeData.save();

                const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                await updateSpenderRoles(targetMember, userData);
                scheduleLiveLeaderboardUpdate();

                // 2) UBAH WARNA EMBED INVOICE JADI HIJAU (TANDA SELESAI)
                const doneEmbed = EmbedBuilder.from(invoiceEmbed)
                    .setColor(0x57F287)
                    .setFooter({ text: '✅ Invoice Selesai • VibeBlox' });

                const disabledComponents = invoiceMsg.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => btn.setDisabled(true));
                    return newRow;
                });

                await invoiceMsg.edit({ embeds: [doneEmbed], components: disabledComponents });

                // 3) KIRIM LOG KE STORE-FINANCE
                const financeChannelId = '1489665490770067678';
                const kategori = `${typeNames[typeValue] || typeValue} - ${methodNames[method] || method}`;

                let pembeliDisplay = `<@${targetUserId}>`;
                try {
                    const fetched = targetMember || await interaction.guild.members.fetch(targetUserId);
                    if (fetched) {
                        pembeliDisplay = `<@${targetUserId}>\n(${fetched.displayName} • @${fetched.user.username})`;
                    }
                } catch (e) {}

                const historyEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('✅ Uang Masuk Dicatat!')
                    .addFields(
                        { name: '👤 Pembeli', value: pembeliDisplay, inline: true },
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: true },
                        { name: '🛒 Kategori', value: kategori, inline: true },
                        { name: '📊 Total spent user', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();

                try {
                    const financeChannel = await client.channels.fetch(financeChannelId);
                    if (financeChannel) await financeChannel.send({ embeds: [historyEmbed] });
                } catch (e) { console.error("Gagal kirim ke store-finance:", e.message); }

               // 4) GENERATE & KIRIM PESAN AUTO-VOUCH (UI/UX Mobile Friendly Menggunakan Embed)
                const separator = '──────────────────────────────';
                const vouchDesc = vouchDescriptions[typeValue] || 'Robux';
                const vouchTemplate = `+vouch robux <@${adminUserId}> ${amountRobux} ${vouchDesc}`;

                const autoVouchEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('📥 Bantu Vouch! ')
                    .setDescription(`Silahkan Kirim Teks Vouch dibawah ini Ke Channel <#1488903383963406507> ya!\n${separator}\n**📱 Pengguna HP:** Tekan dan tahan teks vouch di paling bawah, Lalu pencet **Copy Text**. \n**💻 Pengguna PC:** Blok teks paling bawah lalu tekan **CTRL+C**.\n${separator}\n\n**👇 SALIN TEKS VOUCH DI BAWAH INI:**`);

                // Mengirim Embed instruksi
                await interaction.channel.send({ embeds: [autoVouchEmbed] });

                // Mengirim Teks Vouch Murni sebagai chat terpisah (Bisa di-copy gampang di iOS/Android)
                await interaction.channel.send({ content: vouchTemplate });

                // Update pesan ephemeral admin
                await interaction.editReply({ content: '✅ Invoice selesai! Pencatatan dan Auto-Vouch berhasil diproses.' });

            } catch (err) {
                console.error("Invoice confirm error:", err.message);
                await interaction.editReply({ content: '❌ Terjadi error saat memproses invoice.' });
                try {
                    // Coba hidupkan lagi tombol Done jika gagal di tengah jalan
                    const invoiceMsg = await interaction.channel.messages.fetch(msgIdPart);
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
                } catch(e) {}
            } finally {
                isUpdating.delete(`inv_done_${msgIdPart}`);
            }
            return;
        }

        return;
    }

    // =========================================================================
    // === PARTNER INVOICE BUTTONS & FLOW (KHUSUS ROLE PARTNER) ===
    // =========================================================================
    if (interaction.isButton() && (interaction.customId.startsWith('pinv_') || interaction.customId.startsWith('pinvf_'))) {
        const rolePartnerId = '1519076541055897670';
        if (!interaction.member.roles.cache.has(rolePartnerId)) {
            return interaction.reply({ content: '❌ Hanya Partner yang bisa menekan tombol ini.', flags: MessageFlags.Ephemeral });
        }

        const customId = interaction.customId;
        
        // --- BUTTON UTAMA: CANCEL & DONE ---
        if (customId.startsWith('pinv_')) {
            const parts = customId.split('_');
            const action = parts[1]; // cancel atau done
            const invoiceMsgId = parts[2];

            if (action === 'cancel') {
                await interaction.deferUpdate();
                try { await interaction.message.delete(); } catch (e) {}
                return;
            }

            if (action === 'done') {
                if (isUpdating.has(`pinv_done_${invoiceMsgId}`)) {
                    return interaction.reply({ content: '⏳ Proses sedang berlangsung...', flags: MessageFlags.Ephemeral });
                }
                isUpdating.add(`pinv_done_${invoiceMsgId}`);

                try {
                    // Disable button to loading
                    const currentComponents = interaction.message.components.map(row => {
                        const newRow = ActionRowBuilder.from(row);
                        newRow.components.forEach(btn => btn.setDisabled(true));
                        return newRow;
                    });
                    await interaction.update({ components: currentComponents });

                    // Pilih Tipe Transaksi
                    const typeRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`pinvf_type_community_${invoiceMsgId}`).setLabel('Community').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`pinvf_type_gamepass_after_${invoiceMsgId}`).setLabel('GP After').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`pinvf_type_gig_${invoiceMsgId}`).setLabel('GIG').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`pinvf_type_vilog_${invoiceMsgId}`).setLabel('Vilog').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`pinvf_type_robux_plus_${invoiceMsgId}`).setLabel('Robux Plus').setStyle(ButtonStyle.Primary)
                    );
                    const cancelRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`pinvf_cancel_${invoiceMsgId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
                    );

                    const typeEmbed = new EmbedBuilder().setColor(0x4F4580).setTitle('📋 Pilih Tipe Transaksi (Partner)').setDescription('Pilih salah satu tipe di bawah:');
                    await interaction.followUp({ embeds: [typeEmbed], components: [typeRow, cancelRow], flags: MessageFlags.Ephemeral });
                } catch (err) {
                    console.error("Partner Invoice Done error:", err);
                } finally {
                    isUpdating.delete(`pinv_done_${invoiceMsgId}`);
                }
                return;
            }
        }

        // --- FLOW EPHEMERAL PARTNER ---
        const lastUnderscoreIdx = customId.lastIndexOf('_');
        const invoiceMsgId = customId.substring(lastUnderscoreIdx + 1);

        // Helper: Menghidupkan kembali tombol utama partner invoice
        const reEnableDonePartner = async () => {
            isUpdating.delete(`pinv_done_${invoiceMsgId}`);
            try {
                const invoiceMsg = await interaction.channel.messages.fetch(invoiceMsgId);
                const origComponents = invoiceMsg.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => {
                        if (btn.data.custom_id && btn.data.custom_id.startsWith('pinv_done')) {
                            btn.setDisabled(false).setLabel('✅ Done');
                        }
                        if (btn.data.custom_id && btn.data.custom_id.startsWith('pinv_cancel')) {
                            btn.setDisabled(false);
                        }
                    });
                    return newRow;
                });
                await invoiceMsg.edit({ components: origComponents });
            } catch (e) {}
        };

        if (customId.startsWith('pinvf_cancel_')) {
            await interaction.update({ content: '❌ Proses dibatalkan.', embeds: [], components: [] });
            await reEnableDonePartner(); // <--- MENGHIDUPKAN TOMBOL
            return;
        }

        // Pilih Metode Pembayaran (Hanya QRIS & BANK)
        if (customId.startsWith('pinvf_type_')) {
            const withoutPrefix = customId.replace('pinvf_type_', '');
            const typeValue = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));
            const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };

            const payRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pinvf_pay_qris_${typeValue}_${invoiceMsgId}`).setLabel('QRIS').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`pinvf_pay_bank_${typeValue}_${invoiceMsgId}`).setLabel('BANK').setStyle(ButtonStyle.Secondary)
            );
            
            // Tambahan: Tombol Cancel
            const cancelRow2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pinvf_cancel_${invoiceMsgId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
            );
            
            const payEmbed = new EmbedBuilder().setColor(0x4F4580).setTitle('💳 Pilih Metode Pembayaran')
                .setDescription(`Tipe: **${typeNames[typeValue] || typeValue}**\nPilih metode pembayaran:`);

            await interaction.update({ embeds: [payEmbed], components: [payRow, cancelRow2] });
            return;
        }

        // Konfirmasi Akhir
        if (customId.startsWith('pinvf_pay_')) {
            const withoutPrefix = customId.replace('pinvf_pay_', '');
            const segmentBeforeMsgId = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));
            const method = segmentBeforeMsgId.substring(0, segmentBeforeMsgId.indexOf('_'));
            const typeValue = segmentBeforeMsgId.substring(segmentBeforeMsgId.indexOf('_') + 1);

            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pinvf_confirm_yes_${method}_${typeValue}_${invoiceMsgId}`).setLabel('✅ Yakin').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`pinvf_confirm_no_${invoiceMsgId}`).setLabel('❌ Tidak').setStyle(ButtonStyle.Danger)
            );

            const confirmEmbed = new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ Konfirmasi Partner').setDescription(`Yakin selesaikan invoice ini?`);
            await interaction.update({ embeds: [confirmEmbed], components: [confirmRow] });
            return;
        }

        if (customId.startsWith('pinvf_confirm_no_')) {
            await interaction.update({ content: '❌ Dibatalkan.', embeds: [], components: [] });
            await reEnableDonePartner(); // <--- MENGHIDUPKAN TOMBOL
            return;
        }

        // EKSEKUSI DATABASE & LOG (YAKIN)
        if (customId.startsWith('pinvf_confirm_yes_')) {
            const withoutPrefix = customId.replace('pinvf_confirm_yes_', '');
            const beforeMsgId = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));
            const method = beforeMsgId.substring(0, beforeMsgId.indexOf('_'));
            const typeValue = beforeMsgId.substring(beforeMsgId.indexOf('_') + 1);

            await interaction.update({ content: '⏳ Memproses transaksi Partner...', embeds: [], components: [] });

            try {
                const invoiceMsg = await interaction.channel.messages.fetch(invoiceMsgId);
                const invoiceEmbed = invoiceMsg.embeds[0];

                let targetUserId = null; let totalHarga = 0; let amountRobux = 0;
                
                if (invoiceEmbed && invoiceEmbed.fields) {
                    for (const field of invoiceEmbed.fields) {
                        if (field.name.includes('Pembeli') && field.value.includes('<@')) targetUserId = field.value.match(/<@(\d+)>/)[1];
                        if (field.name.includes('Total Bayar')) totalHarga = parseInt(field.value.replace(/[^\d]/g, ''));
                        if (field.name.includes('Jumlah Robux')) amountRobux = parseInt(field.value.replace(/[^\d]/g, ''));
                    }
                }

                if (!targetUserId || !totalHarga) return await interaction.editReply({ content: '❌ Gagal baca invoice.' });

                // 1. UPDATE USER SPENDING (Keuntungan VibeBlox Utama)
                let userData = await User.findOne({ userId: targetUserId });
                if (!userData) userData = new User({ userId: targetUserId });
                userData.uangMasuk += totalHarga;
                await userData.save();

                // 2. UPDATE KEUANGAN KHUSUS PARTNER (Tidak masuk ke Store utama)
                let partnerData = await Partner.findOne({ partnerId: interaction.user.id });
                if (!partnerData) partnerData = new Partner({ partnerId: interaction.user.id });
                partnerData.totalUangMasuk += totalHarga;
                await partnerData.save();

                // Auto role & Leaderboard update
                const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                await updateSpenderRoles(targetMember, userData);
                scheduleLiveLeaderboardUpdate();

                // 3. EDIT INVOICE JADI HIJAU
                const doneEmbed = EmbedBuilder.from(invoiceEmbed).setColor(0x57F287).setFooter({ text: '✅ Partner Invoice Selesai' });
                await invoiceMsg.edit({ embeds: [doneEmbed], components: [] });

                // 4. KIRIM LOG KE PARTNER-FINANCE (Channel Khusus)
                const partnerFinanceId = '1519075561396371647';
                let pembeliDisplay = `<@${targetUserId}>`;
                if (targetMember) pembeliDisplay += `\n(${targetMember.displayName})`;

                const historyEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('🤝 Uang Masuk Partner Dicatat!')
                    .addFields(
                        { name: '🧑‍💼 Partner', value: `<@${interaction.user.id}>\n(${interaction.user.displayName} • @${interaction.user.username})`, inline: true },
                        { name: '👤 Pembeli', value: pembeliDisplay, inline: true },
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: true },
                        { name: '🛒 Kategori', value: `${typeValue.toUpperCase()} - ${method.toUpperCase()}`, inline: true },
                        { name: '📊 Total Spent Pembeli', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();

                try {
                    const financeChannel = await client.channels.fetch(partnerFinanceId);
                    if (financeChannel) await financeChannel.send({ embeds: [historyEmbed] });
                } catch (e) { console.error("Gagal kirim log partner:", e.message); }

                // 5. AUTO VOUCH
                const vouchDescriptions = { 'community': 'Robux Payout Instant', 'vilog': 'Robux Via Login', 'gamepass_after': 'Robux Gamepass After', 'gig': 'Robux Gift in-Game', 'robux_plus': 'Robux Via Send Username' };
                const vouchDesc = vouchDescriptions[typeValue] || 'Robux';
                const vouchTemplate = `+vouch robux <@${interaction.user.id}> ${amountRobux} ${vouchDesc}`;

                const separator = '──────────────────────────────';
                const autoVouchEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('📥 Bantu Vouch! ')
                    .setDescription(`Silahkan Kirim Teks Vouch dibawah ini Ke Channel <#1488903383963406507> ya!\n${separator}\n**📱 Pengguna HP:** Tekan dan tahan teks vouch di paling bawah, Lalu pencet **Copy Text**. \n**💻 Pengguna PC:** Blok teks paling bawah lalu tekan **CTRL+C**.\n${separator}\n\n**👇 SALIN TEKS VOUCH DI BAWAH INI:**`);

                // Mengirim Embed instruksi
                await interaction.channel.send({ embeds: [autoVouchEmbed] });

                // Mengirim Teks Vouch Murni sebagai chat terpisah (Bisa di-copy gampang di iOS/Android)
                await interaction.channel.send({ content: vouchTemplate });

                await interaction.editReply({ content: '✅ Transaksi Partner selesai!' });
            } catch (err) {
                console.error("Partner Invoice error:", err);
                await interaction.editReply({ content: '❌ Terjadi error sistem.' });
            }
            return;
        }
        return;
    }
    
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.commandName;

    // --- POST MENU LIVE STORE ---
    if (command === 'postmenu') {
        const allowedRolesMenu = ['1489612423521374309', '1489612221544665231'];
        const hasRoleMenu = interaction.member.roles.cache.some(role => allowedRolesMenu.includes(role.id));
        if (!hasRoleMenu) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa post menu.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const typeMenu = interaction.options.getString('type');

        let rate = 0;
        if (typeMenu !== 'howtoorder') {
            const rateData = await RobuxRate.findOne({ type: typeMenu }).lean();
            if (!rateData) return interaction.editReply({ content: `❌ Rate untuk ${typeMenu} belum diatur di database.` });
            rate = rateData.rate;
        }

        const embedMenu = buildMenuEmbed(typeMenu, rate);
        let componentsRow = [];

        // Buat Button Sesuai Tipe
        if (typeMenu === 'howtoorder') {
            const rbxE = '<:robux:1497884445494087752>';
            const giftE = '<:purplegift:1515114763842097175>';
            
            // Dibuat menjadi 3 baris (2 tombol per baris) agar HP tidak menumpuk ke bawah
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Community').setEmoji(rbxE).setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1488894547852398602'),
                new ButtonBuilder().setLabel('Gempass').setEmoji(rbxE).setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1488894587673247774')
            );
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Vilog').setEmoji(rbxE).setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1488894800735240202'),
                new ButtonBuilder().setLabel('Send Usn').setEmoji(rbxE).setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1490174072649416868')
            );
            const row3 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Gift In-Game').setEmoji(giftE).setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1488894888446660739'),
                new ButtonBuilder().setLabel('Stock').setEmoji('📦').setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1490149401254166618')
            );
            componentsRow = [row1, row2, row3];
        } else {
            const btnEmoji = typeMenu === 'gig' ? '<:purplegift:1515114763842097175>' : '<:robux:1497884445494087752>';
            componentsRow = [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Buy Robux').setEmoji(btnEmoji).setStyle(ButtonStyle.Link).setURL('https://discord.com/channels/1488782135887401104/1488896466167795722')
            )];
        }

        const sentMsg = await interaction.channel.send({ embeds: [embedMenu], components: componentsRow });

        // Catat ke DB agar bisa diupdate otomatis
        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        if (!storeData) storeData = new Store({ storeId: 'VIBEBLOX_FINANCE' });
        
        // Bersihkan data lama jika ada yang rusak
        if (!storeData.menuMessages) storeData.menuMessages = [];
        storeData.menuMessages.push({ channelId: interaction.channel.id, messageId: sentMsg.id, type: typeMenu });
        
        // Simpan menggunakan markModified karena tipe datanya Array
        storeData.markModified('menuMessages');
        await storeData.save();

        return interaction.editReply({ content: '✅ Live Menu berhasil diposting!' });
    }
    
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
        const allowedRolesRestock = ['1489612423521374309', '1489612221544665231', '1519076541055897670']; // Owner, Handler, Partner
        const hasRoleRestock = interaction.member.roles.cache.some(role => allowedRolesRestock.includes(role.id));
        if (!hasRoleRestock) {
            return interaction.reply({ content: '❌ Sori, command ini khusus Owner, Handler, dan Partner.', flags: MessageFlags.Ephemeral });
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

    // --- OMEN PAYMENT (PARTNER) ---
    if (command === 'omen') {
        const allowedRolesOmen = ['1489612423521374309', '1489612221544665231', '1519076541055897670'];
        const hasRoleOmen = interaction.member.roles.cache.some(role => allowedRolesOmen.includes(role.id));
        if (!hasRoleOmen) {
            return interaction.reply({ content: '❌ Sori, command ini hanya untuk Owner, Handler, atau Partner.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();
        const metode = interaction.options.getString('metode');
        
        const omenEmbed = new EmbedBuilder().setTimestamp();

        if (metode === 'qris') {
            omenEmbed.setColor(0xFFA500)
                .setTitle('💳 Pembayaran QRIS Omen')
                .setDescription('Silakan scan QRIS di bawah ini untuk melakukan pembayaran.')
                .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1519107554628866222/1782216403987.png?ex=6a3c5aa8&is=6a3b0928&hm=ecb4cbd02fa9f76838f2df9726a5facb4b83dc2c204e67922991046266a1dcca&')
                .setFooter({ text: 'Omen Partner Payment' });
        } else if (metode === 'bank') {
            omenEmbed.setColor(0xFFA500)
                .setTitle('🏦 Transfer Bank SeaBank Omen')
                .addFields(
                    { name: '👤 Atas Nama', value: '**muhammad amin**', inline: false },
                    { name: '🔢 Nomor Rekening', value: '**901606323148**', inline: false },
                    { name: '🏦 Bank', value: '**SeaBank**', inline: false }
                )
                .setFooter({ text: 'Omen Partner Payment' });
        }

        return interaction.editReply({ embeds: [omenEmbed] });
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

   // --- FORM TEMPLATE UNTUK TICKET ---
    if (command === 'form') {
        const allowedRolesForm = ['1489612423521374309', '1489612221544665231', '1519076541055897670']; // Owner, Handler, Partner
        const hasRoleForm = interaction.member.roles.cache.some(role => allowedRolesForm.includes(role.id));
        if (!hasRoleForm) {
            return interaction.reply({ content: '❌ Sori, command ini hanya untuk staf.', flags: MessageFlags.Ephemeral });
        }

        // 1. Respon instan agar command tidak "Gagal" di mata Discord
        await interaction.reply({ content: '✅ Form telah dikirim.', flags: MessageFlags.Ephemeral });
        
        const separator = '──────────────────────────────';
        const formEmbed = new EmbedBuilder()
            .setColor(0x4F4580)
            .setTitle('🛒 PENJELASAN METODE PENGIRIMAN:')
            .setDescription(`\n\n\n• **Robux Via Community**: Instant, tanpa potongan, syarat wajib sudah Join Ketiga Community selama 14 hari.\n\n• **Robux Via Gamepass**: Sistem After Tax (terima bersih), pending 5 Hari.\n\n• **Robux Via Login**: Instant via login untuk top up, proses 5-15 menit.\n\n• **Robux Send Username**: Instant via Send Username Plus, tanpa pending.\n\n• **Gift In-Game**: Khusus Gift item/gamepass langsung di dalam Map.\n\n${separator}\n\n👇 **SILAHKAN ISI FORM DIBAWAH:**`);
        const formTemplate = `Keperluan: Buy/Support/Middleman
Robux Via: 
Username Roblox: 
Jumlah Robux: `;

        // Mengirim Embed
        await interaction.channel.send({ embeds: [formEmbed] });

        // Mengirim Template dalam Code Block agar mudah di-copy dan tidak mengganggu visual
        await interaction.channel.send({ content: formTemplate });
        return;
    }

// --- CEK ELIGIBLE (MULTI-GROUP & ANTI-SPAM LOCK) ---
    if (command === 'cek-eligible') {
        // Sistem Antrean: Tolak jika bot sedang mengecek untuk user lain
        if (isCheckingEligible) {
            return interaction.reply({ content: '⏳ Sistem sedang memproses pengecekan lain. Mohon antre dan coba beberapa detik lagi...', flags: MessageFlags.Ephemeral });
        }
        
        isCheckingEligible = true; // Kunci sistem
        await interaction.deferReply(); // Cegah Interaction Failed

        try {
            const targetUsername = interaction.options.getString('username');
            
            // 1. Dapatkan User ID Roblox
            const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [targetUsername], excludeBannedUsers: true });
            if (!userRes.data.data.length) {
                isCheckingEligible = false;
                return interaction.editReply('❌ Username tidak ditemukan di Roblox.');
            }
            const userId = userRes.data.data[0].id;
            const actualUsername = userRes.data.data[0].name;

            await sleep(500); // Jeda untuk nafas CPU Server

            // 2. Ambil Avatar
            let avatarUrl = null;
            try {
                const avaRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
                avatarUrl = avaRes.data.data[0].imageUrl;
            } catch(e) {}

            await sleep(500);

            // 3. Cek User masuk grup mana saja via Public API
            const groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
            const userGroups = groupsRes.data.data.map(g => g.group.id.toString());

            const targetGroups = [
                { id: '1064667246', name: 'Community 1' },
                { id: '1108229986', name: 'Community 2' }
            ];

            const embed = new EmbedBuilder()
                .setColor(0x4F4580)
                .setTitle(`✅ Eligibility Status`)
                // Menggunakan garis tipis yang lebih pendek agar tidak dobel di HP
                .setDescription(`👤 **Username:** \`${actualUsername}\`\n───────────────`)
                .setFooter({ text: 'Roblox Eligibility Checker' })
                .setTimestamp();
            if (avatarUrl) embed.setThumbnail(avatarUrl);

            let isAnyEligible = false;

            // Native JS Date Formatter (Sangat Hemat RAM, tanpa library Moment)
            const formatWaktu = (isoString) => {
                const d = new Date(isoString);
                return d.toLocaleString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' }).replace(/\./g, ':') + ' WIB';
            };

            // 4. Analisa masing-masing grup (Berurutan dengan delay)
            for (let i = 0; i < targetGroups.length; i++) {
                const grp = targetGroups[i];
                let fieldContent = "";

                if (!userGroups.includes(grp.id)) {
                    fieldContent = `❌ **Belum Join Grup**\nSilakan join terlebih dahulu.`;
                } else {
                    await sleep(1000); // Jeda 1 detik sebelum hit API Audit Log
                    try {
                        const auditRes = await axios.get(`https://groups.roblox.com/v1/groups/${grp.id}/audit-log?actionType=JoinGroup&userId=${userId}&limit=10`, {
                            headers: { 'Cookie': `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` }
                        });

                        if (auditRes.data && auditRes.data.data && auditRes.data.data.length > 0) {
                            const rawJoin = auditRes.data.data[0].created;
                            const joinDate = new Date(rawJoin);
                            const eligibleDate = new Date(joinDate.getTime() + (14 * 24 * 60 * 60 * 1000));
                            const now = new Date();
                            const isElig = now >= eligibleDate;

                            if (isElig) isAnyEligible = true;

                            const statusTxt = isElig ? '🟢 **ELIGIBLE**' : '🔴 **NOT ELIGIBLE (PENDING)**';
                            
                            // Susunan teks dengan 1x enter
                            fieldContent = `📅 **Join Date:**\n\`${formatWaktu(rawJoin)}\`\n🗓️ **Eligible Since:**\n\`${formatWaktu(eligibleDate)}\`\n📊 **Status:**\n${statusTxt}`;
                        } else {
                            // Case: Sudah gabung tapi log join lebih dari setahun lalu
                            isAnyEligible = true;
                            fieldContent = `🟢 **ELIGIBLE**\n*(User tergabung di grup, data log lawas tertimbun)*`;
                        }
                    } catch (e) {
                        fieldContent = `⚠️ **Gagal Tarik Log**\nCek validitas Cookie / IP Address di server.`;
                    }
                }

                // Trik menghilangkan space kosong: Masukkan garis tipis langsung ke bawah teks grup
                if (i < targetGroups.length - 1) {
                    fieldContent += `\n───────────────`;
                }

                // Tambahkan field
                embed.addFields({ name: `🏢 ${grp.name}`, value: fieldContent, inline: false });
            }

            if (isAnyEligible) embed.setColor(0x57F287); // Ubah warna jadi Hijau jika min 1 eligible

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error("Eligible Check Error:", error.message);
            await interaction.editReply('❌ Gagal mengecek. Terjadi kesalahan pada API Roblox.');
        } finally {
            isCheckingEligible = false; // Selalu lepaskan kuncian saat selesai atau error
        }
        return;
    }

    // --- LINK COMMUNITY ---
    if (command === 'linkcommunity') {
        if (linkCommunityActive) {
            return interaction.reply({ content: '⏳ Command ini sedang digunakan oleh user lain. Coba lagi nanti.', flags: MessageFlags.Ephemeral });
        }
        linkCommunityActive = true;

        await interaction.deferReply();

        await interaction.editReply({ content: '**Link Grup Komunitas:**\nKomunitas 1:\nhttps://www.roblox.com/communities/1064667246/BEJIRLAH-Community\n\nKomunitas 2:\nhttps://www.roblox.com/id/communities/1108229986/Vandamoy\n\nKomunitas 3:\nhttps://www.roblox.com/groups/654669898' });
        linkCommunityActive = false;
        return;
    }

    // --- ROBUX CALCULATOR ---
    if (command === 'robux') {
        const allowedRolesRobux = ['1489612423521374309', '1489612221544665231', '1519076541055897670'];
        const hasRoleRobux = interaction.member.roles.cache.some(role => allowedRolesRobux.includes(role.id));
        if (!hasRoleRobux) {
            return interaction.reply({ content: '❌ Sori, cuma Owner, Handler, Partner yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
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
                { name: '💰 Total Harga', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: false }
            )
            .setFooter({ text: 'VibeBlox Robux Calculator' })
            .setTimestamp();

        return interaction.editReply({ embeds: [robuxEmbed] });
    }

    // --- HARGA ROBUX (UPDATE RATE) ---
// --- HARGA ROBUX (UPDATE RATE & AUTO SYNC MENU) ---
    if (command === 'hargarobux') {
        const allowedRolesHarga = ['1489612423521374309', '1489612221544665231'];
        const hasRoleHarga = interaction.member.roles.cache.some(role => allowedRolesHarga.includes(role.id));
        if (!hasRoleHarga) return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        
        await interaction.deferReply();

        const type = interaction.options.getString('type');
        const newRate = interaction.options.getInteger('rate');
        if (newRate <= 0) return interaction.editReply({ content: '❌ Rate harus lebih dari 0!' });

        const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };
        
        const oldData = await RobuxRate.findOne({ type }).lean();
        const oldRate = oldData ? oldData.rate : 0;

        await RobuxRate.findOneAndUpdate({ type }, { rate: newRate }, { upsert: true });

        // --- SISTEM AUTO UPDATE LIVE MENU (EVENT-DRIVEN: 0 BEBAN SERVER) ---
        let storeData = await Store.findOne({ storeId: 'VIBEBLOX_FINANCE' });
        let updatedCount = 0;

        if (storeData && storeData.menuMessages && storeData.menuMessages.length > 0) {
            const validMessages = [];
            // Looping tanpa Promise.all agar RAM 256MB Alwaysdata tetap stabil
            for (const menu of storeData.menuMessages) {
                if (menu.type === type) {
                    try {
                        const channel = await client.channels.fetch(menu.channelId);
                        const msg = await channel.messages.fetch(menu.messageId);
                        
                        const newEmbed = buildMenuEmbed(type, newRate);
                        await msg.edit({ embeds: [newEmbed] });
                        
                        updatedCount++;
                        validMessages.push(menu); // Simpan yang berhasil diedit
                    } catch (e) {
                        // Jika pesan dihapus manual di Discord, abaikan dan jangan dimasukkan ke array valid (Auto Clean-up)
                    }
                } else {
                    validMessages.push(menu); // Simpan menu tipe lain
                }
            }
            
            // Perbarui array di database agar tidak menumpuk error message
            storeData.menuMessages = validMessages;
            storeData.markModified('menuMessages');
            await storeData.save();
        }

        let rateDescription = type === 'vilog' ? `Rp ${formatRupiah(oldRate)} → **Rp ${formatRupiah(newRate)}** /500 Robux` : `Rp ${formatRupiah(oldRate)} → **Rp ${formatRupiah(newRate)}** /1 Robux`;

        const updateEmbed = new EmbedBuilder().setColor(0x57F287).setTitle('✅ Rate Harga Robux Diperbarui!').addFields({ name: '📦 Tipe', value: `**${typeNames[type]}**`, inline: true }, { name: '💱 Perubahan Rate', value: rateDescription, inline: false }, { name: '🔄 Live Menu Sync', value: `Berhasil mengupdate **${updatedCount}** post menu di server.`, inline: false }).setFooter({ text: 'VibeBlox Rate Manager' }).setTimestamp();
        
        return interaction.editReply({ embeds: [updateEmbed] });
    }

    // ==================================================
    // --- COMMAND: PARTNER INVOICE ---
    // ==================================================
    if (command === 'partnerinvoice') {
        const rolePartnerId = '1519076541055897670';
        if (!interaction.member.roles.cache.has(rolePartnerId)) {
            return interaction.reply({ content: '❌ Sori, cuma role Partner yang bisa bikin invoice ini.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const target = interaction.options.getUser('user');
        const type = interaction.options.getString('type');
        const amount = interaction.options.getInteger('amount');

        if (amount <= 0) return interaction.editReply({ content: '❌ Jumlah Robux harus lebih dari 0!' });

        const rateData = await RobuxRate.findOne({ type }).lean();
        if (!rateData) return interaction.editReply({ content: '❌ Rate belum diatur.' });

        const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };

        let totalHarga = 0; let detailCalc = '';
        if (type === 'vilog') {
            if (amount % 500 !== 0) return interaction.editReply({ content: '❌ Vilog harus kelipatan 500!' });
            const kelipatan = amount / 500;
            totalHarga = kelipatan * rateData.rate;
            detailCalc = `${kelipatan}x Rp ${formatRupiah(rateData.rate)}`;
        } else {
            totalHarga = rateData.rate * amount;
            detailCalc = `Rp ${formatRupiah(rateData.rate)} × ${formatRupiah(amount)} R$`;
        }

        const invoiceEmbed = new EmbedBuilder()
            .setColor(0xFFA500) // Warna Orange membedakan dengan invoice utama
            .setTitle('🧾 Partner Invoice VibeBlox')
            .addFields(
                { name: '👤 Pembeli', value: `<@${target.id}>`, inline: true },
                { name: '🧑‍💼 Partner', value: `<@${interaction.user.id}>`, inline: true },
                { name: '📦 Tipe', value: `**${typeNames[type]}**`, inline: true },
                { name: '<:robux:1497884445494087752> Jumlah Robux', value: `**${formatRupiah(amount)} R$**`, inline: true },
                { name: '📝 Perhitungan', value: detailCalc, inline: false },
                { name: '💰 Total Bayar', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: false }
            )
            .setFooter({ text: '⏳ Menunggu Konfirmasi Partner' })
            .setTimestamp();

        const sentReply = await interaction.editReply({ embeds: [invoiceEmbed], components: [] });
        const msgId = sentReply.id;

        // Hanya ada 2 Button
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pinv_cancel_${msgId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`pinv_done_${msgId}`).setLabel('✅ Done').setStyle(ButtonStyle.Success)
        );

        await interaction.editReply({ embeds: [invoiceEmbed], components: [row] });
        return;
    }

    // ==================================================
    // --- COMMAND: PARTNER SUMMARY ---
    // ==================================================
    if (command === 'partnersummary') {
        const allowedRoles = ['1489612423521374309', '1489612221544665231', '1519076541055897670'];
        const hasRole = interaction.member.roles.cache.some(r => allowedRoles.includes(r.id));
        if (!hasRole) {
            return interaction.reply({ content: '❌ Anda tidak memiliki izin melihat summary partner.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const partners = await Partner.find({ totalUangMasuk: { $gt: 0 } }).sort({ totalUangMasuk: -1 }).lean();
        
        let totalSeluruhPartner = 0;
        let listText = '';

        for (let i = 0; i < partners.length; i++) {
            const p = partners[i];
            totalSeluruhPartner += p.totalUangMasuk;
            
            let namaPartner = "Unknown";
            let displayPartner = "Unknown";
            try {
                const fetched = await client.users.fetch(p.partnerId);
                namaPartner = fetched.username;
                displayPartner = fetched.displayName || fetched.username;
            } catch(e) {}

            listText += `**${i+1}. ${displayPartner}** (@${namaPartner})\nTotal Pemasukan: **Rp ${formatRupiah(p.totalUangMasuk)}**\n\n`;
        }

        if (listText === '') listText = '_Belum ada data transaksi partner._';

        const summaryEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('📊 Laporan Keuangan Partner Vibeblox')
            .addFields(
                { name: '🟢 Total Pemasukan Keseluruhan', value: `**Rp ${formatRupiah(totalSeluruhPartner)}**`, inline: false },
                { name: '\u200B', value: '───────────────────────', inline: false },
                { name: '👥 Statistik Individu Partner', value: listText, inline: false }
            )
            .setFooter({ text: 'Data Keuangan Partner VibeBlox' })
            .setTimestamp();

        return interaction.editReply({ embeds: [summaryEmbed] });
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
                { name: '💰 Total Bayar', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: false }
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
    const allowedChannels = ['1489665490770067678', '1519075561396371647'];
    if (!allowedChannels.includes(interaction.channel.id)) {
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
            const sumber = interaction.options.getString('sumber'); // "utama" atau "partner"
            const kategori = interaction.options.getString('keterangan') || 'Tidak ada kategori';

            if (isNaN(amount) || amount <= 0) {
                return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 50.000).', flags: MessageFlags.Ephemeral });
            }

            let userData = await User.findOne({ userId: target.id });
            if (!userData) userData = new User({ userId: target.id });

            let embed;

            // Jika menambah uang
            if (command === 'adduangmasuk') {
                userData.uangMasuk += amount;

                if (sumber === 'utama') {
                    storeData.totalUangMasuk += amount;
                } else if (sumber === 'partner') {
                    let partnerData = await Partner.findOne({ partnerId: interaction.user.id });
                    if (!partnerData) partnerData = new Partner({ partnerId: interaction.user.id });
                    partnerData.totalUangMasuk += amount;
                    await partnerData.save();
                }

                embed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle(`✅ Uang Masuk Dicatat! (${sumber === 'utama' ? 'Store Utama' : 'Partner'})`)
                    .addFields(
                        { name: '👤 Pembeli', value: target.username, inline: true },
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(amount)}**`, inline: true },
                        { name: '🛒 Kategori', value: kategori, inline: true },
                        { name: '📊 Total spent user', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();
            } 
            // Jika mengurangi/merevisi uang
            else {
                const bisaDikurangUser = Math.min(userData.uangMasuk, amount);
                userData.uangMasuk = Math.max(0, userData.uangMasuk - amount);

                if (sumber === 'utama') {
                    const bisaDikurangStore = Math.min(storeData.totalUangMasuk, amount);
                    storeData.totalUangMasuk = Math.max(0, storeData.totalUangMasuk - bisaDikurangStore);
                } else if (sumber === 'partner') {
                    let partnerData = await Partner.findOne({ partnerId: interaction.user.id });
                    if (partnerData) {
                        const bisaDikurangPartner = Math.min(partnerData.totalUangMasuk, amount);
                        partnerData.totalUangMasuk = Math.max(0, partnerData.totalUangMasuk - bisaDikurangPartner);
                        await partnerData.save();
                    }
                }

                embed = new EmbedBuilder()
                    .setColor(0xFEE75C)
                    .setTitle(`📉 Revisi Uang Masuk (${sumber === 'utama' ? 'Store Utama' : 'Partner'})`)
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
