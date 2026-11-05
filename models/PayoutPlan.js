const mongoose = require('mongoose');

// Rencana & verifikasi payout Community per invoice (tahan restart).
const PayoutPlanSchema = new mongoose.Schema({
    invoiceMessageId: { type: String, required: true, unique: true },
    channelId: { type: String, required: true, index: true },
    messageId: { type: String, default: null },   // pesan rencana di tiket
    buyerId: { type: String, default: null },
    robux: { type: Number, default: 0 },
    recipients: { type: [{ username: String, amount: Number }], default: [] },
    allocations: { type: [{ num: String, username: String, amount: Number, note: String }], default: [] },
    shortfall: { type: Number, default: 0 },
    status: { type: String, default: 'planned', index: true }, // planned | checking | verified | mismatch | manual
    doneAt: { type: Date, default: Date.now },
    checkAttempts: { type: Number, default: 0 },
    nextCheckAt: { type: Date, default: null },
    found: { type: [{ num: String, username: String, amount: Number }], default: [] },
    foundTotal: { type: Number, default: 0 },
    claimedKeys: { type: [String], default: [] }, // entri audit log yang sudah "dipakai" rencana ini (tidak dihitung untuk tiket lain)
    isPreOrder: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('PayoutPlan', PayoutPlanSchema);
