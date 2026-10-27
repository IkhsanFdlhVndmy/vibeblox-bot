const mongoose = require('mongoose');

const TicketVouchSchema = new mongoose.Schema({
    channelId: { type: String, required: true, unique: true },
    messageId: { type: String, required: true },
    buyerId: { type: String, required: true },
    vouched: { type: Boolean, default: false },
    // Waktu invoice yang lagi ditunggu vouch-nya di-done. Pesan di channel vouches cuma dihitung SAH
    // buat ticket ini kalau dikirim SETELAH waktu ini -- vouch lama (sebelum invoice ini selesai)
    // gak ikut kehitung. Tiap ada invoice baru di ticket yang sama, ini di-update ke waktu terbaru.
    doneAt: { type: Date, required: true },
    // false = status vouch sudah tercatat di database tapi tampilan form tiket belum berhasil diupdate
    // (akan diulang otomatis tiap 2 menit)
    embedSynced: { type: Boolean, default: true },
    // ID pesan vouch yang dipakai untuk mencentang tiket ini (1 pesan hanya boleh dipakai 1x)
    vouchMessageId: { type: String, default: null, index: true },
    // Pengingat vouch: dicatat per transaksi (reminderDoneAt = doneAt transaksi yang diingatkan)
    reminderDoneAt: { type: Date, default: null },
    reminder1At: { type: Date, default: null },   // waktu pengingat ke-1 BENAR-BENAR terkirim
    reminder2At: { type: Date, default: null }    // waktu pengingat terakhir BENAR-BENAR terkirim
}, { timestamps: true });

module.exports = mongoose.model('TicketVouch', TicketVouchSchema);
