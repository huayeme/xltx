

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { isIP } from 'node:net';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { writePrivateFileSync } from '../engine/secure-file.js';
import { isAbortError, sleepWithSignal, timeoutSignal } from '../engine/abort.js';
import { parseProtocolJson } from '../engine/protocol-json.js';
import { KeyedSerialQueue } from '../engine/keyed-queue.js';
import { backupCorruptFileSync } from '../engine/atomic-file.js';
import { diagnosticJson, DiagnosticError, platformResult, probe, requireDiagnostic } from './diagnostics.js';

export function validateWeixinUploadUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')))
        throw new Error('Invalid Weixin upload URL');
    return url.href;
}
const BASE_URL = 'https://ilinkai.weixin.qq.com';

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;

const UPLOAD_IMAGE = 1;
const UPLOAD_VIDEO = 2;
const UPLOAD_FILE = 3;

export function aesEcbPaddedSize(plaintextSize) {
    return Math.ceil((plaintextSize + 1) / 16) * 16;
}
export function encryptAesEcb(plaintext, key) {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
export function decryptAesEcb(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseAesKey(aesKeyBase64, label = 'aes') {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16)
        return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
        return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`${label}: invalid aes_key (${decoded.length} decoded bytes; expected 16 bytes or 32 hexadecimal characters)`);
}

export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = CDN_BASE_URL) {
    return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

class WeixinImageError extends Error {
    kind;
    status;
    constructor(kind, status) {
        super(`Weixin image ${kind} error${status === undefined ? '' : ` (HTTP ${status})`}`);
        this.kind = kind;
        this.status = status;
        this.name = 'WeixinImageError';
    }
}
function imageTransportError(error) {
    if (error instanceof WeixinImageError)
        return error;
    const e = error;
    const code = e?.code ?? e?.cause?.code ?? '';
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))
        return new WeixinImageError('timeout');
    if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY_|SELF_SIGNED_)/.test(code))
        return new WeixinImageError('unsafe');
    return new WeixinImageError('network');
}

function pickStr(obj, ...keys) {
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && v !== '')
            return String(v);
    }
    return undefined;
}
function normalizeId(v) {
    if (typeof v === 'string')
        return v || undefined;
    if (typeof v === 'number' && Number.isFinite(v))
        return String(Math.trunc(v));
    if (v && typeof v === 'object') {
        const inner = pickStr(v, 'id', 'value', 'str');
        if (inner !== undefined)
            return normalizeId(inner);
    }
    return undefined;
}
function guessExt(name) {
    const m = name.match(/\.([a-zA-Z0-9]+)$/);
    return m ? `.${m[1].toLowerCase()}` : '.bin';
}
export function mimeFromExt(ext) {
    const map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
        '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.silk': 'audio/silk', '.amr': 'audio/amr',
    };
    return map[ext] ?? 'application/octet-stream';
}

export function uniqueMediaFileName(prefix, ext, name) {
    const safePrefix = prefix.replace(/[^\w-]+/g, '_') || 'media';
    const normalizedName = (name ?? `${safePrefix}${ext}`).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
    const safeName = normalizedName.replace(/^\.+/, '') || `${safePrefix}${ext}`;
    const withExt = safeName.endsWith(ext) || safeName.includes('.') ? safeName : `${safeName}${ext}`;
    return `${safePrefix}-${Date.now()}-${randomBytes(6).toString('hex')}-${withExt}`;
}
export function isStaleWeixinTokenError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:ret|errcode)\s*=\s*-14(?:\D|$)/i.test(message);
}

function cdnUrlOf(mediaRef) {
    if (!mediaRef)
        return undefined;
    const param = pickStr(mediaRef, 'encrypt_query_param');
    if (param)
        return buildCdnDownloadUrl(param);
    return pickStr(mediaRef, 'full_url');
}

