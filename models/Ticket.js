const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    channelId: { type: String, required: true },
    creatorId: { type: String, required: true },
    claimedBy: { type: String, default: null },
    ticketType: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    // Pre-Order: tiket ini TIDAK PERNAH ditutup otomatis (disimpan di DB, tidak bergantung nama channel)
    isPreOrder: { type: Boolean, default: false },
    // Username Roblox di form (huruf kecil) — untuk aturan "1 username = 1 tiket Community aktif"
    robloxUsername: { type: String, default: null, index: true },
    // Tiket tanpa kabar (tanpa invoice) -> diingatkan lalu ditutup otomatis
    idle: {
        warnedAt: { type: Date, default: null },
        cancelled: { type: Boolean, default: false }
    },
    // Status auto-close (disimpan di DB supaya tetap aman walau bot restart)
    autoClose: {
        state: { type: String, default: null },      // null | 'armed' | 'paused' | 'cancelled' | 'closing'
        forDoneAt: { type: Date, default: null },     // transaksi (waktu Done) yang membuat auto-close aktif
        buyerId: { type: String, default: null },
        armedAt: { type: Date, default: null },
        closeAt: { type: Date, default: null },
        noticeMessageId: { type: String, default: null },
        warned: { type: Boolean, default: false },
        reason: { type: String, default: null },
        failCount: { type: Number, default: 0 },
        viaReminder: { type: Boolean, default: false } // true = ditutup karena belum vouch setelah 2x pengingat
    }
});

module.exports = mongoose.model('Ticket', TicketSchema);
