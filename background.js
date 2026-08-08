// 共有翻訳ユーティリティ（前処理・辞書・後処理）を読み込む。
// Chrome系service workerではimportScripts、event page型（Firefox/Orion系）では
// manifestのbackground.scriptsで先に読み込まれるため二重読込しない
if (typeof importScripts === 'function' && typeof preprocessForYouTubeChat === 'undefined') {
    importScripts('translation.js');
}

const translationCache = new Map();
const pendingTranslations = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 1000;
const CACHE_VERSION = 'lmstudio-clean-v7';
const LMSTUDIO_ENDPOINT = 'http://localhost:1234';
const LANGUAGE_CACHE_MAX = 300;
const detectedLanguageCache = new Map();

// TranslateGemmaのchat templateが受け付ける主要なISO 639-1コード。
// detectLanguageが返す地域付きコードは基本言語へ正規化して照合する。
const TRANSLATEGEMMA_SUPPORTED_LANGUAGES = new Set([
    'af', 'am', 'ar', 'be', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en',
    'es', 'et', 'fa', 'fi', 'fr', 'ga', 'gu', 'he', 'hi', 'hr', 'hu',
    'id', 'is', 'it', 'ja', 'kn', 'ko', 'lt', 'lv', 'ml', 'mr', 'ms', 'nl',
    'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta',
    'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh'
]);

const SETTINGS_DEFAULTS = {
    translator: 'google',
    lmstudioModel: '',
    lmstudioModelActive: false,
    ollamaEndpoint: 'http://localhost:11434',
    ollamaModel: 'youtube-translator:latest',
    ollamaModelActive: false,
    enableGoogleTranslateFallback: true,
    dictionary: ''
};

function normalizeSettings(settings) {
    const normalized = { ...settings };
    if (normalized.translator === 'ollama') normalized.translator = 'lmstudio';
    if (!normalized.lmstudioModel && normalized.ollamaModel) normalized.lmstudioModel = normalized.ollamaModel;
    if (normalized.lmstudioModelActive === undefined && normalized.ollamaModelActive !== undefined) {
        normalized.lmstudioModelActive = normalized.ollamaModelActive;
    }
    normalized.lmstudioModel = normalized.lmstudioModel || '';
    normalized.lmstudioModelActive = normalized.lmstudioModelActive === true;
    return normalized;
}

