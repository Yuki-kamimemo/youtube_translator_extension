/**
 * translation.js
 * 翻訳共有ユーティリティ
 *
 * background（service worker / event page）とcontent scriptの両文脈で読み込まれる。
 * content script側のGoogle翻訳直接フォールバックでも前処理・後処理の品質を
 * 落とさないため、翻訳パイプラインの共通部分をここに置く。
 * ylcApiには依存しない（backgroundでも動かすため）。
 */

function shouldSkipTranslation(text) {
    if (!text || !text.trim()) return true;
    const trimmedText = text.trim();
    const hasJapanese = /[\p{Script_Extensions=Han}ぁ-んァ-ヶー]/u.test(trimmedText);
    const hasLatin = /\p{Script=Latin}/u.test(trimmedText);
    const hasOtherForeignScript = hasTranslatableForeignText(trimmedText) && !hasLatin;
    // ライブチャットの短い漢字文は日中判定が不安定で、日本語文中の英単語も
    // 固有名詞・作品名であることが多い。日本語文字を1文字でも含む文は翻訳しない。
    if (hasJapanese) return true;
    if (/^(w|ｗ|草)+$/i.test(trimmedText)) return true;
    if (/^https?:\/\/[^\s]+$/.test(trimmedText)) return true;
    if (/^[ｦ-ﾟ\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    if (/^[\p{Emoji}\s]+$/u.test(trimmedText) && !/[a-zA-Z0-9]/.test(trimmedText)) return true;
    if (/^([a-zA-Z])\1+$/.test(trimmedText)) return true;
    if (/^(xd|lol|lmao|kek|haha|hehe|lul|kekw|lolol)+[!?]*$/i.test(trimmedText)) return true;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    const alphaCount = (trimmedText.match(/\p{Script=Latin}/gu) || []).length;
    if (!hasOtherForeignScript && alphaCount <= 1) return true;
    return false;
}

function hasTranslatableForeignText(text) {
    const value = String(text || '');
    const hasLatin = /\p{Script=Latin}/u.test(value);
    const withoutKnownJapanese = value.replace(/[\p{Script_Extensions=Han}ぁ-んァ-ヶー]/gu, '');
    const withoutLatin = withoutKnownJapanese.replace(/\p{Script=Latin}/gu, '');
    return hasLatin || /\p{L}/u.test(withoutLatin);
}

const YLC_TARGET_CHAT_NODE_TYPES = new Set([
    'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER',
    'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER',
    'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
    'YT-LIVE-CHAT-PAID-STICKER-RENDERER',
    'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER',
    'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER'
]);

function collectRecentChatNodes(mutations, limit = 5) {
    const recent = [];
    const safeLimit = Math.max(0, Number(limit) || 0);
    if (safeLimit === 0) return recent;
    for (const mutation of mutations || []) {
        for (const node of mutation.addedNodes || []) {
            if (node?.nodeType !== 1 || !YLC_TARGET_CHAT_NODE_TYPES.has(String(node.tagName || '').toUpperCase())) continue;
            recent.push(node);
            if (recent.length > safeLimit) recent.shift();
        }
    }
    return recent;
}

function createChatMutationBatcher(limit, processNode, scheduleFrame) {
    const safeLimit = Math.max(0, Number(limit) || 0);
    const schedule = scheduleFrame || (callback => requestAnimationFrame(callback));
    let pendingNodes = [];
    let scheduled = false;
    let generation = 0;
    return {
        push(mutations) {
            for (const node of collectRecentChatNodes(mutations, safeLimit)) {
                pendingNodes.push(node);
                if (pendingNodes.length > safeLimit) pendingNodes.shift();
            }
            if (scheduled || pendingNodes.length === 0) return;
            scheduled = true;
            const scheduledGeneration = generation;
            schedule(() => {
                scheduled = false;
                if (scheduledGeneration !== generation) return;
                const nodes = pendingNodes;
                pendingNodes = [];
                nodes.forEach(processNode);
            });
        },
        clear() {
            generation++;
            pendingNodes = [];
            scheduled = false;
        },
        pendingCount() { return pendingNodes.length; },
    };
}

// ---- スラング辞書による前処理 ----

let slangMap = null;
let slangMapPromise = null;
let slangRegexEntries = null;

function buildSlangRegexEntries(map) {
    return Object.entries(map).map(([pattern, replacement]) => ({
        regex: new RegExp(pattern, 'gi'),
        replacement,
    }));
}

function loadSlangMap() {
    if (slangMap) return Promise.resolve(slangMap);
    if (!slangMapPromise) {
        let slangDictUrl = '';
        try { slangDictUrl = chrome.runtime.getURL('slang_dict.json'); } catch { /* runtime喪失時 */ }
        slangMapPromise = fetch(slangDictUrl)
            .then(res => res.json())
            .then(data => {
                slangMap = data || {};
                slangRegexEntries = buildSlangRegexEntries(slangMap);
                return slangMap;
            })
            .catch(() => {
                slangMap = {};
                slangRegexEntries = [];
                return slangMap;
            });
    }
    return slangMapPromise;
}

async function preprocessForYouTubeChat(text) {
    if (!text) return text;
    await loadSlangMap();
    let processed = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    processed = processed.replace(/([\p{Emoji}])([a-zA-Z0-9])/gu, '$1 $2');
    processed = processed.replace(/([a-zA-Z0-9])([\p{Emoji}])/gu, '$1 $2');
    processed = processed.replace(/([a-zA-Z])\1{2,}/gi, '$1$1');
    for (const { regex, replacement } of slangRegexEntries) {
        regex.lastIndex = 0;
        processed = processed.replace(regex, replacement);
    }
    return processed;
}

// ---- ユーザー辞書による前処理 ----

let cachedDictionaryStr = null;
let cachedRegexEntries = [];

function preprocessWithDictionary(text, dictionaryStr) {
    if (!dictionaryStr || !text) return text;
    if (cachedDictionaryStr !== dictionaryStr) {
        cachedDictionaryStr = dictionaryStr;
        const lines = dictionaryStr.split('\n');
        const entries = [];
        for (const line of lines) {
            const parts = line.split(',');
            if (parts.length >= 2) {
                const original = parts[0].trim();
                const translated = parts.slice(1).join(',').trim();
                if (original && translated) entries.push({ original, translated });
            }
        }
        entries.sort((a, b) => b.original.length - a.original.length);
        cachedRegexEntries = entries.map(({ original, translated }) => {
            const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return { regex: new RegExp(escaped, 'gi'), translated };
        });
    }
    let processedText = text;
    for (const { regex, translated } of cachedRegexEntries) {
        regex.lastIndex = 0;
        processedText = processedText.replace(regex, translated);
    }
    return processedText;
}

// ---- Google翻訳結果のカジュアル化後処理 ----

const JAPANESE_POSTPROCESS_RULES = [
    [/ですね/g, 'だね'],
    [/ですよ/g, 'だよ'],
    [/でしょう/g, 'だろう'],
    [/ますか\？/g, '？'],
    [/ではありません/g, 'じゃない'],
    [/することができません/g, 'できない'],
    [/することができます/g, 'できる'],
    [/てしまいました/g, 'てしまった'],
    [/ということです/g, 'ってこと'],
    [/かもしれません/g, 'かもしれない'],
    [/なのです/g, 'なんだ'],
    [/しています/g, 'してる'],
    [/ています/g, 'てる'],
    [/ありません/g, 'ない'],
];

function postprocessJapanese(translationObj) {
    if (!translationObj || !translationObj.translation) return translationObj;
    let text = translationObj.translation;
    for (const [regex, replacement] of JAPANESE_POSTPROCESS_RULES) {
        text = text.replace(regex, replacement);
    }
    translationObj.translation = text;
    return translationObj;
}

// ---- Google翻訳（background/content script共有） ----

async function translateWithGoogle(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const translation = Array.isArray(data?.[0])
            ? data[0].map((segment) => (Array.isArray(segment) ? segment[0] : '')).join('').trim()
            : '';
        if (translation) return { translation };
        throw new Error("Invalid response");
    } catch (error) {
        return { error: "翻訳エラー" };
    }
}

// ---- 翻訳失敗キャッシュ（同一コメントの連続再試行を抑制） ----

const failedTranslationCache = new Map();
const FAILED_TRANSLATION_TTL = 60 * 1000;
const FAILED_TRANSLATION_MAX = 500;

function markTranslationFailed(text) {
    if (!text) return;
    if (failedTranslationCache.size >= FAILED_TRANSLATION_MAX) {
        failedTranslationCache.delete(failedTranslationCache.keys().next().value);
    }
    failedTranslationCache.set(text, Date.now());
}

function isRecentlyFailedTranslation(text) {
    const failedAt = failedTranslationCache.get(text);
    if (failedAt === undefined) return false;
    if (Date.now() - failedAt > FAILED_TRANSLATION_TTL) {
        failedTranslationCache.delete(text);
        return false;
    }
    return true;
}

// ---- content script直接翻訳フォールバック ----

const directTranslationCache = new Map();
const DIRECT_TRANSLATION_CACHE_MAX = 300;
const DIRECT_TRANSLATION_CACHE_TTL = 5 * 60 * 1000;

function getTranslationCacheContext(settings = {}, routeOverride = '') {
    const dictionary = String(settings.dictionary || '');
    let hash = 2166136261;
    for (let i = 0; i < dictionary.length; i++) {
        hash ^= dictionary.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const route = routeOverride ||
        (settings.translator === 'lmstudio' && settings.lmstudioModelActive === true ? 'lmstudio' : 'google');
    const model = route === 'lmstudio' ? (settings.lmstudioModel || '') : '';
    return `${route}:${model}:${hash >>> 0}`;
}

function directTranslationCacheKey(text, context = '') {
    return `${context}\u0000${text}`;
}

/**
 * content script文脈の翻訳結果共有キャッシュ。
 * background経由・直接fetchのどちらの成功結果も保存し、
 * 同一テキスト再出現時のservice worker起床とネットワークを節約する
 */
function getCachedTranslation(text, context = '') {
    if (!text) return null;
    const key = directTranslationCacheKey(text, context);
    const cached = directTranslationCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > DIRECT_TRANSLATION_CACHE_TTL) {
        directTranslationCache.delete(key);
        return null;
    }
    return cached.translation;
}

function cacheTranslation(text, translation, context = '') {
    if (!text || !translation) return;
    if (directTranslationCache.size >= DIRECT_TRANSLATION_CACHE_MAX) {
        directTranslationCache.delete(directTranslationCache.keys().next().value);
    }
    directTranslationCache.set(directTranslationCacheKey(text, context), { translation, timestamp: Date.now() });
}

/**
 * background中継が使えない環境向けのGoogle翻訳直接実行。
 * background経由と同じ前処理・辞書・後処理パイプラインを通す。
 *
 * 注意: MV3のcontent script fetchはページのCORS制約下にあり、
 * translate.googleapis.comがCORSを許可しない環境では失敗する。
 * 失敗は短期キャッシュされ連続再試行しない（Orion実機での可否は要検証）。
 */
async function translateDirectWithGoogle(text, dictionaryStr) {
    if (!text) return { error: '翻訳エラー' };
    if (isRecentlyFailedTranslation(text)) return { error: '翻訳エラー' };

    const context = getTranslationCacheContext({ translator: 'google', dictionary: dictionaryStr || '' });
    const cached = getCachedTranslation(text, context);
    if (cached) return { translation: cached };

    let processedText = await preprocessForYouTubeChat(text);
    processedText = preprocessWithDictionary(processedText, dictionaryStr || '');

    const result = await translateWithGoogle(processedText);
    if (result && result.translation) {
        postprocessJapanese(result);
        cacheTranslation(text, result.translation, context);
        return result;
    }

    markTranslationFailed(text);
    return result || { error: '翻訳エラー' };
}
