const mongoose = require('mongoose');

const VouchedUserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true }
}, { timestamps: true });

module.exports = mongoose.model('VouchedUser', VouchedUserSchema);
