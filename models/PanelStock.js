const mongoose = require('mongoose');

const PanelStockSchema = new mongoose.Schema({
    messageId: { type: String, required: true },
    channelId: { type: String, required: true },
    guildId: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('PanelStock', PanelStockSchema);
