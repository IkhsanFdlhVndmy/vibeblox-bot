const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    channelId: { type: String, required: true },
    creatorId: { type: String, required: true },
    claimedBy: { type: String, default: null },
    ticketType: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Ticket', TicketSchema);
