const mongoose = require('mongoose');

// Tombol "Ingatkan Saya": restock (jadwal dari /restock) atau saat tiket Community dibuka lagi.
const StockReminderSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    target: { type: String, required: true },     // messageId restock | 'community_open'
    offsets: { type: [String], default: [] },     // d1 | h1 | m10 | ready | open
    sent: { type: [String], default: [] }
}, { timestamps: true });
StockReminderSchema.index({ userId: 1, target: 1 }, { unique: true });

module.exports = mongoose.model('StockReminder', StockReminderSchema);
