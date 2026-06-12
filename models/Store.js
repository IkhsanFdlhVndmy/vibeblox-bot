const mongoose = require('mongoose');

const StoreSchema = new mongoose.Schema({
    storeId: { type: String, default: 'VIBEBLOX_FINANCE' },
    totalUangMasuk: { type: Number, default: 0 },
    totalUangKeluar: { type: Number, default: 0 },
    leaderboardChannelId: { type: String, default: null },
    leaderboardMessageId: { type: String, default: null },
    menuMessages: { type: Array, default: [] } // <-- TAMBAHAN BARU: [{ channelId, messageId, type }]
});

module.exports = mongoose.model('Store', StoreSchema);
