require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Options, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');
axios.defaults.timeout = 15000; // 15 detik — cegah request macet tanpa batas waktu yang bikin "Sending Command..." tidak pernah selesai
const User = require('./models/User');
const Store = require('./models/Store');
const RobuxRate = require('./models/RobuxRate');
const Partner = require('./models/Partner'); // <--- TAMBAHKAN INI
const TicketConfig = require('./models/TicketConfig'); // <--- TAMBAHAN TICKET
const Ticket = require('./models/Ticket');             // <--- TAMBAHAN TICKET
const Restock = require('./models/Restock');            // <--- TAMBAHAN RESTOCK
const InvoiceTracker = require('./models/InvoiceTracker'); // <--- TAMBAHAN PANEL STOCK
const PanelStock = require('./models/PanelStock');          // <--- TAMBAHAN PANEL STOCK
const TicketVouch = require('./models/TicketVouch');         // <--- TAMBAHAN VOUCH TRACKING (per-ticket, BUKAN global)

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

// =====================================================================
// === TICKET CATEGORY SYSTEM (5 KATEGORI + AUTO NAIK ANTRIAN) ===
// =====================================================================
// Urutan PENTING: index 0 = kategori paling atas (Ticket 1), dst.
const TICKET_CATEGORY_IDS = [
    '1488785950011166790', // Ticket 1 (Utama)
    '1522155806475419788', // Ticket 2 (Backup)
    '1545837833145679973', // Ticket 3 (Backup 2)
    '1563087054798196846', // Ticket 4 (BARU)
    '1563087326303887390'  // Ticket 5 (BARU)
];
const TICKET_CATEGORY_LIMIT = 50; // batas maksimal channel per kategori dari Discord
const TICKET_STAFF_ROLES = ['1489612423521374309', '1489612221544665231', '1519076541055897670']; // Owner, Handler, Partner

// Channel tiket yang sedang dalam proses close (jangan dipindah-pindah)
const closingTicketChannels = new Set();

// --- KUNCI ANTRIAN (MUTEX) ---
// Semua proses "buka tiket" dan "geser antrian" lewat kunci ini satu per satu,
// jadi tidak akan pernah tabrakan (misal: bot lagi mindahin channel, lalu ada yang open tiket).
let ticketLockChain = Promise.resolve();
function withTicketLock(task) {
    const run = ticketLockChain.then(task, task);
    ticketLockChain = run.catch(() => {}); // error satu tugas tidak boleh macetin antrian
    return run;
}

// Cari kategori PERTAMA (paling atas) yang masih punya slot.
// Karena auto-geser selalu menjaga kategori atas tetap penuh, ini otomatis jatuh ke posisi antrian yang benar.
async function pickTicketCategory(guild) {
    for (const catId of TICKET_CATEGORY_IDS) {
        let cat = guild.channels.cache.get(catId);
        if (!cat) {
            cat = await guild.channels.fetch(catId).catch(err => {
                console.error(`DEBUG: Gagal fetch kategori tiket ${catId}:`, err.message);
                return null;
            });
        }
        if (!cat) continue;
        if (cat.children.cache.size < TICKET_CATEGORY_LIMIT) return cat.id;
    }
    return null; // semua kategori penuh
}

// Geser antrian: channel PALING AWAL dibuka di kategori bawah naik ke slot kosong di kategori atas,
// beruntun (2 -> 1, 3 -> 2, 4 -> 3, 5 -> 4) sampai kategori atas penuh lagi.
async function rebalanceTicketCategories(guild) {
    const cats = TICKET_CATEGORY_IDS.map(id => guild.channels.cache.get(id)).filter(Boolean);
    if (cats.length < 2) return;

    // Hanya channel yang tercatat sebagai tiket di DB yang boleh dipindah
    let ticketIds;
    try {
        ticketIds = new Set((await Ticket.find({}, 'channelId').lean()).map(t => t.channelId));
    } catch (e) {
        console.error('❌ Rebalance tiket: gagal baca DB:', e.message);
        return;
    }

    const isMovable = (c) => c.type === 0 && ticketIds.has(c.id) && !closingTicketChannels.has(c.id);
    let moved = 0;

    for (let i = 0; i < cats.length - 1; i++) {
        const target = cats[i];
        let guard = 0;

        while (target.children.cache.size < TICKET_CATEGORY_LIMIT && guard++ < TICKET_CATEGORY_LIMIT) {
            // Ambil channel paling awal dibuka dari kategori terdekat di bawahnya yang masih ada isinya
            let candidate = null;
            for (let j = i + 1; j < cats.length && !candidate; j++) {
                const list = [...cats[j].children.cache.filter(isMovable).values()]
                    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                if (list.length) candidate = list[0];
            }
            if (!candidate) return finishRebalance(moved); // kategori bawah sudah kosong semua

            try {
                await candidate.setParent(target.id, { lockPermissions: false }); // izin per-channel tetap utuh
                // Taruh di paling bawah kategori tujuan (karena dia antrian setelah channel yang sudah ada)
                const siblings = guild.channels.cache.filter(c => c.parentId === target.id && [0, 5].includes(c.type));
                await candidate.setPosition(siblings.size - 1).catch(() => {});
                moved++;
            } catch (err) {
                console.error(`⚠️ Gagal memindah ${candidate.name} ke ${target.name}:`, err.message);
                ticketIds.delete(candidate.id); // lewati channel ini, jangan sampai loop terus
            }
        }
    }
    finishRebalance(moved);
}
function finishRebalance(moved) {
    if (moved > 0) console.log(`✅ Auto-geser antrian tiket: ${moved} channel dinaikkan.`);
}

// Jadwalkan geser antrian (didebounce, biar close beruntun cuma diproses sekali)
const pendingRebalance = new Set();
function scheduleTicketRebalance(guild, delayMs = 1500) {
    if (!guild || pendingRebalance.has(guild.id)) return;
    pendingRebalance.add(guild.id);
    setTimeout(() => {
        withTicketLock(async () => {
            pendingRebalance.delete(guild.id); // close baru selama proses berjalan -> dijadwalkan ulang
            await rebalanceTicketCategories(guild);
        }).catch(e => console.error('❌ Error rebalance tiket:', e));
    }, delayMs);
}

mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 20,                 // batasi koneksi paralel (default 100, kebesaran untuk RAM 256MB)
    minPoolSize: 1,
    serverSelectionTimeoutMS: 8000,  // GAGAL CEPAT kalau MongoDB tidak bisa dihubungi, bukan nunggu tanpa batas
    socketTimeoutMS: 20000           // GAGAL CEPAT kalau query macet di tengah jalan
})
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

// Pantau koneksi MongoDB SETELAH tersambung pertama kali — supaya kalau putus di tengah jalan
// (bukan cuma pas start), kita tetap KELIHATAN di log, bukan diam-diam bikin semua command macet.
mongoose.connection.on('disconnected', () => {
    console.error('⚠️ MongoDB terputus! Semua command yang butuh database akan macet sampai konek lagi.');
});
mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB tersambung kembali.');
});
mongoose.connection.on('error', (err) => {
    console.error('❌ Error koneksi MongoDB:', err.message);
});

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
             .setDescription(`**Pengiriman Robux Langsung (Tanpa Login/Pending)** ${ver}\nRobux dikirim langsung ke saldo akun melalui sistem Payout Community Roblox kami. **SYARAT WAJIB**: Sesuai kebijakan Roblox, kamu **wajib sudah bergabung (Join) di Community kami minimal 14 Hari** agar sistem mengizinkan proses pencairan dana.\n\n**Ingin link Community-nya?**\nSilakan tanya langsung ke admin di tiket/DM ya! 🙋\n\n**Cara cek status 14 hari kamu?**\nCara cek eligible username Roblox-nya sudah 14 hari di Community atau belum, bisa gunakan fitur \`/cek-eligible\` di channel <#1504349336559947818>.\n\n${priceList}`)
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
    { name: 'panelstock', description: '[Vibe Owner] Setup panel tracking stock & invoice Community secara real-time' },
    {
        name: 'restock', description: 'Countdown restock Robux (real-time, otomatis 5 hari dari tanggal masuk)',
        options: [
            { name: 'amount', description: 'Jumlah Robux (contoh: 55.000)', type: 3, required: true },
            { name: 'tanggal_masuk', description: 'Tanggal & jam Robux MASUK, format: DD-MM-YYYY HH:MM (contoh: 02-08-2026 17:00)', type: 3, required: true },
            { name: 'community', description: 'Nomor community, pisah koma jika lebih dari satu (contoh: 1,3)', type: 3, required: true }
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
        name: 'editform',
        description: '[Owner/Handler/Partner] Edit Username Roblox dan/atau Jumlah Robux pada form tiket ini',
        options: [
            { name: 'username', description: 'Username Roblox baru (kosongkan jika tidak diubah)', type: 3, required: false },
            { name: 'robux', description: 'Jumlah Robux baru (kosongkan jika tidak diubah)', type: 4, required: false }
        ]
    },
    // --- TAMBAHAN BARU: PRE-ORDER ---
    {
        name: 'pre-order',
        description: '[Owner/Handler] Tandai channel ticket ini sebagai Pre-Order (tambah -po di nama channel)'
    },
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

    // --- TAMBAHAN TICKET SYSTEM ---
    {
        name: 'ticket',
        description: 'Post panel Embed Ticket System VibeBlox'
    },
    {
        name: 'buttonticket',
        description: 'Enable/Disable tombol metode pada Ticket Panel',
        options: [
            {
                name: 'tipe', description: 'Pilih tipe via', type: 3, required: true,
                choices: [
                    { name: 'Community', value: 'community' },
                    { name: 'Send Plus', value: 'robux_plus' },
                    { name: 'Vilog', value: 'vilog' },
                    { name: 'Gamepass', value: 'gamepass' },
                    { name: 'Gift In-Game', value: 'gig' },
                    { name: 'Limited Item', value: 'limited' },
                    { name: 'Middleman', value: 'mm' }
                ]
            },
            {
                name: 'status', description: 'Enable atau Disable?', type: 3, required: true,
                choices: [
                    { name: 'Enable', value: 'enable' },
                    { name: 'Disable', value: 'disable' }
                ]
            }
        ]
    },
    
    //cek eligble
    {
        name: 'cek-eligible', 
        description: 'Cek status antrean 14 hari di grup BEJIRLAH, Vandamoy, Maycomn & VibeBlox Community',
        options: [
            { name: 'username', description: 'Username Roblox pembeli', type: 3, required: true }
        ]
    },
    // --- TAMBAHAN BARU: CEK TRANSAKSI (OWNER/HANDLER ONLY) ---
    {
        name: 'cek-transaksi',
        description: 'Cek total Robux payout ke username tertentu (5/10/30 hari)',
        options: [
            { name: 'username', description: 'Username Roblox penerima payout', type: 3, required: true }
        ]
    },
    // --- TAMBAHAN BARU: OMEN ---
    { 
        name: 'omen', description: 'Tampilkan metode pembayaran Partner Omen' 
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
        // Memuat SELURUH channel di server ke dalam cache saat bot online
        // Ini menggantikan fetchChildren yang error, dan jauh lebih aman.
        for (const guild of client.guilds.cache.values()) {
            await guild.channels.fetch().catch(() => {});
        }
        console.log('✅ Seluruh data Channel berhasil dimuat ke Cache!');
    } catch (e) {
        console.error('❌ Gagal memuat Cache Channel:', e);
    }

    // --- FIX PERCOBAAN: samakan izin akses di LEVEL KATEGORI 2 & 3 dengan kategori 1 ---
    // Kategori 1 "Private" OFF, kategori 2 & 3 "Private" ON — bedanya, role staff cuma dikasih akses
    // per-CHANNEL tiket (bukan di kategori-nya sendiri) untuk kategori 2 & 3. Ini nyamain biar konsisten,
    // dengan harapan (BUKAN jaminan) bisa bantu soal collapse di client admin.
    try {
        const categoriesToFix = TICKET_CATEGORY_IDS.slice(1); // Ticket 2, 3, 4 & 5
        const staffRoles = TICKET_STAFF_ROLES; // Owner, Handler, Partner

        for (const guild of client.guilds.cache.values()) {
            for (const catId of categoriesToFix) {
                const cat = guild.channels.cache.get(catId);
                if (!cat) continue;
                for (const roleId of staffRoles) {
                    await cat.permissionOverwrites.edit(roleId, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    }).catch(err => console.error(`Gagal set izin kategori ${catId} untuk role ${roleId}:`, err.message));
                }
            }
        }
        console.log('✅ Sinkronisasi izin kategori 2 - 5 selesai.');
    } catch (e) {
        console.error('❌ Gagal sinkronisasi izin kategori:', e.message);
    }

    // --- AUTO GESER ANTRIAN TIKET: rapikan sekali saat bot online
    // (jaga-jaga ada tiket yang di-close waktu bot sedang mati) ---
    for (const guild of client.guilds.cache.values()) {
        scheduleTicketRebalance(guild, 3000);
    }
    
       try {
        await client.application.commands.set(slashCommands);
        console.log('✅ Slash Commands berhasil didaftarkan!');
    } catch (err) {
        console.error('❌ Gagal mendaftarkan Slash Commands:', err);
    }

    // --- RESTOCK: mulai loop countdown real-time (jalan tiap 15 detik) ---
    // Karena berbasis timestamp absolut di DB, ini otomatis "nyambung" lagi walau bot sempat mati/restart.
    tickRestocks(); // jalankan sekali langsung saat startup, jangan nunggu 15 detik pertama
    setInterval(tickRestocks, 15000);

    // --- PANEL STOCK: refresh berkala (jaga-jaga kalau saldo Group Funds berubah dari luar bot,
    // dan sebagai self-heal kalau ada event yang sempat terlewat pas bot offline) ---
    refreshPanelFunds(); // ambil saldo sekali saat bot online (panel ikut terupdate setelahnya)
    setInterval(refreshPanelFunds, 30000);
    // --- PANEL STOCK: scan PENDING ROBUX tiap community (lebih jarang, tiap 5 menit) ---
    refreshPendingCache();
    setInterval(refreshPendingCache, PENDING_REFRESH_MS);
});



// === FUNGSI AUTO ROLE PEMBELI ===
async function updateSpenderRoles(member, userData) {
    if (!member || !userData) return;

    // Daftar ID Role
    const roleClient = '1489610714988417145';
    const roleElite = '1489611849245786347';
    const rolePrime = '1490140596298580048';
    const roleBeast = '1523587564504875058';       // 10 Juta+
    const roleSovereign = '1523588030630203502';   // 25 Juta+
    const roleImmortal = '1523588314303697006';    // 50 Juta+

    const spentUang = userData.uangMasuk;
    const isAnon = userData.isAnonymous;

    try {
        // 1. Role Client (> 0)
        if (spentUang > 0 && !member.roles.cache.has(roleClient)) {
            await member.roles.add(roleClient);
        } else if (spentUang <= 0 && member.roles.cache.has(roleClient)) {
            await member.roles.remove(roleClient);
        }

        // 2. Role Elite (>= 1 Juta)
        if (spentUang >= 1000000 && !isAnon && !member.roles.cache.has(roleElite)) {
            await member.roles.add(roleElite);
        } else if ((spentUang < 1000000 || isAnon) && member.roles.cache.has(roleElite)) {
            await member.roles.remove(roleElite);
        }

        // 3. Role Prime (>= 5 Juta)
        if (spentUang >= 5000000 && !isAnon && !member.roles.cache.has(rolePrime)) {
            await member.roles.add(rolePrime);
        } else if ((spentUang < 5000000 || isAnon) && member.roles.cache.has(rolePrime)) {
            await member.roles.remove(rolePrime);
        }

        // 4. Role Vibe Beast (>= 10 Juta)
        if (spentUang >= 10000000 && !isAnon && !member.roles.cache.has(roleBeast)) {
            await member.roles.add(roleBeast);
        } else if ((spentUang < 10000000 || isAnon) && member.roles.cache.has(roleBeast)) {
            await member.roles.remove(roleBeast);
        }

        // 5. Role Vibe Sovereign (>= 25 Juta)
        if (spentUang >= 25000000 && !isAnon && !member.roles.cache.has(roleSovereign)) {
            await member.roles.add(roleSovereign);
        } else if ((spentUang < 25000000 || isAnon) && member.roles.cache.has(roleSovereign)) {
            await member.roles.remove(roleSovereign);
        }

        // 6. Role Vibe Immortal (>= 50 Juta)
        if (spentUang >= 50000000 && !isAnon && !member.roles.cache.has(roleImmortal)) {
            await member.roles.add(roleImmortal);
        } else if ((spentUang < 50000000 || isAnon) && member.roles.cache.has(roleImmortal)) {
            await member.roles.remove(roleImmortal);
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

// =====================================================================
// === VOUCH TRACKING: UPDATE TAMPILAN FORM TIKET (dengan percobaan ulang) ===
// =====================================================================
// Database = sumber kebenaran. Tampilan form tiket disesuaikan ke database; kalau gagal
// (Discord gangguan sesaat), ditandai embedSynced=false lalu diulang otomatis tiap 2 menit.
async function syncVouchEmbed(tv, channel = null) {
    try {
        let gone = false;
        const ch = channel || await client.channels.fetch(tv.channelId).catch(err => { if (err?.code === 10003) gone = true; return null; });
        if (!ch && !gone) return false; // gangguan sementara -> coba lagi nanti
        const formMsg = ch ? await ch.messages.fetch(tv.messageId).catch(err => { if (err?.code === 10008) gone = true; return null; }) : null;
        if (gone) { await TicketVouch.deleteOne({ _id: tv._id }); return false; } // tiket/form benar-benar sudah dihapus
        if (!formMsg) return false;

        // Cek ulang database tepat sebelum edit (bisa saja status baru di-reset oleh invoice baru di tiket ini)
        const fresh = await TicketVouch.findById(tv._id);
        if (!fresh || !fresh.vouched) return false;

        const oldFormEmbed = formMsg.embeds[0];
        if (oldFormEmbed) {
            const updatedFields = oldFormEmbed.fields.map(f =>
                f.name === '🗣️ Status Vouch'
                    ? { name: f.name, value: '✅ Sudah melakukan Vouch', inline: f.inline }
                    : f
            );
            const newFormEmbed = EmbedBuilder.from(oldFormEmbed).setFields(updatedFields);
            await discordRetry(() => formMsg.edit({ embeds: [newFormEmbed] }));
        }
        await TicketVouch.updateOne({ _id: tv._id, vouched: true }, { $set: { embedSynced: true } });
        return true;
    } catch (e) {
        console.error(`Gagal update tampilan vouch di ticket ${tv.channelId}:`, e.message);
        return false;
    }
}

// Perbaikan otomatis: tampilan form yang sempat gagal diupdate, diulang tiap 2 menit
setInterval(async () => {
    if (!client.isReady()) return;
    try {
        const unsynced = await TicketVouch.find({ vouched: true, embedSynced: false }).limit(20);
        for (const tv of unsynced) await syncVouchEmbed(tv);
    } catch (e) {}
}, 2 * 60 * 1000);

// === EVENT: BACA CHAT TEXT BIASA (KHUSUS VOUCH) ===
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const vouchChannelId = '1488903383963406507';
    if (message.channel.id === vouchChannelId) {
        try {
            await message.react('1502074502228738098');
        } catch (err) {}

        // --- VOUCH TRACKING: pesan ini dihitung SAH buat ticket manapun milik buyer yang sama
        // yang masih pending DAN invoice-nya di-done SEBELUM pesan ini dikirim (doneAt <= waktu pesan).
        // Vouch lama (sebelum invoice terkait selesai) otomatis gak ikut kehitung. ---
        try {
            const msgTime = message.createdAt;
            const pendingTickets = await TicketVouch.find({
                buyerId: message.author.id,
                vouched: false,
                doneAt: { $lte: msgTime }
            }).sort({ doneAt: 1 }); // tiket yang invoicenya paling dulu selesai didahulukan

            for (const tv of pendingTickets) {
                // 1. Pastikan tiket & form-nya masih ada. Data dihapus HANYA kalau Discord memastikan
                //    sudah tidak ada (10003/10008), BUKAN karena gangguan koneksi sesaat.
                let gone = false;
                const ch = await client.channels.fetch(tv.channelId).catch(err => { if (err?.code === 10003) gone = true; return null; });
                if (!gone && ch) {
                    await ch.messages.fetch(tv.messageId).catch(err => { if (err?.code === 10008) gone = true; });
                }
                if (gone) { await TicketVouch.deleteOne({ _id: tv._id }).catch(() => {}); continue; }

                // 2. Kunci vouch ke tiket ini di DATABASE dulu (sumber kebenaran).
                //    Kalau database gagal -> berhenti, jangan dialihkan ke tiket lain.
                try {
                    tv.vouched = true;
                    tv.embedSynced = false;
                    await tv.save();
                } catch (e) {
                    console.error(`Gagal simpan vouch ticket ${tv.channelId}:`, e.message);
                    break;
                }

                // 3. Update tampilan form (dengan percobaan ulang). Kalau tetap gagal,
                //    diulang otomatis tiap 2 menit — vouch TIDAK pindah ke tiket lain.
                await syncVouchEmbed(tv, ch);
                break; // 1 pesan vouch hanya untuk 1 tiket
            }
        } catch (e) {
            console.error('Gagal proses vouch tracking:', e.message);
        }
    }
});

// === EVENT: INTERAKSI SLASH COMMANDS & BUTTON ===
const isUpdating = new Set();
let linkCommunityActive = false;
let isCheckingEligible = false;
let isCheckingTransaksi = false;
const transaksiCache = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


// =====================================================================
// === HELPER: ULANGI AKSI DISCORD YANG GAGAL SEMENTARA ===
// =====================================================================
// Dipakai invoice: kalau koneksi ke Discord putus/lambat sesaat, aksi diulang otomatis.
// Error yang PERMANEN (pesan sudah dihapus, interaksi kadaluarsa, tidak ada izin) tidak diulang.
async function discordRetry(fn, tries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if ([10008, 10015, 10062, 50001, 50013, 50035].includes(e?.code)) break;
            if (attempt < tries) await sleep(1000 * attempt);
        }
    }
    throw lastErr;
}

