/**
 * extension_api.js
 * WebExtensions互換レイヤー
 *
 * chrome/browser名前空間の差異、callback/Promise APIの差異、runtime.lastErrorの扱い、
 * storage.syncが使えない環境（Orion iOS/iPadOS等）の差異を吸収する。
 * content script（watch / live_chat）と popup の全文脈で最初に読み込まれる前提。
 * background.js では使用しない（service worker側は単体で完結させる）。
 */

var ylcApi = (() => {
    // Firefox/Orion系はbrowser名前空間（Promiseベース）、ChromeはchromeのみでcallbackベースAPI
    const hasBrowserNs = (typeof browser !== 'undefined') && !!browser?.runtime;
    const api = hasBrowserNs ? browser : ((typeof chrome !== 'undefined') ? chrome : null);

    // 拡張レイヤー内部でstorageに置くキー。設定変更の監視対象から除外する
    const INTERNAL_KEY_PREFIXES = ['tabState_', 'sessionState_'];
    const INTERNAL_KEYS = ['globalState', 'settingsPanelLayout', 'ylcMigratedFromSync', 'ylcProbe'];

    // sessionState/tabStateの鮮度上限。tabs.onRemovedによる掃除が効かない環境での残留対策
    const STATE_TTL = 12 * 60 * 60 * 1000;

    function hasRuntime() {
        try { return !!api?.runtime?.id; } catch { return false; }
    }

    /**
     * iOS/iPadOS相当の環境か（Orion iOS/iPadOS等）。
     * localhost連携（LM Studio）が実用にならない環境の判定に使う。
     * iPadOSはMacintosh UAを名乗るためタッチ点数で判別する
     */
    function isAppleTouchEnvironment() {
        try {
            const ua = navigator.userAgent || '';
            if (/iPhone|iPad|iPod/.test(ua)) return true;
            if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
        } catch { /* navigator未定義環境 */ }
        return false;
    }

    function getRuntimeUrl(path) {
        try { return api.runtime.getURL(path); } catch { return ''; }
    }

    function isInternalKey(key) {
        if (INTERNAL_KEYS.includes(key)) return true;
        return INTERNAL_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
    }

    /**
     * runtime.sendMessageを正規化する。
     * 失敗してもrejectせず { ok: false, reason } を返し、呼び出し側のフォールバック分岐を単純にする。
     */
    function sendMessage(message) {
        return new Promise(resolve => {
            if (!hasRuntime()) {
                resolve({ ok: false, reason: 'no-runtime' });
                return;
            }
            try {
                if (hasBrowserNs) {
                    api.runtime.sendMessage(message).then(
                        response => resolve({ ok: true, data: response }),
                        e => resolve({ ok: false, reason: String(e?.message || e) })
                    );
                } else {
                    api.runtime.sendMessage(message, response => {
                        const err = api.runtime.lastError;
                        if (err) resolve({ ok: false, reason: err.message });
                        else resolve({ ok: true, data: response });
                    });
                }
            } catch (e) {
                resolve({ ok: false, reason: String(e?.message || e) });
            }
        });
    }

    function onMessage(callback) {
        try {
            api.runtime.onMessage.addListener(callback);
            return true;
        } catch {
            return false;
        }
    }

    function onStorageChanged(callback) {
        try {
            api.storage.onChanged.addListener(callback);
            return true;
        } catch {
            return false;
        }
    }

    /** storage操作のPromise化。エリア未対応・実行時エラーはrejectで返す */
    function storageOp(areaName, method, arg) {
        return new Promise((resolve, reject) => {
            const area = api?.storage?.[areaName];
            if (!area || typeof area[method] !== 'function') {
                reject(new Error(`storage.${areaName}.${method} unavailable`));
                return;
            }
            try {
                if (hasBrowserNs) {
                    area[method](arg).then(resolve, reject);
                } else {
                    area[method](arg, result => {
                        const err = api.runtime?.lastError;
                        if (err) reject(new Error(err.message));
                        else resolve(result);
                    });
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    // ---- 設定保存エリアの解決（sync優先・local フォールバック） ----

    let resolvedSettingsArea = null;
    let settingsAreaPromise = null;

    async function migrateSyncToLocalOnce() {
        const marker = await storageOp('local', 'get', 'ylcMigratedFromSync').catch(() => null);
        if (marker?.ylcMigratedFromSync) return;
        let syncValues = null;
        try { syncValues = await storageOp('sync', 'get', null); } catch { syncValues = null; }
        if (syncValues && typeof syncValues === 'object') {
            const toCopy = {};
            for (const [key, value] of Object.entries(syncValues)) {
                if (!isInternalKey(key)) toCopy[key] = value;
            }
            if (Object.keys(toCopy).length) {
                await storageOp('local', 'set', toCopy).catch(() => {});
            }
        }
        await storageOp('local', 'set', { ylcMigratedFromSync: true }).catch(() => {});
    }

    async function resolveSettingsArea() {
        try {
            await storageOp('sync', 'set', { ylcProbe: Date.now() });
            storageOp('sync', 'remove', 'ylcProbe').catch(() => {});
            resolvedSettingsArea = 'sync';
        } catch {
            // syncに書けない環境。読めた既存値は一度だけlocalへ移行する
            await migrateSyncToLocalOnce().catch(() => {});
            resolvedSettingsArea = 'local';
        }
        return resolvedSettingsArea;
    }

    function getSettingsArea() {
        if (!settingsAreaPromise) settingsAreaPromise = resolveSettingsArea();
        return settingsAreaPromise;
    }

    /** 解決済みエリア名（'sync' | 'local'）。未解決時はChrome既定の'sync'を返す */
    function settingsAreaName() {
        return resolvedSettingsArea || 'sync';
    }

    async function settingsGet(defaultsOrKeys) {
        const area = await getSettingsArea();
        try {
            return await storageOp(area, 'get', defaultsOrKeys);
        } catch {
            if (area === 'sync') {
                try { return await storageOp('local', 'get', defaultsOrKeys); } catch { /* fallthrough */ }
            }
            return (defaultsOrKeys && !Array.isArray(defaultsOrKeys) && typeof defaultsOrKeys === 'object')
                ? { ...defaultsOrKeys }
                : {};
        }
    }

    async function settingsSet(values) {
        const area = await getSettingsArea();
        try {
            await storageOp(area, 'set', values);
            return true;
        } catch {
            if (area === 'sync') {
                // 途中からsyncが書けなくなった場合（容量超過等）はlocalへ切り替える
                try {
                    await storageOp('local', 'set', values);
                    resolvedSettingsArea = 'local';
                    settingsAreaPromise = Promise.resolve('local');
                    return true;
                } catch { /* fallthrough */ }
            }
            return false;
        }
    }

    async function settingsRemove(keys) {
        const area = await getSettingsArea();
        try {
            await storageOp(area, 'remove', keys);
            return true;
        } catch {
            return false;
        }
    }

    // ---- local storage（タブ状態・レイアウト等の端末ローカル値専用） ----

    async function localGet(keys) {
        try { return await storageOp('local', 'get', keys); } catch { return {}; }
    }

    async function localSet(values) {
        try { await storageOp('local', 'set', values); return true; } catch { return false; }
    }

    async function localRemove(keys) {
        try { await storageOp('local', 'remove', keys); return true; } catch { return false; }
    }

    // ---- フレーム間直接通信（background折り返し非依存の主経路） ----

    const FRAME_MESSAGE_SOURCE = 'ylc-enhancer';
    const PARENT_ORIGIN_ALLOWLIST = ['https://www.youtube.com', 'https://m.youtube.com'];

    /** 親フレームのoriginを返す。YouTube以外に埋め込まれている場合はnull */
    function getParentYouTubeOrigin() {
        try {
            if (window.parent === window) return null;
            if (document.referrer) {
                const origin = new URL(document.referrer).origin;
                if (PARENT_ORIGIN_ALLOWLIST.includes(origin)) return origin;
            }
        } catch { /* referrer不正は未対応扱い */ }
        return null;
    }

    /**
     * 親フレーム（YouTubeページ）へ直接postMessageする。
     * service worker・tabs APIに依存しない弾幕/設定通知の主経路。
     * 親がYouTubeページと確認できない場合は送らずfalseを返す（呼び出し側でbackground中継へフォールバック）。
     */
    function postToParent(message) {
        const origin = getParentYouTubeOrigin();
        if (!origin) return false;
        try {
            window.parent.postMessage({ source: FRAME_MESSAGE_SOURCE, ...message }, origin);
            return true;
        } catch {
            return false;
        }
    }

    /** 指定iframeへ直接postMessageする（親→子方向の設定更新通知用） */
    function postToFrame(frameWindow, message, targetOrigin) {
        if (!frameWindow) return false;
        try {
            frameWindow.postMessage({ source: FRAME_MESSAGE_SOURCE, ...message }, targetOrigin);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 他フレームからの拡張メッセージを受信する。
     * 許可origin: YouTubeページ（hidden live_chat等）と拡張オリジン（popup iframe）。
     * sourceマーカーとoriginの両方を検証する。
     */
    function onFrameMessage(callback) {
        const allowedOrigins = new Set(PARENT_ORIGIN_ALLOWLIST);
        const extensionBaseUrl = getRuntimeUrl('');
        if (extensionBaseUrl) {
            try { allowedOrigins.add(new URL(extensionBaseUrl).origin); } catch { /* 無効URLは無視 */ }
        }
        window.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object' || data.source !== FRAME_MESSAGE_SOURCE) return;
            if (!allowedOrigins.has(event.origin)) return;
            callback(data, event);
        });
    }

    // ---- タブ/セッション状態キーの解決 ----

    async function getTabId() {
        const res = await sendMessage({ action: 'getTabId' });
        if (!res.ok) return null;
        return res.data?.tabId ?? null;
    }

    /**
     * ツールバーポップアップ文脈用。sender.tab経由のgetTabIdが効かないため
     * tabs.queryでアクティブタブのIDを取る。content scriptではtabs APIが
     * 存在しないためnullを返す
     */
    async function getActiveTabId() {
        try {
            if (!api?.tabs?.query) return null;
            const tabs = hasBrowserNs
                ? await api.tabs.query({ active: true, currentWindow: true })
                : await new Promise(resolve => api.tabs.query({ active: true, currentWindow: true }, resolve));
            return tabs?.[0]?.id ?? null;
        } catch {
            return null;
        }
    }

    function getVideoIdFromLocation() {
        try {
            const params = new URLSearchParams(window.location.search);
            return params.get('v') || null;
        } catch {
            return null;
        }
    }

    /**
     * タブ固有状態の保存キーを解決する。
     * 優先順: 明示指定 > tabState_${tabId} > sessionState_${videoId} > globalState
     * watchページとlive_chat iframeはどちらもURLのvパラメータを持つため、
     * タブIDが取れない環境でも親子で同じsessionStateキーに到達できる。
     */
    async function resolveStateKey(explicitKey = null) {
        if (explicitKey) return explicitKey;
        const tabId = await getTabId();
        if (tabId) return `tabState_${tabId}`;
        const activeTabId = await getActiveTabId();
        if (activeTabId) return `tabState_${activeTabId}`;
        const videoId = getVideoIdFromLocation();
        if (videoId) return `sessionState_${videoId}`;
        return 'globalState';
    }

    async function readTabState(stateKey) {
        if (!stateKey) return {};
        const data = await localGet(stateKey);
        const state = data?.[stateKey];
        if (!state || typeof state !== 'object') return {};
        if (stateKey.startsWith('sessionState_') && state.updatedAt && (Date.now() - state.updatedAt > STATE_TTL)) {
            localRemove(stateKey);
            return {};
        }
        return state;
    }

    async function updateTabState(stateKey, partial) {
        if (!stateKey) return false;
        const current = await readTabState(stateKey);
        const next = { ...current, ...partial, updatedAt: Date.now() };
        return localSet({ [stateKey]: next });
    }

    /** 期限切れsessionStateの掃除。起動時に1回呼べば十分 */
    async function cleanupStaleSessionStates() {
        try {
            const all = await storageOp('local', 'get', null);
            if (!all || typeof all !== 'object') return;
            const now = Date.now();
            const staleKeys = Object.keys(all).filter(key =>
                key.startsWith('sessionState_') &&
                (!all[key]?.updatedAt || now - all[key].updatedAt > STATE_TTL)
            );
            if (staleKeys.length) await localRemove(staleKeys);
        } catch { /* 掃除失敗は致命的ではない */ }
    }

    return {
        hasRuntime,
        isAppleTouchEnvironment,
        getRuntimeUrl,
        isInternalKey,
        sendMessage,
        onMessage,
        onStorageChanged,
        settingsGet,
        settingsSet,
        settingsRemove,
        settingsAreaName,
        localGet,
        localSet,
        localRemove,
        postToParent,
        postToFrame,
        onFrameMessage,
        getTabId,
        getActiveTabId,
        getVideoIdFromLocation,
        resolveStateKey,
        readTabState,
        updateTabState,
        cleanupStaleSessionStates,
    };
})();
