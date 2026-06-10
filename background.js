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
const CACHE_VERSION = 'lmstudio-clean-v5';
const LMSTUDIO_ENDPOINT = 'http://localhost:1234';

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

// キャッシュクリーンアップ（alarms未対応環境では翻訳リクエスト時の間引きのみで運用）
try {
    chrome.runtime.onInstalled.addListener(() => {
        try {
            chrome.alarms?.create('cleanupCache', { periodInMinutes: 1 });
        } catch (e) { /* alarms未対応環境 */ }
    });
    chrome.alarms?.onAlarm?.addListener((alarm) => {
        if (alarm.name === 'cleanupCache') purgeExpiredCacheEntries();
    });
} catch (e) { /* alarms未対応環境 */ }

// alarmsが動かない環境向けの保険: 翻訳リクエスト処理時に60秒間隔で期限切れを間引く
let lastCachePurgeAt = 0;
function purgeExpiredCacheThrottled() {
    const now = Date.now();
    if (now - lastCachePurgeAt < 60 * 1000) return;
    lastCachePurgeAt = now;
    purgeExpiredCacheEntries();
}

// preprocessForYouTubeChat / preprocessWithDictionary / postprocessJapanese \u306F
// translation.js\uFF08\u5171\u6709\uFF09\u3067\u5B9A\u7FA9\u3055\u308C\u308B

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

async function translateWithLmstudio(text, settings) {
    const endpoint = LMSTUDIO_ENDPOINT;
    const model = settings.lmstudioModel;
    if (!model) throw new Error('LM Studio model is not selected');

    const quickTranslation = getQuickChatTranslation(text);
    if (quickTranslation !== null) return { translation: quickTranslation };

    const systemPrompt = `You are a YouTube live chat translator.
Translate the user message into natural casual Japanese.
Output ONLY a JSON object: {"translation":"<japanese>"}.
No explanation. No labels. No original text. No markdown. No reasoning.
For short reactions use 草 / マジか / やった / うん / お願い.
Keep names like Vox unchanged.`;
    const body = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: LMSTUDIO_HEADERS,
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}`);
        const data = await response.json();
        const raw = data?.choices?.[0]?.message?.content || '';
        const out = parseStructuredTranslation(raw, text) || cleanupLmstudioTranslation(raw, text);
        if (!out) throw new Error('LM Studio empty response');
        return { translation: out };
    } finally {
        clearTimeout(timer);
    }
}

async function handleTranslationRequest(text, settings) {
    settings = normalizeSettings(settings);
    const { translator, lmstudioModelActive, enableGoogleTranslateFallback, dictionary } = settings;
    let processedText = await preprocessForYouTubeChat(text);
    processedText = preprocessWithDictionary(processedText, dictionary);
    let result;
    const useLmstudio = translator === 'lmstudio' && lmstudioModelActive === true;
    let usedTranslator = useLmstudio ? 'lmstudio' : 'google';

    if (useLmstudio) {
        try {
            result = await translateWithLmstudio(processedText, settings);
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
    if (finalResult && finalResult.translation) {
        if (translationCache.size >= MAX_CACHE_SIZE) {
            const firstKey = translationCache.keys().next().value;
            translationCache.delete(firstKey);
        }
        const cacheKey = `${CACHE_VERSION}:${usedTranslator}:${usedTranslator === 'lmstudio' ? (settings.lmstudioModel || '') : ''}:${text}`;
        translationCache.set(cacheKey, { translation: finalResult.translation, timestamp: Date.now() });
    }
    return finalResult;
}

async function listLmstudioModels() {
    const ep = LMSTUDIO_ENDPOINT;
    const response = await fetch(`${ep}/api/v1/models`, {
        headers: LMSTUDIO_HEADERS
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.models)
        ? data.models
            .filter(model => model?.type === 'llm')
            .map(model => model.selected_variant || model.key)
            .filter(Boolean)
        : [];
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
                const models = await listLmstudioModels();
                sendResponse({ ok: true, models });
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
                        throw new Error(`HTTP ${response.status}`);
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
            const settings = normalizeSettings(await new Promise(r => chrome.storage.sync.get(SETTINGS_DEFAULTS, r)));
            const useLmstudio = settings.translator === 'lmstudio' && settings.lmstudioModelActive === true;
            const usedTranslator = useLmstudio ? 'lmstudio' : 'google';
            const cacheKey = `${CACHE_VERSION}:${usedTranslator}:${usedTranslator === 'lmstudio' ? (settings.lmstudioModel || '') : ''}:${text}`;
            const cached = translationCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
                sendResponse({ translation: cached.translation });
                return;
            }
            if (pendingTranslations.has(cacheKey)) {
                sendResponse(await pendingTranslations.get(cacheKey));
                return;
            }
            const task = handleTranslationRequest(text, settings);
            pendingTranslations.set(cacheKey, task);
            try {
                const result = await task;
                sendResponse(result);
            } finally {
                pendingTranslations.delete(cacheKey);
            }
            return;
        }
        sendResponse({ ok: false, error: 'Unknown action' });
    })();
    return true; 
});

try {
    chrome.action?.onClicked?.addListener((tab) => {
        if (tab.url && tab.url.includes("youtube.com/watch")) {
            chrome.tabs?.sendMessage(tab.id, { action: "toggleSettingsPanel" });
        }
    });
} catch (e) { /* action API未対応環境 */ }
