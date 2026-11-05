// =====================================================================
// CEK ELIGIBLE "BORONGAN" + MODE TIKET COMMUNITY (Normal / Ketat-War / Pre-Order)
// =====================================================================
// Daftar orang yang JOIN dalam 16 hari terakhir per community diambil di belakang layar (akun dummy,
// lewat antrean prioritas rendah). Cek per username cukup pakai API PUBLIK (tanpa akun dummy) + daftar itu.
// -> 100 tiket bersamaan TIDAK menambah beban akun dummy sama sekali.
const { EmbedBuilder } = require('discord.js');

const JOIN_WINDOW_MS = 16 * 24 * 60 * 60 * 1000;   // simpan join 16 hari terakhir (syarat 14 hari + cadangan)
const ELIGIBLE_MS = 14 * 24 * 60 * 60 * 1000;
const REFRESH_MS = 3 * 60 * 1000;
const FULL_MAX_PAGES = 150;
const INCR_MAX_PAGES = 20;

module.exports = function createEligible(ctx, core) {
    const { client, models, h } = ctx;
    const { Ticket, TicketConfig } = models;
    const axios = h.axios;

    // ---------------- Cache join per community ----------------
    const caches = {}; // num -> { map: Map<userId, joinMs>, ready, newestTs, lastOk }
    for (const num of Object.keys(h.RESTOCK_COMMUNITIES)) caches[num] = { map: new Map(), ready: false, newestTs: 0, lastOk: 0 };
    let sampleLogged = false;
    let refreshing = false;

    function entryUserId(e) {
        const u = e?.actor?.user || e?.actor || {};
        const id = u.userId ?? u.id ?? u.UserId;
        return id != null ? String(id) : null;
    }

    async function fetchJoinPage(groupId, cursor) {
        return h.rbxRun({
            priority: 'low',
            gapAfter: 700,
            run: async () => {
                if (h.rbxIsPaused()) throw new Error('RBX_PAUSED');
                const url = `https://groups.roblox.com/v1/groups/${groupId}/audit-log?actionType=JoinGroup&limit=100&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
                const res = await axios.get(url, { headers: { Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` } });
                return res.data || {};
            }
        });
    }

    async function refreshCommunity(num) {
        const grp = h.RESTOCK_COMMUNITIES[num];
        const c = caches[num];
        const full = !c.ready;
        const stopBefore = full ? Date.now() - JOIN_WINDOW_MS : c.newestTs;
        const maxPages = full ? FULL_MAX_PAGES : INCR_MAX_PAGES;
        const fresh = new Map();
        let newest = c.newestTs;
        let cursor = '';
        let complete = false;
        for (let page = 0; page < maxPages; page++) {
            const data = await fetchJoinPage(grp.groupId, cursor);
            const entries = Array.isArray(data.data) ? data.data : [];
            if (!sampleLogged && entries.length) {
                sampleLogged = true;
                console.log('[ELIGIBLE] Contoh data join audit log:', JSON.stringify(entries[0]).slice(0, 400));
            }
            let reached = false;
            for (const e of entries) {
                const t = new Date(e.created).getTime();
                if (!t) continue;
                if (t <= stopBefore) { reached = true; break; }
                if (t > newest) newest = t;
                const uid = entryUserId(e);
                if (uid && !fresh.has(uid)) fresh.set(uid, t); // urutan terbaru dulu -> join TERAKHIR yang dipakai
            }
            if (reached || !data.nextPageCursor || entries.length === 0) { complete = true; break; }
            cursor = data.nextPageCursor;
        }
        if (full && !complete) {
            console.error(`[ELIGIBLE] Community ${num}: join 16 hari terakhir terlalu banyak (>${FULL_MAX_PAGES * 100}), cache tidak dipakai.`);
            return;
        }
        if (!full && !complete) {
            // Bot lama mati / join sangat ramai: bangun ulang penuh supaya tidak ada yang terlewat
            c.ready = false; c.map.clear(); c.newestTs = 0;
            return refreshCommunity(num);
        }
        for (const [uid, t] of fresh) {
            const old = c.map.get(uid);
            if (!old || t > old) c.map.set(uid, t);
        }
        const cutoff = Date.now() - JOIN_WINDOW_MS;
        for (const [uid, t] of c.map) if (t < cutoff) c.map.delete(uid);
        c.newestTs = Math.max(newest, c.newestTs);
        c.lastOk = Date.now();
        if (!c.ready) console.log(`✅ [ELIGIBLE] Cache join Community ${num} (${grp.name}) siap: ${c.map.size} orang join 16 hari terakhir.`);
        c.ready = true;
    }

    async function refreshAll() {
        if (refreshing || !client.isReady()) return;
        refreshing = true;
        try {
            for (const num of Object.keys(caches)) {
                try { await refreshCommunity(num); }
                catch (e) {
                    const st = e.response?.status;
                    if (e.message !== 'RBX_PAUSED') console.error(`[ELIGIBLE] Gagal refresh join Community ${num}:`, st || e.message);
                    if (st === 401 || st === 403) core.alarm(`elig_${num}`, `⚠️ Akun dummy tidak bisa membaca audit log **Community ${num} (${h.RESTOCK_COMMUNITIES[num].name})** (HTTP ${st}). Cek izin rank akun dummy / cookie.`);
                }
                // Data terlalu lama tidak diperbarui -> jangan dipakai (lebih aman cek manual)
                const c = caches[num];
                if (c.ready && Date.now() - c.lastOk > 20 * 60 * 1000) { c.ready = false; c.map.clear(); c.newestTs = 0; }
            }
        } finally { refreshing = false; }
    }

    // Untuk /cek-eligible lama: { joinMs } kalau cache siap, null kalau belum (pakai cara lama)
    function cachedJoin(groupId, userId) {
        const num = Object.keys(h.RESTOCK_COMMUNITIES).find(n => String(h.RESTOCK_COMMUNITIES[n].groupId) === String(groupId));
        const c = num && caches[num];
        if (!c || !c.ready) return null;
        return { joinMs: c.map.get(String(userId)) || null };
    }

    // ---------------- API publik (tanpa akun dummy) dengan pembatas kecepatan ----------------
    const pubQueue = [];
    let pubActive = 0;
    let pubLast = 0;
    function pub(fn) {
        return new Promise((resolve, reject) => { pubQueue.push({ fn, resolve, reject }); pump(); });
    }
    function pump() {
        if (pubActive >= 3 || !pubQueue.length) return;
        const wait = Math.max(0, pubLast + 200 - Date.now());
        if (wait > 0) { setTimeout(pump, wait); return; }
        const job = pubQueue.shift();
        pubActive++; pubLast = Date.now();
        job.fn().then(job.resolve, job.reject).finally(() => { pubActive--; pump(); });
        pump();
    }
    async function getWithProxy(path, method = 'get', body) {
        try {
            return method === 'post' ? await axios.post(`https://${path}`, body) : await axios.get(`https://${path}`);
        } catch (e) {
            const alt = path.replace('.roblox.com', '.roproxy.com');
            return method === 'post' ? await axios.post(`https://${alt}`, body) : await axios.get(`https://${alt}`);
        }
    }
    const userCache = new Map();   // username -> { at, user|null }
    const groupCache = new Map();  // userId -> { at, set }
    async function resolveUser(username) {
        const key = username.toLowerCase();
        const c = userCache.get(key);
        if (c && Date.now() - c.at < 10 * 60 * 1000) return c.user;
        const res = await pub(() => getWithProxy('users.roblox.com/v1/usernames/users', 'post', { usernames: [username], excludeBannedUsers: true }));
        const d = res.data?.data?.[0];
        const user = d ? { id: String(d.id), name: d.name, displayName: d.displayName || d.name } : null;
        userCache.set(key, { at: Date.now(), user });
        if (userCache.size > 2000) userCache.clear();
        return user;
    }
    async function userGroups(userId) {
        const c = groupCache.get(userId);
        if (c && Date.now() - c.at < 5 * 60 * 1000) return c.set;
        const res = await pub(() => getWithProxy(`groups.roblox.com/v2/users/${userId}/groups/roles`));
        const set = new Set((res.data?.data || []).map(g => String(g.group?.id)));
        groupCache.set(userId, { at: Date.now(), set });
        if (groupCache.size > 2000) groupCache.clear();
        return set;
    }

    // Status per community untuk 1 username
    async function checkUsername(username, timeoutMs = 12000) {
        const run = (async () => {
            const user = await resolveUser(username);
            if (!user) return { status: 'notfound', username };
            const groups = await userGroups(user.id);
            const rows = [];
            for (const [num, grp] of Object.entries(h.RESTOCK_COMMUNITIES)) {
                let st, eligibleAt = null;
                if (!groups.has(String(grp.groupId))) st = 'notjoin';
                else if (!caches[num].ready) st = 'unknown';
                else {
                    const j = caches[num].map.get(user.id);
                    if (j && j + ELIGIBLE_MS > Date.now()) { st = 'pending'; eligibleAt = j + ELIGIBLE_MS; }
                    else st = 'eligible';
                }
                rows.push({ num, name: grp.name, status: st, eligibleAt });
            }
            return {
                status: 'ok', user, rows,
                anyEligible: rows.some(r => r.status === 'eligible'),
                allKnown: rows.every(r => r.status !== 'unknown')
            };
        })();
        const timeout = new Promise(resolve => setTimeout(() => resolve({ status: 'error', username, error: 'timeout' }), timeoutMs));
        try { return await Promise.race([run, timeout]); }
        catch (e) { return { status: 'error', username, error: e.message }; }
    }

    const ICON = { eligible: '✅', pending: '⏳', notjoin: '❌', unknown: '❔' };
    function rowText(r) {
        if (r.status === 'eligible') return `${ICON.eligible} **C${r.num} ${r.name}** — Eligible`;
        if (r.status === 'pending') return `${ICON.pending} **C${r.num} ${r.name}** — eligible <t:${Math.floor(r.eligibleAt / 1000)}:R>`;
        if (r.status === 'notjoin') return `${ICON.notjoin} **C${r.num} ${r.name}** — belum join`;
        return `${ICON.unknown} **C${r.num} ${r.name}** — sedang dimuat, cek manual dengan /cek-eligible`;
    }
    function buildEligibilityEmbed(result) {
        const e = new EmbedBuilder().setTitle('🔎 Cek Eligible Otomatis').setTimestamp();
        if (result.status === 'notfound') {
            return e.setColor(0xED4245).setDescription(`Username **\`${result.username}\`** tidak ditemukan di Roblox. Pastikan username benar (bukan display name).\n-# Staf bisa membetulkan lewat /editform.`);
        }
        if (result.status !== 'ok') {
            return e.setColor(0x99AAB5).setDescription(`Belum bisa mengecek **\`${result.username}\`** saat ini (Roblox sedang lambat). Staf bisa cek manual dengan /cek-eligible.`);
        }
        const name = result.user.displayName && result.user.displayName !== result.user.name ? `${result.user.name} (${result.user.displayName})` : result.user.name;
        let desc = `👤 **\`${name}\`**\n\n${result.rows.map(rowText).join('\n')}`;
        if (!result.anyEligible && result.allKnown) {
            desc += '\n\n⚠️ **Username ini belum bisa menerima Robux Community.** Wajib sudah join minimal 14 hari di salah satu community di atas. Silakan pilih metode lain atau tunggu sampai eligible.';
        }
        return e.setColor(result.anyEligible ? 0x57F287 : (result.allKnown ? 0xED4245 : 0xFEE75C)).setDescription(desc)
            .setFooter({ text: 'Status bisa berubah · cek ulang dengan /cek-eligible' });
    }

    // ---------------- Mode tiket Community ----------------
    async function getCommunityMode() {
        const cfg = await TicketConfig.findOne({ configId: 'VIBEBLOX_TICKET' }).lean();
        if (!cfg) return 'normal';
        const enabled = cfg.buttonStates ? (cfg.buttonStates instanceof Map ? cfg.buttonStates.get('community') : cfg.buttonStates.community) : true;
        if (enabled === false) return 'disable';
        return cfg.communityMode || 'normal';
    }
    const MODE_LABEL = { normal: 'Normal', ketat: 'Ketat (War)', preorder: 'Pre-Order', disable: 'Disable' };
    // Dipanggil /buttonticket: kembalikan { status: boolean, modeLabel } atau { error }
    function applyButtonTicket(config, tipe, rawStatus) {
        const communityOnly = ['normal', 'ketat', 'preorder'];
        if (tipe !== 'community') {
            if (communityOnly.includes(rawStatus)) return { error: '❌ Pilihan Normal / Ketat (War) / Pre-Order hanya untuk tipe **Community**. Untuk tipe lain pilih Enable atau Disable.' };
            return { status: rawStatus === 'enable' };
        }
        const mode = rawStatus === 'enable' ? 'normal' : rawStatus;
        if (mode === 'disable') return { status: false, modeLabel: 'Disable' };
        config.communityMode = mode;
        return { status: true, modeLabel: MODE_LABEL[mode] };
    }
    function panelLabel(id, label, config) {
        if (id !== 'community') return label;
        const enabled = config.buttonStates?.get ? config.buttonStates.get('community') !== false : true;
        if (!enabled) return label;
        if (config.communityMode === 'preorder') return '💎 Robux Community (Pre-Order)';
        if (config.communityMode === 'ketat') return '💎 Robux Community (War)';
        return label;
    }

    const norm = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();

    // Sebelum tiket dibuat (setelah form dikirim). Return { block: pesan } atau { result, mode }
    async function beforeTicket(interaction, type) {
        if (type !== 'community') return {};
        const mode = await getCommunityMode().catch(() => 'normal');
        if (mode === 'disable') return { block: '❌ Tiket **Robux Community** sedang ditutup. Pantau pengumuman restock ya!' };
        let username = '';
        try { username = interaction.fields.getTextInputValue('user_roblox').trim(); } catch (e) {}
        const out = { mode, username };
        if (core.isOn('batas_username') && username) {
            const existing = await Ticket.findOne({ ticketType: 'community', robloxUsername: norm(username) }).lean().catch(() => null);
            if (existing) return { block: `❌ Username Roblox **\`${username}\`** masih punya tiket Community aktif: <#${existing.channelId}>.\nSelesaikan tiket itu dulu, atau gunakan username lain.` };
        }
        if (core.isOn('eligible_tiket') && username) {
            const result = await checkUsername(username);
            out.result = result;
            if (mode === 'ketat') {
                if (result.status === 'notfound') return { block: `❌ **Tiket tidak dibuat.** Username **\`${username}\`** tidak ditemukan di Roblox. Pastikan kamu menulis **username** (bukan display name).` };
                if (result.status === 'ok' && result.allKnown && !result.anyEligible) {
                    return { block: `❌ **Tiket tidak dibuat — username belum eligible.**\n\n${result.rows.map(rowText).join('\n')}\n\nSyarat: sudah join minimal **14 hari** di salah satu community. Cek kapan saja dengan /cek-eligible.` };
                }
            }
        }
        return out;
    }
    // Di DALAM kunci antrean tiket (anti dobel kalau 2 orang kirim form username sama bersamaan)
    async function inLockCheck(interaction, type) {
        if (type !== 'community' || !core.isOn('batas_username')) return null;
        let username = '';
        try { username = interaction.fields.getTextInputValue('user_roblox').trim(); } catch (e) { return null; }
        if (!username) return null;
        const existing = await Ticket.findOne({ ticketType: 'community', robloxUsername: norm(username) }).lean();
        if (existing) return `❌ Username Roblox **\`${username}\`** masih punya tiket Community aktif: <#${existing.channelId}>.`;
        return null;
    }
    function ticketExtraFields(interaction, type) {
        try {
            const u = interaction.fields.getTextInputValue('user_roblox');
            return u ? { robloxUsername: norm(u) } : {};
        } catch (e) { return {}; }
    }

    async function postEligibility(channel, gate) {
        if (!core.isOn('eligible_tiket') || !gate?.username) return;
        let result = gate.result;
        if (!result || result.status === 'error' || (result.status === 'ok' && !result.allKnown)) {
            result = await checkUsername(gate.username, 30000);
        }
        await h.discordRetry(() => channel.send({ embeds: [buildEligibilityEmbed(result)] })).catch(e => console.error('[ELIGIBLE] Gagal kirim status eligible:', e.message));
    }

    // Tiket Community yang dibuka SEBELUM fitur ini dipasang: isi username-nya dari form (sekali saat bot nyala),
    // supaya aturan "1 username = 1 tiket" juga berlaku untuk tiket lama.
    async function backfillUsernames() {
        try {
            const list = await Ticket.find({ ticketType: 'community', robloxUsername: null }).lean();
            let n = 0;
            for (const t of list) {
                const ch = client.channels.cache.get(t.channelId);
                if (!ch) continue;
                const msgs = await ch.messages.fetch({ limit: 5, after: ch.id, cache: false }).catch(() => null);
                const form = msgs && [...msgs.values()].find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title?.startsWith('🎫 Order Tiket'));
                const f = form?.embeds?.[0]?.fields?.find(x => x.name.includes('Username Roblox'));
                if (!f) continue;
                await Ticket.updateOne({ channelId: t.channelId }, { $set: { robloxUsername: norm(f.value.replace(/`/g, '')) } });
                n++;
                await new Promise(r => setTimeout(r, 300));
            }
            if (n) console.log(`✅ [ELIGIBLE] Username ${n} tiket Community lama dicatat.`);
        } catch (e) { console.error('[ELIGIBLE] Gagal mencatat username tiket lama:', e.message); }
    }

    function start() {
        setTimeout(refreshAll, 20000);
        setInterval(refreshAll, REFRESH_MS);
        setTimeout(backfillUsernames, 30000);
    }

    return {
        start, refreshAll, cachedJoin, checkUsername, buildEligibilityEmbed, rowText,
        getCommunityMode, applyButtonTicket, panelLabel, beforeTicket, inLockCheck, ticketExtraFields, postEligibility,
        norm, caches, resolveUser, userGroups, MODE_LABEL
    };
};