function isTranslateGemmaModel(modelId) {
    const normalized = String(modelId || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return normalized.includes('translategemma') &&
        /(?:^|-)4b(?:-|$)/.test(normalized) &&
        /(?:^|-)it(?:-|$)/.test(normalized);
}

function normalizeDetectedLanguage(language) {
    const aliases = { iw: 'he', in: 'id' };
    const detected = String(language || '').toLowerCase().split(/[-_]/)[0];
    const base = aliases[detected] || detected;
    if (!/^[a-z]{2}$/.test(base)) return null;
    return TRANSLATEGEMMA_SUPPORTED_LANGUAGES.has(base) ? base : null;
}

function isLanguageScriptCompatible(text, language) {
    const scripts = {
        cyrillic: /[\u0400-\u04ff]/,
        korean: /[\uac00-\ud7a3]/,
        thai: /[\u0e00-\u0e7f]/,
        arabic: /[\u0600-\u06ff]/,
        devanagari: /[\u0900-\u097f]/,
        ethiopic: /[\u1200-\u137f]/,
        bengali: /[\u0980-\u09ff]/,
        greek: /[\u0370-\u03ff]/,
        gujarati: /[\u0a80-\u0aff]/,
        hebrew: /[\u0590-\u05ff]/,
        kannada: /[\u0c80-\u0cff]/,
        malayalam: /[\u0d00-\u0d7f]/,
        gurmukhi: /[\u0a00-\u0a7f]/,
        tamil: /[\u0b80-\u0bff]/,
        telugu: /[\u0c00-\u0c7f]/,
        japanese: /[\u3040-\u30ff\u3400-\u9fff]/,
        latin: /[a-zA-Z\u00c0-\u024f]/
    };
    if (language === 'sr') return scripts.cyrillic.test(text) || scripts.latin.test(text);
    const expected = new Map([
        ['ru', 'cyrillic'], ['uk', 'cyrillic'], ['bg', 'cyrillic'], ['be', 'cyrillic'],
        ['ko', 'korean'], ['th', 'thai'], ['ar', 'arabic'], ['fa', 'arabic'], ['ur', 'arabic'],
        ['hi', 'devanagari'], ['mr', 'devanagari'], ['ja', 'japanese'], ['zh', 'japanese'],
        ['am', 'ethiopic'], ['bn', 'bengali'], ['el', 'greek'], ['gu', 'gujarati'], ['he', 'hebrew'],
        ['kn', 'kannada'], ['ml', 'malayalam'], ['pa', 'gurmukhi'], ['ta', 'tamil'], ['te', 'telugu']
    ]).get(language) || 'latin';
    // ライブチャットでは人名など別scriptが混在するため、期待scriptが本文にあれば許可する。
    return scripts[expected].test(text);
}

function detectLanguage(text) {
    if (!text || typeof chrome?.i18n?.detectLanguage !== 'function') return Promise.resolve(null);
    if (detectedLanguageCache.has(text)) return Promise.resolve(detectedLanguageCache.get(text));
    return new Promise(resolve => {
        try {
            chrome.i18n.detectLanguage(text, result => {
                const top = result?.languages?.[0];
                // 短いライブチャットではisReliable/percentageが低くても第1候補は有用。
                // 対応言語の第1候補を採用し、候補自体がないASCII文だけ英語へ寄せる。
                let language = normalizeDetectedLanguage(top?.language);
                const percentage = Number(top?.percentage) || 0;
                if (percentage < 20 || !isLanguageScriptCompatible(text, language)) language = null;
                const nonLatinText = String(text).replace(/\p{Script=Latin}/gu, '');
                if (!language && /[a-zA-Z].*[a-zA-Z]/.test(text) && !/\p{L}/u.test(nonLatinText)) {
                    language = 'en';
                }
                if (detectedLanguageCache.size >= LANGUAGE_CACHE_MAX) {
                    detectedLanguageCache.delete(detectedLanguageCache.keys().next().value);
                }
                detectedLanguageCache.set(text, language);
                resolve(language);
            });
        } catch {
            resolve(null);
        }
    });
}

function fingerprint(value) {
    let hash = 2166136261;
    const input = String(value || '');
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function buildTranslationCacheKey(text, settings, route, sourceLanguage = '') {
    return [
        CACHE_VERSION,
        route,
        route === 'lmstudio' ? (settings.lmstudioModel || '') : '',
        sourceLanguage,
        fingerprint(settings.dictionary || ''),
        text
    ].join(':');
}

const LIVE_CHAT_STYLE_INSTRUCTIONS = `Use concise, natural, casual Japanese, not formal, polite, literary, or instructional language. ` +
    `Keep the translation close to the source length and energy. ` +
    `Preserve names, handles, titles, abbreviations, emotes, stylized spellings, capitalization-based emphasis, ` +
    `and unknown terms when their meaning is uncertain. ` +
    `Copy names, handles, and mixed-case or stylized tokens exactly as written; do not translate, transliterate, split, or normalize them. ` +
    `Do not add subjects, honorifics, definitions, explanations, inferred context, or information not present in the source. ` +
    `Do not expand abbreviations or give multiple dictionary meanings. ` +
    `Keep questions, fragments, repetition, laughter, and incomplete sentences in the same form and tone as the source.`;

function buildTranslateGemmaRequest(model, text, sourceLanguage) {
    let sourceLanguageName = sourceLanguage.toUpperCase();
    try {
        sourceLanguageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(sourceLanguage) || sourceLanguageName;
    } catch { /* DisplayNames未対応時は言語コードを使う */ }
    const prompt = `Translate this YouTube live chat message from ${sourceLanguageName} (${sourceLanguage}) to Japanese (ja).\n` +
        `${LIVE_CHAT_STYLE_INSTRUCTIONS} Output one translation only.\n\n\n${text}`;
    return {
        model,
        messages: [{
            role: 'user',
            content: prompt
        }],
        temperature: 0,
        max_tokens: 128,
        stream: false
    };
}

function buildDefaultLmstudioRequest(model, text) {
    const systemPrompt = `You are a YouTube live chat translator. ` +
        `${LIVE_CHAT_STYLE_INSTRUCTIONS} ` +
        `Output only the Japanese translation. No labels, original text, markdown, or reasoning.`;
    return {
        model,
        input: text,
        system_prompt: systemPrompt,
        reasoning: 'off',
        temperature: 0,
        max_output_tokens: 80,
        stream: false,
        store: false
    };
}

function buildDefaultLmstudioCompatibilityRequest(model, text) {
    const nativeRequest = buildDefaultLmstudioRequest(model, text);
    return {
        model,
        messages: [
            { role: 'system', content: nativeRequest.system_prompt.replace('Output only the Japanese translation.', 'Output only a JSON object matching the required schema.') },
            { role: 'user', content: text }
        ],
        temperature: 0,
        max_tokens: 80,
        stream: false,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'chat_translation',
                strict: true,
                schema: {
                    type: 'object',
                    properties: {
                        translation: { type: 'string' }
                    },
                    required: ['translation'],
                    additionalProperties: false
                }
            }
        }
    };
}

