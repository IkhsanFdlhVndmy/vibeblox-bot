const mongoose = require('mongoose');

const TicketConfigSchema = new mongoose.Schema({
    configId: { type: String, default: 'VIBEBLOX_TICKET' },
    ticketCounter: { type: Number, default: 0 },
    panelChannelId: { type: String, default: null }, // <--- TAMBAHAN BARU
    panelMessageId: { type: String, default: null }, // <--- TAMBAHAN BARU
    buttonStates: {
        type: Map,
        of: Boolean,
        default: {
            'community': true,
            'robux_plus': true,
            'vilog': true,
            'gamepass': true,
            'gig': true,
            'limited': true,
            'mm': true
        }
    }
});

module.exports = mongoose.model('TicketConfig', TicketConfigSchema);
