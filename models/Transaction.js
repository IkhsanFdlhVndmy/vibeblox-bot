const mongoose = require('mongoose');

// Catatan transaksi SATU PER SATU (untuk /riwayat & laporan).
// key unik = pengaman: 1 invoice hanya bisa tercatat 1x walau tombol Done ditekan 2x / bot restart.
const TransactionSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // inv:<msgId> | pinv:<msgId> | man:<id> | exp:<id> | imp:<msgId>
    source: { type: String, required: true },            // invoice | partner | manual | expense | import
    direction: { type: Number, default: 1 },              // 1 = uang masuk / pengeluaran, -1 = revisi (dikurangi)
    buyerId: { type: String, default: null, index: true },
    buyerName: { type: String, default: null, index: true }, // username (huruf kecil) — untuk data lama yang tidak punya ID
    amount: { type: Number, default: 0 },                 // Rupiah (selalu positif, arah lihat direction)
    robux: { type: Number, default: null },
    type: { type: String, default: null },                // community | gamepass_after | ... | null
    category: { type: String, default: null },            // teks kategori asli (mis. "Community - QRIS")
    method: { type: String, default: null },              // qris | bca | dana | gopay | lainnya
    sumber: { type: String, default: 'utama' },           // utama | partner
    channelId: { type: String, default: null },
    channelName: { type: String, default: null },
    staffId: { type: String, default: null },
    partnerId: { type: String, default: null },
    kodeUnik: { type: Number, default: 0 },
    isPreOrder: { type: Boolean, default: false },
    poOutstanding: { type: Boolean, default: false },     // PO sudah dibayar tapi Robux belum terkirim
    legacy: { type: Boolean, default: false },            // hasil impor dari log lama
    note: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('Transaction', TransactionSchema);