function cleanupTranslateGemmaTranslation(output, sourceText = '') {
    const text = String(output || '')
        .replace(/```(?:\w+)?/g, '')
        .replace(/```/g, '')
        .replace(/^(?:translation|translated text|翻訳|日本語訳)\s*[:：-]\s*/i, '')
        .trim();
    if (!text || text === String(sourceText || '').trim()) return '';
    return text;
}

function storageGet(areaName, keys) {
    return new Promise((resolve, reject) => {
        const area = chrome?.storage?.[areaName];
        if (!area?.get) { reject(new Error(`storage.${areaName} unavailable`)); return; }
        try {
            const maybePromise = area.get(keys, value => {
                const error = chrome.runtime?.lastError;
                if (error) reject(new Error(error.message));
                else resolve(value || {});
            });
            if (maybePromise?.then) maybePromise.then(value => resolve(value || {}), reject);
        } catch (error) { reject(error); }
    });
}

async function loadTranslationSettings() {
    const marker = await storageGet('local', ['ylcSettingsArea', 'ylcMigratedFromSync']).catch(() => ({}));
    if (marker?.ylcSettingsArea === 'local' || (!marker?.ylcSettingsArea && marker?.ylcMigratedFromSync)) {
        return normalizeSettings(await storageGet('local', SETTINGS_DEFAULTS).catch(() => ({ ...SETTINGS_DEFAULTS })));
    }
    try {
        return normalizeSettings(await storageGet('sync', SETTINGS_DEFAULTS));
    } catch {
        return normalizeSettings(await storageGet('local', SETTINGS_DEFAULTS).catch(() => ({ ...SETTINGS_DEFAULTS })));
    }
}

const LMSTUDIO_HEADERS = { 'Content-Type': 'application/json' };

function extractLmstudioText(data) {
    const texts = [];
    const readContent = (content) => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map(item => {
                if (typeof item === 'string') return item;
                if (item?.type && /reasoning|thinking|analysis/i.test(item.type)) return '';
                return item?.text || item?.content || '';
            }).filter(Boolean).join('\n');
        }
        if (content && typeof content === 'object') return content.text || content.content || '';
        return '';
    };
    const push = (value) => {
        const text = readContent(value).trim();
        if (text) texts.push(text);
    };

    if (typeof data?.output_text === 'string') push(data.output_text);
    if (Array.isArray(data?.choices)) {
        for (const choice of data.choices) {
            push(choice?.message?.content || choice?.delta?.content || choice?.text);
        }
    }
    if (data?.message) push(data.message.content);
    if (typeof data?.content === 'string') push(data.content);
    if (typeof data?.response === 'string') push(data.response);
    if (Array.isArray(data?.output)) {
        for (const item of data.output) {
            if (item?.type && /reasoning|thinking|analysis/i.test(item.type)) continue;
            if (item?.type === 'message' || item?.role === 'assistant' || item?.content || item?.text) {
                push(item.content || item.text);
            }
        }
    }
    return texts.join('\n').trim();
}

