const mongoose = require('mongoose');

// Penyimpanan kecil serbaguna (pengaturan fitur, posisi impor, jadwal laporan, dll) — tahan restart.
const BotStateSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

module.exports = mongoose.model('BotState', BotStateSchema);
