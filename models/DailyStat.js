const mongoose = require('mongoose');

// Penghitung kejadian harian (tiket dibuka/ditutup, invoice dibatalkan, vouch, dll) untuk laporan.
const DailyStatSchema = new mongoose.Schema({
    day: { type: String, required: true, unique: true }, // YYYY-MM-DD (WIB)
    counters: { type: Map, of: Number, default: {} }
});

module.exports = mongoose.model('DailyStat', DailyStatSchema);
