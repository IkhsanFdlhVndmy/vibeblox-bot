// Fungsi bersama untuk semua fitur baru: pengaturan ON/OFF, alarm, statistik harian, waktu WIB.
const CFG = require('./config');

module.exports = function createCore(ctx) {
    const { client, models } = ctx;
    const { BotState, DailyStat } = models;

    // ---------------- Pengaturan ON/OFF (tersimpan di database) ----------------
    const settings = { ...CFG.DEFAULT_SETTINGS };
    let settingsLoaded = false;
    async function loadSettings() {
        try {
            const doc = await BotState.findOne({ key: 'settings' }).lean();
            if (doc?.value && typeof doc.value === 'object') {
                for (const k of Object.keys(CFG.DEFAULT_SETTINGS)) {
                    if (typeof doc.value[k] === 'boolean') settings[k] = doc.value[k];
                }
            }
            settingsLoaded = true;
        } catch (e) {
            console.error('[FITUR] Gagal memuat pengaturan (pakai default):', e.message);
        }
    }
    function isOn(key) { return settings[key] === true; }
    async function setSetting(key, value) {
        if (!(key in CFG.DEFAULT_SETTINGS)) throw new Error('Pengaturan tidak dikenal');
        settings[key] = !!value;
        await BotState.updateOne({ key: 'settings' }, { $set: { value: { ...settings } } }, { upsert: true });
    }

    async function getState(key, fallback = null) {
        const doc = await BotState.findOne({ key }).lean();
        return doc ? doc.value : fallback;
    }
    async function setState(key, value) {
        await BotState.updateOne({ key }, { $set: { value } }, { upsert: true });
    }

    // ---------------- Waktu WIB ----------------
    const WIB_OFFSET = 7 * 60 * 60 * 1000;
    function wibDate(d = new Date()) { return new Date(new Date(d).getTime() + WIB_OFFSET); } // pakai getUTC* untuk membaca
    function dayKey(d = new Date()) {
        const w = wibDate(d);
        return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, '0')}-${String(w.getUTCDate()).padStart(2, '0')}`;
    }
    // Awal hari (00:00 WIB) untuk dayKey tertentu, dalam UTC
    function dayStart(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d) - WIB_OFFSET);
    }
    function addDays(key, n) {
        const t = dayStart(key).getTime() + n * 86400000;
        return dayKey(new Date(t));
    }
    const ts = (d) => Math.floor(new Date(d).getTime() / 1000);

    // ---------------- Statistik harian ----------------
    function stat(name, n = 1) {
        DailyStat.updateOne({ day: dayKey() }, { $inc: { [`counters.${name}`]: n } }, { upsert: true })
            .catch(e => console.error('[FITUR] Gagal catat statistik:', e.message));
    }

    // ---------------- Staf ----------------
    function hasAnyRole(member, roles) {
        try { return !!member?.roles?.cache?.some(r => roles.includes(r.id)); } catch (e) { return false; }
    }
    const isStaff = (member) => hasAnyRole(member, CFG.STAFF_ROLES);
    const isInvoiceStaff = (member) => hasAnyRole(member, CFG.INVOICE_ROLES);
    const isOwner = (member) => hasAnyRole(member, [CFG.ROLE_OWNER]);

    // ---------------- Kirim ke channel (dengan percobaan ulang) ----------------
    async function sendTo(channelId, payload) {
        const ch = await client.channels.fetch(channelId).catch(() => null);
        if (!ch) throw new Error(`Channel ${channelId} tidak ditemukan / bot tidak punya akses`);
        return ctx.h.discordRetry(() => ch.send(payload));
    }

    // ---------------- Alarm (#alarm-bot) ----------------
    const alarmLast = new Map(); // kunci -> waktu kirim terakhir (anti spam)
    async function alarm(key, text, cooldownMs = 60 * 60 * 1000) {
        if (!isOn('alarm')) return;
        const last = alarmLast.get(key) || 0;
        if (Date.now() - last < cooldownMs) return;
        alarmLast.set(key, Date.now());
        const pings = CFG.PING_ROLES.map(r => `<@&${r}>`).join(' ');
        try {
            await sendTo(CFG.CHANNEL_ALARM, { content: `${pings}\n${text}`, allowedMentions: { roles: CFG.PING_ROLES } });
        } catch (e) {
            console.error('[ALARM] Gagal kirim alarm:', e.message, '| isi:', text);
        }
    }
    function clearAlarm(key) { alarmLast.delete(key); }

    // Status tombol Community di MEMORI -> dibaca instan di dalam antrean tiket (tanpa tanya database).
    // closed: null = belum diketahui (dianggap buka), true = ditutup (Disable / War penuh), false = buka
    const commGate = { closed: null, ver: 0, at: 0 };
    function setCommunityClosed(v) { commGate.closed = !!v; commGate.ver++; commGate.at = Date.now(); }
    // dari bacaan database: hanya dipakai kalau sejak bacaan dimulai tidak ada perubahan lewat /buttonticket
    // (dan bukan sesaat setelah perubahan, saat database mungkin belum selesai ditulis)
    function syncCommunityClosed(v, verAtRead) {
        if (commGate.ver === verAtRead && Date.now() - commGate.at > 15000) commGate.closed = !!v;
    }
    const communityClosed = () => commGate.closed === true;
    const communityGateVer = () => commGate.ver;

    const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
    const rp = (n) => `Rp ${fmt(n)}`;
    const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

    return {
        CFG, settings, loadSettings, isOn, setSetting, getState, setState,
        dayKey, dayStart, addDays, wibDate, ts, stat,
        isStaff, isInvoiceStaff, isOwner, hasAnyRole,
        sendTo, alarm, clearAlarm, fmt, rp, snowflakeTime,
        setCommunityClosed, syncCommunityClosed, communityClosed, communityGateVer,
        get settingsLoaded() { return settingsLoaded; }
    };
};
