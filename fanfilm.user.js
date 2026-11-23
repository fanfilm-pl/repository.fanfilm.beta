// ==UserScript==
// @name         FanFilm
// @namespace    http://tampermonkey.net/
// @version      0.2.20261122.1
// @description  Web service
// @author       kpl-team
// @match        http*://imdb.com/*
// @match        http*://*.imdb.com/*
// @match        http*://cda-hd.cc/*
// @match        http*://zaluknij.cc/*
// @match        http*://filmyonline.cc/*
// @match        http*://filman.cc/*
// @match        http*://netmirror.gg/tv*
// @match        http*://p.111477.xyz/*
// @icon         https://raw.githubusercontent.com/fanfilm-pl/repository.fanfilm.beta/refs/heads/main/favicon.png
// @downloadURL  https://raw.githubusercontent.com/fanfilm-pl/repository.fanfilm.beta/refs/heads/main/fanfilm.user.js
// @updateURL    https://raw.githubusercontent.com/fanfilm-pl/repository.fanfilm.beta/refs/heads/main/fanfilm.user.js
// @include      http://*:8663/*
// @include      https://*:8663/*
// @require      https://raw.githubusercontent.com/dchest/tweetnacl-js/1.0.3/nacl.min.js#sha256=973cc5733cc7432e30ee4682098f413094f494bccf76a567c23908c5035ddbbc
// @grant        GM.xmlHttpRequest
// @grant        GM.cookie
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

const fanfilmDefaultPort = 8663;
// X25519 of the key agreement of a pairing (tweetnacl, `@require`; the tests: web/mod/nacl.min.js, the same file).
const fanfilmNacl = typeof nacl !== 'undefined' ? nacl : (typeof require === 'function' ? require('./nacl.min.js') : null);
const fanfilmEncoder = new TextEncoder();
// The size of the nonce of a seal, of its tag, of a block of its stream (bytes; FanFilm/lib/service/web_crypto.py).
const fanfilmNonceSize = 24;
const fanfilmTagSize = 32;
const fanfilmBlockSize = 32;
var fanfilmRoot;
var fanfilmMessageTimer = null;
var fanfilmSendTimer = null;
const fanfilmMessageHideInterval = 4000;
const fanfilmUpdateInterval = 5000;

// The page of the FanFilm web server itself (it hands this script its access: `fanfilm-pair-script`).
const fanfilmOnServerPage = typeof document !== 'undefined' && document.querySelector('meta[name="application-name"][content="FanFilm"]') !== null;

// Zmienne do śledzenia statusu wysyłania
var fanfilmSendResults = {};
var fanfilmSendWarning = '';  // the warning of a FanFilm answer (shown in the status)
var fanfilmTotalHosts = 0;

// --- the texts of the widget in the language of a Kodi (its `/texts`, kept in this browser; none yet: English) ---

// The texts of a Kodi kept in this browser: {language, texts: {<English>: <text>}}.
var fanfilmText = {language: '', texts: {}};
// The texts read on this page already (once a page: after the first sending to a Kodi - its language, the texts of a newer FanFilm).
var fanfilmTextsRead = false;

// A text of the widget by its English text, its `{name}` places filled by `values` (as the page of FanFilm).
function T(text, values = {})
{
    return (fanfilmText.texts[text] || text).replace(/\{(\w+)\}/g, (place, name) => name in values ? String(values[name]) : place);
}

// The texts of a Kodi read (`force`: again - after a pairing, after the first sending of a page; else only when none are kept), the widget
// shown in them; an older FanFilm answers the texts alone.
async function fanfilmLoadTexts(target, force = false)
{
    if (!target || !force && Object.keys(fanfilmText.texts).length)
        return;
    try {
        // public: never signed - the access kept may be gone (unpaired in Kodi: 401), the texts come anyway
        const answer = await fanfilmRequest({host: target.host, tls: target.tls}, 'GET', '/texts');
        if (answer.status !== 200 || !answer.json) {
            console.error('[FanFilm] Texts:', answer.status, answer.json);
            return;
        }
        fanfilmText = answer.json.texts ? answer.json : {language: '', texts: answer.json};
        fanfilmTextsRead = true;
        GM_setValue('ff_texts', fanfilmText);
        fanfilmPanelTexts();
        fanfilmRenderTargets();
    } catch (err) {
        console.error('[FanFilm] Texts:', err);
    }
}

// The texts of the parts of the widget (at its start, again when the texts of a Kodi come).
function fanfilmPanelTexts()
{
    const set = (id, text, attribute = 'textContent') => {
        const element = fanfilmRoot.getElementById(id);
        if (element)
            element[attribute] = text;
    };
    set('ff-targets-label', T('Kodi (☑ send)'));
    set('ff-add', T('IP or IP:PORT'), 'placeholder');
    set('ff-port-info', T('Default port: {port}.', {port: fanfilmDefaultPort}));
    set('ff-pair-with', T('Connect to {host}:', {host: fanfilmHostLabel(fanfilmPairing.host || '')}));
    set('ff-pair-code', T('Code from the TV'), 'placeholder');
    set('ff-pair-code-button', T('Connect with the code'));
    set('ff-pair-request-button', T('Ask for access (QR code)'));
    set('ff-pair-img', T('QR code'), 'alt');
    set('ff-pair-scan', T('Scan with a phone connected to FanFilm or approve in Kodi.'));
    set('ff-pair-match-label', `${T('Match code')}:`);
    set('ff-pair-cancel', T('Cancel'));
    set('ff-send', T('Send'));
    const imdb = fanfilmRoot.getElementById('ff-imdb-user-add');
    if (imdb && imdb.dataset.nick)
        imdb.textContent = T('Add {nick} as a public IMDb account', {nick: imdb.dataset.nick});
}

function sleep(ms)
{
    return new Promise(resolve => setTimeout(resolve, ms));
}

function hasClass(element, className)
{
    return (' ' + element.className + ' ').indexOf(' ' + className+ ' ') > -1;
}

function toHash(data)
{
    if (!(typeof data === 'string' || data instanceof String)) {
        data = JSON.stringify(data);
    }
    return data.split('').reduce((hash, char) => {
        return char.charCodeAt(0) + (hash << 6) + (hash << 16) - hash;
    }, 0);
}

// A host with the default port of FanFilm (`192.168.1.5` -> `192.168.1.5:8663`).
function fanfilmHostPort(host)
{
    host = host.trim();
    return host.includes(":") ? host : `${host}:${fanfilmDefaultPort}`;
}

