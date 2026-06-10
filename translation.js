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
    if (/[一-龠ぁ-んァ-ヶー]/.test(trimmedText)) return true;
    if (/^(w|ｗ|草)+$/i.test(trimmedText)) return true;
    if (/^https?:\/\/[^\s]+$/.test(trimmedText)) return true;
    if (/^[ｦ-ﾟ\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    if (/^[\p{Emoji}\s]+$/u.test(trimmedText) && !/[a-zA-Z0-9]/.test(trimmedText)) return true;
    if (/^([a-zA-Z])\1+$/.test(trimmedText)) return true;
    if (/^(xd|lol|lmao|kek|haha|hehe|lul|kekw|lolol)+[!?]*$/i.test(trimmedText)) return true;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    const alphaCount = (trimmedText.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount <= 1) return true;
    return false;
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
