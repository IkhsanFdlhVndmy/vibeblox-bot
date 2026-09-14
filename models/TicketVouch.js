const mongoose = require('mongoose');

const TicketVouchSchema = new mongoose.Schema({
    channelId: { type: String, required: true, unique: true },
    messageId: { type: String, required: true },
    buyerId: { type: String, required: true },
    vouched: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('TicketVouch', TicketVouchSchema);
