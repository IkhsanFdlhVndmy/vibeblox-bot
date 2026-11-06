const mongoose = require('mongoose');

// Robux yang "dipesan" lewat form tiket Community saat mode War (Ketat).
// Dihitung sampai dibatalkan (tiket ditutup tanpa Done). Yang sudah Done tetap terhitung (Robux-nya sudah terjual).
const WarReservationSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },   // id interaksi form (sebelum channel ada)
    session: { type: Number, required: true, index: true }, // sesi War (waktu mulai, ms)
    channelId: { type: String, default: null, index: true },
    userId: { type: String, default: null },
    robux: { type: Number, required: true },
    done: { type: Boolean, default: false },
    released: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('WarReservation', WarReservationSchema);
