const translationCache = new Map();
const pendingTranslations = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 2000;

const SETTINGS_DEFAULTS = {
    translator: 'google',
    ollamaEndpoint: 'http://localhost:11434',
    ollamaModel: 'youtube-translator:latest',
    ollamaModelActive: false,
    enableGoogleTranslateFallback: true,
    dictionary: ''
};

// タブが閉じられたらタブ固有の設定をクリア
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove(`tabState_${tabId}`);
});

// キャッシュクリーンアップ
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('cleanupCache', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'cleanupCache') {
        const now = Date.now();
        for (const [key, value] of translationCache.entries()) {
            if (now - value.timestamp > CACHE_TTL) {
                translationCache.delete(key);
            }
        }
    }
});

let slangMap = {};
fetch(chrome.runtime.getURL('slang_dict.json'))
    .then(res => res.json())
    .then(data => { slangMap = data; })
    .catch(() => {});

function preprocessForYouTubeChat(text) {
    if (!text) return text;
    let processed = text;
    processed = processed.replace(/([\p{Emoji}])([a-zA-Z0-9])/gu, '$1 $2');
    processed = processed.replace(/([a-zA-Z0-9])([\p{Emoji}])/gu, '$1 $2');
    processed = processed.replace(/([a-zA-Z])\1{2,}/gi, '$1$1');
    for (const [pattern, replacement] of Object.entries(slangMap)) {
        processed = processed.replace(new RegExp(pattern, 'gi'), replacement);
    }
    return processed;
}

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

function postprocessJapanese(translationObj) {
    if (!translationObj || !translationObj.translation) return translationObj;
    let text = translationObj.translation;
    text = text.replace(/ですね/g, 'だね');
    text = text.replace(/ですよ/g, 'だよ');
    text = text.replace(/でしょう/g, 'だろう');
    text = text.replace(/ますか\？/g, '？');
    text = text.replace(/ではありません/g, 'じゃない');
    text = text.replace(/することができません/g, 'できない');
    text = text.replace(/することができます/g, 'できる');
    text = text.replace(/てしまいました/g, 'てしまった');
    text = text.replace(/ということです/g, 'ってこと');
    text = text.replace(/かもしれません/g, 'かもしれない');
    text = text.replace(/なのです/g, 'なんだ');
    text = text.replace(/しています/g, 'してる');
    text = text.replace(/ています/g, 'てる');
    text = text.replace(/ありません/g, 'ない');
    translationObj.translation = text;
    return translationObj;
}

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

async function translateWithOllama(text, settings) {
    const endpoint = (settings.ollamaEndpoint || 'http://localhost:11434').replace(/\/$/, '');
    const model = settings.ollamaModel || 'youtube-translator:latest';
    const systemPrompt = `You are a specialist AI for translating YouTube live chat messages.
Translate English chat (including internet slang and gaming terms) into natural, casual Japanese (tame-guchi).
Provide ONLY the translated text. No explanations or notes.`;
    const body = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ],
        stream: false,
        think: false,
        keep_alive: settings.ollamaModelActive ? -1 : '5m',
        options: { temperature: 0.3 }
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(`${endpoint}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
        const data = await response.json();
        let out = (data.message?.content || '').trim();
        out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        out = out.replace(/^["'「『]/, '').replace(/["'」』]$/, '').trim();
        if (!out) throw new Error('Ollama empty response');
        return { translation: out };
    } finally {
        clearTimeout(timer);
    }
}

async function handleTranslationRequest(text, settings) {
    const { translator, enableGoogleTranslateFallback, dictionary } = settings;
    let processedText = preprocessForYouTubeChat(text);
    processedText = preprocessWithDictionary(processedText, dictionary);
    let result;
    let usedTranslator = translator;

    if (translator === 'ollama') {
        try {
            result = await translateWithOllama(processedText, settings);
        } catch (e) {
            if (enableGoogleTranslateFallback) {
                result = await translateWithGoogle(processedText);
                usedTranslator = 'google';
            } else {
                return { error: 'Ollama翻訳エラー' };
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
        const cacheKey = `${translator}:${settings.ollamaModel || ''}:${text}`;
        translationCache.set(cacheKey, { translation: finalResult.translation, timestamp: Date.now() });
    }
    return finalResult;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        if (request.action === 'toggleSettingsPanel') {
            if (sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, { action: 'toggleSettingsPanel' });
            return;
        }
        if (request.action === 'getTabId') {
            sendResponse({ tabId: sender.tab?.id });
            return;
        }
        if (request.type === 'FLOW_COMMENT_DATA') {
            if (sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, request);
            return;
        }
        if (request.action === 'ollamaListModels') {
            const ep = (request.endpoint || 'http://localhost:11434').replace(/\/$/, '');
            try {
                const response = await fetch(`${ep}/api/tags`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                const models = Array.isArray(data.models)
                    ? data.models.map(model => model.name).filter(Boolean)
                    : [];
                sendResponse({ ok: true, models });
            } catch (e) {
                sendResponse({ ok: false, error: String(e.message || e) });
            }
            return;
        }
        if (request.action === 'ollamaSetActive') {
            const { active, endpoint, model } = request;
            const ep = (endpoint || 'http://localhost:11434').replace(/\/$/, '');
            const m = model || 'youtube-translator:latest';
            try {
                const response = await fetch(`${ep}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: m,
                        prompt: '',
                        keep_alive: active ? -1 : 0,
                        stream: false
                    })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: String(e.message || e) });
            }
            return;
        }
        if (request.action === "translate") {
            const text = request.text;
            if (!text) { sendResponse({ error: 'No text' }); return; }
            const settings = await new Promise(r => chrome.storage.sync.get(SETTINGS_DEFAULTS, r));
            const cacheKey = `${settings.translator}:${settings.ollamaModel || ''}:${text}`;
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
        }
    })();
    return true; 
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.includes("youtube.com/watch")) {
    chrome.tabs.sendMessage(tab.id, { action: "toggleSettingsPanel" });
  }
});