export function createWeixinChannel(config, log, stateDir) {
    if (!config.enabled)
        return undefined;
    const dir = config.stateDir ?? stateDir;
    const mediaDir = join(dir, 'media');
    const statePath = join(dir, 'wechat-state.json');
    const loginPath = join(dir, 'wechat-login.txt');
    let state = loadState();
    let handler;
    let stopped = false;
    let lifecycle;
    let pollTask,processing=false;
    const login = state.login;
    const validLogin = typeof login?.token === 'string' && !!login.token.trim()
        && typeof login.userId === 'string' && !!login.userId && login.userId === state.allowedUserId;
    let botToken = validLogin ? login.token : '';
    if (!validLogin) {
        state = { allowedUserId: state.allowedUserId, contextTokens: {} };
        log('[weixin] Saved credentials do not match the bound user; scan required');
    }
    let statusText = 'signed-out';
    // User-facing notices come from the host so the wording can live in a
    // message file (messages.json) instead of being hard-coded here.
    const notices = config.messages ?? {
        imageFailed: (reason) => `Image download failed: ${reason}. The message was not submitted; send it again.`,
        mediaFailed: () => 'Media download failed. Send the message again.',
        reason: (kind, status) => (kind === 'http' || kind === 'server' ? `HTTP ${status}` : kind),
    };

    let currentLoginUrl;
    let lastFlushed = '';
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), 'utf8').toString('base64');

    const typingTickets = new Map();

    const outbound = new KeyedSerialQueue();
    function loadState() {
        try {
            const raw = readFileSync(statePath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                allowedUserId: parsed.allowedUserId,
                contextTokens: parsed.contextTokens ?? {},
                login: parsed.login,
                baseUrl: parsed.baseUrl,
                syncBuf: parsed.syncBuf,
            };
        }
        catch {
            backupCorruptFileSync(statePath);
            return { contextTokens: {} };
        }
    }
    function flush() {
        try {
            mkdirSync(dir, { recursive: true });

            const serialized = `${JSON.stringify(state, null, 2)}\n`;
            if (serialized === lastFlushed)
                return;
            writePrivateFileSync(statePath, serialized);
            lastFlushed = serialized;
        }
        catch (err) {
            log(`[weixin] Failed to persist state: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    function headers() {
        const h = {
            'content-type': 'application/json',
            'iLink-App-ClientVersion': '1',
            'X-WECHAT-UIN': uin,
        };
        if (botToken) {
            h['Authorization'] = `Bearer ${botToken}`;
            h['AuthorizationType'] = 'ilink_bot_token';
        }
        return h;
    }
    async function request(path, body, timeoutMs, tolerateRet1 = false, signal, beforeSubmit = () => {}) {
        const baseUrl = state.baseUrl && state.baseUrl.trim() !== '' ? state.baseUrl : BASE_URL;
        const base = new URL(baseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || !(base.hostname === 'weixin.qq.com' || base.hostname.endsWith('.weixin.qq.com'))) throw new Error('Invalid Weixin API URL');
        const init = {
            method: 'POST',
            redirect: 'error',
            headers: headers(),
            body: JSON.stringify(body),
            signal: AbortSignal.any([timeoutSignal(timeoutMs, lifecycle?.signal), ...(signal ? [signal] : [])]),
        };
        init.signal.throwIfAborted();
        beforeSubmit();
        const res = await fetch(`${base.origin}${path}`, init);
        if (!res.ok)
            throw new Error(`weixin ${path} http ${res.status}`);
        const text = await res.text();
        const data = parseProtocolJson(text);
        const ret = Number(data.ret ?? 0);
        const errcode = Number(data.errcode ?? 0);
        if (tolerateRet1 && ret === 1 && errcode === 0)
            return data;
        if (ret !== 0 || errcode !== 0) {
            const error = new Error(`weixin ${path} ret=${ret} errcode=${errcode} ${String(data.errmsg ?? '')}`);
            if (path === '/ilink/bot/sendmessage' && Number.isFinite(ret) && Number.isFinite(errcode)) error.deliveryNotSent = true;
            throw error;
        }
        if (path === '/ilink/bot/sendmessage' && data.ret === undefined && data.errcode === undefined) {
            // HTTP 200 means the platform accepted the message; some responses
            // carry no status field at all. Reporting that as an unconfirmed
            // delivery told the user the reply "was not sent" after it arrived,
            // so record the shape and treat the send as delivered.
            log(`[weixin] sendmessage accepted without status field: ${text.slice(0, 200)}`);
            return data;
        }
        return data;
    }
    async function loginLoop() {
        statusText = 'signing-in';
        while (!stopped) {
            let qr;
            try {
                qr = await request('/ilink/bot/get_bot_qrcode?bot_type=3', {}, 15_000);
            }
            catch (err) {
                log(`[weixin] Failed to obtain QR code; retrying in 5 seconds: ${err instanceof Error ? err.message : String(err)}`);
                await sleepWithSignal(5000, lifecycle?.signal);
                continue;
            }
            const qrcodeId = pickStr(qr, 'qrcode', 'qrcode_id');
            const qrUrl = pickStr(qr, 'qrcode_img_content', 'qrcode_url', 'url');
            if (!qrcodeId || !qrUrl) {
                log('[weixin] Missing QR code fields; retrying in 5 seconds');
                await sleepWithSignal(5000, lifecycle?.signal);
                continue;
            }
            statusText = 'awaiting-scan';
            currentLoginUrl = qrUrl;
            log(`[weixin] Scan with Weixin to sign in: ${qrUrl}`);
            try {
                mkdirSync(dir, { recursive: true });
                writeFileSync(loginPath, `${qrUrl}\n`);
            }
            catch {          }
            while (!stopped) {
                let st;
                try {
                    st = await request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`, {}, 40_000, true);
                }
                catch {
                    await sleepWithSignal(2000, lifecycle?.signal);
                    continue;
                }
                const status = String(st.status ?? '');
                if (Number(st.ret ?? 0) === 0 && status === 'confirmed') {
                    const token = pickStr(st, 'bot_token');
                    const userId = pickStr(st, 'ilink_user_id');
                    if (!token || !userId)
                        throw new Error('Weixin sign-in confirmed but missing token/user');
                    const previousUserId = state.allowedUserId;
                    const newBaseUrl = pickStr(st, 'baseurl', 'base_url');
                    processing=true;
                    await config.onLogin?.({ userId, previousUserId });
                    state = {
                        allowedUserId: userId,
                        login: { token, userId },
                        contextTokens: {},
                        baseUrl: newBaseUrl || BASE_URL,
                    };
                    typingTickets.clear();
                    writePrivateFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
                    lastFlushed = `${JSON.stringify(state, null, 2)}\n`;
                    botToken = token;
                    log(`[weixin] Bound signed-in user: ${userId}`);
                    statusText = 'signed-in';
                    currentLoginUrl = undefined;
                    log('[weixin] Sign-in complete; persisted credentials will be reused after restart');
                    processing=false;
                    return true;
                }
                if (status === 'expired') {
                    log('[weixin] QR code expired; requesting a new code');
                    break;
                }
                await sleepWithSignal(2000, lifecycle?.signal);
            }
        }
        return false;
    }

    async function downloadCdn(mediaRef, aesKey) {
        const url = cdnUrlOf(mediaRef);
        if (!url)
            return undefined;
        try {
            const target = new URL(url);
            if (target.protocol !== 'https:' || target.username || target.password || isIP(target.hostname) || target.hostname === 'localhost' || target.hostname.endsWith('.localhost')) throw new Error('Invalid media URL');
            const res = await fetch(url, { signal: timeoutSignal(60_000, lifecycle?.signal), redirect: 'error' });
            if (!res.ok)
                throw new Error(`CDN download HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            const plain = aesKey ? decryptAesEcb(buf, aesKey) : buf;
            return { buf: plain, contentType: res.headers.get('content-type') ?? undefined };
        }
        catch (err) {
            log('[weixin] Media download failed');
            return undefined;
        }
    }

    async function downloadImageCdn(mediaRef, aesKey) {
        const url = cdnUrlOf(mediaRef);
        if (!url)
            throw new WeixinImageError('metadata');
        try {
            const target = new URL(url);
            const hostname = target.hostname.replace(/\.$/, '');

            if (target.protocol !== 'https:' || target.username || target.password
                || isIP(hostname) || hostname.includes(':')
                || hostname === 'localhost' || hostname.endsWith('.localhost'))
                throw new Error();
        }
        catch {
            throw new WeixinImageError('unsafe');
        }
        const parent = lifecycle?.signal;
        const signal = timeoutSignal(60_000, parent);
        for (let attempt = 0;; attempt++) {
            if (parent?.aborted)
                throw parent.reason;
            if (signal.aborted)
                throw new WeixinImageError('timeout');
            let res;
            let buf;
            try {
                res = await fetch(url, { signal, redirect: 'manual' });
                if (!res.ok) {
                    await res.body?.cancel().catch(() => undefined);
                    throw new WeixinImageError(res.status >= 500 ? 'server' : 'http', res.status);
                }
                try {
                    buf = Buffer.from(await res.arrayBuffer());
                }
                catch (error) {
                    await res.body?.cancel().catch(() => undefined);
                    throw error;
                }
                signal.throwIfAborted();
            }
            catch (error) {
                if (parent?.aborted)
                    throw parent.reason;
                if (signal.aborted)
                    throw new WeixinImageError('timeout');
                const e = error;
                const retryable = (e.status !== undefined && e.status >= 500 && e.status <= 599)
                    || ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(e.code ?? e.cause?.code ?? '');
                if (attempt >= 1 || !retryable)
                    throw imageTransportError(error);
                try {
                    await sleepWithSignal(150, signal);
                }
                catch {
                    if (parent?.aborted)
                        throw parent.reason;
                    throw new WeixinImageError('timeout');
                }
                continue;
            }
            try {
                return { buf: aesKey ? decryptAesEcb(buf, aesKey) : buf, contentType: res.headers.get('content-type') ?? undefined };
            }
            catch {
                throw new WeixinImageError('decrypt');
            }
        }
    }

    function saveMediaBuf(buf, ext, prefix, name) {
        mkdirSync(mediaDir, { recursive: true });
        const filePath = join(mediaDir, uniqueMediaFileName(prefix, ext, name));
        writeFileSync(filePath, buf);
        return filePath;
    }

    function aesKeyOf(mediaRef, hexKey, label) {
        if (hexKey)
            return Buffer.from(hexKey, 'hex');
        if (mediaRef) {
            const b64 = pickStr(mediaRef, 'aes_key');
            if (b64)
                return parseAesKey(b64, label);
        }
        return undefined;
    }

    async function downloadImageItem(item) {
        const img = item.image_item;
        const mediaRef = img?.media;
        let aesKey;
        try {
            const hex = img ? pickStr(img, 'aeskey') : undefined;
            if (hex && !/^[a-fA-F0-9]{32}$/.test(hex))
                throw new Error();
            aesKey = aesKeyOf(mediaRef, hex, 'wechat-image');
            if (!aesKey && Number(mediaRef?.encrypt_type) === 1)
                throw new Error();
        }
        catch {
            throw new WeixinImageError('decrypt');
        }
        const dl = await downloadImageCdn(mediaRef, aesKey);

        const buf = dl.buf;
        const ext = buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png'
            : buf.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? '.jpg'
                : /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii')) ? '.gif'
                    : buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? '.webp' : undefined;
        if (!ext)
            throw new WeixinImageError('format');
        const mediaType = mimeFromExt(ext);
        let saved;
        try {
            saved = saveMediaBuf(buf, ext, 'image', `image${ext}`);
        }
        catch {
            throw new WeixinImageError('storage');
        }
        return { kind: 'image', path: saved, mediaType, name: basename(saved) };
    }
    async function downloadVoiceItem(item) {
        const voice = item.voice_item;
        const mediaRef = voice?.media;
        const aesKey = aesKeyOf(mediaRef, undefined, 'wechat-voice');
        const dl = await downloadCdn(mediaRef, aesKey);
        if (!dl)
            return { kind: 'file', name: 'voice.silk' };
        const saved = saveMediaBuf(dl.buf, '.silk', 'voice', 'voice.silk');
        return { kind: 'file', path: saved, mediaType: 'audio/silk', name: basename(saved) };
    }
    async function downloadFileItem(item) {
        const fileItem = item.file_item;
        const mediaRef = fileItem?.media;
        const aesKey = aesKeyOf(mediaRef, undefined, 'wechat-file');
        const dl = await downloadCdn(mediaRef, aesKey);
        const fileName = fileItem ? pickStr(fileItem, 'file_name') ?? 'file.bin' : 'file.bin';
        if (!dl)
            return { kind: 'file', name: fileName };
        return { kind: 'file', data: dl.buf, name: fileName, mediaType: mimeFromExt(guessExt(fileName)) };
    }
    async function downloadVideoItem(item) {
        const videoItem = item.video_item;
        const mediaRef = videoItem?.media;
        const aesKey = aesKeyOf(mediaRef, undefined, 'wechat-video');
        const dl = await downloadCdn(mediaRef, aesKey);
        if (!dl)
            return { kind: 'video', name: 'video.mp4' };
        const saved = saveMediaBuf(dl.buf, '.mp4', 'video', 'video.mp4');
        return { kind: 'video', path: saved, mediaType: 'video/mp4', name: basename(saved) };
    }

    function parseInbound(raw) {
        if (!raw || typeof raw !== 'object')
            return null;
        let m = raw;
        if (m.message && typeof m.message === 'object')
            m = { ...m, ...m.message };
        if (m.message_type !== undefined && Number(m.message_type) !== 1)
            return null;
        const fromUserId = pickStr(m, 'from_user_id', 'from_user');
        if (!fromUserId || (state.allowedUserId && fromUserId !== state.allowedUserId))
            return null;
        const reference = m.item_list?.find(item => item?.ref_msg)?.ref_msg;
        const quotedItem = reference?.message_item;
        const quotedParts = [];
        let quoteMediaCount = 0;
        const parts = [];
        const media = [];
        if (typeof m.text === 'string')
            parts.push(m.text);
        for (const [items, target] of [[quotedItem ? [quotedItem] : [], quotedParts], [Array.isArray(m.item_list) ? m.item_list : [], parts]]) {
            for (const rawItem of items) {
                const it = rawItem;
                const type = Number(it.type ?? 0);
                try {
                    if (type === ITEM_TEXT) {
                        const textItem = it.text_item;
                        const t = textItem ? pickStr(textItem, 'text') : undefined;
                        if (t)
                            target.push(t);
                    }
                    else if (type === ITEM_IMAGE) {
                        media.push(Promise.resolve().then(() => downloadImageItem(it)));
                    }
                    else if (type === ITEM_VOICE) {
                        const voiceItem = it.voice_item;
                        const asr = voiceItem ? pickStr(voiceItem, 'text') : undefined;
                        if (asr) {

                            target.push(`[Voice] ${asr}`);
                        }
                        else {
                            media.push(Promise.resolve().then(() => downloadVoiceItem(it)));
                        }
                    }
                    else if (type === ITEM_FILE) {
                        media.push(Promise.resolve().then(() => downloadFileItem(it)));
                    }
                    else if (type === ITEM_VIDEO) {
                        media.push(Promise.resolve().then(() => downloadVideoItem(it)));
                    }
                }
                catch (err) {
                    log(`[weixin] Failed to parse media: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (target === quotedParts) quoteMediaCount = media.length;
        }
        const text = parts.join('').trim();
        const messageId = String(normalizeId(m.message_id) ?? normalizeId(m.msg_id) ?? `${fromUserId}:${String(m.create_time_ms ?? m.create_time ?? 0)}`);
        const contextToken = pickStr(m, 'context_token');
        const quoteText = quotedParts.join('') || (typeof reference?.title === 'string' ? reference.title : '');
        const quoteId = normalizeId(reference?.svr_id) ?? normalizeId(reference?.message_item?.msg_id);
        return { fromUserId, contextToken, text, media, messageId, quoteId, quoteText, quoteAvailable: !!quoteText || quoteMediaCount > 0, hasQuote: !!reference };
    }
    async function pollLoop() {
        const generation = lifecycle;
        const current = () => !stopped && lifecycle === generation && !generation?.signal.aborted;

        if (botToken) {
            statusText = 'signing-in';
            log('[weixin] Saved credentials found; checking connection');
        }
        else if (!(await loginLoop())) {
            return;
        }
        let cursor = state.syncBuf ?? '';
        let staleCount = 0;
        while (current()) {
            let data;
            try {
                data = await request('/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: { channel_version: '1.0.0' } }, (config.pollTimeoutSecs ?? 70) * 1000 + 5000);
            }
            catch (err) {
                if (!current())
                    return;
                const msg = err instanceof Error ? err.message : String(err);

                if (isStaleWeixinTokenError(err)) {
                    statusText = 'signing-in';
                    staleCount += 1;
                    if (staleCount >= 3) {
                        log('[weixin] Credentials rejected three times; clearing credentials, scan required');
                        botToken = '';
                        state.login = undefined;
                        state.syncBuf = undefined;
                        writePrivateFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
                        if (!(await loginLoop()))
                            return;
                        staleCount = 0;
                        cursor = state.syncBuf ?? '';
                        continue;
                    }
                    log(`[weixin] Credentials rejected (${staleCount}/3); retrying in 3 minutes`);
                    await sleepWithSignal(180_000, lifecycle?.signal);
                    continue;
                }
                staleCount = 0;
                log(`[weixin] Polling failed; retrying in 5 seconds: ${msg}`);
                await sleepWithSignal(5000, lifecycle?.signal);
                continue;
            }
            if (!current())
                return;
            staleCount = 0;
            statusText = 'signed-in';
            const nextCursor = pickStr(data, 'get_updates_buf', 'cursor', 'sync_buf') ?? cursor;
            if (nextCursor !== cursor) {
                cursor = nextCursor;
                state.syncBuf = cursor;
            }
            const rawList = data.msgs ?? data.messages ?? data.updates;
            if (Array.isArray(rawList)) {
                for (const raw of rawList) {
                    if (!current())
                        return;
                    try {
                        const parsed = parseInbound(raw);
                        if (!parsed)
                            continue;
                        if (parsed.contextToken)
                            state.contextTokens[parsed.fromUserId] = parsed.contextToken;
                        if (state.allowedUserId && parsed.fromUserId !== state.allowedUserId)
                            continue;

                        processing=true;
                        const settled = await Promise.allSettled(parsed.media);
                        if (!current())
                            return;
                        const media = [];
                        let mediaFailed = false;
                        let imageFailure;
                        for (const item of settled) {
                            if (item.status === 'fulfilled') {
                                if (item.value.kind === 'image' && !item.value.path && !item.value.data)
                                    mediaFailed = true;
                                else
                                    media.push(item.value);
                            }
                            else {
                                mediaFailed = true;
                                if (item.reason instanceof WeixinImageError) {
                                    imageFailure ??= item.reason;
                                    log(`[weixin] Image download failed category=${item.reason.kind}: ${item.reason.message}`);
                                }
                                else
                                    log('[weixin] Media download failed');
                            }
                        }
                        if (mediaFailed) {
                            if (!current())
                                return;
                            const feedback = imageFailure
                                ? notices.imageFailed(notices.reason(imageFailure.kind, imageFailure.status))
                                : notices.mediaFailed();
                            await sendText(parsed.fromUserId, feedback).catch(() => log('[weixin] Failed to send media feedback'));

                            continue;
                        }
                        if (parsed.text === '' && media.length === 0 && !parsed.hasQuote)
                            continue;
                        if (!current())
                            return;
                        void handler?.({
                            messageId: parsed.messageId,
                            quoteId: parsed.quoteId,
                            hasQuote: parsed.hasQuote,
                            quoteText: parsed.quoteText,
                            quoteAvailable: parsed.quoteAvailable,
                            chatId: parsed.fromUserId,
                            userId: parsed.fromUserId,
                            text: parsed.text,
                            media,
                            context: { contextToken: parsed.contextToken },
                        });
                    }
                    catch (error) {
                        log(`[weixin] Message dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    finally { processing=false; }
                }
            }
            flush();
        }
    }

    async function sendRaw(toUserId, item, clientId, signal, beforeSubmit) {
        const userId = state.allowedUserId;
        if (statusText !== 'signed-in' || !userId || toUserId !== userId) throw new Error('Weixin recipient is not the signed-in user');
        const contextToken = state.contextTokens[toUserId];
        return await outbound.run(toUserId, () => {
            if (statusText !== 'signed-in' || state.allowedUserId !== userId || toUserId !== userId) throw new Error('Weixin signed-in user has changed');
            return request('/ilink/bot/sendmessage', {
                msg: {
                    from_user_id: '',
                    to_user_id: toUserId,
                    client_id: clientId,
                    message_type: 2,
                    message_state: 2,
                    context_token: contextToken ?? '',
                    item_list: [item],
                },
                base_info: { channel_version: '1.0.0' },
            }, 15_000, false, signal, beforeSubmit);
        });
    }
    async function sendText(toUserId, text, beforeSubmit, signal) {
        return await sendRaw(toUserId, { type: ITEM_TEXT, text_item: { text } }, `dsh-im-connect:${Date.now()}:${Math.floor(Math.random() * 1e6)}`, signal, beforeSubmit);
    }

    async function sendTypingStatus(toUserId, status) {
        try {
            let cached = typingTickets.get(toUserId);
            if (!cached || Date.now() >= cached.nextFetchAt) {
                const resp = await request('/ilink/bot/getconfig', { ilink_user_id: toUserId, context_token: state.contextTokens[toUserId] ?? '', base_info: { channel_version: '1.0.0' } }, 15_000);
                const ticket = pickStr(resp, 'typing_ticket');
                if (!ticket)
                    return;
                cached = { ticket, nextFetchAt: Date.now() + 5 * 60_000 };
                typingTickets.set(toUserId, cached);
            }
            await request('/ilink/bot/sendtyping', { ilink_user_id: toUserId, typing_ticket: cached.ticket, status, base_info: { channel_version: '1.0.0' } }, 10_000);
        }
        catch (err) {
            log(`[weixin] Typing notification failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async function uploadToCdn(filePath, toUserId, mediaType, signal) {
        const plaintext = await readFile(filePath);
        const rawsize = plaintext.length;
        const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
        const filesize = aesEcbPaddedSize(rawsize);
        const filekey = randomBytes(16).toString('hex');
        const aeskey = randomBytes(16);
        const resp = await request('/ilink/bot/getuploadurl', {
            filekey,
            media_type: mediaType,
            to_user_id: toUserId,
            rawsize,
            rawfilemd5,
            filesize,
            no_need_thumb: true,
            aeskey: aeskey.toString('hex'),
        }, 20_000, false, signal);
        const uploadFullUrl = pickStr(resp, 'upload_full_url')?.trim();
        const uploadParam = pickStr(resp, 'upload_param');
        if (!uploadFullUrl && !uploadParam)
            throw new Error('getuploadurl response is missing an upload URL');
        const cdnUrl = uploadFullUrl ?? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
        const ciphertext = encryptAesEcb(plaintext, aeskey);
        const upRes = await fetch(validateWeixinUploadUrl(cdnUrl), {
            redirect: 'error',
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array(ciphertext),
            signal: AbortSignal.any([timeoutSignal(120_000, lifecycle?.signal), ...(signal ? [signal] : [])]),
        });
        if (upRes.status !== 200) {
            const errMsg = upRes.headers.get('x-error-message') ?? `HTTP ${upRes.status}`;
            throw new Error(`CDN upload failed: ${errMsg}`);
        }
        const downloadParam = upRes.headers.get('x-encrypted-param');
        if (!downloadParam)
            throw new Error('CDN upload response is missing x-encrypted-param');
        return { downloadParam, aeskeyHex: aeskey.toString('hex'), rawsize, filesizeCiphertext: filesize };
    }

    async function sendMediaFile(toUserId, filePath, caption, signal, beforeSubmit) {
        const mime = mimeFromExt(guessExt(filePath));
        const now = Date.now();
        let item;
        if (mime.startsWith('image/')) {
            const up = await uploadToCdn(filePath, toUserId, UPLOAD_IMAGE, signal);
            item = {
                type: ITEM_IMAGE,
                image_item: {
                    media: {
                        encrypt_query_param: up.downloadParam,
                        aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
                        encrypt_type: 1,
                    },
                    mid_size: up.filesizeCiphertext,
                },
            };
        }
        else if (mime.startsWith('video/')) {
            const up = await uploadToCdn(filePath, toUserId, UPLOAD_VIDEO, signal);
            item = {
                type: ITEM_VIDEO,
                video_item: {
                    media: {
                        encrypt_query_param: up.downloadParam,
                        aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
                        encrypt_type: 1,
                    },
                    video_size: up.filesizeCiphertext,
                },
            };
        }
        else {
            const up = await uploadToCdn(filePath, toUserId, UPLOAD_FILE, signal);
            item = {
                type: ITEM_FILE,
                file_item: {
                    media: {
                        encrypt_query_param: up.downloadParam,
                        aes_key: Buffer.from(up.aeskeyHex).toString('base64'),
                        encrypt_type: 1,
                    },
                    file_name: basename(filePath),
                    len: String(up.rawsize),
                },
            };
        }
        if (caption)
            await sendText(toUserId, caption);
        signal?.throwIfAborted();
        return await sendRaw(toUserId, item, `dsh-im-connect:${now}:${randomBytes(4).toString('hex')}`, signal, beforeSubmit);
    }
    return {
        isBusy: () => processing,
        id: 'weixin',
        label: 'Weixin',
        maxMessageLength: 1200,
        async start() {
            lifecycle?.abort();
            lifecycle = new AbortController();
            stopped = false;
            statusText = 'signing-in';
            pollTask = pollLoop().catch((error) => {
                processing=false;
                if (stopped || isAbortError(error))
                    return;
                statusText = 'failed';
                currentLoginUrl = undefined;
                log(`[weixin] Polling loop exited: ${error instanceof Error ? error.message : String(error)}`);
            });
        },
        async stop() {
            stopped = true;
            lifecycle?.abort();
            await pollTask?.catch(() => undefined);
            pollTask = undefined;
            lifecycle = undefined;
            statusText = 'stopped';
            flush();
        },
        async send(chatId, text, beforeSubmit, signal) {
            return await sendText(chatId, text, beforeSubmit, signal);
        },
        typingIntervalMs: 5000,
        async stopAction(chatId) { await sendTypingStatus(chatId, 2); },
        async sendAction(chatId) {
            await sendTypingStatus(chatId, 1);
        },
        async sendFile(chatId, file, signal, beforeSubmit) {
            signal = AbortSignal.any([timeoutSignal(120_000, lifecycle?.signal), ...(signal ? [signal] : [])]);
            signal.throwIfAborted();
            const { withOutgoingPath } = await import('./file-send.js');
            return await withOutgoingPath(file, async (path) => { signal?.throwIfAborted(); return await sendMediaFile(chatId, path, undefined, signal, beforeSubmit); }, dir);
        },
        async sendMedia(chatId, filePath, caption) {
            await sendMediaFile(chatId, filePath, caption);
        },
        loginUrl() {
            return currentLoginUrl;
        },
        userId() {
            return state.allowedUserId;
        },
        authorizes(userId) {
            if (state.allowedUserId)
                return state.allowedUserId === userId;
            return undefined;
        },
        setMessageHandler(h) {
            handler = h;
        },
        async diagnose(signal) {
            return [await probe('config', signal, async () => {
                    if (!botToken)
                        throw new DiagnosticError('auth');
                    const userId = state.allowedUserId;
                    if (!userId)
                        throw new DiagnosticError('missing-context');
                    const base = new URL(state.baseUrl || BASE_URL);
                    if (base.protocol !== 'https:' || !(base.hostname === 'weixin.qq.com' || base.hostname.endsWith('.weixin.qq.com')) || base.username || base.password)
                        throw new DiagnosticError('unsupported');
                    const data = await diagnosticJson(`${base.origin}/ilink/bot/getconfig`, signal, { ilink_user_id: userId, context_token: state.contextTokens[userId] ?? '', base_info: { channel_version: '1.0.0' } }, headers());
                    platformResult(data.ret ?? data.errcode, [-14]);
                    if (data.errcode !== undefined)
                        platformResult(data.errcode, [-14]);
                    requireDiagnostic(typeof data.typing_ticket === 'string' && data.typing_ticket);
                })];
        },
        status() {
            return statusText;
        },
    };
}
export function weixinStatePath(stateDir) {
    return join(stateDir, 'wechat-state.json');
}
export function readWeixinAllowedUserId(stateDir) {
    try {
        const parsed = JSON.parse(readFileSync(weixinStatePath(stateDir), 'utf8'));
        const id = parsed.allowedUserId?.trim();
        return id || undefined;
    }
    catch {
        return undefined;
    }
}

export function readLegacyWeixinBotToken(stateDir) {
    try {
        const parsed = JSON.parse(readFileSync(weixinStatePath(stateDir), 'utf8'));
        return parsed.botToken?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
export function persistWeixinLogin(stateDir, data) {
    mkdirSync(stateDir, { recursive: true });
    const file = weixinStatePath(stateDir);
    let prev = { contextTokens: {} };
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        prev = {
            allowedUserId: parsed.allowedUserId,
            login: parsed.login,
            contextTokens: parsed.contextTokens ?? {},
            baseUrl: parsed.baseUrl,
            syncBuf: parsed.syncBuf,
        };
    }
    catch {            }
    const next = {
        ...prev,
        allowedUserId: data.allowedUserId || prev.allowedUserId,
        login: !data.allowedUserId || data.allowedUserId === prev.allowedUserId ? prev.login : undefined,
        baseUrl: data.baseUrl || prev.baseUrl,
    };
    writePrivateFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}
export function clearWeixinLogin(stateDir) {
    rmSync(weixinStatePath(stateDir), { force: true });
    rmSync(join(stateDir, 'wechat-login.txt'), { force: true });
}
