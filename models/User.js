const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    uangMasuk: { type: Number, default: 0 },
    isAnonymous: { type: Boolean, default: false } // <--- TAMBAHAN BARU
});

module.exports = mongoose.model('User', UserSchema);
