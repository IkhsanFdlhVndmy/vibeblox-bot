const mongoose = require('mongoose');

const StoreSchema = new mongoose.Schema({
    storeId: { type: String, default: 'VIBEBLOX_FINANCE' },
    totalUangMasuk: { type: Number, default: 0 },
    totalUangKeluar: { type: Number, default: 0 },
    leaderboardChannelId: { type: String, default: null }, // Buat nginget channel-nya
    leaderboardMessageId: { type: String, default: null }  // Buat nginget pesan leaderboard-nya
});

module.exports = mongoose.model('Store', StoreSchema);