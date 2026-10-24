const mongoose = require('mongoose');

const PanelStockSchema = new mongoose.Schema({
    messageId: { type: String, required: true },
    channelId: { type: String, required: true },
    guildId: { type: String, required: true },
    extraMessageIds: { type: [String], default: [] } // pesan lanjutan kalau daftar invoice tidak muat 1 pesan
}, { timestamps: true });

module.exports = mongoose.model('PanelStock', PanelStockSchema);
