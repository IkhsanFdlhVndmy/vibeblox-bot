# Fitur Otomatis VibeBlox (folder `fitur/`)

Semua fitur baru ada di folder ini. `index.js` hanya memanggilnya lewat `FX.xxx(...)`, jadi alur lama tetap utuh.
Setiap fitur punya saklar **ON/OFF** lewat `/pengaturan` (khusus Vibe Owner, tersimpan di database).

| File | Isi |
|---|---|
| `config.js` | Semua angka & ID yang bisa diubah (channel, sisa wajib 1.000, ambang 2.000, batas payout 9.999, kode unik, jam laporan, 12 jam tiket mati) |
| `riwayat.js` | Catatan transaksi per Done / manual / pengeluaran, impor log keuangan lama, `/riwayat` |
| `eligible.js` | Cek eligible "borongan", mode Community di `/buttonticket`, 1 username = 1 tiket Community |
| `stok.js` | Bisa dijual = saldo − 1.000, alarm saldo < 2.000, kuota Pre-Order dari Robux pending, estimasi dari `/restock`, tombol Ingatkan Saya |
| `pembayaran.js` | Draft invoice, kode unik, QRIS bernominal, antrean "Sudah Bayar" |
| `qris.js` + `qrcode-lite.js` | Pembuat QRIS bernominal + gambar QR (tanpa library tambahan) |
| `payout.js` | Opsi payout Community per username (community yang bisa dipakai, maks kirim, riwayat 10–20 hari) |
| `operasional.js` | Tiket tanpa kabar, laporan harian/mingguan/bulanan, alarm, `/balas` |

## Command baru
- `/riwayat [user]` — riwayat belanja (pembeli: miliknya sendiri; staf: siapa pun)
- `/pengaturan [fitur] [status]` — saklar fitur (Vibe Owner)
- `/laporan [periode]` — laporan hari ini / kemarin / 7 hari / bulan ini (Owner & Handler)
- `/balas template` — balasan cepat ke pembeli di tiket
- `/qris-tes nominal` — QRIS bernominal untuk uji bayar (hanya terlihat staf)
- `/buttonticket tipe:Community status:` **Normal** / **Ketat (War)** / **Pre-Order** / **Disable**

## Tahan restart
Semua status (kode unik, antrean bayar, draft, rencana payout, pengingat, jadwal laporan, pengaturan) disimpan di MongoDB.
Saat bot menyala lagi: bukti bayar yang masuk selama bot mati dicari ulang, laporan yang terlewat dikirim (ditandai terlambat),
dan pengingat yang sudah basi tidak dikirim.
