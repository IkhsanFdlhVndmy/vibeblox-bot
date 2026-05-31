const mongoose = require('mongoose');

const RobuxRateSchema = new mongoose.Schema({
    type: { type: String, required: true, unique: true },
    rate: { type: Number, required: true } // Untuk vilog: harga per 500 robux, untuk lainnya: harga per 1 robux
});

module.exports = mongoose.model('RobuxRate', RobuxRateSchema);