function getQuickChatTranslation(text) {
    const normalized = (text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!normalized) return '';
    const universalReaction = getUniversalQuickReaction(normalized);
    if (universalReaction !== null) return universalReaction;
    const lower = normalized.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
    const compact = normalized.replace(/\s+/g, '');
    const compactLower = lower.replace(/\s+/g, '');
    if (/^and that['?]?s very reasonable[.!?]*$/.test(lower)) return 'それはすごくわかる';
    if (/^he (?:is |'s )?addicted(?: (?:for real|fr))?[.!?]*$/.test(lower)) return 'マジでハマってるね';
    if (/^he can'?t stop[.!?]*$/.test(lower)) return '止まらないね';
    if (/^i get (?:u|you)(?: man)?[.!?]*$/.test(lower)) return 'わかるよ';
    if (/^this game is dangerous(?: haha| lol)?[.!?]*$/.test(lower)) return 'このゲームやばいw';
    if (/^it'?s so addicting to watch[.!?]*$/.test(lower)) return '見てるだけでハマる';
    if (/^yes vox you must play[.!?]*$/.test(lower)) return 'Vox、絶対やって！';
    if (/^oh no omg the drama[.!?]*$/.test(lower)) return 'うわ、めっちゃドラマだ';
    if (/^they hate each other[!.\-\s]*bruh[.!?]*$/.test(lower)) return 'めっちゃ仲悪いじゃん';
    if (/can'?t wait[.!?]*$/.test(lower)) return '待ちきれない！';
    if (/^it'?s possible[.!?]*$/.test(lower)) return 'いける！';
    if (/^(?:l+mao+|lmfao+|rofl|lol+|lo+l|kekw+|kek+|lul+|omegalul+|ha(?:ha)+|haha+|hehe+|xd)+[!?.~wｗ草]*$/i.test(compact)) {
        return '草';
    }
    if (/^(?:yes|please|yesplease|pls|plz)[!?.~]*$/i.test(compactLower)) {
        return /please|pls|plz/i.test(compactLower) ? 'お願い！' : 'うん！';
    }
    if (/^(?:ye+s+|yeh+|yep+|yeah+|yea+|yup+)[!?.~]*$/i.test(compactLower)) {
        return 'うん！';
    }
    if (/^(?:ya+s+|yippee+|yay+|ya+y+|let'?sgo+|letsgo+)[!?.~]*$/i.test(compactLower)) {
        return 'やった！';
    }
    if (/^(?:omg+|ohmygod|holy(?:moly|shit|cow))[!?.~]*$/i.test(compactLower)) {
        return 'マジか';
    }
    if (/^short\??$/i.test(normalized)) {
        return '短い？';
    }
    if (/^play\s+it[,!\s]*(?:vox)?[!?.\s]*$/i.test(normalized)) {
        return 'やって、Vox！';
    }
    if (/^play\s+it+[!?.\s]*$/i.test(normalized)) {
        return 'やって！';
    }
    if (/^(?:face-[a-z-]+)+$/i.test(compact)) {
        return '';
    }
    return null;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseStructuredTranslation(raw, sourceText = '') {
    if (!raw) return '';
    const s = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return '';
    try {
        const obj = JSON.parse(s.slice(start, end + 1));
        const translation = (obj && typeof obj.translation === 'string') ? obj.translation.trim() : '';
        if (!translation) return '';
        if (sourceText && translation.toLowerCase() === sourceText.trim().toLowerCase()) return '';
        return translation;
    } catch {
        return '';
    }
}

function cleanupLmstudioTranslation(output, sourceText = '') {
    if (!output) return '';
    let text = output
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```[\s\S]*?```/g, block => block.replace(/```(?:\w+)?|```/g, ''))
        .replace(/\*\*(?:元のフレーズ|文脈の推測|翻訳の方向性|候補|翻訳|答え|出力)\s*:\*\*/gi, '\n')
        .trim();
    const source = (sourceText || '').trim();
    if (source) {
        text = text.replace(new RegExp(`^${escapeRegExp(source)}\\s*`, 'i'), '').trim();
    }
    const hasJapanese = (value) => /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
    const isExplanation = (value) =>
        /(ユーザー|元の|原文|文脈|推測|方向性|候補|直訳|意訳|最も|判断|フレーズ|YouTube|チャット|英語|日本語訳|翻訳対象|対象のテキスト|一般的|ニュアンス|シンプル|今回は|そのまま|音の響き|以下|理由|解説|説明|注|感嘆詞|表現|適切|という意味|意味です|意味だ|合わせて|カジュアル|翻訳する|である|だろう|note|because|means|meaning|the user|wants me|translate|translation|casual Japanese)/i.test(value);
    const stripLabel = (value) => value
        .replace(/^[>\-\*\s]+/, '')
        .replace(/^\d+[.)、]\s*/, '')
        .replace(/^(?:final\s*)?(?:japanese\s*)?(?:translation|answer|output)\s*[:：-]\s*/i, '')
        .replace(/^(?:翻訳文|翻訳結果|日本語訳|翻訳|訳|カジュアルな訳|答え|回答|出力|採用案|最終)\s*[:：-]\s*/i, '')
        .trim();
    const trimDecorations = (value) => value
        .replace(/^[\s"'`「『【\[(]+/, '')
        .replace(/[\s"'`」』】\])]+$/, '')
        .trim();
    const isUsableTranslation = (value) =>
        value &&
        hasJapanese(value) &&
        (value.length >= 2 || /^[草笑wｗ]+$/.test(value)) &&
        !isExplanation(value) &&
        (!source || value.toLowerCase() !== source.toLowerCase()) &&
        value.length <= 80;

    const lines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => trimDecorations(stripLabel(line)))
        .filter(Boolean);
    const candidates = lines.filter(isUsableTranslation);

    for (const line of lines) {
        const parts = line
            .split(/\s*[/／]\s*/)
            .map(part => trimDecorations(stripLabel(part)))
            .filter(isUsableTranslation);
        candidates.push(...parts);
    }

    const numberedMatches = [...text.matchAll(/(?:^|\s)\d+[.)、]\s*([^。！？\n]+[。！？]?)/g)]
        .map(match => match[1].trim())
        .filter(isUsableTranslation);
    candidates.push(...numberedMatches);

    const sentenceTail = text
        .split(/[。！？]/)
        .map(part => part.trim())
        .filter(Boolean)
        .pop();
    if (isUsableTranslation(sentenceTail)) candidates.push(sentenceTail);

    const trailingJapanese = text.match(/([\u3040-\u30ff\u3400-\u9fff][\u3040-\u30ff\u3400-\u9fff\s、。！？!?（）()・ー〜…wｗ草笑]{0,79})$/);
    if (trailingJapanese && isUsableTranslation(trailingJapanese[1].trim())) {
        candidates.push(trailingJapanese[1].trim());
    }

    if (candidates.length) {
        text = candidates[0];
    }

    text = text
        .split(/\r?\n/)[0]
        .replace(/^(?:翻訳文|翻訳結果|日本語訳|翻訳|訳|カジュアルな訳|答え|回答|出力|採用案|最終)\s*[:：-]\s*/i, '')
        .replace(/^[\s"'`「『【\[(]+/, '')
        .replace(/[\s"'`」』】\])]+$/, '')
        .trim();
    return isUsableTranslation(text) ? text : '';
}

function purgeExpiredCacheEntries() {
    const now = Date.now();
    for (const [key, value] of translationCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            translationCache.delete(key);
        }
    }
}

// タブが閉じられたらタブ固有の設定をクリア（tabs API未対応環境ではスキップ。
// その場合の残留はextension_api.js側のTTL掃除が拾う）
try {
    chrome.tabs?.onRemoved?.addListener((tabId) => {
        chrome.storage.local.remove(`tabState_${tabId}`);
    });
} catch (e) { /* tabs API未対応環境 */ }

// キャッシュ掃除は翻訳リクエスト処理時のオンデマンド実行のみ（60秒間隔で間引き）。
// キャッシュはSWメモリ上にありサスペンドで消えるため、定期タイマーは持たない
let lastCachePurgeAt = 0;
function purgeExpiredCacheThrottled() {
    const now = Date.now();
    if (now - lastCachePurgeAt < 60 * 1000) return;
    lastCachePurgeAt = now;
    purgeExpiredCacheEntries();
}

// preprocessForYouTubeChat / preprocessWithDictionary / postprocessJapanese /
// translateWithGoogle は translation.js（共有）で定義される

async function translateWithLmstudio(text, settings, sourceLanguage = '') {
    const endpoint = LMSTUDIO_ENDPOINT;
    const model = settings.lmstudioModel;
    if (!model) throw new Error('LM Studio model is not selected');

    const quickTranslation = getQuickChatTranslation(text);
    if (quickTranslation !== null) return { translation: quickTranslation };

    const translateGemma = isTranslateGemmaModel(model);
    let body = translateGemma
        ? buildTranslateGemmaRequest(model, text, sourceLanguage)
        : buildDefaultLmstudioRequest(model, text);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        let response = await fetch(`${endpoint}${translateGemma ? '/v1/chat/completions' : '/api/v1/chat'}`, {
            method: 'POST',
            headers: LMSTUDIO_HEADERS,
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!translateGemma && !response.ok) {
            const detail = await response.text().catch(() => '');
            if (response.status === 400 && /reasoning/i.test(detail)) {
                body = buildDefaultLmstudioCompatibilityRequest(model, text);
                response = await fetch(`${endpoint}/v1/chat/completions`, {
                    method: 'POST',
                    headers: LMSTUDIO_HEADERS,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } else {
                throw new Error(detail || `LM Studio HTTP ${response.status}`);
            }
        }
        if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}`);
        const data = await response.json();
        const raw = translateGemma
            ? (data?.choices?.[0]?.message?.content || '')
            : extractLmstudioText(data);
        const out = translateGemma
            ? cleanupTranslateGemmaTranslation(raw, text)
            : (parseStructuredTranslation(raw, text) || cleanupLmstudioTranslation(raw, text));
        if (!out) throw new Error('LM Studio empty response');
        return { translation: out };
    } finally {
        clearTimeout(timer);
    }
}

async function resolveTranslationRoute(text, settings) {
    const useLmstudio = settings.translator === 'lmstudio' && settings.lmstudioModelActive === true;
    if (!useLmstudio) return { route: 'google', sourceLanguage: '' };
    if (!isTranslateGemmaModel(settings.lmstudioModel)) return { route: 'lmstudio', sourceLanguage: '' };
    const sourceLanguage = await detectLanguage(text);
    if (sourceLanguage) return { route: 'lmstudio', sourceLanguage };
    return { route: settings.enableGoogleTranslateFallback ? 'google' : 'unavailable', sourceLanguage: '' };
}

const UNIVERSAL_QUICK_REACTIONS = Object.freeze({
    oh: '\u304a\u304a',
    'oh nice': '\u304a\u3001\u3044\u3044\u306d',
    nice: '\u3044\u3044\u306d',
    maybe: '\u305f\u3076\u3093',
    'hmm maybe': '\u3046\u30fc\u3093\u3001\u305d\u3046\u304b\u3082',
    'makes sense': '\u306a\u308b\u307b\u3069',
    cute: '\u304b\u308f\u3044\u3044',
    wow: '\u308f\u3042',
    thanks: '\u3042\u308a\u304c\u3068\u3046',
    'thank you': '\u3042\u308a\u304c\u3068\u3046',
    'no way': '\u307e\u3055\u304b',
    yes: '\u3046\u3093',
    no: '\u3044\u3084'
});

function getUniversalQuickReaction(text) {
    const normalized = String(text || '').trim().replace(/[\u2018\u2019]/g, "'");
    const match = normalized.match(/^([a-z]+(?:[ '\u2019][a-z]+)*)([!?~.]+)?$/i);
    if (!match) return null;
    const phrase = match[1].toLowerCase().replace(/\s+/g, ' ');
    if (!Object.prototype.hasOwnProperty.call(UNIVERSAL_QUICK_REACTIONS, phrase)) return null;
    const punctuation = String(match[2] || '')
        .slice(0, 5)
        .replace(/!/g, '\uff01')
        .replace(/\?/g, '\uff1f')
        .replace(/~+/g, '\uff5e')
        .replace(/\.{2,}/g, '\u2026')
        .replace(/\.$/, '');
    return UNIVERSAL_QUICK_REACTIONS[phrase] + punctuation;
}

async function handleTranslationRequest(text, settings, routeInfo) {
    settings = normalizeSettings(settings);
    const { enableGoogleTranslateFallback, dictionary } = settings;
    let processedText = await preprocessForYouTubeChat(text);
    processedText = preprocessWithDictionary(processedText, dictionary);
    let result;
    let usedTranslator = routeInfo.route;

    if (routeInfo.route === 'unavailable') {
        return { error: '原文言語を判定できません' };
    }
    if (routeInfo.route === 'lmstudio') {
        try {
            result = await translateWithLmstudio(processedText, settings, routeInfo.sourceLanguage);
        } catch (e) {
            if (enableGoogleTranslateFallback) {
                result = await translateWithGoogle(processedText);
                usedTranslator = 'google';
            } else {
                return { error: 'LM Studio翻訳エラー' };
            }
        }
    } else {
        result = await translateWithGoogle(processedText);
        usedTranslator = 'google';
    }

    const finalResult = usedTranslator === 'google' ? postprocessJapanese(result) : result;
    return { result: finalResult, usedTranslator };
}

async function listLmstudioModels() {
    const ep = LMSTUDIO_ENDPOINT;
    const response = await fetch(`${ep}/api/v1/models`, {
        headers: LMSTUDIO_HEADERS
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const llms = Array.isArray(data.models) ? data.models.filter(model => model?.type === 'llm') : [];
    const models = llms.map(model => model.selected_variant || model.key).filter(Boolean);
    const modelDetails = {};
    for (const model of llms) {
        const id = model.selected_variant || model.key;
        if (!id) continue;
        modelDetails[id] = {
            publisher: model.publisher || '',
            quantization: model.quantization?.name || '',
            format: model.format || '',
        };
    }
    return { models, modelDetails };
}

async function getLmstudioLoadedInstanceId(model) {
    const ep = LMSTUDIO_ENDPOINT;
    const v1Response = await fetch(`${ep}/api/v1/models`, {
        headers: LMSTUDIO_HEADERS
    });
    if (!v1Response.ok) throw new Error(`HTTP ${v1Response.status}`);
    const v1Data = await v1Response.json();
    const v1Models = Array.isArray(v1Data.models) ? v1Data.models : [];
    const target = v1Models.find(item =>
        item?.key === model ||
        item?.selected_variant === model ||
        (Array.isArray(item?.variants) && item.variants.includes(model))
    );
    const v1InstanceId = target?.loaded_instances?.[0]?.id;
    if (v1InstanceId) return v1InstanceId;

    const v0Response = await fetch(`${ep}/api/v0/models`, {
        headers: LMSTUDIO_HEADERS
    });
    if (!v0Response.ok) return null;
    const v0Data = await v0Response.json();
    const v0Models = Array.isArray(v0Data.data) ? v0Data.data : [];
    const loaded = v0Models.find(item =>
        item?.state === 'loaded' &&
        (item.id === model || item.id === target?.key || item.id === target?.selected_variant)
    );
    return loaded?.id || null;
}

async function unloadLmstudioModel(model) {
    const ep = LMSTUDIO_ENDPOINT;
    const instanceId = await getLmstudioLoadedInstanceId(model);
    if (!instanceId) return;
    const unloadResponse = await fetch(`${ep}/api/v1/models/unload`, {
        method: 'POST',
        headers: LMSTUDIO_HEADERS,
        body: JSON.stringify({ instance_id: instanceId })
    });
    if (unloadResponse.status === 404) return;
    if (!unloadResponse.ok) throw new Error(`HTTP ${unloadResponse.status}`);
}

async function warmupLmstudioModel(model) {
    const ep = LMSTUDIO_ENDPOINT;
    const response = await fetch(`${ep}/v1/chat/completions`, {
        method: 'POST',
        headers: LMSTUDIO_HEADERS,
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'Reply with OK only.' },
                { role: 'user', content: 'OK' }
            ],
            temperature: 0,
            max_tokens: 4,
            stream: false,
        })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        if (request.action === 'toggleSettingsPanel') {
            if (sender.tab?.id) chrome.tabs?.sendMessage(sender.tab.id, { action: 'toggleSettingsPanel' });
            sendResponse({ ok: true });
            return;
        }
        if (request.action === 'getTabId') {
            sendResponse({ tabId: sender.tab?.id });
            return;
        }
        if (request.type === 'FLOW_COMMENT_DATA') {
            if (sender.tab?.id) chrome.tabs?.sendMessage(sender.tab.id, request);
            sendResponse({ ok: true });
            return;
        }
        if (request.action === 'lmstudioListModels') {
            try {
                const listed = await listLmstudioModels();
                sendResponse({ ok: true, models: listed.models, modelDetails: listed.modelDetails });
            } catch (e) {
                sendResponse({ ok: false, error: String(e.message || e) });
            }
            return;
        }
        if (request.action === 'lmstudioSetActive') {
            const { active, model } = request;
            const ep = LMSTUDIO_ENDPOINT;
            const m = model || '';
            try {
                if (active) {
                    if (!m) throw new Error('モデルが選択されていません');
                    const response = await fetch(`${ep}/api/v1/models/load`, {
                        method: 'POST',
                        headers: LMSTUDIO_HEADERS,
                        body: JSON.stringify({ model: m })
                    });
                    if (response.status === 404) {
                        await warmupLmstudioModel(m);
                    } else if (!response.ok) {
                        let detail = '';
                        try {
                            const data = await response.json();
                            detail = data?.error?.message || data?.message || '';
                        } catch { /* JSONでないエラー */ }
                        if (isTranslateGemmaModel(m) && /template|parser|healthy/i.test(detail)) {
                            throw new Error('TranslateGemma用のLM Studioプロンプトテンプレート設定が必要です。READMEの手順を確認してください。');
                        }
                        throw new Error(detail || `HTTP ${response.status}`);
                    }
                } else if (m) {
                    await unloadLmstudioModel(m);
                }
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: String(e.message || e) });
            }
            return;
        }
        if (request.action === "translate") {
            const text = request.text;
            if (!text) { sendResponse({ error: 'No text' }); return; }
            purgeExpiredCacheThrottled();
            const settings = await loadTranslationSettings();
            const routeInfo = await resolveTranslationRoute(text, settings);
            const cacheKey = buildTranslationCacheKey(text, settings, routeInfo.route, routeInfo.sourceLanguage);
            const cached = translationCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
                sendResponse({ translation: cached.translation });
                return;
            }
            if (pendingTranslations.has(cacheKey)) {
                const pendingOutcome = await pendingTranslations.get(cacheKey);
                const pendingResult = pendingOutcome?.result || pendingOutcome;
                sendResponse(pendingResult?.translation
                    ? { ...pendingResult, translator: pendingOutcome?.usedTranslator || routeInfo.route }
                    : pendingResult);
                return;
            }
            const task = handleTranslationRequest(text, settings, routeInfo);
            pendingTranslations.set(cacheKey, task);
            try {
                const outcome = await task;
                const result = outcome?.result || outcome;
                if (result?.translation) {
                    if (translationCache.size >= MAX_CACHE_SIZE) {
                        translationCache.delete(translationCache.keys().next().value);
                    }
                    const finalKey = buildTranslationCacheKey(
                        text,
                        settings,
                        outcome?.usedTranslator || routeInfo.route,
                        routeInfo.sourceLanguage
                    );
                    translationCache.set(finalKey, { translation: result.translation, timestamp: Date.now() });
                    while (translationCache.size > MAX_CACHE_SIZE) {
                        translationCache.delete(translationCache.keys().next().value);
                    }
                }
                sendResponse(result?.translation
                    ? { ...result, translator: outcome?.usedTranslator || routeInfo.route }
                    : result);
            } finally {
                pendingTranslations.delete(cacheKey);
            }
            return;
        }
        sendResponse({ ok: false, error: 'Unknown action' });
    })();
    return true; 
});

// default_popup設定済みの環境ではonClickedは発火しない。
// default_popup未対応環境向けのフォールバックとして残す
try {
    chrome.action?.onClicked?.addListener((tab) => {
        if (tab.url && tab.url.includes("youtube.com/watch")) {
            chrome.tabs?.sendMessage(tab.id, { action: "toggleSettingsPanel" });
        }
    });
} catch (e) { /* action API未対応環境 */ }