// A host as shown (the default port of FanFilm left out: `192.168.1.5:8663` -> `192.168.1.5`, another port kept).
function fanfilmHostLabel(host)
{
    return host.endsWith(`:${fanfilmDefaultPort}`) ? host.slice(0, -`:${fanfilmDefaultPort}`.length) : host;
}

// The targets (Kodi with FanFilm) of an older list of hosts (`ff_target_hosts`): every one sent to, none paired yet.
function fanfilmMigrateTargets(hosts)
{
    return hosts.filter(host => host.trim()).map(host => ({host: fanfilmHostPort(host), enabled: true}));
}

// The access of the targets paired before the key agreement forgotten (FanFilm removed their devices: they pair again); true if any.
function fanfilmForgetOldAccess(targets)
{
    const old = targets.filter(target => target.token);
    for (const target of old) {
        delete target.token;
        delete target.device;
    }
    return old.length > 0;
}

// The targets: {host, enabled (☑: sent to), id (of the FanFilm), name (of the Kodi), key (hex), device, tls, offset (of the clock), last}.
function fanfilmTargets()
{
    let targets = GM_getValue("ff_targets", null);
    if (targets === null) {
        targets = fanfilmMigrateTargets(GM_getValue("ff_target_hosts", ['127.0.0.1']));
        GM_setValue("ff_targets", targets);
    } else if (fanfilmForgetOldAccess(targets)) {
        GM_setValue("ff_targets", targets);
    }
    return targets;
}

function fanfilmSaveTargets(targets)
{
    GM_setValue("ff_targets", targets);
}

// The targets sent to (☑).
function fanfilmEnabledTargets()
{
    return fanfilmTargets().filter(target => target.enabled);
}

// Unpair the device of a target on its FanFilm (a signed `/pair/logout` by its old key): True if FanFilm knows it no more (it answered,
// also "not paired"), False with no connection; a target without a key: True (nothing to unpair).
async function fanfilmLogout(target)
{
    if (!target || !target.key || !target.device)
        return true;
    try {
        const answer = await fanfilmRequest(target, 'POST', '/pair/logout', {});
        return answer.status === 200 || answer.status === 401;
    } catch (err) {
        return false;
    }
}

// The target a new access of a FanFilm replaces (`fanfilmUpsertTarget()`: of its ID, else of its host), a copy (its old key): undefined none.
function fanfilmOldTarget(info)
{
    const host = fanfilmHostPort(info.host);
    const found = fanfilmTargets().find(t => info.instance && t.id === info.instance) || fanfilmTargets().find(t => t.host === host);
    return found && {...found};
}

// Add a FanFilm paired by its page (or by a code, a request): the target of the same FanFilm (its ID, else its host) is updated,
// the others are kept (a new address of the same Kodi replaces its old one).
function fanfilmUpsertTarget(targets, info)
{
    const host = fanfilmHostPort(info.host);
    let target = targets.find(t => info.instance && t.id === info.instance) || targets.find(t => t.host === host);
    if (!target) {
        target = {host: host, enabled: true};
        targets.push(target);
    }
    Object.assign(target, {host: host, id: info.instance || target.id, name: info.name || target.name, key: info.key,
                           device: info.device ? info.device.id : target.device, tls: !!info.tls, offset: 0});
    return targets;
}

