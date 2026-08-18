const mongoose = require('mongoose');

const RestockSchema = new mongoose.Schema({
    messageId: { type: String, required: true },
    channelId: { type: String, required: true },
    guildId: { type: String },
    amount: { type: Number, required: true },       // jumlah Robux
    communities: { type: [Number], required: true }, // contoh: [1, 3]
    arrivalTimestamp: { type: Date, required: true }, // waktu robux READY (input + 5 hari)
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    createdBy: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Restock', RestockSchema);
