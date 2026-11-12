// =====================================================================
// PENGATURAN FITUR BARU VIBEBLOX (ubah angka di sini kalau perlu)
// Saklar ON/OFF tiap fitur bisa diubah langsung dari Discord: /pengaturan
// =====================================================================
const ROLE_OWNER = '1489612423521374309';
const ROLE_HANDLER = '1489612221544665231';
const ROLE_PARTNER = '1519076541055897670';

module.exports = {
    ROLE_OWNER,
    ROLE_HANDLER,
    ROLE_PARTNER,
    STAFF_ROLES: [ROLE_OWNER, ROLE_HANDLER, ROLE_PARTNER],
    INVOICE_ROLES: [ROLE_OWNER, ROLE_HANDLER],       // yang boleh membuat / menyelesaikan invoice utama
    PING_ROLES: [ROLE_OWNER, ROLE_HANDLER],          // di-ping untuk verifikasi pembayaran & alarm

    CHANNEL_LAPORAN: '1567724447824093244',
    CHANNEL_VERIFIKASI: '1567723986262036650',
    CHANNEL_ALARM: '1567724076460417095',
    // Channel tempat buka tiket (dipakai di pengumuman restock READY). Kosong = dicari otomatis dari nama channel "open-ticket".
    CHANNEL_OPEN_TICKET: '',
    // Channel log keuangan lama (dibaca 1x untuk mengisi /riwayat)
    FINANCE_CHANNELS: ['1489665490770067678', '1519075561396371647', '1544599293451833444'],

    // --- STOK COMMUNITY ---
    STOCK_RESERVE: 1000,          // saldo minimal yang WAJIB tersisa di tiap community
    ELIGIBLE_FRESH_WAIT_MS: 6000, // cek eligible: maks menunggu daftar join diperbarui (yang baru join) sebelum 'sedang dimuat'
    WAR_STOP_REMAINING: 5000,
    WAR_MAX_ORDER: 100000,        // War Community: form di atas ini dianggap salah ketik & ditolak (mode lain tanpa batas)
    WAR_RESUME_HOURS: 6,          // /buttonticket War dalam X jam sejak War terakhir dimulai = lanjut; lebih lama = War BARU     // War Community: tiket ditolak & tombol ditutup kalau stok tersisa tinggal segini
    STOCK_LOW: 2000,              // di bawah ini = menipis -> alarm & jangan beri invoice dari community ini

    // --- ASISTEN PAYOUT ---
    PAYOUT_CAP: 9999,             // maks Robux ke 1 username dari 1 community
    PAYOUT_WINDOW_DAYS: 10,       // total payout 10 hari terakhir ke username itu dari community itu dihitung ke batas 9.999 (lewat = pending)

    // --- KODE UNIK (ditambahkan ke Total Bayar) ---
    KODE_UNIK_MIN: 1,
    KODE_UNIK_MAX: 99,            // kalau 1-99 sedang terpakai semua, otomatis pakai 100-299

    // --- QRIS (isi kode QRIS statis VibeBlox, Dana Bisnis, NMID ID1026513310379) ---
    QRIS_PAYLOAD: '00020101021126570011ID.DANA.WWW011893600915302422717302090242271730303UMI51440014ID.CO.QRIS.WWW0215ID10265133103790303UMI5204594553033605802ID5908VibeBlox6012Kota Cilegon61054242363040955',
    QRIS_NMID: 'ID1026513310379',
    QRIS_MERCHANT_NAME: 'VibeBlox',
    // Total >= ini: QRIS STATIS (yang lama, nominal diketik pembeli) — sama dengan batas QRIS lama 300k (pembeli luar negeri)
    QRIS_NOMINAL_LIMIT: 300000,

    // --- TIKET TANPA KABAR ---
    IDLE_TICKET_MS: 12 * 60 * 60 * 1000,      // 12 jam tanpa pesan & tanpa invoice -> diingatkan
    IDLE_CLOSE_AFTER_WARN_MS: 60 * 60 * 1000, // 1 jam setelah diingatkan tetap diam -> ditutup (dengan transcript)

    // --- LAPORAN ---
    REPORT_HOUR: 23,
    REPORT_MINUTE: 59,

    // Saklar default (bisa diubah lewat /pengaturan, tersimpan di database)
    DEFAULT_SETTINGS: {
        eligible_tiket: true,     // cek eligible otomatis saat tiket Community dibuka
        batas_username: true,     // 1 username Roblox = 1 tiket Community aktif
        draft_invoice: true,      // draft invoice dari form tiket
        kode_unik: true,          // kode unik di Total Bayar
        qris_otomatis: false,     // QRIS bernominal otomatis (aktifkan setelah uji bayar Rp 1.000)
        antrean_bayar: true,      // antrean "Sudah Bayar" di #verifikasi-pembayaran
        asisten_payout: true,     // rencana & verifikasi payout Community
        ingatkan_saya: true,      // tombol Ingatkan Saya (restock / Community dibuka)
        tiket_mati: true,         // tutup otomatis tiket tanpa kabar 12 jam
        laporan: true,            // laporan harian / mingguan / bulanan
        alarm: true               // alarm di #alarm-bot
    },
    SETTING_LABELS: {
        eligible_tiket: 'Cek eligible saat buka tiket Community',
        batas_username: '1 username Roblox = 1 tiket Community',
        draft_invoice: 'Draft invoice otomatis',
        kode_unik: 'Kode unik di Total Bayar',
        qris_otomatis: 'QRIS bernominal otomatis',
        antrean_bayar: 'Antrean "Sudah Bayar"',
        asisten_payout: 'Asisten payout Community',
        ingatkan_saya: 'Tombol Ingatkan Saya',
        tiket_mati: 'Tutup tiket tanpa kabar (12 jam)',
        laporan: 'Laporan harian/mingguan/bulanan',
        alarm: 'Alarm #alarm-bot'
    }
};
