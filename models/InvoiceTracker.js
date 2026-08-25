const mongoose = require('mongoose');

const InvoiceTrackerSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    channelId: { type: String, required: true },
    channelName: { type: String, required: true },
    amount: { type: Number, required: true }, // jumlah Robux
    createdBy: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('InvoiceTracker', InvoiceTrackerSchema);
