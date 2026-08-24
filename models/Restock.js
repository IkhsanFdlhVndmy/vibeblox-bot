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
    createdBy: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Restock', RestockSchema);