function fanfilmHex(buffer)
{
    return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

function fanfilmBase64(buffer)
{
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function fanfilmFromBase64(text)
{
    return Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
}

function fanfilmFromHex(text)
{
    return Uint8Array.from(text.match(/../g) || [], pair => parseInt(pair, 16));
}

function fanfilmConcat(...parts)
{
    const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

// The 4 bytes of a number, big-endian.
function fanfilmU32(n)
{
    return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

// HMAC-SHA256 of the data by a key (WebCrypto: this script runs on HTTPS pages; an empty key is the zeros of its block, as HMAC pads it).
async function fanfilmHmac(key, data)
{
    const subtle = crypto.subtle;
    const imported = await subtle.importKey('raw', key.length ? key : new Uint8Array(32), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', imported, data));
}

// HKDF-SHA256 (RFC 5869), as FanFilm/lib/service/web_crypto.py.
async function fanfilmHkdf(material, salt, info, length = 32)
{
    const prk = await fanfilmHmac(salt, material);
    let out = new Uint8Array(0), block = new Uint8Array(0);
    for (let counter = 1; out.length < length; counter++) {
        block = await fanfilmHmac(prk, fanfilmConcat(block, info, Uint8Array.of(counter)));
        out = fanfilmConcat(out, block);
    }
    return out.slice(0, length);
}

// The key of the device paired by the key of its pairing.
function fanfilmDeviceKey(pairing)
{
    return fanfilmHkdf(pairing, new Uint8Array(0), fanfilmEncoder.encode('device'));
}

async function fanfilmSealKeys(key)
{
    const none = new Uint8Array(0);
    return [await fanfilmHkdf(key, none, fanfilmEncoder.encode('seal enc')), await fanfilmHkdf(key, none, fanfilmEncoder.encode('seal mac'))];
}

// The stream of a seal: HMAC-SHA256 of the nonce and of the number of the block (4 bytes, big-endian).
async function fanfilmStream(key, nonce, size)
{
    const out = new Uint8Array(Math.ceil(size / fanfilmBlockSize) * fanfilmBlockSize);
    for (let number = 0; number * fanfilmBlockSize < size; number++) {
        out.set(await fanfilmHmac(key, fanfilmConcat(nonce, fanfilmU32(number))), number * fanfilmBlockSize);
    }
    return out.slice(0, size);
}

function fanfilmTag(key, direction, binding, nonce, sealed)
{
    return fanfilmHmac(key, fanfilmConcat(fanfilmEncoder.encode(direction), fanfilmU32(binding.length), binding, nonce, sealed));
}

// The seal of the data by the key, bound to the binding and the direction ('req', 'res'): base64 of nonce, ciphertext, tag
// (FanFilm/lib/service/web_crypto.py: a listener of the network never reads the cookies).
async function fanfilmSeal(key, data, binding, direction, nonce)
{
    const [enc, mac] = await fanfilmSealKeys(key);
    nonce = nonce || crypto.getRandomValues(new Uint8Array(fanfilmNonceSize));
    const stream = await fanfilmStream(enc, nonce, data.length);
    const sealed = data.map((byte, i) => byte ^ stream[i]);
    return fanfilmBase64(fanfilmConcat(nonce, sealed, await fanfilmTag(mac, direction, binding, nonce, sealed)));
}

// The data of a seal; a broken one (or of another key, binding, direction): an error.
async function fanfilmUnseal(key, text, binding, direction)
{
    const raw = fanfilmFromBase64(text);
    if (raw.length < fanfilmNonceSize + fanfilmTagSize) {
        throw new Error('broken seal');
    }
    const nonce = raw.slice(0, fanfilmNonceSize), sealed = raw.slice(fanfilmNonceSize, raw.length - fanfilmTagSize);
    const got = raw.slice(raw.length - fanfilmTagSize);
    const [enc, mac] = await fanfilmSealKeys(key);
    const want = await fanfilmTag(mac, direction, binding, nonce, sealed);
    if (got.length !== want.length || got.reduce((diff, byte, i) => diff | (byte ^ want[i]), 0) !== 0) {
        throw new Error('broken seal');
    }
    const stream = await fanfilmStream(enc, nonce, sealed.length);
    return sealed.map((byte, i) => byte ^ stream[i]);
}

// The time of a signature: seconds with a random end (two requests of one second are never signed alike).
function fanfilmStamp(offset)
{
    const [high, low] = crypto.getRandomValues(new Uint8Array(2));
    return `${(Date.now() / 1000 + (offset || 0)).toFixed(3)}${String(((high << 8) | low) % 1000).padStart(3, '0')}`;
}

// The signature of a request (FanFilm/lib/service/web_auth.py: request_signature): HMAC-SHA256 by the key of the device (hex) of
// "<METHOD>\n<path>\n<time>\n<SHA-256 of the body, hex>" - the key itself never goes over the network.
async function fanfilmSignature(key, method, path, stamp, body)
{
    const bodyHash = fanfilmHex(await crypto.subtle.digest('SHA-256', fanfilmEncoder.encode(body || '')));
    return fanfilmBase64(await fanfilmHmac(fanfilmFromHex(key), fanfilmEncoder.encode(`${method.toUpperCase()}\n${path}\n${stamp}\n${bodyHash}`)));
}

// A new key agreement of a pairing with a FanFilm (X25519): its ID and the key of its seals; an error (its `status`) if refused.
async function fanfilmAgree(host)
{
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const own = fanfilmNacl.scalarMult.base(secret);
    const answer = await fanfilmRequest({host: host}, "POST", "/pair/key", {key: fanfilmBase64(own)});
    if (answer.status !== 200) {
        const error = new Error(`key agreement: ${answer.status}`);
        error.status = answer.status;
        throw error;
    }
    return {sid: answer.json.sid, key: await fanfilmPairingKey(secret, own, fanfilmFromBase64(answer.json.key), answer.json.sid)};
}

// The key of the seals of a pairing: HKDF of X25519 of the own secret and the key of FanFilm, salted by the transcript (both public keys,
// the ID of the agreement); a key of FanFilm of no agreement (zero of X25519): an error.
async function fanfilmPairingKey(secret, own, server, sid)
{
    const shared = fanfilmNacl.scalarMult(secret, server);
    if (!shared.some(byte => byte)) {
        throw new Error('no key agreement');
    }
    return fanfilmHkdf(shared, fanfilmConcat(own, server, fanfilmEncoder.encode(sid)), fanfilmEncoder.encode('pair'));
}

// A request to a FanFilm: {status, json}. A paired target signs it and seals its content and answer by the key of its device; a request
// of a pairing (`agreement`) seals them by the key of its agreement. A refused time of the signature corrects the clock once.
async function fanfilmRequest(target, method, path, data, retry = true, agreement = null)
{
    let body = data === undefined ? '' : JSON.stringify(data);
    const headers = {};
    let key = null, binding = null, answerBinding = null, stamp = null;
    if (target.key) {
        key = fanfilmFromHex(target.key);
        stamp = fanfilmStamp(target.offset);
        binding = fanfilmEncoder.encode(`${method.toUpperCase()}\n${path}\n${stamp}`);
    } else if (agreement) {
        key = agreement.key;
        binding = answerBinding = fanfilmEncoder.encode(`${method.toUpperCase()}\n${path}\n${agreement.sid}`);
        headers["X-FF-Pair"] = agreement.sid;
    }
    if (data !== undefined) {
        headers["Content-Type"] = "application/json;charset=UTF-8";
        if (key) {
            body = JSON.stringify({sealed: await fanfilmSeal(key, fanfilmEncoder.encode(body), binding, 'req')});
        }
    }
    if (target.key) {
        const signature = await fanfilmSignature(target.key, method, path, stamp, body);
        Object.assign(headers, {"X-FF-Device": target.device, "X-FF-Time": stamp, "X-FF-Signature": signature});
        answerBinding = fanfilmEncoder.encode(signature);
    }
    const response = await new Promise((resolve, reject) => {
        GM.xmlHttpRequest({
            method: method, url: `${target.tls ? 'https' : 'http'}://${target.host}${path}`, headers: headers,
            ...(data === undefined ? {} : {data: body}), onload: resolve, onerror: reject, ontimeout: reject, timeout: 30000,
        });
    });
    if (!response.status) {  // no answer (the browser or Tampermonkey did not let it through): no connection, not a refusal of FanFilm
        throw new Error('no connection');
    }
    let json = null;
    try {
        json = JSON.parse(response.responseText);
    } catch (e) {
        json = null;
    }
    if (json && key && typeof json.sealed === 'string') {
        json = JSON.parse(new TextDecoder().decode(await fanfilmUnseal(key, json.sealed, answerBinding, 'res')));
    } else if (json && key && response.status >= 200 && response.status < 300) {  // FanFilm seals every answer of a key
        throw new Error('answer not sealed');
    }
    if (response.status === 401 && json && json.error === 'time' && retry) {
        const targets = fanfilmTargets();
        const stored = targets.find(t => t.host === target.host);
        target.offset = json.time - Date.now() / 1000;
        if (stored) {
            stored.offset = target.offset;
            fanfilmSaveTargets(targets);
        }
        return fanfilmRequest(target, method, path, data, false, agreement);
    }
    return {status: response.status, json: json};
}

// Remember the result of the last sending to a target (its status in the list).
function fanfilmSetLast(host, status)
{
    const targets = fanfilmTargets();
    const target = targets.find(t => t.host === host);
    if (target) {
        target.last = {status: status, time: Date.now()};
        fanfilmSaveTargets(targets);
    }
}

function fanfilmMessage(cls, msg)
{
    const ffStatus = fanfilmRoot.getElementById("ff-status");
    // Set message and class (type)
    ffStatus.textContent = msg;
    ffStatus.className = cls || '';
    // Clear active message timer
    if (fanfilmMessageTimer) {
        clearTimeout(fanfilmMessageTimer);
    }
    // Set new timer to clear message (after 4 sec)
    fanfilmMessageTimer = setTimeout(() => {
        ffStatus.textContent = '';
        ffStatus.className = '';
    }, fanfilmMessageHideInterval);
}

function fanfilmUpdateStatus() {
    const completed = Object.keys(fanfilmSendResults).length;

    if (completed < fanfilmTotalHosts) {
        return;
    }

    const successes = Object.values(fanfilmSendResults).filter(result => result === 'success').length;
    const errors = Object.values(fanfilmSendResults).filter(result => result === 'error').length;

    if (successes > 0 && errors === 0 && fanfilmSendWarning) {
        fanfilmMessage('partial', `⚠️ ${fanfilmSendWarning}`);  // sent, but nothing usable (e.g. IMDb without at-main)
    } else if (successes > 0 && errors === 0) {
        fanfilmMessage('success', `✅ ${T('Sent to Kodi')}`);
    } else if (errors > 0 && successes === 0) {
        fanfilmMessage('error', `❌ ${T('Sending error!')}`);
    } else {
        fanfilmMessage('partial', `⚠️ ${T('Sent: {done}/{all}', {done: successes, all: fanfilmTotalHosts})}`);
    }

    fanfilmSendResults = {};
    fanfilmTotalHosts = 0;
    fanfilmSendWarning = '';
}

function fanfilmLoadSites(host) {
    let sites = GM_getValue('ff_sites', {});
    let site = sites[location.hostname]
    if (!site) {
        sites[location.hostname] = site = {
            hosts: {},
        }
    }
    let host_data = null;
    if (host) {
        host_data = site.hosts[host];
        if(!host_data) {
            site.hosts[host] = host_data = {
                timestamp: 0,
                cookies: 0,
                status: '',
            }
        }
    }
    return [sites, site, host_data]
}

async function fanfilmCookies(options)
{
    // Pobranie cookies
    let cookies = await GM.cookie.list({url: location.hostname, partitionKey: {}});
    if (!options) {
        options = {}
    }
    let data = {
        host: location.hostname,
        user_agent: navigator.userAgent,
        cookies: cookies,
    };
    // console.log("[FanFilm] Zebrane dane:", data);
    return data
}

// __NEXT_DATA__ ma prawdziwe id (`ur#######`) - adres `p.xxxxxxxx` z paska to tylko kosmetyka,
// której nie przyjmuje API.
function fanfilmExtractImdbUser()
{
    if (!location.hostname.endsWith('imdb.com')) {
        return null;
    }
    try {
        const el = document.getElementById('__NEXT_DATA__');
        const pageProps = el && JSON.parse(el.textContent)?.props?.pageProps;
        const id = pageProps?.userId;
        if (!/^ur\d+$/.test(id)) {
            return null;
        }
        const nick = pageProps?.userNickName?.value || id;
        return {id, nick};
    } catch (e) {
        return null;
    }
}

// Leci przez /cookies (jak reszta ciasteczek) na każdą skonfigurowaną instancję Kodi - tam,
// zgodnie z const.py (web_server.cookies['www.imdb.com'][':imdb_user_id']) FanFilm tworzy publiczne
// konto IMDb tego użytkownika (istniejące zostaje).
async function fanfilmAddImdbUser(urId)
{
    const targets = fanfilmEnabledTargets();
    if (!targets.length) {
        fanfilmMessage('error', `❌ ${T('No host set up!')}`);
        return;
    }
    // Pełny fanfilmCookies() (nie tylko {host, imdb_user_id}!) - inaczej pusta lista ciasteczek
    // wyzerowałaby przy okazji imdb.at-main (ten sam wpis 'www.imdb.com' obsługuje oba pola).
    const data = {...await fanfilmCookies(), imdb_user_id: urId};
    const send = async (target) => {
        const answer = await fanfilmRequest(target, "POST", "/cookies", data);
        if (answer.status !== 200) {
            throw new Error(`HTTP ${answer.status}`);
        }
    };
    const results = await Promise.allSettled(targets.map(send));
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            console.error(`[FanFilm] Adding the IMDb account (${targets[i].host}):`, r.reason);
        }
    });
    const errors = results.filter(r => r.status === 'rejected').length;
    const hosts = targets;
    if (errors === hosts.length) {
        fanfilmMessage('error', `❌ ${T('Sending error!')}`);
    } else if (errors > 0) {
        fanfilmMessage('partial', `⚠️ ${T('Sent: {done}/{all}', {done: hosts.length - errors, all: hosts.length})}`);
    } else {
        fanfilmMessage('success', `✅ ${T('Sent to Kodi')}`);
    }
}

async function fanfilmSendOne(target, options)
{
    const host = target.host;
    if (!options) {
        options = {};
    }
    const cookies = options.cookies ? options.cookies : await fanfilmCookies(options);
    const hash = toHash(cookies);

    let [sites, site, site_host] = fanfilmLoadSites(host);
    site_host.cookies_hash = hash;
    site_host.timestamp = Date.now();
    GM_setValue('ff_sites', sites);

    const interval = fanfilmUpdateInterval;
    if (fanfilmSendTimer) {
        clearTimeout(fanfilmSendTimer);
    }
    if (interval) {
        fanfilmSendTimer = setTimeout(() => {
            fanfilmUpdate();
        }, interval);
    }

    // Post cookies to FanFilm plugin
    let data = { ...cookies, forced_by_user: options.forced_by_user ? true : false};
    console.log(`[FanFilm] Sending to ${host}:`, data);
    let status = 'error';
    try {
        const answer = await fanfilmRequest(target, "POST", "/cookies", data);
        console.log(`[FanFilm] Answer of ${host}:`, answer);
        if (answer.status === 200) {
            status = 'success';
            if (answer.json && answer.json.warning) {
                fanfilmSendWarning = answer.json.warning;  // FanFilm says why the data is not usable
            }
        } else if (answer.status === 401 || answer.status === 403) {
            status = 'locked';  // not paired (or no scope of the cookies): "Connect"
        }
    } catch (err) {
        console.error(`[FanFilm] Sending to ${host}:`, err);
    }
    if (status === 'success' && !fanfilmTextsRead)
        fanfilmLoadTexts(target, true);  // the texts of this Kodi again, once a page (another language, a newer FanFilm)
    fanfilmSendResults[host] = status === 'success' ? 'success' : 'error';
    fanfilmUpdateStatus();
    fanfilmSetLast(host, status);
    fanfilmRenderTargets();

    [sites, site, site_host] = fanfilmLoadSites(host);
    site_host.status = status;
    GM_setValue('ff_sites', sites);
}

async function fanfilmSendToAll(options)
{
    if (!options) {
        options = {};
    }
    if (!options.cookies) {
        options.cookies = await fanfilmCookies(options);
    }
    const hosts = fanfilmEnabledTargets();
    const ffStatus = fanfilmRoot.getElementById("ff-status");

    // Reset wyników i ustaw liczbę hostów
    fanfilmSendResults = {};
    fanfilmTotalHosts = hosts.length;

    if (hosts.length > 1) {
        ffStatus.textContent = T('Status: sending to {n} servers...', {n: hosts.length});
    } else {
        ffStatus.textContent = T('Status: sending...');
    }
    ffStatus.className = "sending";

    for(const target of hosts) {
        fanfilmSendOne(target, options);
    }
}

// --- the list of the targets in the widget, the pairing with a Kodi ---

// The icon of the last sending to a target.
function fanfilmStatusIcon(target)
{
    if (!target.key) {
        return '🔒';
    }
    const status = target.last ? target.last.status : '';
    return {success: '✅', error: '❌', locked: '🔒'}[status] || '·';
}

// Draw the list of the targets (☑ sent to, name or host, status, "Połącz" without access, ✕ removed).
function fanfilmRenderTargets()
{
    const list = fanfilmRoot && fanfilmRoot.getElementById("ff-targets");
    const active = fanfilmRoot && fanfilmRoot.activeElement;
    if (!list || (active && active.tagName === 'INPUT' && list.contains(active))) {  // a checkbox in use kept; a clicked button (✕) is not
        return;
    }
    list.textContent = '';
    fanfilmTargets().forEach((target, index) => {
        const row = document.createElement('div');
        row.className = 'ff-target';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!target.enabled;
        check.title = T('Send to this Kodi');
        check.addEventListener('change', () => fanfilmChangeTarget(index, t => { t.enabled = check.checked; }));
        const name = document.createElement('span');
        name.className = 'ff-name';
        name.textContent = target.name ? `${target.name} (${fanfilmHostLabel(target.host)})` : fanfilmHostLabel(target.host);
        name.title = target.host;
        const status = document.createElement('span');
        status.textContent = fanfilmStatusIcon(target);
        row.append(check, name, status);
        if (!target.key || (target.last && target.last.status === 'locked')) {
            const pair = document.createElement('button');
            pair.className = 'ff-small';
            pair.textContent = T('Connect');
            pair.addEventListener('click', () => fanfilmShowPairing(target.host));
            row.append(pair);
        }
        const remove = document.createElement('button');
        remove.className = 'ff-small ff-remove';
        remove.textContent = '✕';
        remove.title = T('Remove from the list (and disconnect in Kodi)');
        remove.addEventListener('click', () => fanfilmRemoveTarget(index));
        row.append(remove);
        list.append(row);
    });
}

// Change a target of the list (`change` null: removed), save, draw again.
function fanfilmChangeTarget(index, change)
{
    const targets = fanfilmTargets();
    if (change === null) {
        targets.splice(index, 1);
    } else if (targets[index]) {
        change(targets[index]);
    }
    fanfilmSaveTargets(targets);
    fanfilmRenderTargets();
}

// Remove a target: gone from the list at once, its device unpaired on its FanFilm after (no connection: the Kodi list keeps it - told).
async function fanfilmRemoveTarget(index)
{
    const target = fanfilmTargets()[index];
    fanfilmChangeTarget(index, null);
    const unpaired = await fanfilmLogout(target);
    if (!unpaired) {
        fanfilmMessage('partial', `⚠️ ${T('Kodi does not answer: remove this device in Kodi too (Web server → Paired devices)')}`);
    }
}

function fanfilmAddTarget()
{
    const input = fanfilmRoot.getElementById("ff-add");
    const host = input.value.trim();
    if (host) {
        const targets = fanfilmTargets();
        if (!targets.some(t => t.host === fanfilmHostPort(host))) {
            targets.push({host: fanfilmHostPort(host), enabled: true});
            fanfilmSaveTargets(targets);
        }
        input.value = '';
        input.blur();
        fanfilmRenderTargets();
        fanfilmLoadTexts({host: fanfilmHostPort(host)});  // no texts yet (a fresh script): of this Kodi, `/texts` needs no pairing
    }
}

// The pairing of a target: a code shown by Kodi, or a request (its QR code scanned by a phone of the owner, or approved in Kodi).
var fanfilmPairing = {host: '', request: null};

function fanfilmShowPairing(host)
{
    fanfilmPairing = {host: host, request: null};
    fanfilmPanelTexts();  // the address in the text
    fanfilmLoadTexts(fanfilmTargets().find(target => target.host === host) || {host: host}, true);  // newer texts of this Kodi (no pairing needed)
    fanfilmRoot.getElementById("ff-pair-qr").style.display = 'none';
    fanfilmRoot.getElementById("ff-pair").style.display = 'block';
}

function fanfilmHidePairing()
{
    if (fanfilmPairing.request) {
        fanfilmPairing.request.stopped = true;
    }
    fanfilmPairing = {host: '', request: null};
    fanfilmRoot.getElementById("ff-pair").style.display = 'none';
}

// A paired FanFilm: its access kept in the list (the old access of the same FanFilm unpaired there: no pile of devices).
async function fanfilmPaired(host, answer)
{
    const old = fanfilmOldTarget({...answer, host: host});
    fanfilmSaveTargets(fanfilmUpsertTarget(fanfilmTargets(), {...answer, host: host}));
    if (old && old.device !== (answer.device && answer.device.id))
        fanfilmLogout(old);
    fanfilmHidePairing();
    fanfilmRenderTargets();
    fanfilmMessage('success', `✅ ${T('Connected to {name}', {name: answer.name || host})}`);
    fanfilmLoadTexts(fanfilmTargets().find(target => target.host === host), true);  // the language of this Kodi
    fanfilmSendToAll({forced_by_user: true});
}

async function fanfilmPairByCode()
{
    const host = fanfilmPairing.host;
    const code = fanfilmRoot.getElementById("ff-pair-code").value.trim();
    try {
        const agreement = await fanfilmAgree(host);
        const answer = await fanfilmRequest({host: host}, "POST", "/pair/code", {code: code, client: 'script', name: `FanFilm script (${location.hostname})`},
                                            true, agreement);
        if (answer.status === 200) {
            fanfilmRoot.getElementById("ff-pair-code").value = '';
            fanfilmPaired(host, {...answer.json, key: fanfilmHex(await fanfilmDeviceKey(agreement.key))});
        } else {
            fanfilmMessage('error', `❌ ${answer.status === 429 ? T('Too many failed attempts, try later') : T('Wrong or expired code')}`);
        }
    } catch (err) {
        fanfilmMessage('error', `❌ ${err.status === 429 ? T('Too many failed attempts, try later') : T('No connection with Kodi')}`);
    }
}

async function fanfilmPairByRequest()
{
    const host = fanfilmPairing.host;
    if (fanfilmPairing.request) {
        fanfilmPairing.request.stopped = true;  // a new request ends the one before (Kodi replaces it too)
    }
    const req = fanfilmPairing.request = {stopped: false};
    const current = () => !req.stopped && fanfilmPairing.request === req;  // an older request never touches the widget
    fanfilmMessage('sending', `⏳ ${T('Asking Kodi for access…')}`);
    try {
        const agreement = await fanfilmAgree(host);
        const answer = await fanfilmRequest({host: host}, "POST", "/pair/request", {client: 'script', name: `FanFilm script (${location.hostname})`},
                                            true, agreement);
        if (!current()) {
            return;
        }
        if (answer.status !== 200) {
            console.error('[FanFilm] Pairing request:', answer.status, answer.json);
            fanfilmMessage('error', `❌ ${T('Kodi did not accept the request')}`);
            return;
        }
        Object.assign(req, answer.json);
        const poll = encodeURIComponent(req.poll);
        const svg = await new Promise((resolve, reject) => GM.xmlHttpRequest({
            method: "GET", url: `http://${host}/pair/request/${req.id}/qr.svg?poll=${poll}`, onload: resolve, onerror: reject}));
        if (!current()) {
            return;
        }
        fanfilmRoot.getElementById("ff-pair-img").src = 'data:image/svg+xml;base64,' + btoa(svg.responseText);
        fanfilmRoot.getElementById("ff-pair-match").textContent = req.match;
        fanfilmRoot.getElementById("ff-pair-qr").style.display = 'block';
        fanfilmMessage('sending', `⏳ ${T('Approve the request in Kodi (code {match})', {match: req.match})}`);
        while (current()) {
            const wait = await fanfilmRequest({host: host}, "GET", `/pair/request/${req.id}?poll=${poll}`, undefined, true, agreement);
            if (!current()) {
                return;
            }
            const state = wait.json && wait.json.state;
            if (state === 'approved') {
                fanfilmPaired(host, {...wait.json, key: fanfilmHex(await fanfilmDeviceKey(agreement.key))});
                return;
            }
            if (state !== 'waiting') {
                fanfilmMessage('error', `❌ ${state === 'rejected' ? T('Request rejected') : T('Request expired')}`);
                fanfilmHidePairing();
                return;
            }
        }
    } catch (err) {
        console.error('[FanFilm] Pairing request:', err);
        if (current()) {
            fanfilmMessage('error', `❌ ${T('No connection with Kodi')}`);
        }
    }
}

// On the page of the FanFilm web server: the page asks whether this script is here (`fanfilm-ping`) and hands it its access
// (`fanfilm-pair-script`, JSON text: an object crosses the worlds of the page and of the script badly).
function fanfilmServerPage()
{
    window.addEventListener('fanfilm-ping', () => {
        window.dispatchEvent(new CustomEvent('fanfilm-pong', {detail: JSON.stringify({version: GM_info.script.version})}));
    });
    window.addEventListener('fanfilm-pair-script', (e) => {
        try {
            const info = JSON.parse(e.detail);
            const old = fanfilmOldTarget(info);
            fanfilmSaveTargets(fanfilmUpsertTarget(fanfilmTargets(), info));
            if (old && old.device !== (info.device && info.device.id))
                fanfilmLogout(old);  // the old access of the same FanFilm unpaired there (the page replaces its own script: no harm)
            console.log(`[FanFilm] Dodano Kodi ${info.name} (${info.host})`);
        } catch (err) {
            console.error('[FanFilm] Wrong data of the connection:', err);
        }
    });
}

// netmirror.gg/tv publishes the bypass OTP code as `const otp = [d,d,d,d,d,d]`
// (plus a commented-out all-zero placeholder before it) - see netmirror.py's
// _fetch_otp_code, which this mirrors so the addon doesn't have to scrape the
// page itself when Cloudflare blocks it. Rides the same /cookies flow as
// cda-hd/zaluknij/filmyonline (const.tune.service.web_server.cookies) - the
// code just goes along as a fake "cookie" named otp_code.
function fanfilmUpdateNetmirrorOtp()
{
    const text = Array.from(document.scripts).map(s => s.textContent).join('\n');
    const matches = [...text.matchAll(/const\s+otp\s*=\s*\[([\d,\s]+)\]/g)];
    const digits = matches.length && matches[matches.length - 1][1].match(/\d/g);
    if (!digits) {
        return false;
    }
    // The code redeems into a single-session usertoken - sending it to every
    // configured host would just have them race to kick each other's session,
    // so only the first (primary) target gets it.
    const target = fanfilmEnabledTargets()[0];
    if (!target) {
        return false;
    }
    const data = {host: 'netmirror.gg', cookies: [{name: 'otp_code', value: digits.join('')}]};
    fanfilmRequest(target, "POST", "/cookies", data).then(
        answer => answer.status === 200 ? fanfilmMessage('success', `✅ ${T('Sent to Kodi')}`) : fanfilmMessage('error', `❌ ${T('No access - connect with Kodi')}`),
        () => fanfilmMessage('error', `❌ ${T('Sending error!')}`));
    return true;
}

// Kod bywa doklejany do strony z opóźnieniem (zasoby, Cloudflare), więc zamiast
// jednorazowego sprawdzenia po stałym czasie - odpytujemy aż się pojawi.
async function fanfilmWaitForNetmirrorOtp(maxAttempts = 20, interval = 500)
{
    for (let i = 0; i < maxAttempts; i++) {
        if (fanfilmUpdateNetmirrorOtp()) {
            return;
        }
        await sleep(interval);
    }
}

async function fanfilmUpdate(options)
{
    if (!options) {
        options = {};
    }
    options.data = await fanfilmCookies(options);
    const new_hash = toHash(options.data);
    const [sites, site, host_site] = fanfilmLoadSites();
    let should_send = false;
    for (const target of fanfilmEnabledTargets()) {
        const host_site = site.hosts[target.host];
        if (!host_site || new_hash != host_site.cookies_hash) {
            should_send = true;
            break;
        }
    }
    if (should_send) {
        await fanfilmSendToAll(options);
    }
}

if (typeof module === 'object' && module.exports) {  // the tests (node)
    module.exports = {fanfilmHostPort, fanfilmHostLabel, fanfilmMigrateTargets, fanfilmUpsertTarget, fanfilmSignature, fanfilmForgetOldAccess,
                      fanfilmHkdf, fanfilmDeviceKey, fanfilmPairingKey, fanfilmSeal, fanfilmUnseal, fanfilmStamp, fanfilmLogout};
} else if (fanfilmOnServerPage) {
    fanfilmServerPage();
} else (async function() {
    'use strict';

    // Tworzymy kontener + Shadow DOM
    const container = document.createElement("div");
    document.body.appendChild(container);
    fanfilmRoot = container.attachShadow({ mode: "open" });

    fanfilmRoot.innerHTML = `
      <style>
        #ff-panel {
          position: fixed;
          bottom: 8px;
          right: 8px;
          background: #222;
          color: #fff;
          font-family: Arial, sans-serif;
          font-size: 15px;
          padding: 4px;
          border-radius: 8px;
          border: solid #999 2px;
          box-shadow: 0 0 8px rgba(0,0,0,0.5);
          z-index: 999999;
          width: 260px;
          line-height: 1.4;
        }
        #ff-header {
          font-weight: bold;
          text-align: center;
          margin-bottom: 4px;
          user-select: none; /* nagłówek nigdy się nie zaznacza */
          display: flex;
          align-items: center;
          position: relative;
        }
        #ff-drag-handle {
          position: absolute;
          cursor: move;
          font-size: 1.1em;
          line-height: 1;
          margin-right: 8px;
          color: #888;
          user-select: none;
          touch-action: none;
          min-width: 1.5em;
        }
        #ff-drag-handle:hover {
          color: #eee;
        }
        #ff-body {
          margin: 12px 8px 8px;
        }
        #ff-title {
          flex: 1;
          cursor: pointer;
        }
        label {
          display: block;
          margin-bottom: 2px;
        }
        input {
          all: unset;
          box-sizing: border-box;
          width: 100%;
          padding: 6px;
          margin-bottom: 6px;
          background: #333;
          color: #fff;
          border: 1px solid #555;
          border-radius: 4px;
          font-size: 0.95em;
        }
        button {
          all: unset;
          box-sizing: border-box;
          width: 100%;
          background: #4CAF50;
          text-align: center;
          color: #fff;
          padding: 8px;
          border-radius: 4px;
          font-size: 1em;
          cursor: pointer;
        }
        button:hover {
          filter: brightness(1.25);
        }
        button:focus-visible {
          outline: 2px solid #fff;
          outline-offset: 1px;
        }
        #ff-status {
          margin-top: 6px;
          font-size: 0.9em;
          text-align: center;
          color: #bbb;
        }
        #ff-panel .info {
          font-size: 85%;
          color: #bbb;
        }
        #ff-status {
            color: #eee;
        }
        #ff-status.sending {
            color: #bbb;
        }
        #ff-status.ok, #ff-status.success {
            color: #4CAF50;
        }
        #ff-status.error {
            color: red;
        }
        #ff-status.partial {
            color: #FFA500;
        }
        .ff-target, .ff-add-row {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-bottom: 4px;
        }
        .ff-target input[type=checkbox] {
          all: revert;
          margin: 0;
        }
        .ff-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 0.9em;
        }
        button.ff-small {
          width: auto;
          padding: 2px 6px;
          font-size: 0.85em;
        }
        button.ff-remove {
          background: #555;
        }
        button.ff-secondary {
          background: #555;
          margin-top: 4px;
        }
        #ff-pair-request-button {
          background: #1e6fbf;
        }
        #ff-pair-match {
          display: block;
          margin: 4px 0;
          text-align: center;
          font-size: 2.2em;
          letter-spacing: 0.15em;
          color: #fff;
        }
        .ff-add-row input {
          margin-bottom: 0;
        }
        #ff-pair {
          border-top: 1px solid #555;
          padding-top: 6px;
          margin-bottom: 6px;
        }
        #ff-pair-img {
          display: block;
          width: 160px;
          height: 160px;
          margin: 6px auto;
          background: #fff;
        }
      </style>
      <div id="ff-panel">
        <div id="ff-header">
          <span id="ff-drag-handle">⋮</span>
          <span id="ff-title">⚙️ FanFilm</span>
        </div>
        <div id="ff-body" style="display:none;">
          <label id="ff-targets-label"></label>
          <div id="ff-targets"></div>
          <div class="ff-add-row">
            <input type="text" id="ff-add">
            <button id="ff-add-button" class="ff-small">+</button>
          </div>
          <div class="info" style="margin-bottom:6px;" id="ff-port-info"></div>
          <div id="ff-pair" style="display:none;">
            <div class="info" id="ff-pair-with"></div>
            <input type="text" id="ff-pair-code" autocomplete="off">
            <button id="ff-pair-code-button"></button>
            <button id="ff-pair-request-button" class="ff-secondary"></button>
            <div id="ff-pair-qr" style="display:none;">
              <img id="ff-pair-img">
              <div class="info"><span id="ff-pair-scan"></span> <span id="ff-pair-match-label"></span> <b id="ff-pair-match"></b></div>
            </div>
            <button id="ff-pair-cancel" class="ff-secondary"></button>
          </div>
          <button id="ff-send"></button>
          <div id="ff-imdb-user" style="display:none; margin-top:8px;">
            <button id="ff-imdb-user-add"></button>
          </div>
          <div id="ff-status"></div>
        </div>
      </div>
    `;

    const ffPanel = fanfilmRoot.getElementById("ff-panel");
    const ffTitle = fanfilmRoot.getElementById("ff-title");
    const ffDragHandle = fanfilmRoot.getElementById("ff-drag-handle");
    const ffBody = fanfilmRoot.getElementById("ff-body");
    const ffSend = fanfilmRoot.getElementById("ff-send");
    const ffStatus = fanfilmRoot.getElementById("ff-status");
    const ffImdbUser = fanfilmRoot.getElementById("ff-imdb-user");
    const ffImdbUserAdd = fanfilmRoot.getElementById("ff-imdb-user-add");

    const imdbUser = fanfilmExtractImdbUser();
    if (imdbUser) {
        ffImdbUserAdd.dataset.nick = imdbUser.nick;  // its text: `fanfilmPanelTexts()`
        ffImdbUser.style.display = "block";
        ffImdbUserAdd.addEventListener("click", () => fanfilmAddImdbUser(imdbUser.id));
    }

    // the texts kept of a Kodi, none yet: read from the first Kodi of the list (the widget in English until it answers)
    fanfilmText = GM_getValue('ff_texts', null) || fanfilmText;
    fanfilmPanelTexts();
    fanfilmLoadTexts(fanfilmEnabledTargets()[0] || fanfilmTargets()[0]);

    // Zmienne dla drag&drop
    let isDragging = false, offsetX = 0, offsetY = 0;
    let wasDragged = false; // flaga czy rzeczywiście przeciągano

    // Funkcja pomocnicza do pobierania współrzędnych z różnych typów zdarzeń
    function getEventCoords(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        } else {
            return { x: e.clientX, y: e.clientY };
        }
    }

    // Panel zawsze w oknie: po rozwinięciu, przeciągnięciu i zmianie rozmiaru okna (np. rozwinięty
    // w dół panel przeciągnięty nisko albo dłuższy napis przycisku konta IMDb).
    function keepInView() {
        const rect = ffPanel.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - 4 || rect.top < 0) {
            ffPanel.style.top = Math.max(4, window.innerHeight - rect.height - 8) + "px";
            ffPanel.style.bottom = "auto";
        }
        if (rect.right > window.innerWidth - 4 || rect.left < 0) {
            ffPanel.style.left = Math.max(4, window.innerWidth - rect.width - 8) + "px";
            ffPanel.style.right = "auto";
        }
    }
    window.addEventListener("resize", keepInView);

    // Rozwijanie/zamykanie po kliknięciu w tytuł (tylko jeśli nie przeciągano)
    ffTitle.addEventListener("click", (e) => {
        // Jeśli właśnie skończono przeciąganie, ignoruj kliknięcie
        if (wasDragged) {
            wasDragged = false;
            return;
        }
        ffBody.style.display = (ffBody.style.display === "none") ? "block" : "none";
        keepInView();
    });

    // Zwinięcie po kliknięciu poza panelem
    document.addEventListener("click", (e) => {
        if (!container.contains(e.target)) {
            ffBody.style.display = "none";
        }
    });

    // Funkcja rozpoczynania przeciągania
    function startDragging(e) {
        isDragging = true;
        wasDragged = false;

        const coords = getEventCoords(e);
        const rect = ffPanel.getBoundingClientRect();
        offsetX = coords.x - rect.left;
        offsetY = coords.y - rect.top;

        document.body.style.userSelect = "none";
        e.preventDefault();
    }

    // Funkcja przeciągania
    function doDragging(e) {
        if (!isDragging) {
            return;
        }
        wasDragged = true;
        const coords = getEventCoords(e);
        ffPanel.style.left = (coords.x - offsetX) + "px";
        ffPanel.style.top = (coords.y - offsetY) + "px";
        ffPanel.style.right = 'auto';
        ffPanel.style.bottom = 'auto';
        e.preventDefault();
    }

    // Funkcja kończenia przeciągania
    function stopDragging(e) {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = "auto";
        keepInView();
        if (wasDragged) {
            setTimeout(() => {
                wasDragged = false;
            }, 10);
        }
        e.preventDefault();
    }

    // Obsługa zdarzeń dotykowych
    ffDragHandle.addEventListener("touchstart", startDragging, { passive: false });
    document.addEventListener("touchmove", doDragging, { passive: false });
    document.addEventListener("touchend", stopDragging, { passive: false });
    document.addEventListener("touchcancel", stopDragging, { passive: false });

    // Obsługa zdarzeń myszy (zachowana dla kompatybilności z desktopem)
    ffDragHandle.addEventListener("mousedown", startDragging);
    document.addEventListener("mousemove", doDragging);
    document.addEventListener("mouseup", stopDragging);

    // Obsługa zdarzeń pointer (dla kompatybilności z nowszymi przeglądarkami)
    ffDragHandle.addEventListener("pointerdown", startDragging);
    document.addEventListener("pointermove", doDragging);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);

    // Obsługa przycisku "Wyślij"
    ffSend.addEventListener("click", () => {
        if (location.hostname === 'netmirror.gg') {
            fanfilmUpdateNetmirrorOtp();
        } else {
            fanfilmSendToAll({forced_by_user: true});
        }
    });

    // Lista Kodi i łączenie
    fanfilmRenderTargets();
    fanfilmRoot.getElementById("ff-add-button").addEventListener("click", fanfilmAddTarget);
    fanfilmRoot.getElementById("ff-add").addEventListener("keydown", (e) => { if (e.key === 'Enter') fanfilmAddTarget(); });
    fanfilmRoot.getElementById("ff-pair-code-button").addEventListener("click", fanfilmPairByCode);
    fanfilmRoot.getElementById("ff-pair-request-button").addEventListener("click", fanfilmPairByRequest);
    fanfilmRoot.getElementById("ff-pair-cancel").addEventListener("click", fanfilmHidePairing);

    // Aktualizacja listy (gdy inna zakładka zmieni)
    setInterval(fanfilmRenderTargets, 5000);

    if (location.hostname === 'netmirror.gg') {
        fanfilmWaitForNetmirrorOtp();
    } else {
        await sleep(1000);
        await fanfilmUpdate();
    }
})();
