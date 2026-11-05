const mongoose = require('mongoose');

// Status pembayaran tiap invoice utama (/invoice & draft): kode unik, bukti bayar, antrean verifikasi.
const InvoiceRecordSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true }, // 'tmp:<id>' sebentar sebelum pesan invoice terkirim
    channelId: { type: String, required: true, index: true },
    buyerId: { type: String, default: null },
    type: { type: String, default: null },
    robux: { type: Number, default: 0 },
    price: { type: Number, default: 0 },          // harga sebelum kode unik
    kodeUnik: { type: Number, default: 0 },
    total: { type: Number, default: 0 },          // harga + kode unik (= Total Bayar di invoice)
    codeActive: { type: Boolean, default: false }, // kode unik sedang dipakai (unik di antara invoice aktif)
    status: { type: String, default: 'open', index: true }, // open | waiting | done | cancelled
    proofAt: { type: Date, default: null },
    proofMessageId: { type: String, default: null },
    proofUrl: { type: String, default: null },
    closedAt: { type: Date, default: null }
}, { timestamps: true });

// Kode unik tidak boleh sama di antara invoice yang masih aktif
InvoiceRecordSchema.index({ kodeUnik: 1 }, { unique: true, partialFilterExpression: { codeActive: true } });

module.exports = mongoose.model('InvoiceRecord', InvoiceRecordSchema);