// Kirim invoice (embed + tombol) SEKALIGUS dalam 1 edit, dengan cadangan edit lewat channel.
// Kalau tetap gagal, pesan setengah jadi dihapus & staf diberi tahu -> tidak ada lagi invoice tanpa tombol.
async function sendInvoiceMessage(interaction, messageId, payload, commandName) {
    try {
        await discordRetry(() => interaction.editReply(payload));
        return true;
    } catch (e1) {
        try {
            await discordRetry(() => interaction.channel.messages.edit(messageId, payload), 2);
            return true;
        } catch (e2) {
            console.error(`❌ Gagal kirim invoice (${commandName}):`, e1?.message, '|', e2?.message);
            await interaction.channel.messages.delete(messageId).catch(() => {});
            await interaction.followUp({
                content: `❌ Invoice gagal dibuat karena gangguan koneksi Discord. Silakan jalankan \`${commandName}\` lagi.`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
            return false;
        }
    }
}

// =====================================================================
// === ANTREAN AKUN DUMMY ROBLOX ===
// =====================================================================
// SEMUA request yang memakai akun dummy (cookie) lewat 1 antrean ini, satu per satu, dengan jeda:
//   - prioritas 'high'   : saldo Group Funds untuk Panel Stock (cepat, ±1 detik)
//   - prioritas 'normal' : /cek-eligible & /cek-transaksi pelanggan (urut sesuai waktu masuk)
//   - prioritas 'low'    : scan pending Robux (background, mengalah ke pelanggan)
// Jadi akun dummy TIDAK PERNAH dipakai 2 proses bersamaan.
const RBX_GAP_MS = 1200;                       // jeda setelah 1 pengecekan pelanggan selesai
const RBX_MAX_WAIT_MS = 10 * 60 * 1000;        // token interaksi Discord cuma hidup 15 menit
const RBX_MAX_CUSTOMER_JOBS = 30;              // maks antrean pelanggan sekaligus
const RBX_MAX_JOBS_PER_USER = 3;               // maks pengecekan per orang yang sedang antre
const RBX_PRIORITY = { high: 0, normal: 1, low: 2 };

const rbxQueue = [];
let rbxActive = null;
let rbxNextAllowedAt = 0;
let rbxWorkerRunning = false;
let rbxWake = null;
const rbxLastCheckByKey = new Map();           // cooldownKey -> waktu pengecekan terakhir selesai
const rbxAvgDuration = { elig: 4000, tx: 15000 }; // rata-rata durasi (ms), diperbarui otomatis

function rbxWakeUp() {
    if (rbxWake) { const wake = rbxWake; rbxWake = null; wake(); }
}

// Waktu paling cepat job boleh jalan (jeda per-orang, pengganti pesan "tunggu X detik")
function rbxJobReadyAt(job) {
    if (!job.cooldownKey) return 0;
    return (rbxLastCheckByKey.get(job.cooldownKey) || 0) + (job.cooldownMs || 0);
}

function rbxPickNext(now) {
    const seenKeys = new Set();
    let best = null;
    for (const job of rbxQueue) {
        if (job.cooldownKey) {
            if (seenKeys.has(job.cooldownKey)) continue; // pengecekan dia sebelumnya harus jalan duluan
            seenKeys.add(job.cooldownKey);
            if (rbxJobReadyAt(job) > now) continue;      // masih dalam jeda per-orang
        }
        if (!best || RBX_PRIORITY[job.priority] < RBX_PRIORITY[best.priority]) best = job;
    }
    return best;
}

async function rbxWorker() {
    if (rbxWorkerRunning) return;
    rbxWorkerRunning = true;
    try {
        while (rbxQueue.length > 0) {
            const now = Date.now();

            // Pelanggan yang menunggu terlalu lama dikeluarkan (token Discord hampir habis)
            for (const job of [...rbxQueue]) {
                if (job.maxWaitMs && now - job.enqueuedAt > job.maxWaitMs) {
                    rbxQueue.splice(rbxQueue.indexOf(job), 1);
                    job.reject(new Error('RBX_TIMEOUT'));
                }
            }
            if (rbxQueue.length === 0) break;

            const job = rbxPickNext(now);
            const gapLeft = Math.max(rbxNextAllowedAt, rbxPauseUntil) - now; // jeda normal / rem darurat 429
            if (!job || gapLeft > 0) {
                rbxNotifyAll();
                let waitMs = 5000;
                if (gapLeft > 0) waitMs = Math.min(waitMs, gapLeft);
                if (!job) {
                    const soonest = Math.min(...rbxQueue.map(rbxJobReadyAt));
                    if (Number.isFinite(soonest)) waitMs = Math.min(waitMs, soonest - now);
                }
                await new Promise(resolve => { rbxWake = resolve; setTimeout(resolve, Math.max(waitMs, 50)); });
                rbxWake = null;
                continue;
            }

            rbxQueue.splice(rbxQueue.indexOf(job), 1);
            rbxActive = job;
            job.startedAt = Date.now();
            rbxNotifyAll();
            try {
                job.resolve(await job.run());
            } catch (e) {
                job.reject(e);
            } finally {
                const duration = Date.now() - job.startedAt;
                if (job.kind && rbxAvgDuration[job.kind]) {
                    rbxAvgDuration[job.kind] = Math.round(rbxAvgDuration[job.kind] * 0.7 + duration * 0.3);
                }
                if (job.cooldownKey) rbxLastCheckByKey.set(job.cooldownKey, Date.now());
                rbxNextAllowedAt = Date.now() + (job.gapAfter ?? RBX_GAP_MS);
                rbxActive = null;
            }
        }
    } finally {
        rbxWorkerRunning = false;
    }
}

// Masukkan 1 pekerjaan ke antrean. Mengembalikan job (job.promise = hasilnya).
function rbxCreateJob({ priority = 'normal', run, gapAfter, kind, cooldownKey, cooldownMs, maxWaitMs }) {
    const job = { priority, run, gapAfter, kind, cooldownKey, cooldownMs, maxWaitMs, enqueuedAt: Date.now() };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    rbxQueue.push(job);
    rbxWakeUp();
    rbxWorker();
    return job;
}

// Versi singkat untuk proses internal bot (panel stock & scan pending)
function rbxRun(options) {
    return rbxCreateJob(options).promise;
}

// --- REM DARURAT: kalau Roblox membalas 429 ("terlalu banyak request"), SEMUA pemakaian akun dummy
//     otomatis istirahat (sesuai header retry-after dari Roblox, default 30 detik, maks 2 menit) ---
let rbxPauseUntil = 0;
function rbxIsPaused() {
    return Date.now() < rbxPauseUntil;
}
axios.interceptors.response.use(res => res, err => {
    const status = err?.response?.status;
    const url = String(err?.config?.url || '');
    if (status === 429 && /roblox\.com|roproxy\.com/.test(url)) {
        const retryAfter = Number(err.response.headers?.['retry-after']);
        const pauseMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 120000) : 30000;
        if (!rbxIsPaused()) console.warn(`⚠️ [ROBLOX] Kena rate limit (429). Antrean akun dummy istirahat ${Math.round(pauseMs / 1000)} detik.`);
        rbxPauseUntil = Math.max(rbxPauseUntil, Date.now() + pauseMs);
        rbxNotifyAll();
    }
    return Promise.reject(err);
});

// --- PEMBERSIH MEMORI (penting untuk VPS RAM kecil): buang cache & catatan jeda yang sudah kedaluwarsa ---
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of eligibilityCache) if (now - val.timestamp > (val.ttl || 3600000)) eligibilityCache.delete(key);
    for (const [key, val] of transaksiCache) if (now - val.timestamp > 900000) transaksiCache.delete(key);
    for (const [key, at] of rbxLastCheckByKey) if (now - at > 10 * 60 * 1000) rbxLastCheckByKey.delete(key);
}, 10 * 60 * 1000);

// --- Tampilan "loading antrean" untuk pelanggan ---
function rbxCustomerJobsInOrder() {
    const list = [];
    if (rbxActive?.customer) list.push(rbxActive);
    for (const job of rbxQueue) if (job.customer) list.push(job);
    return list;
}

function rbxFormatEta(ms) {
    const sec = Math.max(5, Math.round(ms / 5000) * 5);
    return sec < 60 ? `± ${sec} detik` : `± ${Math.round(sec / 60)} menit`;
}

function rbxBuildLoadingText(job, phase, position, etaMs, readyAt) {
    const title = job.kind === 'tx' ? 'cek transaksi' : 'cek eligible';
    const user = `👤 Username: \`${job.label}\``;
    const hint = '-# Tidak perlu ketik ulang command. Hasil akan muncul otomatis di pesan ini.';
    if (phase === 'running') {
        return `🔍 **Sedang ${title}...**\n${user}\n-# Biasanya selesai dalam beberapa detik.`;
    }
    if (phase === 'behindOwn') {
        return `⏳ **Menunggu pengecekan kamu sebelumnya selesai**\n${user}\n-# Pengecekan dijalankan satu per satu. Tidak perlu ketik ulang command, hasil akan muncul otomatis di pesan ini.`;
    }
    if (phase === 'cooldown') {
        return `⏳ **Menunggu jeda antar pengecekan**\n${user}\n🕐 Mulai otomatis <t:${Math.ceil(readyAt / 1000)}:R>\n-# Jeda ini menjaga sistem tetap aman. Tidak perlu ketik ulang command, hasil akan muncul otomatis di pesan ini.`;
    }
    return `⏳ **Kamu masuk antrean ${title}**\n${user}\n📍 Posisi antrean: **#${position}**\n🕐 Perkiraan mulai: ${rbxFormatEta(etaMs)}\n${hint}`;
}

// Kirim edit ke pesan pelanggan secara BERURUTAN (edit lama tidak bisa menimpa hasil akhir)
function rbxQueueEdit(sub, payloadFn) {
    sub.chain = sub.chain.then(async () => {
        if (sub.dead) return;
        const payload = payloadFn();
        if (!payload) return;
        await sub.interaction.editReply(payload);
    }).catch(() => {});
}

function rbxNotifyAll() {
    const now = Date.now();
    const jobs = rbxCustomerJobsInOrder();
    let etaMs = 0;
    if (rbxActive) {
        const avg = rbxAvgDuration[rbxActive.kind] || 5000;
        etaMs = Math.max(avg - (now - rbxActive.startedAt), 1000) + (rbxActive.gapAfter ?? RBX_GAP_MS);
    } else {
        etaMs = Math.max(Math.max(rbxNextAllowedAt, rbxPauseUntil) - now, 0);
    }

    const seenOwners = new Set();
    jobs.forEach((job, index) => {
        // Tampilan dibuat STABIL: selama masih dalam jeda per-orang -> selalu tampil "menunggu jeda",
        // setelah jeda selesai -> tampil posisi antrean. Tidak bolak-balik.
        let phase = 'queued';
        const readyAt = rbxJobReadyAt(job);
        if (job === rbxActive) phase = 'running';
        else if (job.cooldownKey && seenOwners.has(job.cooldownKey)) phase = 'behindOwn'; // pengecekan dia sebelumnya belum selesai
        else if (readyAt > now) phase = 'cooldown';
        if (job.cooldownKey) seenOwners.add(job.cooldownKey);

        const key = phase === 'cooldown' ? `cooldown|${readyAt}` : (phase === 'behindOwn' ? 'behindOwn' : `${phase}|${index + 1}`);
        const text = rbxBuildLoadingText(job, phase, index + 1, etaMs, readyAt);
        for (const sub of job.subscribers) {
            if (sub.done || sub.lastKey === key) continue;
            sub.lastKey = key;
            rbxQueueEdit(sub, () => (sub.done ? null : { content: text, embeds: [] }));
        }

        if (job !== rbxActive) etaMs += (rbxAvgDuration[job.kind] || 5000) + RBX_GAP_MS;
    });
}

// Job tertahan oleh pemiliknya sendiri (jeda per-orang / pengecekan dia sebelumnya belum selesai)?
function rbxIsBlockedByOwner(job) {
    if (job === rbxActive || !job.cooldownKey) return false;
    if (rbxActive && rbxActive.cooldownKey === job.cooldownKey) return true;
    const idx = rbxQueue.indexOf(job);
    if (rbxQueue.some((j, i) => i < idx && j.cooldownKey === job.cooldownKey)) return true;
    return rbxJobReadyAt(job) > Date.now();
}

function rbxMakeSubscriber(interaction) {
    const sub = { interaction, userId: interaction.user.id, done: false, dead: false, lastKey: null };
    sub.chain = interaction.deferReply().then(() => {}).catch(err => {
        sub.dead = true;
        console.error('Gagal defer interaksi antrean:', err?.message);
    });
    return sub;
}

function rbxDeliver(job, payload) {
    job.delivered = true;
    for (const sub of job.subscribers) {
        sub.done = true;
        rbxQueueEdit(sub, () => ({ content: payload.content ?? '', embeds: payload.embeds ?? [] }));
    }
}

