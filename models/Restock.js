const mongoose = require('mongoose');

const RestockSchema = new mongoose.Schema({
    messageId: { type: String, required: true },
    channelId: { type: String, required: true },
    guildId: { type: String },
    amount: { type: Number, required: true },       // jumlah Robux
    communities: { type: [Number], required: true }, // contoh: [1, 3]
    arrivalTimestamp: { type: Date, required: true }, // waktu robux READY (input + 5 hari)
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    // Penanda EKSPLISIT terpisah dari `status`, khusus buat cegah pengumuman "RESTOCK SELESAI"
    // kekirim lebih dari sekali. Begitu true, GAK ADA jalur manapun di kode yang boleh kirim
    // pengumuman lagi untuk restock ini, walau `status` sempat berubah/direset manual di DB.
    announcementSent: { type: Boolean, default: false },
    createdBy: { type: String },
    // Stok restock ini sudah HABIS terjual lewat Pre-Order (/restock-sold) -> tampilan "SOLD OUT",
    // tombol Ingatkan Saya dimatikan, pengingat DM dibatalkan, pengumuman @everyone saat ready TIDAK dikirim
    soldOut: { type: Boolean, default: false },
    soldOutAt: { type: Date, default: null },
    // Gambar "Dana Grup" di pengumuman READY: kalau saat countdown selesai saldo grup BELUM terisi
    // (Robux telat masuk), gambar ditambahkan belakangan begitu saldonya sudah masuk (maks 24 jam).
    announceMessageId: { type: String, default: null },
    imagePending: { type: Boolean, default: false },
    imageDeadline: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Restock', RestockSchema);
