// models/Partner.js
const mongoose = require('mongoose');

const PartnerSchema = new mongoose.Schema({
    partnerId: { type: String, required: true, unique: true },
    totalUangMasuk: { type: Number, default: 0 }
});

module.exports = mongoose.model('Partner', PartnerSchema);