// Pintu masuk untuk /cek-eligible & /cek-transaksi
async function enqueueCustomerCheck({ interaction, kind, label, dedupeKey, cooldownKey, cooldownMs, run }) {
    const userId = interaction.user.id;
    const customerJobs = rbxCustomerJobsInOrder().filter(j => !j.delivered);

    // a) Username yang SAMA sedang diantre/dicek -> ikut dapat hasilnya, akun dummy tidak mengecek 2x.
    //    (Tidak ikut menumpang kalau pengecekan itu sedang tertahan jeda milik orang lain.)
    const sameUsernameJobs = customerJobs.filter(j => j.dedupeKey === dedupeKey);
    if (sameUsernameJobs.some(j => j.subscribers.some(s => s.userId === userId))) {
        return interaction.reply({ content: `⏳ Username \`${label}\` sudah ada di antrean kamu. Hasilnya akan muncul di pesan sebelumnya.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    const existing = sameUsernameJobs.find(j => !rbxIsBlockedByOwner(j));
    if (existing) {
        existing.subscribers.push(rbxMakeSubscriber(interaction));
        rbxNotifyAll();
        return;
    }

    // b) Batas antrean per orang & total
    const mine = customerJobs.filter(j => j.ownerId === userId).length;
    if (mine >= RBX_MAX_JOBS_PER_USER) {
        return interaction.reply({ content: `⏳ Kamu masih punya **${mine} pengecekan** di antrean. Tunggu salah satunya selesai dulu, ya.`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    if (customerJobs.length >= RBX_MAX_CUSTOMER_JOBS) {
        return interaction.reply({ content: '⏳ Antrean pengecekan sedang penuh. Silakan coba lagi 1-2 menit lagi.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    const subscriber = rbxMakeSubscriber(interaction); // defer langsung (wajib < 3 detik)
    const job = rbxCreateJob({ priority: 'normal', kind, cooldownKey, cooldownMs, maxWaitMs: RBX_MAX_WAIT_MS, run });
    job.customer = true;
    job.label = label;
    job.dedupeKey = dedupeKey;
    job.ownerId = userId;
    job.subscribers = [subscriber];

    job.promise
        .then(payload => rbxDeliver(job, payload))
        .catch(err => {
            if (err?.message === 'RBX_TIMEOUT') {
                rbxDeliver(job, { content: '⌛ Antrean sedang sangat ramai dan pengecekan kamu belum sempat diproses. Silakan jalankan command-nya lagi.' });
            } else {
                console.error('Error antrean pengecekan:', err?.response?.data || err?.message);
                rbxDeliver(job, { content: '❌ Terjadi gangguan komunikasi dengan server Roblox saat ini. Coba beberapa saat lagi.' });
            }
        });

    rbxNotifyAll();
}

// =====================================================================
// === PENGECEKAN ELIGIBLE (dijalankan oleh antrean) ===
// =====================================================================
async function runEligibilityCheck(targetUsername, cacheKey) {
    // Sudah ada hasil segar (dicek pelanggan lain barusan) -> pakai itu, tidak perlu ke Roblox lagi
    const fresh = eligibilityCache.get(cacheKey);
    if (fresh && Date.now() - fresh.timestamp < (fresh.ttl || 3600000)) {
        return { embeds: [EmbedBuilder.from(fresh.embed).setFooter({ text: 'Roblox Eligibility Checker • (Data Cached)' })] };
    }
    try {
        // Dapatkan User ID Roblox
        let userRes;
        try {
            userRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [targetUsername], excludeBannedUsers: true });
        } catch (err) {
            console.log("API Asli Gagal (ID), mencoba RoProxy...");
            userRes = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [targetUsername], excludeBannedUsers: true });
        }

        if (!userRes.data?.data?.length) {
            return { content: `❌ Username **${targetUsername}** tidak ditemukan di Roblox.` };
        }

        const userId = userRes.data.data[0].id;
        const actualUsername = userRes.data.data[0].name;
        const actualDisplayName = String(userRes.data.data[0].displayName || actualUsername).replace(/`/g, "'");

        await sleep(200); // request publik (tanpa cookie akun dummy)

        // Ambil Avatar
        let avatarUrl = null;
        try {
            const avaRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
            avatarUrl = avaRes.data.data[0].imageUrl;
        } catch (e) {}

        await sleep(200); // request publik (tanpa cookie akun dummy)

        // Cek Daftar Grup User
        let groupsRes;
        try {
            groupsRes = await axios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
        } catch (err) {
            console.log("API Asli Gagal (Grup), mencoba RoProxy...");
            groupsRes = await axios.get(`https://groups.roproxy.com/v2/users/${userId}/groups/roles`);
        }

        const userGroups = groupsRes.data.data.map(g => g.group.id.toString());

        const targetGroups = [
            { id: '1064667246', shortName: 'BEJIRLAH', url: 'https://www.roblox.com/communities/1064667246/BEJIRLAH-Community' },
            { id: '1108229986', shortName: 'Vandamoy', url: 'https://www.roblox.com/id/communities/1108229986/Vandamoy' },
            { id: '653724099', shortName: 'Maycomn', url: 'https://www.roblox.com/communities/653724099/Maycomn' },
            { id: '617301345', shortName: 'Vibies', url: 'https://www.roblox.com/id/communities/617301345/VibeBlox-Community' }
        ];

        const formatWaktu = (isoString) => {
            const d = new Date(isoString);
            return d.toLocaleString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' }).replace(/\./g, ':') + ' WIB';
        };

        const getRemainingTime = (targetDate) => {
            const diff = targetDate.getTime() - Date.now();
            if (diff <= 0) return "0 Detik";
            const d = Math.floor(diff / (1000 * 60 * 60 * 24));
            const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            const res = [];
            if (d > 0) res.push(`${d} Hari`);
            if (h > 0) res.push(`${h} Jam`);
            if (m > 0) res.push(`${m} Menit`);
            if (s > 0 || res.length === 0) res.push(`${s} Detik`);
            return res.join(' ');
        };

        const embed = new EmbedBuilder()
            .setTitle(`⏳ Eligibility Status`)
            .addFields(
                { name: '👤 Username', value: `\`${actualUsername}\``, inline: true },
                { name: '🏷️ Display Name', value: `\`${actualDisplayName}\``, inline: true }
            )
            .setFooter({ text: 'Roblox Eligibility Checker' })
            .setTimestamp();

        if (avatarUrl) embed.setThumbnail(avatarUrl);

        let overallColor = 0xFF0000; // Merah (belum join sama sekali)
        let hasEligible = false;
        let hasPending = false;
        let hadLookupError = false; // ada data yang gagal ditarik -> hasil TIDAK disimpan ke cache

        const emojiNotJoin = '<:notjoin:1530931902985277521>';
        const emojiEligible = '<a:eligible:1502074502228738098>';
        const emojiPending = '<:pending:1530933220726804603>';

        for (let i = 0; i < targetGroups.length; i++) {
            const grp = targetGroups[i];
            let fieldValue;

            if (!userGroups.includes(grp.id)) {
                fieldValue = `${emojiNotJoin} Belum Bergabung`;
            } else {
                await sleep(350); // request audit-log (pakai cookie akun dummy)
                try {
                    if (rbxIsPaused()) throw new Error('RBX_PAUSED'); // sedang kena rate limit -> jangan tambah request
                    const auditRes = await axios.get(`https://groups.roblox.com/v1/groups/${grp.id}/audit-log?actionType=JoinGroup&userId=${userId}&limit=10`, {
                        headers: { 'Cookie': `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` }
                    });

                    if (auditRes.data && auditRes.data.data && auditRes.data.data.length > 0) {
                        const rawJoin = auditRes.data.data[0].created;
                        const joinDate = new Date(rawJoin);
                        const eligibleDate = new Date(joinDate.getTime() + (14 * 24 * 60 * 60 * 1000));
                        if (new Date() >= eligibleDate) {
                            hasEligible = true;
                            fieldValue = `📆 Join: \`${formatWaktu(rawJoin)}\`\n${emojiEligible} **ELIGIBLE** *(sejak ${formatWaktu(eligibleDate)})*`;
                        } else {
                            hasPending = true;
                            fieldValue = `📆 Join: \`${formatWaktu(rawJoin)}\`\n${emojiPending} **PENDING** — Sisa \`${getRemainingTime(eligibleDate)}\``;
                        }
                    } else {
                        hasEligible = true; // tertimbun = otomatis eligible
                        fieldValue = `${emojiEligible} **ELIGIBLE** *(tergabung > 14 hari)*`;
                    }
                } catch (e) {
                    hadLookupError = true;
                    hasEligible = true; // asumsi positif jika API Roblox nyangkut tapi user ada di grup
                    fieldValue = `⚠️ **User ada di dalam grup** *(Gagal narik tanggal. Silakan cek manual).*`;
                }
            }

            embed.addFields({ name: `🏢 Community ${i + 1}`, value: `[**${grp.shortName}**](${grp.url})\n${fieldValue}\n\u200b`, inline: false });
        }

        if (hasEligible) overallColor = 0x57F287;      // Hijau
        else if (hasPending) overallColor = 0xFFA500;  // Orange
        embed.setColor(overallColor);

        // Cache: 1 jam. Kalau ada status PENDING, cukup 10 menit (sisa waktunya berubah terus).
        // Kalau ada data yang GAGAL ditarik, jangan di-cache -> pengecekan berikutnya ambil data baru.
        if (!hadLookupError) {
            eligibilityCache.set(cacheKey, {
                embed: embed.toJSON(),
                timestamp: Date.now(),
                ttl: hasPending ? 600000 : 3600000
            });
        }

        return { embeds: [embed] };
    } catch (error) {
        console.error("Eligible Check Error ASLI:", error.response?.data || error.message);
        return { content: '❌ Terjadi gangguan komunikasi dengan server Roblox saat ini. Coba beberapa saat lagi.' };
    }
}

// =====================================================================
// === PENGECEKAN TRANSAKSI PAYOUT (dijalankan oleh antrean) ===
// =====================================================================
async function runTransactionCheck(targetUsername, cacheKey, requesterTag) {
    const fresh = transaksiCache.get(cacheKey);
    if (fresh && Date.now() - fresh.timestamp < 900000) {
        return { embeds: [EmbedBuilder.from(fresh.embed).setFooter({ text: 'Roblox Transaction Checker • (Data Cached)' })] };
    }
    try {
        let userRes;
        try {
            userRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [targetUsername], excludeBannedUsers: true });
        } catch (err) {
            userRes = await axios.post('https://users.roproxy.com/v1/usernames/users', { usernames: [targetUsername], excludeBannedUsers: true });
        }

        if (!userRes.data?.data?.length) {
            return { content: `❌ Username **${targetUsername}** tidak ditemukan di Roblox.` };
        }

        const userId = userRes.data.data[0].id;
        const actualUsername = userRes.data.data[0].name;
        const actualDisplayName = userRes.data.data[0].displayName || actualUsername;

        await sleep(200); // request publik (tanpa cookie akun dummy)

        let avatarUrl = null;
        try {
            const avaRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
            avatarUrl = avaRes.data.data[0].imageUrl;
        } catch (e) {}

        const targetGroups = [
            { id: '1064667246', name: 'Community 1 (BEJIRLAH)' },
            { id: '1108229986', name: 'Community 2 (Vandamoy)' },
            { id: '653724099', name: 'Community 3 (Maycomn)' },
            { id: '617301345', name: 'Community 4 (Vibies)' }
        ];
        const now = Date.now();
        const cutoffOldest = now - (10 * 24 * 60 * 60 * 1000); // batas 10 hari ke belakang

        const embed = new EmbedBuilder()
            .setTitle('🧾 Transaksi Robux Checker')
            .addFields({ name: '👤 Username', value: `\`${actualUsername}\``, inline: false })
            .setColor(0x5865F2)
            .setFooter({ text: `Diminta oleh ${requesterTag} • Roblox Transaction Checker` })
            .setTimestamp();
        if (avatarUrl) embed.setThumbnail(avatarUrl);

        let grandTotal = 0;
        let anyFetchFailed = false; // ada community yang gagal -> hasil TIDAK disimpan ke cache
        const namesToMatch = [actualUsername.toLowerCase(), actualDisplayName.toLowerCase()];

        for (const grp of targetGroups) {
            await sleep(400); // jeda antar community (pakai cookie akun dummy)

            const totals = { p1_3: 0, p4_6: 0, p7_10: 0 };
            let fetchFailed = false;
            let reachedPageLimit = false;

            try {
                let cursor = '';
                let page = 0;
                const maxPages = 40;

                while (page < maxPages) {
                    if (rbxIsPaused()) throw new Error('RBX_PAUSED'); // sedang kena rate limit -> berhenti
                    const url = `https://groups.roblox.com/v1/groups/${grp.id}/audit-log?actionType=${encodeURIComponent('Spend Group Funds')}&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
                    const auditRes = await axios.get(url, {
                        headers: { 'Cookie': `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` }
                    });

                    const entries = auditRes.data?.data || [];
                    if (entries.length === 0) break;

                    let stop = false;
                    for (const entry of entries) {
                        const createdTime = new Date(entry.created).getTime();
                        if (createdTime < cutoffOldest) { stop = true; break; }

                        // Format: "one-time payout of Robux from group funds to Nama1 (1,000), Nama2 (2,000)"
                        const itemDesc = entry.description?.ItemDescription || '';
                        const pairRegex = /([A-Za-z0-9_]+)\s*\(([\d,]+)\)/g;
                        let match;
                        while ((match = pairRegex.exec(itemDesc)) !== null) {
                            const recipientName = match[1].toLowerCase();
                            const recipientAmount = parseInt(match[2].replace(/,/g, ''), 10) || 0;
                            if (namesToMatch.includes(recipientName)) {
                                const ageDays = (now - createdTime) / (1000 * 60 * 60 * 24);
                                if (ageDays <= 3) totals.p1_3 += recipientAmount;
                                else if (ageDays <= 6) totals.p4_6 += recipientAmount;
                                else if (ageDays <= 10) totals.p7_10 += recipientAmount;
                            }
                        }
                    }

                    if (stop) break;
                    cursor = auditRes.data?.nextPageCursor;
                    if (!cursor) break;

                    page++;
                    if (page >= maxPages) reachedPageLimit = true;
                    await sleep(350);
                }
            } catch (e) {
                console.error(`Gagal ambil audit log payout ${grp.name}:`, e.response?.data || e.message);
                fetchFailed = true;
            }

            if (fetchFailed) {
                anyFetchFailed = true;
                embed.addFields({ name: `🏢 ${grp.name}`, value: '⚠️ Gagal mengambil data (cek console log bot).\n\u200b', inline: false });
            } else {
                const totalGrp = totals.p1_3 + totals.p4_6 + totals.p7_10;
                grandTotal += totalGrp;
                const warning = reachedPageLimit ? '\n⚠️ *Data mungkin belum lengkap (terpotong di halaman ke-40).*' : '';
                embed.addFields({
                    name: `🏢 ${grp.name}`,
                    value: `📅 **1-3 Hari:** \`${totals.p1_3.toLocaleString('id-ID')} Robux\`\n📅 **4-6 Hari:** \`${totals.p4_6.toLocaleString('id-ID')} Robux\`\n📅 **7-10 Hari:** \`${totals.p7_10.toLocaleString('id-ID')} Robux\`\n📊 **Total: \`${totalGrp.toLocaleString('id-ID')} Robux\`**${warning}\n\u200b`,
                    inline: false
                });
            }
        }

        embed.addFields({ name: '📊 Total Keseluruhan (10 Hari)', value: `\`${grandTotal.toLocaleString('id-ID')} Robux\``, inline: false });

        if (!anyFetchFailed) transaksiCache.set(cacheKey, { embed: embed.toJSON(), timestamp: Date.now() });
        return { embeds: [embed] };
    } catch (error) {
        console.error("Transaksi Check Error:", error.response?.data || error.message);
        return { content: '❌ Terjadi gangguan komunikasi dengan server Roblox saat ini. Coba beberapa saat lagi.' };
    }
}

// ==================================================
// --- RESTOCK: KONSTANTA & HELPER ---
// ==================================================
// Tambah community baru cukup nambah 1 baris di sini — TIDAK perlu ubah command/choices Discord.
const RESTOCK_COMMUNITIES = {
    1: { name: 'BEJIRLAH', groupId: '1064667246' },
    2: { name: 'Vandamoy', groupId: '1108229986' },
    3: { name: 'Maycomn', groupId: '653724099' },
    4: { name: 'Vibies', groupId: '617301345' }
};

// "1,3" -> [1, 3] (nomor valid saja, dedup, urut)
function parseCommunityNumbers(raw) {
    const nums = raw.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && RESTOCK_COMMUNITIES[n]);
    return [...new Set(nums)].sort((a, b) => a - b);
}

// [1, 3] -> "Community 1 dan 3" | [1,2,3] -> "Community 1, 2, dan 3"
function formatCommunityList(nums) {
    if (nums.length === 0) return '-';
    if (nums.length === 1) return `Community ${nums[0]} (${RESTOCK_COMMUNITIES[nums[0]].name})`;
    const names = nums.map(n => `${n} (${RESTOCK_COMMUNITIES[n].name})`);
    const last = names.pop();
    return `Community ${names.join(', ')} dan ${last}`;
}

// Jumlah hari valid di suatu bulan (termasuk cek tahun kabisat untuk Februari)
function daysInMonth(yyyy, mm) {
    return new Date(Date.UTC(yyyy, mm, 0)).getUTCDate(); // mm di sini 1-based
}

// "02-08-2026 17:00" -> Date (WIB / UTC+7)
function parseRestockDate(raw) {
    const match = raw.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const [, dd, mm, yyyy, hh, min] = match.map(Number);
    if (mm < 1 || mm > 12 || hh > 23 || min > 59) return null;
    if (dd < 1 || dd > daysInMonth(yyyy, mm)) return null; // tolak tanggal yg gak ada, misal 31 Februari
    // Dibuat sebagai WIB (UTC+7) secara eksplisit, terlepas timezone server hosting
    const utcMs = Date.UTC(yyyy, mm - 1, dd, hh - 7, min, 0);
    const date = new Date(utcMs);
    if (isNaN(date.getTime())) return null;
    return date;
}

// Format tanggal jadi "2026-08-22 06:00 WIB"
function formatWIB(date) {
    const wib = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())} ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())} WIB`;
}

// Countdown asli real-time: "3d 17h 38m 30s left until 2026-08-22 06:00 WIB"
function formatCountdown(targetDate) {
    const diffMs = targetDate.getTime() - Date.now();
    if (diffMs <= 0) return null; // sudah lewat waktu
    const totalSec = Math.floor(diffMs / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${d}d ${h}h ${m}m ${s}s left`;
}

// Ambil saldo Group Funds LIVE via API Roblox (pakai cookie dummy yang sama dengan cek-eligible/cek-transaksi)
async function fetchGroupFunds(groupId) {
    try {
        const res = await axios.get(`https://economy.roblox.com/v1/groups/${groupId}/currency`, {
            headers: { 'Cookie': `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` }
        });
        return typeof res.data?.robux === 'number' ? res.data.robux : null;
    } catch (e) {
        return null; // gagal ambil -> field ini dilewati aja di embed, tidak fatal
    }
}


// ==================================================
// --- PANEL STOCK: PENDING ROBUX PER COMMUNITY (dari riwayat transaksi) ---
// ==================================================
// Dibaca dari riwayat transaksi "Sale" tiap community (akun dummy, cookie sama dengan cek-eligible).
// Status di web Roblox:
//   "Pending"           -> isPending: true  -> dihitung sebagai pending
//   "Dibayar"           -> isPending: false -> sudah masuk Dana Komunitas, tidak dihitung
//   "Dana Dikembalikan" -> dana batal masuk -> dicatat kecil, tidak dihitung pending
// Discan TERPISAH tiap 5 menit (bukan tiap 20 detik seperti saldo) supaya tidak kena rate limit Roblox.
const PENDING_LOOKBACK_DAYS = 45;              // transaksi lebih lama dari ini dianggap pasti sudah selesai
const PENDING_MAX_PAGES = 40;                  // pengaman: maks 40 x 100 transaksi per community per scan
const PENDING_REFRESH_MS = 5 * 60 * 1000;      // scan ulang tiap 5 menit
const pendingCache = {};                       // { [nomorCommunity]: { pending, pendingCount, refundedCount, refundedAmount, ok } }
let pendingLastUpdated = null;
let isPendingScanRunning = false;
let pendingSampleLogged = false;

const sleepMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Deteksi status "Dana Dikembalikan".
// Nama field-nya tidak didokumentasikan resmi oleh Roblox, jadi dicek dari beberapa kemungkinan sekaligus.
function isRefundedTx(tx) {
    if (!tx) return false;
    if (tx.isRefunded === true || tx.refunded === true || tx.isReverted === true || tx.isReversed === true) return true;
    const status = String(tx.transactionStatus ?? tx.status ?? tx.state ?? tx.saleStatus ?? '').toLowerCase();
    return /refund|revers|revert|cancel|chargeback|dikembalikan/.test(status);
}

