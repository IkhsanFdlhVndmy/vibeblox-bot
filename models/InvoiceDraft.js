const mongoose = require('mongoose');

// Draft invoice otomatis dari form tiket (belum jadi invoice sampai staf menekan "Buat Invoice").
const InvoiceDraftSchema = new mongoose.Schema({
    channelId: { type: String, required: true, unique: true },
    messageId: { type: String, default: null },
    buyerId: { type: String, required: true },
    type: { type: String, default: null },
    robux: { type: Number, default: 0 },
    customTotal: { type: Number, default: null }, // harga manual (mis. GIG item khusus)
    used: { type: Boolean, default: false },
    usedBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('InvoiceDraft', InvoiceDraftSchema);