async function fetchGroupPendingInfo(groupId) {
    const cutoff = Date.now() - PENDING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const info = { pending: 0, pendingCount: 0, refundedCount: 0, refundedAmount: 0 };
    let cursor = '';
    let pagesWithoutPending = 0; // berhenti lebih awal kalau sudah lewat zona pending

    for (let page = 0; page < PENDING_MAX_PAGES; page++) {
        const url = `https://economy.roblox.com/v2/groups/${groupId}/transactions?transactionType=Sale&limit=100&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await axios.get(url, {
            headers: { 'Cookie': `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` },
            timeout: 15000
        });

        const items = Array.isArray(res.data?.data) ? res.data.data : [];

        // Log 1x per bot nyala: contoh isi transaksi, buat memastikan nama field status refund
        if (!pendingSampleLogged && items.length > 0) {
            pendingSampleLogged = true;
            console.log('[PENDING] Contoh field transaksi Roblox:', JSON.stringify(items[0]).slice(0, 600));
        }

        let reachedOld = false;
        let pendingInThisPage = 0;
        for (const tx of items) {
            const createdTime = new Date(tx.created).getTime();
            if (createdTime && createdTime < cutoff) { reachedOld = true; break; }

            const amount = Number(tx.currency?.amount) || 0;
            if (isRefundedTx(tx)) {
                info.refundedCount += 1;
                info.refundedAmount += amount;
                continue; // dana dikembalikan -> BUKAN pending
            }
            if (tx.isPending === true) {
                info.pending += amount;
                info.pendingCount += 1;
                pendingInThisPage += 1;
            }
        }

        // Transaksi diurutkan dari yang terbaru. Pending selalu ada di bagian paling baru,
        // jadi kalau 2 halaman berturut-turut (200 transaksi) sudah "Dibayar" semua, sisanya pasti juga sudah dibayar.
        pagesWithoutPending = pendingInThisPage > 0 ? 0 : pagesWithoutPending + 1;

        if (reachedOld || pagesWithoutPending >= 2 || !res.data?.nextPageCursor || items.length === 0) break;
        cursor = res.data.nextPageCursor;
        await sleepMs(400); // jeda antar halaman, ramah rate limit
    }
    return info;
}

const pendingErrorLogged = new Set(); // cegah log error yang sama muncul tiap 5 menit

async function refreshPendingCache() {
    if (isPendingScanRunning) return; // jangan dobel kalau scan sebelumnya belum selesai
    isPendingScanRunning = true;
    try {
        for (const [num, grp] of Object.entries(RESTOCK_COMMUNITIES)) {
            try {
                // Lewat ANTREAN akun dummy (prioritas rendah): otomatis mengalah ke pelanggan /cek-eligible & /cek-transaksi
                const info = await rbxRun({ priority: 'low', gapAfter: 1000, run: () => fetchGroupPendingInfo(grp.groupId) });
                pendingCache[num] = { ...info, ok: true };
                if (pendingErrorLogged.delete(num)) console.log(`✅ [PENDING] Community ${num} (${grp.name}) kembali normal.`);
            } catch (e) {
                const status = e.response?.status;
                if (!pendingErrorLogged.has(num)) {
                    pendingErrorLogged.add(num);
                    if (status === 401 || status === 403) {
                        console.error(`❌ [PENDING] Akun dummy tidak punya akses transaksi Community ${num} (${grp.name}). Cek izin "lihat pendapatan/transaksi grup" & cookie.`);
                    } else {
                        console.error(`⚠️ [PENDING] Gagal scan Community ${num} (${grp.name}):`, status || e.message);
                    }
                }
                // Data lama tetap dipakai (ditandai), jangan langsung jadi 0
                pendingCache[num] = pendingCache[num] ? { ...pendingCache[num], ok: false } : { ok: false };
            }
        }
        pendingLastUpdated = new Date();
        schedulePanelStockUpdate();
    } finally {
        isPendingScanRunning = false;
    }
}
// Catatan: markdown heading (#) Discord CUMA render besar kalau ditaruh di description embed,
// TIDAK bekerja di dalam field value. Makanya build via description (bukan addFields) biar tulisan
// amount/countdown bisa besar seperti versi lama, dan gak perlu backtick (`) yang bikin kotak kecil jelek.

function buildRestockPendingEmbed(restock) {
    const countdown = formatCountdown(restock.arrivalTimestamp) || '0d 0h 0m 0s left';
    const formattedAmount = restock.amount >= 1000 ? Math.floor(restock.amount / 1000) + 'K+' : restock.amount.toLocaleString('id-ID');

    const description = [
        'Halo Vibies! Robux kita bakal segera restock. Jangan sampai telat!',
        `# ${'<:robux:1497884445494087752>'} ${formattedAmount} Robux`,
        '',
        `## ⏳ ${countdown}`,
        `-# Tepatnya pada: ${formatWIB(restock.arrivalTimestamp)}`,
        '',
        '',
        '🏢 **Lokasi Restock**',
        formatCommunityList(restock.communities)
    ].join('\n');

    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📦 VIBEBLOX RESTOCK INCOMING!')
        .setDescription(description)
}

// Embed status singkat yang dipasang di pesan countdown LAMA begitu waktunya habis.
// Pengumuman lengkapnya dikirim TERPISAH sebagai pesan baru (lihat buildRestockCompletedEmbed),
// supaya @everyone di pesan baru itu benar-benar memicu notifikasi baru buat semua orang.
function buildRestockDoneStatusEmbed(restock) {
    const formattedAmount = restock.amount >= 1000 ? Math.floor(restock.amount / 1000) + 'K+' : restock.amount.toLocaleString('id-ID');
    return new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Countdown Selesai')
        .setDescription(`${'<:robux:1497884445494087752>'} **${formattedAmount} Robux** sudah READY! Cek pengumuman terbaru di bawah 👇`)
        .setFooter({ text: 'VibeBlox Auto-Notifier' })
        .setTimestamp();
}

function buildRestockCompletedEmbed(restock) {
    const formattedAmount = restock.amount >= 1000 ? Math.floor(restock.amount / 1000) + 'K+' : restock.amount.toLocaleString('id-ID');

    const description = [
        'Robux sudah masuk! Langsung merapat ke tiket sebelum diborong yang lain 🚀',
        `# ${'<:robux:1497884445494087752>'} ${formattedAmount} Robux`,
        '',
        '',
        '🏢 **Lokasi Restock**',
        formatCommunityList(restock.communities)
    ].join('\n');

    return new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ RESTOCK SELESAI — STOK READY!')
        .setDescription(description)
        .setFooter({ text: 'VibeBlox Restock Complete' })
        .setTimestamp();
}

// ==================================================
// --- PANEL STOCK: BANGUN HALAMAN (BISA LEBIH DARI 1 PESAN) ---
// ==================================================
// Discord membatasi 1 pesan maks 6000 karakter. Kalau tiket banyak, daftar invoice OTOMATIS
// disambung ke pesan berikutnya (tanpa diringkas), dan Stock Overview selalu di pesan paling bawah.
const PANEL_TITLE = '📊 VibeBlox Stock Tracking Panel';
const PANEL_PAGE_BUDGET = 5500; // batas aman karakter per pesan (maks Discord 6000)
const PANEL_MAX_PAGES = 8;      // maks 8 pesan (±800 tiket) — jauh di atas kebutuhan normal


// --- SALDO GROUP FUNDS: diambil dari Roblox HANYA oleh timer-nya sendiri (tiap 30 detik) ---
// Update panel karena invoice baru / done / cancel cukup pakai saldo tersimpan ini -> 0 request ke Roblox.
const panelFunds = { data: {}, failed: new Set(), at: 0 };
let isFundsRefreshing = false;
async function refreshPanelFunds() {
    if (isFundsRefreshing) return;
    isFundsRefreshing = true;
    try {
        const result = await rbxRun({
            priority: 'high',
            gapAfter: 500,
            run: async () => {
                const out = {};
                for (const [num, grp] of Object.entries(RESTOCK_COMMUNITIES)) {
                    if (rbxIsPaused()) break; // kena rate limit -> berhenti, saldo lama tetap dipakai                    
                    out[num] = await fetchGroupFunds(grp.groupId);
                    await sleep(250);
                }
                return out;
            }
        });
        for (const num of Object.keys(RESTOCK_COMMUNITIES)) {
            if (typeof result[num] === 'number') {
                panelFunds.data[num] = result[num];
                panelFunds.failed.delete(num);
            } else {
                panelFunds.failed.add(num); // gagal -> saldo lama tetap dipakai, ditandai
            }
        }
        panelFunds.at = Date.now();
        schedulePanelStockUpdate(); // tampilkan saldo terbaru di panel
    } catch (e) {
        console.error('Gagal ambil saldo Group Funds:', e.message);
    } finally {
        isFundsRefreshing = false;
    }
}

async function buildPanelStockPages() {
    const fmt = (n) => Number(n).toLocaleString('id-ID');

    // Saldo Group Funds diambil dari data TERSIMPAN (diperbarui tiap 30 detik oleh refreshPanelFunds),
    // jadi menyusun panel TIDAK PERNAH memanggil API Roblox.
    const fundsPerCommunity = {};
    for (const num of Object.keys(RESTOCK_COMMUNITIES)) {
        fundsPerCommunity[num] = typeof panelFunds.data[num] === 'number' ? panelFunds.data[num] : null;
    }
    
    let totalStock = 0;
    let anyFundsFailed = false;
    for (const num of Object.keys(RESTOCK_COMMUNITIES)) {
        const funds = fundsPerCommunity[num];
        if (typeof funds === 'number') totalStock += funds;
        else if (panelFunds.at) anyFundsFailed = true; // (sebelum saldo pertama terambil = masih memuat, bukan gagal)
        if (panelFunds.failed.has(num)) anyFundsFailed = true; // saldo lama karena tarikan terakhir gagal
    }

    // Ambil semua invoice Community yang masih AKTIF (belum done/cancel/dihapus)
    let activeInvoices = [];
    try {
        activeInvoices = await InvoiceTracker.find({}).sort({ createdAt: 1 });
    } catch (e) {
        console.error('Gagal ambil data InvoiceTracker:', e.message);
    }
    const totalInvoiced = activeInvoices.reduce((sum, inv) => sum + inv.amount, 0);
    const sisaStock = totalStock - totalInvoiced;
    const color = sisaStock < 0 ? 0xED4245 : 0x5865F2;

    // --- Stock Overview ---
    let totalPending = 0;
    let anyPendingFailed = false;
    const communityLines = [];
    for (const [num, grp] of Object.entries(RESTOCK_COMMUNITIES)) {
        const val = fundsPerCommunity[num];
        communityLines.push(`🏢 **Community ${num} (${grp.name}):** ${val !== null ? `\`${fmt(val)} Robux\`` : (panelFunds.at ? '⚠️ *Gagal ambil data*' : '*memuat...*')}`);

        const p = pendingCache[num];
        if (!p) {
            communityLines.push('└ ⏳ Pending: *memuat...*');
        } else if (typeof p.pending !== 'number') {
            communityLines.push('└ ⏳ Pending: ⚠️ *gagal ambil data*');
            anyPendingFailed = true;
        } else {
            totalPending += p.pending;
            if (!p.ok) anyPendingFailed = true;
            communityLines.push(`└ ⏳ Pending: \`${fmt(p.pending)} Robux\`${p.ok ? '' : ' *(data lama)*'}`);
            if (p.refundedCount > 0) {
                const refundAmt = p.refundedAmount > 0 ? ` · ${fmt(p.refundedAmount)} Robux` : '';
                communityLines.push(`└ *↩️ ${p.refundedCount}x dana dikembalikan${refundAmt}*`);
            }
        }
    }

    const summaryLines = [
        `💎 **Total Stock:** \`${fmt(totalStock)} Robux\``,
        `⏳ **Total Pending:** \`${fmt(totalPending)} Robux\``,
        `🧾 **Ter-invoice:** \`${fmt(totalInvoiced)} Robux\` *(${activeInvoices.length} invoice)*`,
        `${sisaStock < 0 ? '🔴' : '🟢'} **Sisa Stock:** \`${fmt(sisaStock)} Robux\``
    ];
    if (sisaStock < 0) {
        summaryLines.push(''); // baris kosong -> peringatan diberi jarak dari ringkasan di atasnya
        summaryLines.push('⚠️ **PERINGATAN: Total invoice sudah MELEBIHI stock!**');
    }
    if (anyFundsFailed || anyPendingFailed) summaryLines.push('*(Sebagian data gagal ditarik, kemungkinan sementara — akan otomatis re-sync)*');
    if (pendingLastUpdated) {
        summaryLines.push(`*Pending dicek tiap 5 menit · terakhir <t:${Math.floor(pendingLastUpdated.getTime() / 1000)}:R> · refund = ${PENDING_LOOKBACK_DAYS} hari terakhir*`);
    }

    const overviewFields = [];
    const fullOverview = `${communityLines.join('\n')}\n\n${summaryLines.join('\n')}`;
    if (fullOverview.length <= 1024) {
        overviewFields.push({ name: '📦 Stock Overview', value: fullOverview, inline: false });
    } else {
        overviewFields.push({ name: '📦 Stock Overview', value: communityLines.join('\n').slice(0, 1024), inline: false });
        overviewFields.push({ name: '\u200b', value: summaryLines.join('\n').slice(0, 1024), inline: false });
    }
    const overviewSize = overviewFields.reduce((s, f) => s + f.name.length + f.value.length, 0);

    // --- Daftar invoice per tiket (format lengkap, SEMUA tiket ditampilkan) ---
    const grouped = {};
    for (const inv of activeInvoices) {
        if (!grouped[inv.channelId]) grouped[inv.channelId] = { channelName: inv.channelName, total: 0, count: 0 };
        grouped[inv.channelId].total += inv.amount;
        grouped[inv.channelId].count += 1;
    }
    const groupedArr = Object.values(grouped);
    const listHeader = `🎫 Invoice Aktif per Ticket (${groupedArr.length} tiket)`;

    const lines = groupedArr.map((g, i) => `${i + 1}. **${g.channelName}** — \`${fmt(g.total)} Robux\` — ${g.count} invoice`);

    // Potong jadi blok maks ±1000 karakter (batas 1 field = 1024)
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
        if (chunk && chunk.length + 1 + line.length > 1000) { chunks.push(chunk); chunk = line; }
        else chunk = chunk ? `${chunk}\n${line}` : line;
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length === 0) chunks.push('*Belum ada invoice Community yang aktif saat ini.*');

    // Susun blok ke dalam halaman (1 halaman = 1 pesan Discord)
    const packPages = (listChunks) => {
        const pages = [];
        let fields = [];
        let size = PANEL_TITLE.length;
        listChunks.forEach((value, idx) => {
            const isPageStart = fields.length === 0;
            let name = idx === 0 ? listHeader : (isPageStart ? '🎫 Invoice Aktif (lanjutan)' : '\u200b');
            if (fields.length && (size + name.length + value.length > PANEL_PAGE_BUDGET || fields.length >= 24)) {
                pages.push(fields);
                fields = [];
                size = 0;
                name = '🎫 Invoice Aktif (lanjutan)';
            }
            fields.push({ name, value, inline: false });
            size += name.length + value.length;
        });
        // Stock Overview ikut di halaman terakhir kalau muat, kalau tidak -> pesan sendiri
        if (fields.length && size + overviewSize <= PANEL_PAGE_BUDGET && fields.length + overviewFields.length <= 25) {
            fields.push(...overviewFields);
            pages.push(fields);
        } else {
            if (fields.length) pages.push(fields);
            pages.push([...overviewFields]);
        }
        return pages;
    };

    let pages = packPages(chunks);
    if (pages.length > PANEL_MAX_PAGES) {
        // Sangat jarang (ratusan tiket). Potong dari belakang sampai muat, sisanya diberi keterangan.
        let keep = chunks.length;
        while (keep > 1 && pages.length > PANEL_MAX_PAGES) {
            keep--;
            const shownLines = chunks.slice(0, keep).join('\n').split('\n').length;
            const note = `*…dan ${groupedArr.length - shownLines} tiket lainnya (total tetap dihitung di Stock Overview)*`;
            pages = packPages([...chunks.slice(0, keep), note]);
        }
    }

    return pages.map((fields, idx) => {
        const embed = new EmbedBuilder().setColor(color).addFields(fields);
        if (idx === 0) embed.setTitle(PANEL_TITLE);
        if (idx === pages.length - 1) embed.setTimestamp();
        return embed;
    });
}

// Update pesan panel yang tersimpan di DB. Self-healing: kalau channel/pesan sudah tidak ada, DB dibersihkan.
// Kode error Discord: 10003 = Unknown Channel, 10008 = Unknown Message (benar-benar sudah dihapus).
let isPanelUpdating = false;
let panelUpdateQueued = false;
async function updatePanelStockMessage() {
    // Cegah 2 update jalan bersamaan (interval 20 detik + update dari invoice) -> hasil lama bisa menimpa yang baru
    if (isPanelUpdating) { panelUpdateQueued = true; return; }
    isPanelUpdating = true;
    try {
        let panel;
        try {
            panel = await PanelStock.findOne();
        } catch (e) {
            console.error('Gagal ambil data PanelStock:', e.message);
            return;
        }
        if (!panel) return;

        try {
            let fetchError = null;
            const channel = await client.channels.fetch(panel.channelId).catch(err => { fetchError = err; return null; });
            if (!channel) {
                // Hapus dari DB HANYA kalau channel memang sudah tidak ada, bukan karena gangguan sementara
                if (fetchError?.code === 10003) await PanelStock.deleteOne({ _id: panel._id });
                return;
            }
            const msg = await channel.messages.fetch(panel.messageId).catch(err => { fetchError = err; return null; });
            if (!msg) {
                if (fetchError?.code === 10008) {
                    // Pesan utama dihapus -> bersihkan juga pesan lanjutannya
                    for (const id of (panel.extraMessageIds || [])) await channel.messages.delete(id).catch(() => {});
                    await PanelStock.deleteOne({ _id: panel._id });
                }
                return;
            }

            const pages = await buildPanelStockPages();
            await msg.edit({ embeds: [pages[0]] });

            // Pesan lanjutan (dibuat/diedit/dihapus otomatis sesuai jumlah halaman).
            // ID pesan SELALU disimpan (di blok finally) walau Discord error di tengah jalan,
            // supaya tidak ada pesan "yatim" yang tidak terupdate / dobel.
            const oldIds = [...(panel.extraMessageIds || [])];
            const newIds = [];
            let consumed = 0; // jumlah ID lama yang sudah diproses
            try {
                for (let i = 1; i < pages.length; i++) {
                    if (consumed < oldIds.length) {
                        const existingId = oldIds[consumed];
                        try {
                            await channel.messages.edit(existingId, { embeds: [pages[i]] });
                            newIds.push(existingId);
                            consumed++;
                            continue;
                        } catch (err) {
                            if (err?.code !== 10008) throw err; // gangguan sementara -> coba lagi di update berikutnya
                            // Pesan lanjutan ini dihapus manual -> hapus juga yang di bawahnya supaya urutan tetap benar
                            for (const id of oldIds.slice(consumed + 1)) await channel.messages.delete(id).catch(() => {});
                            consumed = oldIds.length;
                        }
                    }
                    const sent = await channel.send({ embeds: [pages[i]] });
                    newIds.push(sent.id);
                }
                // Halaman berkurang (banyak tiket selesai) -> hapus pesan lanjutan yang tidak terpakai
                while (consumed < oldIds.length) {
                    try {
                        await channel.messages.delete(oldIds[consumed]);
                    } catch (err) {
                        if (err?.code !== 10008) throw err; // gagal sementara -> dicoba lagi di update berikutnya
                    }
                    consumed++;
                }
            } finally {
                const finalIds = [...newIds, ...oldIds.slice(consumed)];
                if ((panel.extraMessageIds || []).join(',') !== finalIds.join(',')) {
                    panel.extraMessageIds = finalIds;
                    await panel.save().catch(e => console.error('Gagal simpan pesan lanjutan panel:', e.message));
                }
            }
        } catch (e) {
            console.error('Gagal update Panel Stock:', e.message);
        }
    } finally {
        isPanelUpdating = false;
        if (panelUpdateQueued) {
            panelUpdateQueued = false;
            schedulePanelStockUpdate(); // ada permintaan update selama proses tadi -> jalankan sekali lagi
        }
    }
}
// Debounce — supaya kalau beberapa invoice berubah beruntun dalam waktu singkat,
// panel tidak di-edit berkali-kali (hemat rate limit Discord & CPU).
let panelStockTimeout = null;
function schedulePanelStockUpdate() {
    if (panelStockTimeout) clearTimeout(panelStockTimeout);
    panelStockTimeout = setTimeout(() => {
        updatePanelStockMessage();
        panelStockTimeout = null;
    }, 2000);
}

// Loop utama: jalan tiap 15 detik, urus SEMUA restock aktif dari database.
// Karena sumber kebenarannya adalah arrivalTimestamp absolut di DB (bukan setTimeout in-memory),
// ini otomatis "nyambung" lagi dengan benar walau bot sempat mati/restart.
let isTickRunning = false; // cegah tickRestocks() jalan bertumpuk kalau eksekusi sebelumnya belum selesai

async function tickRestocks() {
    if (isTickRunning) return; // masih ada proses tick sebelumnya yang jalan -> skip, jangan numpuk
    isTickRunning = true;

    try {
        let activeRestocks;
        try {
            activeRestocks = await Restock.find({ status: 'pending' });
        } catch (e) {
            console.error('Gagal ambil data restock aktif:', e.message);
            return;
        }

        for (const restock of activeRestocks) {
            try {
                const channel = await client.channels.fetch(restock.channelId).catch(() => null);
                if (!channel) {
                    await Restock.deleteOne({ _id: restock._id }); // channel sudah tidak ada
                    continue;
                }
                const msg = await channel.messages.fetch(restock.messageId).catch(() => null);
                if (!msg) {
                    // Pesan sudah dihapus manual (dan event messageDelete terlewat, misal bot sempat offline) -> bersihkan DB
                    await Restock.deleteOne({ _id: restock._id });
                    continue;
                }

                const remaining = restock.arrivalTimestamp.getTime() - Date.now();

                if (remaining > 0) {
                    // Masih menghitung mundur -> update embed
                    await msg.edit({ embeds: [buildRestockPendingEmbed(restock)] }).catch(() => {});
                } else {
                    // KLAIM SECARA ATOMIK dulu SEBELUM kirim pengumuman apapun.
                    // Filter mengecek DUA hal sekaligus (status DAN announcementSent) supaya "tertutup rapat" —
                    // begitu salah satu proses berhasil klaim, filter ini otomatis gak akan pernah match lagi
                    // buat proses manapun lainnya, walau ada banyak proses/tick yang jalan bersamaan atau
                    // status sempat direset manual di DB. MongoDB menjamin operasi ini atomik, jadi walau
                    // 100 proses coba klaim di waktu yang sama persis, cuma SATU yang bisa menang.
                    const claimed = await Restock.findOneAndUpdate(
                        { _id: restock._id, status: 'pending', announcementSent: { $ne: true } },
                        { $set: { status: 'completed', announcementSent: true } }
                    );
                    if (!claimed) {
                        // Ini bukti kalau proteksinya BEKERJA: ada percobaan kirim kedua/ketiga yang berhasil dicegah.
                        console.log(`[Restock] Skip restock ${restock._id} — sudah pernah diumumkan sebelumnya, mencegah duplikat.`);
                        continue;
                    }

                    // Pesan countdown LAMA cukup diubah jadi status singkat "Countdown Selesai"
                    // (content @everyone lama dihapus, gak perlu lagi karena udah kepakai pas awal post)
                    await msg.edit({
                        content: null,
                        embeds: [buildRestockDoneStatusEmbed(restock)]
                    }).catch(() => {});

                    // Pengumuman lengkapnya dikirim sebagai PESAN BARU + @everyone,
                    // biar semua orang beneran dapat notifikasi baru kalau stok udah ready
                    const finishedEmbed = await buildRestockCompletedEmbed(restock);
                    await channel.send({
                        content: '@everyone',
                        embeds: [finishedEmbed],
                        allowedMentions: { parse: ['everyone'] }
                    }).catch(() => {});

                    console.log(`[Restock] Pengumuman restock ${restock._id} berhasil dikirim (1x).`);
                }
            } catch (e) {
                console.error(`Gagal update restock ${restock._id}:`, e.message);
            }
        }
    } finally {
        isTickRunning = false;
    }
}

// --- TAMBAHAN CACHE & COOLDOWN ---
const userCooldowns = new Map();
const eligibilityCache = new Map();

// --- RESTOCK & PANEL STOCK: bersihkan data DB kalau pesan terkait dihapus manual ---
// (Ini pembersih CEPAT; tickRestocks()/updatePanelStockMessage() di atas juga punya fallback
// kalau event ini terlewat, misal bot sempat offline)
client.on('messageDelete', async (message) => {
    try {
        if (!message?.id) return;
        await Restock.deleteOne({ messageId: message.id });

        const removedInvoice = await InvoiceTracker.deleteOne({ messageId: message.id });
        if (removedInvoice.deletedCount > 0) schedulePanelStockUpdate();

        await TicketVouch.deleteOne({ messageId: message.id });
    } catch (e) {
        // Diamkan saja — ini cuma pembersihan, tidak kritikal kalau sesekali gagal
    }
});

// --- PANEL STOCK: kalau channel tiket dihapus MANUAL (bukan lewat tombol close),
// pastikan invoice yang nyangkut di situ tetap ikut lepas dari tracking ---
// --- AUTO GESER ANTRIAN: kalau channel tiket DIPINDAH MANUAL keluar/masuk kategori tiket,
// slot jadi berubah -> rapikan antrian juga ---
client.on('channelUpdate', async (oldChannel, newChannel) => {
    try {
        if (!newChannel?.guild || oldChannel.parentId === newChannel.parentId) return;
        if (TICKET_CATEGORY_IDS.includes(oldChannel.parentId) || TICKET_CATEGORY_IDS.includes(newChannel.parentId)) {
            scheduleTicketRebalance(newChannel.guild);
        }
    } catch (e) {
        // Diamkan saja — tidak kritikal
    }
});

// --- PANEL STOCK: kalau channel tiket dihapus MANUAL (bukan lewat tombol close),
// pastikan invoice yang nyangkut di situ tetap ikut lepas dari tracking ---
client.on('channelDelete', async (channel) => {
    try {
        if (!channel?.id) return;

        // --- AUTO GESER ANTRIAN: ada channel tiket hilang -> slot kosong -> naikkan antrian ---
        closingTicketChannels.delete(channel.id);
        if (channel.guild && TICKET_CATEGORY_IDS.includes(channel.parentId)) {
            await Ticket.deleteOne({ channelId: channel.id }).catch(() => {}); // kalau dihapus manual
            scheduleTicketRebalance(channel.guild);
        }

        const removed = await InvoiceTracker.deleteMany({ channelId: channel.id });
        if (removed.deletedCount > 0) schedulePanelStockUpdate();

        await TicketVouch.deleteOne({ channelId: channel.id });
    } catch (e) {
        // Diamkan saja — pembersihan, tidak kritikal
    }
});

client.on('interactionCreate', async (interaction) => {
// =========================================================================
    // === TICKET SYSTEM - AI OPTIMIZED FOR ALWAYSDATA ===
    // =========================================================================

    // Fungsi Render Panel Ticket
    const renderTicketPanel = async (channel) => {
        let config = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' });
        if (!config) config = new TicketConfig();

        // Trik Garis Panjang agar Embed memiliki lebar (width) yang konsisten di PC, Tablet & Mobile
        const separator = '──────────────────────────────────────────';

        const embedTicket = new EmbedBuilder()
            .setColor(0x4F4580)
            .setTitle('🎫 VIBEBLOX - Ticket Order')
            .setThumbnail('https://cdn.discordapp.com/attachments/1500317839507062897/1515115963928940706/iconbot.png')
            .setDescription(`Silakan pilih kategori tiket dengan memencet tombol di bawah.👇\n`)
            // MENGGUNAKAN ADDFIELDS AGAR SPASI RAPIH DAN TIDAK MELEBAR
            .addFields(
                { name: '💎 Robux Community', value: 'Top up robux cepat melalui sistem Payout Community.', inline: false },
                { name: '🏷️ Robux Send Plus', value: 'Robux masuk secara instant tanpa pending via Roblox Plus.', inline: false },
                { name: '💳 Robux Vilog', value: 'Top up Robux instant melalui metode login akun (100% Aman).', inline: false },
                { name: '💰 Robux Gamepass', value: 'Sistem After Tax (Terima Bersih). Robux cair setelah 5 Hari.', inline: false },
                { name: '🎁 Gift In-Game', value: 'Gift semua item atau gamepass di semua map Roblox.', inline: false },
                { name: '👑 Limited Item', value: 'Pembelian item Limited Roblox.', inline: false },
                { name: '💼 Middleman', value: 'Jasa perantara (Rekber) aman untuk segala transaksi.', inline: false }
            )
            .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1521628896938819805/server_banner.png?ex=6a4586d7&is=6a443557&hm=77ec74c8c32de11eae99a2b8baf14fc2b02da44c73b7581f36e478b0ff04be20&')
            .setFooter({ text: 'Made by VibeBlox' });

        // Array tombol dinamis
        const allButtons = [
            { id: 'community', label: '💎 Robux Community' },
            { id: 'robux_plus', label: '🏷️ Robux Send' },
            { id: 'vilog', label: '💳 Robux Vilog' },
            { id: 'gamepass', label: '💰 Robux Gamepass' },
            { id: 'gig', label: '🎁 Gift In-Game' },
            { id: 'limited', label: '👑 Limited Item' },
            { id: 'mm', label: '💼 Middleman' }
        ];

        // Pisahkan tombol enable dan disable untuk disorting (Kiri Aktif, Kanan Mati)
        const enabledButtons = [];
        const disabledButtons = [];

        for (const b of allButtons) {
            const isEnabled = config.buttonStates.get(b.id) !== false; // Default true

            // Set Warna Dinamis: Hijau (Success) jika Aktif, Merah (Danger) jika Mati
            const btn = new ButtonBuilder()
                .setCustomId(`tc_${b.id}`)
                .setLabel(b.label)
                .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Primary)
                .setDisabled(!isEnabled);

            if (isEnabled) {
                enabledButtons.push(btn);
            } else {
                disabledButtons.push(btn);
            }
        }

        const sortedButtons = [...enabledButtons, ...disabledButtons];
        const components = [];
        
        // Memecah menjadi max 5 tombol per baris (Aturan batas Discord)
        for (let i = 0; i < sortedButtons.length; i += 5) {
            components.push(new ActionRowBuilder().addComponents(sortedButtons.slice(i, i + 5)));
        }

        return { embeds: [embedTicket], components };
    };

// --- SLASH COMMAND: /ticket ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ Hanya admin yang dapat membuat panel tiket.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const panelData = await renderTicketPanel();
        
        // Simpan output kiriman bot ke dalam variabel sentPanel
        const sentPanel = await interaction.channel.send(panelData);

        // Catat ID ke Database agar bisa Real-Time Update
        let config = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' });
        if (!config) config = new TicketConfig();
        
        config.panelChannelId = interaction.channel.id;
        config.panelMessageId = sentPanel.id;
        await config.save();

        return interaction.editReply('✅ Panel tiket berhasil dikirim dan disinkronisasi!');
    }

// --- SLASH COMMAND: /buttonticket ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'buttonticket') {
        const allowedRolesBtn = ['1489612423521374309', '1489612221544665231'];
        if (!interaction.member.roles.cache.some(r => allowedRolesBtn.includes(r.id))) {
            return interaction.reply({ content: '❌ Akses ditolak.', flags: MessageFlags.Ephemeral });
        }
        
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const status = interaction.options.getString('status') === 'enable';

        let config = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' });
        if (!config) config = new TicketConfig();
        
        // Update status di database
        config.buttonStates.set(tipe, status);
        await config.save();

        let updateMsg = '';

        // REAL-TIME UPDATE LOGIC
        if (config.panelChannelId && config.panelMessageId) {
            try {
                // Fetch channel dan pesan langsung menggunakan ID (Aman & Ringan)
                const channel = await client.channels.fetch(config.panelChannelId);
                if (channel) {
                    const panelMsg = await channel.messages.fetch(config.panelMessageId);
                    if (panelMsg) {
                        const panelData = await renderTicketPanel();
                        await panelMsg.edit(panelData);
                        updateMsg = `✅ Button **${tipe}** berhasil di-${status ? 'Enable' : 'Disable'} dan Panel ter-update realtime!`;
                    }
                }
            } catch (e) {
                console.error("Gagal update panel tiket realtime:", e.message);
                updateMsg = `✅ Button **${tipe}** di-${status ? 'Enable' : 'Disable'} (Data tersimpan, tapi pesan panel lama sudah terhapus di Discord. Silakan gunakan /ticket ulang).`;
            }
        } else {
            updateMsg = `✅ Button **${tipe}** di-${status ? 'Enable' : 'Disable'} (Belum ada panel tiket aktif yang didaftarkan. Silakan jalankan /ticket).`;
        }

        return interaction.editReply(updateMsg);
    }

    // --- BUTTON PANEL TICKET -> MODAL ---
    if (interaction.isButton() && interaction.customId.startsWith('tc_')) {
        const type = interaction.customId.replace('tc_', '');
        
        const modal = new ModalBuilder().setCustomId(`tm_${type}`).setTitle('Formulir Pemesanan');

        const userRoblox = new TextInputBuilder().setCustomId('user_roblox').setLabel('Username Roblox').setStyle(TextInputStyle.Short).setRequired(true);
        const jmlRobux = new TextInputBuilder().setCustomId('jml_robux').setLabel('Jumlah Robux (Contoh: 1000)').setStyle(TextInputStyle.Short).setRequired(true);

        if (['community', 'robux_plus', 'vilog'].includes(type)) {
            modal.addComponents(new ActionRowBuilder().addComponents(userRoblox), new ActionRowBuilder().addComponents(jmlRobux));
        } else if (type === 'gamepass') {
            modal.addComponents(new ActionRowBuilder().addComponents(jmlRobux));
        } else if (type === 'gig') {
            const namaMap = new TextInputBuilder().setCustomId('nama_map').setLabel('Nama Map').setStyle(TextInputStyle.Short).setRequired(true);
            const namaItem = new TextInputBuilder().setCustomId('nama_item').setLabel('Nama Item').setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userRoblox), new ActionRowBuilder().addComponents(namaMap), new ActionRowBuilder().addComponents(namaItem), new ActionRowBuilder().addComponents(jmlRobux));
        } else if (type === 'limited') {
            const namaLimited = new TextInputBuilder().setCustomId('nama_limited').setLabel('Nama Limited Item').setStyle(TextInputStyle.Short).setRequired(true);
            const tumbal = new TextInputBuilder().setCustomId('tumbal').setLabel('Sudah ada item tumbal? (Sudah/Belum)').setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userRoblox), new ActionRowBuilder().addComponents(namaLimited), new ActionRowBuilder().addComponents(tumbal));
        } else if (type === 'mm') {
            const mmPembeli = new TextInputBuilder().setCustomId('mm_pembeli').setLabel('Username Discord Pembeli (Cth: axel123)').setStyle(TextInputStyle.Short).setRequired(true);
            const mmPenjual = new TextInputBuilder().setCustomId('mm_penjual').setLabel('Username Discord Penjual (Cth: axel321)').setStyle(TextInputStyle.Short).setRequired(true);
            const mmUang = new TextInputBuilder().setCustomId('mm_uang').setLabel('Jumlah Transaksi (Rp / Robux)').setStyle(TextInputStyle.Short).setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(mmPembeli), new ActionRowBuilder().addComponents(mmPenjual), new ActionRowBuilder().addComponents(mmUang));
        }

        // Tampilkan modal SECARA INSTAN agar tidak Interaction Failed
        // Tampilkan modal SECARA INSTAN agar tidak Interaction Failed
        try {
            return await interaction.showModal(modal);
        } catch (err) {
            console.error('Gagal menampilkan modal:', err);
        }
    }

   // --- SUBMIT MODAL -> CREATE TICKET CHANNEL ---
    if (interaction.isModalSubmit() && interaction.customId.startsWith('tm_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Balas aman dulu
        
        const type = interaction.customId.replace('tm_', '');

        // =====================================================================
        // === VALIDASI PINTAR MIDDLEMAN (SEBELUM MEMBUAT TIKET) ===
        // =====================================================================
        let foundPembeli = null;
        let foundPenjual = null;
        let qPembeli = '';
        let qPenjual = '';
        let mmUang = '';

        if (type === 'mm') {
            qPembeli = interaction.fields.getTextInputValue('mm_pembeli').trim();
            qPenjual = interaction.fields.getTextInputValue('mm_penjual').trim();
            mmUang = interaction.fields.getTextInputValue('mm_uang');

           // Fungsi pencarian Hybrid (ID/Ping -> Exact Username -> Exact Display Name -> Tebakan Discord)
            const findMember = async (query) => {
                const q = query.trim().toLowerCase();
                
                // 1. Ekstrak angka jika input berupa ID atau Ping (<@123456>)
                const extractedId = query.replace(/[^\d]/g, ''); 
                if (extractedId.length >= 17 && extractedId.length <= 19) {
                    const member = await interaction.guild.members.fetch(extractedId).catch(() => null);
                    if (member) return member;
                }

                // 2. Jika input berupa teks biasa, lakukan pencarian pintar
                try {
                    // Tarik maksimal 5 member yang mirip (sangat ringan untuk server)
                    const searchResults = await interaction.guild.members.fetch({ query: query, limit: 5 });
                    if (searchResults.size === 0) return null;

                    // Prioritas A: Cocokkan dengan Username asli (Unik, tidak ada spasi)
                    let exactUsername = searchResults.find(m => m.user.username.toLowerCase() === q);
                    if (exactUsername) return exactUsername;

                    // Prioritas B: Cocokkan dengan Display Name
                    let exactDisplayName = searchResults.find(m => m.displayName.toLowerCase() === q);
                    if (exactDisplayName) return exactDisplayName;

                    // Prioritas C: Jika pelanggan typo sedikit, ambil hasil tebakan teratas dari Discord
                    return searchResults.first();
                } catch (e) {
                    return null;
                }
            };

            // Cari kedua user di server (dibungkus try/catch agar TIDAK CRASH seluruh bot
            // kalau Discord API gagal/timeout, misalnya karena Server Members Intent belum aktif)
            try {
                foundPembeli = await findMember(qPembeli);
                foundPenjual = await findMember(qPenjual);
            } catch (err) {
                console.error('Gagal mencari member untuk tiket MM:', err);
                return interaction.editReply({ content: '❌ Gagal memvalidasi Pembeli/Penjual (error saat mencari member di server). Coba lagi atau gunakan User ID Discord.' });
            }

            // Jika salah satu atau keduanya TIDAK DITEMUKAN, batalkan pembuatan tiket!
            if (!foundPembeli || !foundPenjual) {
                let errorMsg = '❌ **Pembuatan Tiket Middleman Dibatalkan!**\n';
                if (!foundPembeli) errorMsg += `- User Pembeli (\`${qPembeli}\`) tidak ditemukan di server.\n`;
                if (!foundPenjual) errorMsg += `- User Penjual (\`${qPenjual}\`) tidak ditemukan di server.\n`;
                errorMsg += '\n💡 *Tips: Masukkan Username asli (bukan Display Name) atau gunakan **User ID Discord** (angka) agar 100% akurat.*';
                
                return interaction.editReply({ content: errorMsg });
            }
        }
        // =====================================================================

        // --- KATEGORI TICKET: dipilih di dalam kunci antrian (lihat withTicketLock di bawah) ---

        const roleOwner = '1489612423521374309';
        const roleHandler = '1489612221544665231';
        const rolePartner = '1519076541055897670';

        // Sistem Antrean Otomatis & Cepat (Atomic Update)
        const config = await TicketConfig.findOneAndUpdate(
            { configId: 'VIBEBLOX_TICKET' },
            { $inc: { ticketCounter: 1 } },
            { new: true, upsert: true }
        );

        const channelPrefixes = {
            'community': 'community',
            'robux_plus': 'visend',
            'vilog': 'vilog',
            'gamepass': 'gamepass',
            'gig': 'gig',
            'limited': 'limited',
            'mm': 'mm'
        };
        const channelName = `${channelPrefixes[type] || 'ticket'}-${config.ticketCounter}`;
        try {
            // Setup Permission
            const permissionOverwrites = [
                { id: interaction.guild.id, deny: ['ViewChannel'] }, // @everyone hide
                { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
                { id: roleOwner, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
                { id: roleHandler, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
                { id: rolePartner, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] }
            ];

            // Masukkan User Middleman (Karena sudah divalidasi, pasti berhasil masuk)
            let mmPings = '';
            if (type === 'mm') {
                permissionOverwrites.push({ id: foundPembeli.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });
                permissionOverwrites.push({ id: foundPenjual.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });
                mmPings += `<@${foundPembeli.id}> <@${foundPenjual.id}>`;
            }

            // Buat Channel + Simpan DB — KEDUANYA DI DALAM KUNCI ANTRIAN,
            // supaya proses auto-geser tidak pernah melihat channel baru yang belum tercatat di DB
            const ticketChannel = await withTicketLock(async () => {
                const activeCategoryId = await pickTicketCategory(interaction.guild);
                if (!activeCategoryId) return null; // semua kategori penuh

                const newChannel = await interaction.guild.channels.create({
                    name: channelName,
                    type: 0, // Text Channel
                    parent: activeCategoryId,
                    permissionOverwrites: permissionOverwrites
                });

                try {
                    await Ticket.create({
                        channelId: newChannel.id,
                        creatorId: interaction.user.id,
                        ticketType: type
                    });
                } catch (dbErr) {
                    // DB gagal -> hapus channel lagi, jangan sampai ada channel "yatim" yang tidak bisa di-close/dipindah
                    console.error('❌ Gagal simpan tiket ke DB, channel dibatalkan:', dbErr.message);
                    await newChannel.delete().catch(() => {});
                    throw dbErr;
                }
                return newChannel;
            });

            if (!ticketChannel) {
                return interaction.editReply('❌ Semua kategori tiket sedang penuh. Silakan coba lagi beberapa saat lagi.');
            }

            // Susun Embed Tiket
            const typeLabels = {
                'community': '💎 Robux Community',
                'robux_plus': '🏷️ Robux Send Plus',
                'vilog': '💳 Robux Vilog',
                'gamepass': '💰 Robux Gamepass',
                'gig': '🎁 Gift In-Game',
                'limited': '👑 Limited Item',
                'mm': '💼 Middleman'
            };

            const ticketEmbed = new EmbedBuilder()
                .setColor(0x4F4580)
                .setTitle(`🎫 Order Tiket: ${typeLabels[type]}`)
                .setDescription(`Halo <@${interaction.user.id}>! Terima kasih telah membuka tiket. Silakan tunggu staf kami untuk merespons pesanan Anda.\n\n**Data Pemesanan:**`)
                .setThumbnail(interaction.user.displayAvatarURL());

            // Masukkan data form ke Embed
            if (['community', 'robux_plus', 'vilog'].includes(type)) {
                ticketEmbed.addFields(
                    { name: '👤 Username Roblox', value: `\`${interaction.fields.getTextInputValue('user_roblox')}\``, inline: true },
                    { name: '💰 Jumlah Robux', value: `**${interaction.fields.getTextInputValue('jml_robux')} R$**`, inline: true }
                );
            } else if (type === 'gamepass') {
                ticketEmbed.addFields({ name: '💰 Jumlah Robux', value: `**${interaction.fields.getTextInputValue('jml_robux')} R$**`, inline: true });
            } else if (type === 'gig') {
                ticketEmbed.addFields(
                    { name: '👤 Username Roblox', value: `\`${interaction.fields.getTextInputValue('user_roblox')}\``, inline: true },
                    { name: '💰 Jumlah Robux', value: `**${interaction.fields.getTextInputValue('jml_robux')} R$**`, inline: true },
                    { name: '🗺️ Nama Map', value: interaction.fields.getTextInputValue('nama_map'), inline: false },
                    { name: '🎁 Nama Item', value: interaction.fields.getTextInputValue('nama_item'), inline: false }
                );
            } else if (type === 'limited') {
                ticketEmbed.addFields(
                    { name: '👤 Username Roblox', value: `\`${interaction.fields.getTextInputValue('user_roblox')}\``, inline: true },
                    { name: '👑 Nama Limited', value: interaction.fields.getTextInputValue('nama_limited'), inline: true },
                    { name: '♻️ Status Tumbal', value: interaction.fields.getTextInputValue('tumbal'), inline: false }
                );
            } else if (type === 'mm') {
                ticketEmbed.addFields(
                    { name: '🛒 Pembeli', value: `<@${foundPembeli.id}>`, inline: true },
                    { name: '🏪 Penjual', value: `<@${foundPenjual.id}>`, inline: true },
                    { name: '💵 Jumlah Transaksi', value: `**${mmUang}**`, inline: false }
                );
            }

            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ta_claim').setLabel('🎯 Claim Ticket').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('ta_close').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
            );

            const roleVibeOwner = '1489612423521374309'; // Vibe Owner — role yang handle tiket
            const userHandlerId = '1192277645065470012'; // User spesifik yang juga handle tiket
            const msgContent = type === 'mm' && mmPings !== ''
                ? `Memanggil para pihak: ${mmPings}\n<@&${roleVibeOwner}> <@${userHandlerId}>`
                : `<@${interaction.user.id}> <@&${roleVibeOwner}> <@${userHandlerId}>`;
            await ticketChannel.send({
                content: msgContent,
                embeds: [ticketEmbed],
                components: [actionRow],
                allowedMentions: { parse: ['users', 'roles'] }
            });

            return interaction.editReply(`✅ Tiket berhasil dibuat! Silakan menuju ${ticketChannel}`);

        } catch (e) {
            console.error(e);
            return interaction.editReply('❌ Tiket Sudah ditutup😂!');
        }
    }

    // --- TICKET ACTION BUTTONS (CLAIM / CLOSE / UNCLAIM) ---
    if (interaction.isButton() && interaction.customId.startsWith('ta_')) {
        const action = interaction.customId;
        const ticketData = await Ticket.findOne({ channelId: interaction.channel.id });

        if (!ticketData) return interaction.reply({ content: '❌ Data tiket tidak ditemukan di sistem.', flags: MessageFlags.Ephemeral });

        const isStaff = interaction.member.roles.cache.some(r => ['1489612423521374309', '1489612221544665231', '1519076541055897670'].includes(r.id));
        
        // CLAIM TICKET
        if (action === 'ta_claim') {
            if (!isStaff) return interaction.reply({ content: '❌ Hanya staf yang bisa meng-claim tiket ini.', flags: MessageFlags.Ephemeral });
            if (ticketData.claimedBy) return interaction.reply({ content: `❌ Tiket ini sudah diklaim oleh <@${ticketData.claimedBy}>!`, flags: MessageFlags.Ephemeral });

            await interaction.deferUpdate();
            
            ticketData.claimedBy = interaction.user.id;
            await ticketData.save();

            const oldEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            oldEmbed.setColor(0x57F287) // Hijau
                    .addFields({ name: '🎯 Status Tiket', value: `Diklaim oleh: <@${interaction.user.id}>\nPada: <t:${Math.floor(Date.now() / 1000)}:f>`, inline: false });

            const newRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ta_unclaim').setLabel('🔄 Unclaim').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('ta_close').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
            );

            await interaction.message.edit({ embeds: [oldEmbed], components: [newRow] });
            await interaction.followUp({ content: `✅ Tiket telah berhasil kamu *claim*, <@${interaction.user.id}>!`, flags: MessageFlags.Ephemeral });
        }

        // UNCLAIM TICKET
        if (action === 'ta_unclaim') {
            if (ticketData.claimedBy !== interaction.user.id && !interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ Kamu tidak bisa melakukan unclaim tiket yang bukan milikmu.', flags: MessageFlags.Ephemeral });
            }

            await interaction.deferUpdate();

            ticketData.claimedBy = null;
            await ticketData.save();

            const oldEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            // Hapus field terakhir (Status claim)
            oldEmbed.data.fields.pop();
            oldEmbed.setColor(0x4F4580);

            const originalRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ta_claim').setLabel('🎯 Claim Ticket').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('ta_close').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
            );

            await interaction.message.edit({ embeds: [oldEmbed], components: [originalRow] });
            await interaction.channel.send({ content: `🔄 <@${interaction.user.id}> melepaskan claim dari tiket ini. Admin lain kini dapat melakukan claim.` });
        }

        // CLOSE TICKET (Generate ringan, gak pakai library HTML)
        if (action === 'ta_close') {
            if (!isStaff) return interaction.reply({ content: '❌ Hanya staf yang bisa menutup tiket.', flags: MessageFlags.Ephemeral });

            // Mencegah klik beruntun
            const msgId = interaction.message.id;
            if (isUpdating.has(`tc_close_${msgId}`)) return interaction.reply({ content: '⏳ Tiket sedang ditutup...', flags: MessageFlags.Ephemeral });
            isUpdating.add(`tc_close_${msgId}`);

            closingTicketChannels.add(interaction.channel.id); // jangan dipindah saat sedang ditutup
            await interaction.reply({ content: '🔒 Menyiapkan data dan menutup tiket... Channel akan terhapus sebentar lagi.' });
            
            try {
                // 1. Buat Text Transcript Hemat RAM (Max 100 pesan)
                const msgs = await interaction.channel.messages.fetch({ limit: 100 });
                const transcriptData = msgs.reverse().map(m => `[${m.createdAt.toLocaleString('id-ID')}] ${m.author.tag}: ${m.content ? m.content : '[Ada Embed/Attachment/Sticker]'}`).join('\n');
                
                const buffer = Buffer.from(transcriptData, 'utf-8');
                const fileAttachment = new AttachmentBuilder(buffer, { name: `${interaction.channel.name}-transcript.txt` });

                // 2. Kirim Embed ke Log Channel
                const logChannelId = '1490236117293862962';
                const logChannel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);

                if (logChannel) {
                    const durasiInMs = Date.now() - ticketData.createdAt.getTime();
                    const durasiJam = Math.floor(durasiInMs / 3600000);
                    const durasiMenit = Math.floor((durasiInMs % 3600000) / 60000);

                    const claimText = ticketData.claimedBy ? `<@${ticketData.claimedBy}>` : '*Tidak ada yang claim*';

                    const logEmbed = new EmbedBuilder()
                        .setColor(0xED4245)
                        .setTitle(`📑 Transcript: ${interaction.channel.name}`)
                        .addFields(
                            { name: '👤 Pembuat Tiket', value: `<@${ticketData.creatorId}>`, inline: true },
                            { name: '🛠️ Ditangani Oleh', value: claimText, inline: true },
                            { name: '⏱️ Durasi Tiket', value: `${durasiJam} Jam, ${durasiMenit} Menit`, inline: false },
                            { name: '📜 Tipe Via', value: `**${ticketData.ticketType.toUpperCase()}**`, inline: false }
                        )
                        .setFooter({ text: 'VibeBlox Auto-Transcript' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [logEmbed], files: [fileAttachment] });
                }

                // --- PANEL STOCK: lepas semua invoice yang masih nyangkut di tiket ini ---
                try {
                    const removed = await InvoiceTracker.deleteMany({ channelId: interaction.channel.id });
                    if (removed.deletedCount > 0) schedulePanelStockUpdate();
                } catch (e) {}

                // --- VOUCH TRACKING: bersihkan data vouch tiket ini juga ---
                try { await TicketVouch.deleteOne({ channelId: interaction.channel.id }); } catch (e) {}

                // 3. Hapus DB dan Channel
                await Ticket.deleteOne({ channelId: interaction.channel.id });
                await interaction.channel.delete();
            } catch (err) {
                console.error("Gagal saat close tiket:", err);
                closingTicketChannels.delete(interaction.channel.id); // gagal hapus -> boleh dipindah lagi
            } finally {
                isUpdating.delete(`tc_close_${msgId}`);
            }
        }
    }

    
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
        const invoiceMsgId = parts[parts.length - 1]; // Ambil ID dari array terakhir

        if ((action === 'cancel' || action === 'done') && !hasRoleInv) {
            return interaction.reply({ content: '❌ Hanya Owner dan Handler yang bisa menekan tombol ini.', flags: MessageFlags.Ephemeral });
        }

        if (action === 'cancel') {
            await interaction.deferUpdate();
            try { await interaction.message.delete(); } catch (e) {}
            try {
                await InvoiceTracker.deleteOne({ messageId: invoiceMsgId });
                schedulePanelStockUpdate();
            } catch (e) {}
            return;
        }

        if (['bca', 'qris', 'dana', 'gopay'].includes(action)) {
            // --- VALIDASI LIMIT QRIS: transaksi >= Rp 300.000 cuma bisa dibuka Admin ---
            if (action === 'qris' && !hasRoleInv) {
                let totalHargaCheck = 0;
                const embedCheck = interaction.message.embeds[0];
                if (embedCheck && embedCheck.fields) {
                    for (const field of embedCheck.fields) {
                        if (field.name.includes('Total Harga') || field.name.includes('Total Bayar')) {
                            const numMatch = field.value.replace(/[^\d]/g, '');
                            if (numMatch) totalHargaCheck = parseInt(numMatch);
                        }
                    }
                }

                if (totalHargaCheck >= 300000) {
                    const warnEmbed = new EmbedBuilder()
                        .setColor(0xFEE75C)
                        .setTitle('⚠️ QRIS hanya untuk Transaksi dibawah RP 300.000')
                        .setDescription('Silahkan gunakan metode pembayaran lainnya(DANA/GOPAY/BCA!)\n\nSilahkan konfirmasi terlebih dahulu kepada admin jika anda dari luar negri dan hanya bisa menggunakan qris untuk payment.\n\n**NOTE:** Jika memaksa membayar ke QRIS tanpa konfirmasi ke admin terlebih dahulu, maka akan ada **pengurangan jumlah robux/item** yang dikirimkan!');
                    return interaction.reply({ embeds: [warnEmbed], flags: MessageFlags.Ephemeral });
                }
            }

            if (isUpdating.has(interaction.message.id)) {
                return interaction.reply({ content: '⏳ Mohon tunggu, metode sedang dimuat...', flags: MessageFlags.Ephemeral });
            }
            isUpdating.add(interaction.message.id);
            await interaction.deferUpdate();

            try {
                const embedPay = new EmbedBuilder().setTimestamp();
                if (action === 'bca') {
                    embedPay.setColor(0x003D79).setTitle('🏦 Transfer Bank BCA VibeBlox').addFields({ name: '👤 Atas Nama', value: '**Angel Vinny Vincentia Pelawi**' }, { name: '🔢 No. Rekening', value: '**8205363625**' }, { name: '🏦 Bank', value: '**BCA**' }).setFooter({ text: 'VibeBlox Payment' });
                } else if (action === 'qris') {
                    embedPay.setColor(0x4F4580).setTitle('💳 Pembayaran QRIS VibeBlox').setDescription('Silakan scan QRIS di bawah ini untuk melakukan pembayaran.').setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1549162963695444079/qr_ID1026513310379_15.09.26_1789418946_1789418947032.jpg?ex=6aa9b1f0&is=6aa86070&hm=dafc1f013d11eb285bb37728fa7551a10fca68da44cc07530fba82e43d0ad6cb&').setFooter({ text: 'VibeBlox Payment' });
                } else if (action === 'dana') {
                    embedPay.setColor(0x108EE9).setTitle('💙 Pembayaran Dana VibeBlox').addFields({ name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**' }, { name: '📱 Nomor Dana', value: '**08119931329**' }, { name: '💳 Platform', value: '**Dana**' }).setFooter({ text: 'VibeBlox Payment' });
                } else if (action === 'gopay') {
                    embedPay.setColor(0x00AED6).setTitle('💚 Pembayaran GoPay VibeBlox').addFields({ name: '👤 Atas Nama', value: '**Muhammad Ikhsan Fadillah**' }, { name: '📱 Nomor GoPay', value: '**08119931329**' }, { name: '💳 Platform', value: '**GoPay**' }).setFooter({ text: 'VibeBlox Payment' });
                }

                await interaction.followUp({ embeds: [embedPay] });

                const newComponents = interaction.message.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => {
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
                isUpdating.delete(interaction.message.id);
            }
            return;
        }

        // --- DONE: LANGSUNG KE METODE PEMBAYARAN ---
        if (action === 'done') {
            const msgId = interaction.message.id;
            const typeValue = parts.slice(2, -1).join('_'); // Mengambil tipe yang disisipkan dari command awal
            
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

                // Step 1: Langsung Pilih Metode Pembayaran (ephemeral)
                const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };

                const payRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`invf_pay_qris_${typeValue}_${msgId}`).setLabel('QRIS').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`invf_pay_bca_${typeValue}_${msgId}`).setLabel('BCA').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`invf_pay_dana_${typeValue}_${msgId}`).setLabel('Dana').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`invf_pay_gopay_${typeValue}_${msgId}`).setLabel('GoPay').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`invf_pay_lainnya_${typeValue}_${msgId}`).setLabel('Lainnya').setStyle(ButtonStyle.Secondary)
                );
                const cancelRow2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`invf_cancel_${msgId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
                );

                const payEmbed = new EmbedBuilder().setColor(0x4F4580).setTitle('💳 Pilih Metode Pembayaran')
                    .setDescription(`Tipe: **${typeNames[typeValue] || typeValue}**\nPilih metode pembayaran:`);

                await interaction.followUp({ embeds: [payEmbed], components: [payRow, cancelRow2], flags: MessageFlags.Ephemeral });
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
        if (customId.startsWith('invf_cancel_') || customId.startsWith('invf_confirm_no_')) {
            await interaction.update({ content: '❌ Proses dibatalkan.', embeds: [], components: [] });
            await reEnableDone();
            return;
        }

        // --- Step 2 result: Metode Pembayaran dipilih → Konfirmasi ---
        if (customId.startsWith('invf_pay_')) {
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

        // --- Konfirmasi: YAKIN ---
        if (customId.startsWith('invf_confirm_yes_')) {
            const withoutPrefix = customId.replace('invf_confirm_yes_', '');
            const msgIdPart = invoiceMsgId;
            const beforeMsgId = withoutPrefix.substring(0, withoutPrefix.lastIndexOf('_'));
            const method = beforeMsgId.substring(0, beforeMsgId.indexOf('_'));
            const typeValue = beforeMsgId.substring(beforeMsgId.indexOf('_') + 1);

            const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };
            const methodNames = { 'qris': 'QRIS', 'bca': 'BCA', 'dana': 'Dana', 'gopay': 'GoPay', 'lainnya': 'Lainnya' };

            const vouchDescriptions = {
                'community': 'Robux Payout Instant',
                'vilog': 'Robux Via Login',
                'gamepass_after': 'Robux Gamepass After',
                'gamepass_before': 'Robux Gamepass Before',
                'gig': 'Robux Gift in-Game',
                'robux_plus': 'Robux Via Send Username'
            };

            await interaction.update({ content: '⏳ Memproses transaksi & generate vouch...', embeds: [], components: [] });

            try {
                const invoiceMsg = await interaction.channel.messages.fetch(msgIdPart);
                const invoiceEmbed = invoiceMsg.embeds[0];

                let targetUserId = null;
                let totalHarga = 0;
                let amountRobux = 0;
                let adminUserId = interaction.user.id; 

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

                // EKSEKUSI DATABASE
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

                // UBAH WARNA EMBED
                const doneEmbed = EmbedBuilder.from(invoiceEmbed)
                    .setColor(0x57F287)
                    .setFooter({ text: '✅ Invoice Selesai • VibeBlox' });

                const disabledComponents = invoiceMsg.components.map(row => {
                    const newRow = ActionRowBuilder.from(row);
                    newRow.components.forEach(btn => btn.setDisabled(true));
                    return newRow;
                });

                await invoiceMsg.edit({ embeds: [doneEmbed], components: disabledComponents });

                // LOG STORE FINANCE
                const financeChannelId = '1489665490770067678';
                const kategori = `${typeNames[typeValue] || typeValue} - ${methodNames[method] || method}`;
                let pembeliDisplay = `<@${targetUserId}>`;
                if (targetMember) pembeliDisplay = `<@${targetUserId}>\n(${targetMember.displayName} • @${targetMember.user.username})`;

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

                // GENERATE AUTO VOUCH (MENGGUNAKAN TIPE DARI COMMAND AWAL)
                const separator = '──────────────────────────────';
                const vouchDesc = vouchDescriptions[typeValue] || 'Robux';
                const vouchTemplate = `+vouch robux <@${adminUserId}> ${amountRobux} ${vouchDesc}`;

                const autoVouchEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('📥 Bantu Vouch! ')
                    .setDescription(`Silahkan Kirim Teks Vouch dibawah ini Ke Channel <#1488903383963406507> ya!\n${separator}\n**📱 Pengguna HP:** Tekan dan tahan teks vouch di paling bawah, Lalu pencet **Copy Text**. \n**💻 Pengguna PC:** Blok teks paling bawah lalu tekan **CTRL+C**.\n${separator}\n\n**👇 SALIN TEKS VOUCH DI BAWAH INI:**`);

                await interaction.channel.send({ embeds: [autoVouchEmbed] });
                await interaction.channel.send({ content: vouchTemplate });

                await interaction.editReply({ content: '✅ Invoice selesai! Pencatatan dan Auto-Vouch berhasil diproses.' });

                // --- PANEL STOCK: invoice sudah selesai (dibayar+autovouch) -> lepas dari tracking stock ---
                try {
                    await InvoiceTracker.deleteOne({ messageId: msgIdPart });
                    schedulePanelStockUpdate();
                } catch (e) {}

                // --- VOUCH TRACKING: pastikan tiap invoice (bukan cuma tiap ticket) butuh vouch sendiri.
                // Kalau ini invoice PERTAMA di ticket ini -> bikin record baru + tambah field ke form.
                // Kalau ini invoice KE-2/KE-3+ di ticket yang SAMA -> RESET status vouch balik ke pending
                // dan update doneAt ke waktu SEKARANG (jangan asal skip, karena vouch buat invoice
                // sebelumnya BUKAN vouch yang sama buat invoice ini). ---
                try {
                    const existingVouchDoc = await TicketVouch.findOne({ channelId: interaction.channel.id });
                    const ticketDoc = await Ticket.findOne({ channelId: interaction.channel.id });
                    const buyerId = ticketDoc ? ticketDoc.creatorId : (existingVouchDoc ? existingVouchDoc.buyerId : null);

                    if (buyerId) {
                        const formMessages = await interaction.channel.messages.fetch({ limit: 5, after: interaction.channel.id });
                        const formMsg = formMessages.find(m => m.author.id === '1490582060308369479' && m.embeds[0]?.title?.startsWith('🎫 Order Tiket'));

                        if (formMsg) {
                            const oldFormEmbed = formMsg.embeds[0];
                            const hasStatusField = oldFormEmbed.fields.some(f => f.name === '🗣️ Status Vouch');
                            const updatedFields = hasStatusField
                                ? oldFormEmbed.fields.map(f =>
                                    f.name === '🗣️ Status Vouch'
                                        ? { name: f.name, value: '⏳ Belum melakukan vouches', inline: f.inline }
                                        : f
                                  )
                                : [...oldFormEmbed.fields, { name: '🗣️ Status Vouch', value: '⏳ Belum melakukan vouches', inline: false }];
                            const newFormEmbed = EmbedBuilder.from(oldFormEmbed).setFields(updatedFields);
                            await formMsg.edit({ embeds: [newFormEmbed] });

                            if (existingVouchDoc) {
                                // Invoice ke-2/ke-3+ di ticket yang sama -> reset, bukan skip
                                existingVouchDoc.vouched = false;
                                existingVouchDoc.doneAt = new Date();
                                existingVouchDoc.messageId = formMsg.id;
                                await existingVouchDoc.save();
                            } else {
                                // Invoice pertama di ticket ini
                                await TicketVouch.create({
                                    channelId: interaction.channel.id,
                                    messageId: formMsg.id,
                                    buyerId: buyerId,
                                    vouched: false,
                                    doneAt: new Date()
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error('Gagal setup vouch tracking:', e.message);
                }

                // [UBAH NAMA CHANNEL JADI -DONE]
                if (!interaction.channel.name.endsWith('-done')) {
                    interaction.channel.setName(`${interaction.channel.name}-done`).catch(e => console.log("Abaikan: Rate limit rename (Tambah done)"));
                }

            } catch (err) {
                console.error("Invoice confirm error:", err.message);
                await interaction.editReply({ content: '❌ Terjadi error saat memproses invoice.' });
                try {
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
            const invoiceMsgId = parts[parts.length - 1];

            if (action === 'cancel') {
                await interaction.deferUpdate();
                try { await interaction.message.delete(); } catch (e) {}
                return;
            }

            // --- DONE: LANGSUNG KE KONFIRMASI YAKIN/TIDAK ---
            if (action === 'done') {
                const typeValue = parts.slice(2, -1).join('_'); // Mengambil tipe yang disisipkan dari command awal

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

                    // Langsung tampilkan Konfirmasi Yakin/Tidak (Bypass Pemilihan Tipe & Metode)
                    const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };
                    
                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`pinvf_confirm_yes_${typeValue}_${invoiceMsgId}`).setLabel('✅ Yakin').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`pinvf_cancel_${invoiceMsgId}`).setLabel('❌ Batal').setStyle(ButtonStyle.Danger)
                    );

                    const confirmEmbed = new EmbedBuilder().setColor(0xFEE75C).setTitle('⚠️ Konfirmasi Partner').setDescription(`Tipe Transaksi: **${typeNames[typeValue] || typeValue}**\n\nYakin selesaikan invoice ini?`);
                    await interaction.followUp({ embeds: [confirmEmbed], components: [confirmRow], flags: MessageFlags.Ephemeral });
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

        if (customId.startsWith('pinvf_cancel_') || customId.startsWith('pinvf_confirm_no_')) {
            await interaction.update({ content: '❌ Proses dibatalkan.', embeds: [], components: [] });
            await reEnableDonePartner(); // <--- MENGHIDUPKAN TOMBOL
            return;
        }

        // EKSEKUSI DATABASE & LOG (YAKIN)
        if (customId.startsWith('pinvf_confirm_yes_')) {
            const parts = customId.split('_');
            const typeValue = parts.slice(3, -1).join('_');
            
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

                // 1. UPDATE USER SPENDING
                let userData = await User.findOne({ userId: targetUserId });
                if (!userData) userData = new User({ userId: targetUserId });
                userData.uangMasuk += totalHarga;
                await userData.save();

                // 2. UPDATE KEUANGAN PARTNER
                let partnerData = await Partner.findOne({ partnerId: interaction.user.id });
                if (!partnerData) partnerData = new Partner({ partnerId: interaction.user.id });
                partnerData.totalUangMasuk += totalHarga;
                await partnerData.save();

                const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
                await updateSpenderRoles(targetMember, userData);
                scheduleLiveLeaderboardUpdate();

                // 3. EDIT INVOICE JADI HIJAU
                const doneEmbed = EmbedBuilder.from(invoiceEmbed).setColor(0x57F287).setFooter({ text: '✅ Partner Invoice Selesai' });
                await invoiceMsg.edit({ embeds: [doneEmbed], components: [] });

                // 4. KIRIM LOG PARTNER
                const partnerFinanceId = '1519075561396371647';
                let pembeliDisplay = `<@${targetUserId}>`;
                if (targetMember) pembeliDisplay += `\n(${targetMember.displayName})`;
                
                const typeNames = { 'community': 'Community', 'gamepass_after': 'Gamepass After', 'gamepass_before': 'Gamepass Before', 'gig': 'GIG', 'vilog': 'Vilog', 'robux_plus': 'Robux Plus' };

                const historyEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('🤝 Uang Masuk Partner Dicatat!')
                    .addFields(
                        { name: '🧑‍💼 Partner', value: `<@${interaction.user.id}>\n(${interaction.user.displayName} • @${interaction.user.username})`, inline: true },
                        { name: '👤 Pembeli', value: pembeliDisplay, inline: true },
                        { name: '💰 Nominal', value: `**Rp ${formatRupiah(totalHarga)}**`, inline: true },
                        { name: '🛒 Kategori', value: `${typeNames[typeValue] || typeValue.toUpperCase()}`, inline: true }, // HANYA TIPE TRANSAKSI
                        { name: '📊 Total Spent Pembeli', value: `**Rp ${formatRupiah(userData.uangMasuk)}**`, inline: false }
                    )
                    .setTimestamp();

                try {
                    const financeChannel = await client.channels.fetch(partnerFinanceId);
                    if (financeChannel) await financeChannel.send({ embeds: [historyEmbed] });
                } catch (e) { console.error("Gagal kirim log partner:", e.message); }

                // 5. AUTO VOUCH
                const vouchDescriptions = { 'community': 'Robux Payout Instant', 'vilog': 'Robux Via Login', 'gamepass_after': 'Robux Gamepass After', 'gamepass_before': 'Robux Gamepass Before', 'gig': 'Robux Gift in-Game', 'robux_plus': 'Robux Via Send Username' };
                const vouchDesc = vouchDescriptions[typeValue] || 'Robux';
                const vouchTemplate = `+vouch robux <@${interaction.user.id}> ${amountRobux} ${vouchDesc}`;

                const separator = '──────────────────────────────';
                const autoVouchEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('📥 Bantu Vouch! ')
                    .setDescription(`Silahkan Kirim Teks Vouch dibawah ini Ke Channel <#1488903383963406507> ya!\n${separator}\n**📱 Pengguna HP:** Tekan dan tahan teks vouch di paling bawah, Lalu pencet **Copy Text**. \n**💻 Pengguna PC:** Blok teks paling bawah lalu tekan **CTRL+C**.\n${separator}\n\n**👇 SALIN TEKS VOUCH DI BAWAH INI:**`);

                await interaction.channel.send({ embeds: [autoVouchEmbed] });
                await interaction.channel.send({ content: vouchTemplate });

                await interaction.editReply({ content: '✅ Transaksi Partner selesai!' });

                // [UBAH NAMA CHANNEL JADI -DONE]
                if (!interaction.channel.name.endsWith('-done')) {
                    interaction.channel.setName(`${interaction.channel.name}-done`).catch(e => console.log("Abaikan: Rate limit rename (Tambah done)"));
                }

            } catch (err) {
                console.error("Partner Invoice error:", err);
                await interaction.editReply({ content: '❌ Terjadi error sistem.' });
            } finally {
                isUpdating.delete(`pinv_done_${invoiceMsgId}`);
            }
            return;
        }
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

        await interaction.deferReply();

        try {
            const rawAmount = interaction.options.getString('amount');
            const amount = parseAmount(rawAmount);
            if (isNaN(amount) || amount <= 0) {
                return interaction.editReply({ content: '❌ Nominal Robux tidak valid! Pastikan hanya memakai angka dan titik (contoh: 55.000).' });
            }

            const rawDate = interaction.options.getString('tanggal_masuk');
            const masukDate = parseRestockDate(rawDate);
            if (!masukDate) {
                return interaction.editReply({ content: '❌ Format tanggal salah/tidak ada! Gunakan format: `DD-MM-YYYY HH:MM` (contoh: `02-08-2026 17:00`).' });
            }

            const rawCommunity = interaction.options.getString('community');
            const communities = parseCommunityNumbers(rawCommunity);
            if (communities.length === 0) {
                const validNums = Object.keys(RESTOCK_COMMUNITIES).join(', ');
                return interaction.editReply({ content: `❌ Nomor community tidak valid! Nomor yang tersedia: ${validNums}. Contoh input: \`1,3\`.` });
            }

            // Restock READY = tanggal masuk + 5 hari, jam yang sama
            const arrivalTimestamp = new Date(masukDate.getTime() + (5 * 24 * 60 * 60 * 1000));

            const restockDoc = new Restock({
                channelId: interaction.channel.id,
                guildId: interaction.guild.id,
                amount,
                communities,
                arrivalTimestamp,
                createdBy: interaction.user.id,
                messageId: 'pending' // diisi sebentar lagi setelah pesan terkirim
            });

            const previewEmbed = buildRestockPendingEmbed(restockDoc);

            await interaction.editReply({
                content: '@everyone',
                embeds: [previewEmbed],
                allowedMentions: { parse: ['everyone'] }
            });
            const replyMessage = await interaction.fetchReply();

            restockDoc.messageId = replyMessage.id;
            await restockDoc.save();
        } catch (err) {
            console.error('Gagal menjalankan /restock:', err);
            return interaction.editReply({ content: '❌ Waduh, gagal bikin restock countdown. Coba lagi ya (cek log kalau masih gagal).' }).catch(() => {});
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
            .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1549162963695444079/qr_ID1026513310379_15.09.26_1789418946_1789418947032.jpg?ex=6aa9b1f0&is=6aa86070&hm=dafc1f013d11eb285bb37728fa7551a10fca68da44cc07530fba82e43d0ad6cb&')
            .setFooter({ text: 'VibeBlox Payment' })
            .setTimestamp();

        return interaction.editReply({ embeds: [qrisEmbed] });
    }
    // --- BCA ---
    if (command === 'bca') {
        const allowedRolesBca = ['1489612423521374309', '1489612221544665231'];
        if (!interaction.member?.roles?.cache) {
            // Data member/role belum ke-cache penuh -> jangan crash, kasih tau user coba lagi
            return interaction.reply({ content: '❌ Gagal verifikasi role kamu, coba lagi ya.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
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
        
        const omenEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('💳 Pembayaran QRIS Omen')
            .setDescription('Silakan scan QRIS di bawah ini untuk melakukan pembayaran.')
            .setImage('https://cdn.discordapp.com/attachments/1500317839507062897/1519107554628866222/1782216403987.png?ex=6a3c5aa8&is=6a3b0928&hm=ecb4cbd02fa9f76838f2df9726a5facb4b83dc2c204e67922991046266a1dcca&')
            .setFooter({ text: 'Omen Partner Payment' })
            .setTimestamp();

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

// --- CEK ELIGIBLE (ANTREAN OTOMATIS, CACHING & DYNAMIC EMBED) ---
    if (command === 'cek-eligible') {
        // 0. LARANGAN CHANNEL — tidak boleh dipakai di channel chit-chat
        const chitChatChannelId = '1488782137149624442';
        const botCmdChannelId = '1504349336559947818';
        if (interaction.channel.id === chitChatChannelId) {
            return interaction.reply({ content: `❌ Command ini tidak bisa dipakai di sini. Silakan gunakan di <#${botCmdChannelId}>.`, flags: MessageFlags.Ephemeral });
        }

        const targetUsername = interaction.options.getString('username').trim();
        const cacheKey = targetUsername.toLowerCase();

        // 1. CACHE: username yang baru saja dicek langsung dijawab (tanpa antre, tanpa menyentuh akun dummy)
        const cachedData = eligibilityCache.get(cacheKey);
        if (cachedData) {
            if (Date.now() - cachedData.timestamp < (cachedData.ttl || 3600000)) {
                const cachedEmbed = EmbedBuilder.from(cachedData.embed)
                    .setFooter({ text: 'Roblox Eligibility Checker • (Data Cached)' });
                return interaction.reply({ embeds: [cachedEmbed] });
            }
            eligibilityCache.delete(cacheKey);
        }

        // 2. MASUK ANTREAN — menggantikan pesan "tunggu X detik" & "mohon antre".
        //    Pelanggan cukup 1x ketik command, hasilnya muncul otomatis saat gilirannya tiba.
        await enqueueCustomerCheck({
            interaction,
            kind: 'elig',
            label: targetUsername,
            dedupeKey: `elig:${cacheKey}`,
            cooldownKey: `elig_${interaction.user.id}`,
            cooldownMs: 5000, // jeda 5 detik antar pengecekan dari orang yang sama (keamanan akun dummy dijaga antrean global)
            run: () => runEligibilityCheck(targetUsername, cacheKey)
        });
        return;
    }

    // --- CEK TRANSAKSI PAYOUT (ANTREAN OTOMATIS) ---
    if (command === 'cek-transaksi') {
        const targetUsername = interaction.options.getString('username').trim();
        const cacheKey = `tx_${targetUsername.toLowerCase()}`;

        // CACHE 15 menit — username yang sama langsung dijawab tanpa antre
        const cached = transaksiCache.get(cacheKey);
        if (cached) {
            if (Date.now() - cached.timestamp < 900000) {
                const cachedEmbed = EmbedBuilder.from(cached.embed).setFooter({ text: 'Roblox Transaction Checker • (Data Cached)' });
                return interaction.reply({ embeds: [cachedEmbed] });
            }
            transaksiCache.delete(cacheKey);
        }

        // ANTREAN BERSAMA /cek-eligible — akun dummy tidak pernah dipakai 2 proses bersamaan
        const requesterTag = interaction.user.tag;
        await enqueueCustomerCheck({
            interaction,
            kind: 'tx',
            label: targetUsername,
            dedupeKey: `tx:${targetUsername.toLowerCase()}`,
            cooldownKey: `tx_${interaction.user.id}`,
            cooldownMs: 20000, // jeda 20 detik (cek transaksi jauh lebih berat: bisa ratusan request)
            run: () => runTransactionCheck(targetUsername, cacheKey, requesterTag)
        });
        return;
    }
    
       if (command === 'linkcommunity') {
        const allowedRolesLinkCommunity = ['1489612423521374309', '1489612221544665231', '1519076541055897670']; // Owner, Handler, Partner
        const hasRoleLinkCommunity = interaction.member.roles.cache.some(role => allowedRolesLinkCommunity.includes(role.id));
        if (!hasRoleLinkCommunity) {
            return interaction.reply({ content: '❌ Sori, command ini khusus Owner, Handler, dan Partner.', flags: MessageFlags.Ephemeral });
        }

        if (linkCommunityActive) {
            return interaction.reply({ content: '⏳ Command ini sedang digunakan oleh user lain. Coba lagi nanti.', flags: MessageFlags.Ephemeral });
        }
        linkCommunityActive = true;

        await interaction.deferReply();

        await interaction.editReply({
            content: '**Link Grup Komunitas:**\nKomunitas 1:\nhttps://www.roblox.com/communities/1064667246/BEJIRLAH-Community\n\nKomunitas 2:\nhttps://www.roblox.com/id/communities/1108229986/Vandamoy\n\nKomunitas 3:\nhttps://www.roblox.com/communities/653724099/Maycomn\n\nKomunitas 4:\nhttps://www.roblox.com/id/communities/617301345/VibeBlox-Community\n\n',
            flags: MessageFlags.SuppressEmbeds
        });
        linkCommunityActive = false;
        return;
    }

// --- ROBUX CALCULATOR ---
        if (command === 'robux') {
        await interaction.deferReply();

        const type = interaction.options.getString('type');
        const amount = interaction.options.getInteger('amount');

        if (amount <= 0) {
            return interaction.editReply({ content: '❌ Jumlah Robux harus lebih dari 0!' });
        }

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
            for (const menu of storeData.menuMessages) {
                if (menu.type === type) {
                    try {
                        const channel = await client.channels.fetch(menu.channelId);
                        const msg = await channel.messages.fetch(menu.messageId);
                        
                        const newEmbed = buildMenuEmbed(type, newRate);
                        await msg.edit({ embeds: [newEmbed] });
                        
                        updatedCount++;
                        validMessages.push(menu); 
                    } catch (e) {
                        // Abaikan jika pesan dihapus manual di Discord
                    }
                } else {
                    validMessages.push(menu); 
                }
            }
            
            storeData.menuMessages = validMessages;
            storeData.markModified('menuMessages');
            await storeData.save();
        }

        let rateDescription = type === 'vilog' ? `Rp ${formatRupiah(oldRate)} → **Rp ${formatRupiah(newRate)}** /500 Robux` : `Rp ${formatRupiah(oldRate)} → **Rp ${formatRupiah(newRate)}** /1 Robux`;

        const updateEmbed = new EmbedBuilder().setColor(0x57F287).setTitle('✅ Rate Harga Robux Diperbarui!').addFields({ name: '📦 Tipe', value: `**${typeNames[type]}**`, inline: true }, { name: '💱 Perubahan Rate', value: rateDescription, inline: false }, { name: '🔄 Live Menu Sync', value: `Berhasil mengupdate **${updatedCount}** post menu di server.`, inline: false }).setFooter({ text: 'VibeBlox Rate Manager' }).setTimestamp();
        
        return interaction.editReply({ embeds: [updateEmbed] });
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

    // ==================================================
    // --- COMMAND: PRE-ORDER ---
    // ==================================================
    if (command === 'pre-order') {
        const allowedRolesPO = ['1489612423521374309', '1489612221544665231']; // Owner, Handler
        const hasRolePO = interaction.member.roles.cache.some(role => allowedRolesPO.includes(role.id));
        if (!hasRolePO) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        // Wajib dipakai di dalam channel ticket, sama seperti /invoice
        const allowedTicketCategoriesPO = TICKET_CATEGORY_IDS; 
        if (!allowedTicketCategoriesPO.includes(interaction.channel.parentId)) {
            return interaction.reply({ content: '❌ Perintah pre-order hanya bisa digunakan di dalam channel Ticket!', flags: MessageFlags.Ephemeral });
        }

        if (interaction.channel.name.endsWith('-po')) {
            return interaction.reply({ content: '⚠️ Channel ini **sudah** ditandai Pre-Order.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply(); // cegah interaction expired (>3 detik) kalau proses rename lambat

        const newNamePO = `${interaction.channel.name}-po`;

        try {
            await interaction.channel.setName(newNamePO);
            await interaction.editReply({ content: `✅ Channel ditandai sebagai **Pre-Order** — nama diganti jadi \`${newNamePO}\`.` });
        } catch (err) {
            console.log('Abaikan/Info: Gagal rename channel (Tambah -po), kemungkinan kena rate limit Discord (maks 2x rename/10 menit).', err.message);
            await interaction.editReply({ content: '⚠️ Gagal ganti nama channel — kemungkinan kena rate limit Discord (channel cuma boleh di-rename maks 2x per 10 menit). Coba lagi sebentar.' });
        }
        return;
    }

    // ==================================================
    // --- COMMAND: EDIT FORM TIKET ---
    // ==================================================
    if (command === 'editform') {
        const allowedRolesEditForm = ['1489612423521374309', '1489612221544665231', '1519076541055897670']; // Owner, Handler, Partner
        if (!interaction.member.roles.cache.some(r => allowedRolesEditForm.includes(r.id))) {
            return interaction.reply({ content: '❌ Command ini khusus Owner, Handler, dan Partner.', flags: MessageFlags.Ephemeral });
        }

        const allowedCategoriesEditForm = TICKET_CATEGORY_IDS;
        if (!allowedCategoriesEditForm.includes(interaction.channel.parentId)) {
            return interaction.reply({ content: '❌ Command ini cuma bisa dipakai di dalam channel tiket!', flags: MessageFlags.Ephemeral });
        }

        const newUsername = interaction.options.getString('username');
        const newRobux = interaction.options.getInteger('robux');

        if (!newUsername && newRobux === null) {
            return interaction.reply({ content: '❌ Isi minimal salah satu: `username` atau `robux`.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const messages = await interaction.channel.messages.fetch({ limit: 5, after: interaction.channel.id });
            const formMsg = messages.find(m => m.author.id === '1490582060308369479' && m.embeds[0]?.title?.startsWith('🎫 Order Tiket'));

            if (!formMsg) {
                return interaction.editReply({ content: '❌ Form tiket tidak ditemukan di channel ini (bukan channel tiket, atau form-nya sudah dihapus).' });
            }

            const oldEmbed = formMsg.embeds[0];
            let usernameFound = false, robuxFound = false;
            const fields = oldEmbed.fields.map(f => {
                if (newUsername && f.name.includes('Username Roblox')) {
                    usernameFound = true;
                    return { name: f.name, value: `\`${newUsername}\``, inline: f.inline };
                }
                if (newRobux !== null && f.name.includes('Jumlah Robux')) {
                    robuxFound = true;
                    return { name: f.name, value: `**${newRobux} R$**`, inline: f.inline };
                }
                return f;
            });

            if (newUsername && !usernameFound) {
                return interaction.editReply({ content: '❌ Field "Username Roblox" tidak ditemukan di form tiket ini (tipe tiket ini mungkin tidak punya field tersebut).' });
            }
            if (newRobux !== null && !robuxFound) {
                return interaction.editReply({ content: '❌ Field "Jumlah Robux" tidak ditemukan di form tiket ini (tipe tiket ini mungkin tidak punya field tersebut).' });
            }

            const newEmbed = EmbedBuilder.from(oldEmbed).setFields(fields);
            await formMsg.edit({ embeds: [newEmbed] });

            const changes = [];
            if (newUsername) changes.push(`Username Roblox → \`${newUsername}\``);
            if (newRobux !== null) changes.push(`Jumlah Robux → **${newRobux} R$**`);

            return interaction.editReply({ content: `✅ Form tiket berhasil diupdate:\n${changes.join('\n')}` });
        } catch (err) {
            console.error('Gagal editform:', err.message);
            return interaction.editReply({ content: '❌ Gagal update form tiket. Coba lagi.' });
        }
    }

    // ==================================================
    // --- COMMAND: PANEL STOCK ---
    // ==================================================
    if (command === 'panelstock') {
        const roleVibeOwner = '1489612423521374309'; // Owner
        if (!interaction.member.roles.cache.has(roleVibeOwner)) {
            return interaction.reply({ content: '❌ Command ini khusus role Vibe Owner.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        // Hapus panel lama + semua pesan lanjutannya (biar cuma 1 panel aktif, tidak ada yang tertinggal double-update)
        try {
            const oldPanel = await PanelStock.findOne();
            if (oldPanel) {
                try {
                    const oldChannel = await client.channels.fetch(oldPanel.channelId).catch(() => null);
                    if (oldChannel) {
                        await oldChannel.messages.delete(oldPanel.messageId).catch(() => {});
                        for (const id of (oldPanel.extraMessageIds || [])) {
                            await oldChannel.messages.delete(id).catch(() => {});
                        }
                    }
                } catch (e) {}
                await PanelStock.deleteMany({});
            }
        } catch (e) {
            console.error('Gagal bersihkan panel stock lama:', e.message);
        }

        const pages = await buildPanelStockPages();
        await interaction.editReply({ embeds: [pages[0]] });
        const panelMsg = await interaction.fetchReply();

        await PanelStock.create({
            messageId: panelMsg.id,
            channelId: interaction.channel.id,
            guildId: interaction.guild.id,
            extraMessageIds: []
        });

        // Kalau tiket banyak, pesan lanjutan dibuat otomatis oleh update berikutnya
        if (pages.length > 1) schedulePanelStockUpdate();
        return;
    }
    
    // ==================================================
    // --- COMMAND: INVOICE (UTAMA) ---
    // ==================================================
    if (command === 'invoice') {
        const allowedRolesInvoice = ['1489612423521374309', '1489612221544665231'];
        const hasRoleInvoice = interaction.member.roles.cache.some(role => allowedRolesInvoice.includes(role.id));
        if (!hasRoleInvoice) {
            return interaction.reply({ content: '❌ Sori, cuma Owner dan Handler yang bisa pakai command ini.', flags: MessageFlags.Ephemeral });
        }

        // [VALIDASI TICKET CATEGORY & RENAME LOGIC]
        const allowedTicketCategories = TICKET_CATEGORY_IDS; // ID Kategori Utama, Backup & Backup 2
        if (!allowedTicketCategories.includes(interaction.channel.parentId)) {
            return interaction.reply({ content: '❌ Perintah invoice hanya bisa digunakan di dalam channel Ticket!', flags: MessageFlags.Ephemeral });
        }

        if (interaction.channel.name.endsWith('-done')) {
            const newName = interaction.channel.name.replace('-done', '');
            interaction.channel.setName(newName).catch(err => console.log('Abaikan: Rate limit rename (Hapus done)'));
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

        // Ambil ID pesan invoice DULU (pesan "VibeBlox is thinking..." dari deferReply),
        // lalu embed + tombol dikirim SEKALIGUS dalam 1 edit -> tidak ada lagi invoice tanpa tombol.
        let invoiceMsgId;
        try {
            invoiceMsgId = (await discordRetry(() => interaction.fetchReply())).id;
        } catch (e) {
            console.error('Gagal ambil ID pesan invoice:', e.message);
            await interaction.deleteReply().catch(() => {});
            return interaction.followUp({ content: '❌ Invoice gagal dibuat karena gangguan koneksi Discord. Silakan jalankan `/invoice` lagi.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inv_bca_${invoiceMsgId}`).setLabel('BCA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_qris_${invoiceMsgId}`).setLabel('QRIS').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_dana_${invoiceMsgId}`).setLabel('DANA').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`inv_gopay_${invoiceMsgId}`).setLabel('GOPAY').setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inv_cancel_${invoiceMsgId}`).setLabel('❌ Close').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`inv_done_${type}_${invoiceMsgId}`).setLabel('✅ Done').setStyle(ButtonStyle.Success)
        );

        const invoiceSent = await sendInvoiceMessage(interaction, invoiceMsgId, { embeds: [invoiceEmbed], components: [row1, row2] }, '/invoice');
        if (!invoiceSent) return; // gagal total -> pesan sudah dihapus & staf sudah diberi tahu, jangan dicatat ke panel

        // --- PANEL STOCK: catat invoice ini kalau tipenya Community ---
        if (type === 'community') {
            try {
                await InvoiceTracker.create({
                    messageId: invoiceMsgId,
                    channelId: interaction.channel.id,
                    channelName: interaction.channel.name,
                    amount: amount,
                    createdBy: interaction.user.id
                });
                schedulePanelStockUpdate();
            } catch (e) {
                console.error('Gagal catat InvoiceTracker:', e.message);
            }
        }

        return;
    }

    // ==================================================
    // --- COMMAND: PARTNER INVOICE ---
    // ==================================================
    if (command === 'partnerinvoice') {
        const rolePartnerId = '1519076541055897670';
        if (!interaction.member.roles.cache.has(rolePartnerId)) {
            return interaction.reply({ content: '❌ Sori, cuma role Partner yang bisa bikin invoice ini.', flags: MessageFlags.Ephemeral });
        }
        
        // [VALIDASI TICKET CATEGORY & RENAME LOGIC]
        const allowedTicketCategories = TICKET_CATEGORY_IDS; // ID Kategori Utama, Backup & Backup 2
        if (!allowedTicketCategories.includes(interaction.channel.parentId)) {
            return interaction.reply({ content: '❌ Perintah invoice hanya bisa digunakan di dalam channel Ticket!', flags: MessageFlags.Ephemeral });
        }

        if (interaction.channel.name.endsWith('-done')) {
            const newName = interaction.channel.name.replace('-done', '');
            interaction.channel.setName(newName).catch(err => console.log('Abaikan: Rate limit rename (Hapus done)'));
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
            .setColor(0xFFA500) 
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

        // Ambil ID pesan DULU, lalu embed + tombol dikirim SEKALIGUS dalam 1 edit -> tidak ada lagi invoice tanpa tombol.
        let msgId;
        try {
            msgId = (await discordRetry(() => interaction.fetchReply())).id;
        } catch (e) {
            console.error('Gagal ambil ID pesan partner invoice:', e.message);
            await interaction.deleteReply().catch(() => {});
            return interaction.followUp({ content: '❌ Invoice gagal dibuat karena gangguan koneksi Discord. Silakan jalankan `/partnerinvoice` lagi.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pinv_cancel_${msgId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`pinv_done_${type}_${msgId}`).setLabel('✅ Done').setStyle(ButtonStyle.Success)
        );

        await sendInvoiceMessage(interaction, msgId, { embeds: [invoiceEmbed], components: [row] }, '/partnerinvoice');
        return;
    }

    // ==================================================
    // --- SECURITY FILTER UNTUK COMMAND KEUANGAN ---
    // ==================================================
    const allowedChannels = ['1489665490770067678', '1519075561396371647', '1544599293451833444'];
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
            const sumber = interaction.options.getString('sumber'); 
            const kategori = interaction.options.getString('keterangan') || 'Tidak ada kategori';

            if (isNaN(amount) || amount <= 0) {
                return interaction.reply({ content: '❌ Nominal tidak valid! Pastikan hanya menggunakan angka dan titik (contoh: 50.000).', flags: MessageFlags.Ephemeral });
            }

            let userData = await User.findOne({ userId: target.id });
            if (!userData) userData = new User({ userId: target.id });

            let embed;

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

// === GLOBAL ERROR HANDLER ===
// Mencegah SATU error kecil (misal gagal fetch member) mematikan SELURUH bot.
// Tanpa ini, sejak Node.js v15+, unhandled promise rejection = proses mati total.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

client.login(process.env.TOKEN);

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot VibeBlox lagi nongkrong 24/7 nih!'));
app.listen(port);
