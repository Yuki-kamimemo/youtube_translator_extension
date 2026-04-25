const translationCache = new Map();
const pendingTranslations = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 2000;

const SETTINGS_DEFAULTS = {
    translator: 'google',
    lmstudioEndpoint: 'http://localhost:1234',
    lmstudioModel: '',
    lmstudioApiToken: '',
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
    if (!normalized.lmstudioEndpoint && normalized.ollamaEndpoint) normalized.lmstudioEndpoint = normalized.ollamaEndpoint;
    if (!normalized.lmstudioModel && normalized.ollamaModel) normalized.lmstudioModel = normalized.ollamaModel;
    if (normalized.lmstudioModelActive === undefined && normalized.ollamaModelActive !== undefined) {
        normalized.lmstudioModelActive = normalized.ollamaModelActive;
    }
    normalized.lmstudioEndpoint = normalized.lmstudioEndpoint || 'http://localhost:1234';
    normalized.lmstudioModel = normalized.lmstudioModel || '';
    normalized.lmstudioApiToken = normalized.lmstudioApiToken || '';
    normalized.lmstudioModelActive = normalized.lmstudioModelActive === true;
    return normalized;
}

function lmstudioHeaders(apiToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
    return headers;
}

function extractLmstudioText(data) {
    const messages = Array.isArray(data?.output)
        ? data.output
            .filter(item => item?.type === 'message' && typeof item.content === 'string')
            .map(item => item.content.trim())
            .filter(Boolean)
        : [];
    return messages.join('\n').trim();
}

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

async function translateWithLmstudio(text, settings) {
    const endpoint = (settings.lmstudioEndpoint || 'http://localhost:1234').replace(/\/$/, '');
    const model = settings.lmstudioModel;
    if (!model) throw new Error('LM Studio model is not selected');
    const systemPrompt = `You are a specialist AI for translating YouTube live chat messages.
Translate English chat (including internet slang and gaming terms) into natural, casual Japanese (tame-guchi).
Provide ONLY the translated text. No explanations or notes.`;
    const bodyWithReasoning = {
        model,
        input: text,
        system_prompt: systemPrompt,
        stream: false,
        temperature: 0.3,
        store: false,
        reasoning: 'off'
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const requestChat = (body) => fetch(`${endpoint}/api/v1/chat`, {
            method: 'POST',
            headers: lmstudioHeaders(settings.lmstudioApiToken),
            body: JSON.stringify(body),
            signal: controller.signal
        });
        let response = await requestChat(bodyWithReasoning);
        if (!response.ok && response.status >= 400) {
            const retryBody = { ...bodyWithReasoning };
            delete retryBody.reasoning;
            response = await requestChat(retryBody);
        }
        if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}`);
        const data = await response.json();
        let out = extractLmstudioText(data);
        out = out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        out = out.replace(/^["'「『]/, '').replace(/["'」』]$/, '').trim();
        if (!out) throw new Error('LM Studio empty response');
        return { translation: out };
    } finally {
        clearTimeout(timer);
    }
}

async function handleTranslationRequest(text, settings) {
    settings = normalizeSettings(settings);
    const { translator, lmstudioModelActive, enableGoogleTranslateFallback, dictionary } = settings;
    let processedText = preprocessForYouTubeChat(text);
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
        const cacheKey = `${usedTranslator}:${usedTranslator === 'lmstudio' ? (settings.lmstudioModel || '') : ''}:${text}`;
        translationCache.set(cacheKey, { translation: finalResult.translation, timestamp: Date.now() });
    }
    return finalResult;
}

async function listLmstudioModels(endpoint, apiToken) {
    const ep = (endpoint || 'http://localhost:1234').replace(/\/$/, '');
    const response = await fetch(`${ep}/api/v1/models`, {
        headers: lmstudioHeaders(apiToken)
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

async function getLmstudioLoadedInstanceId(endpoint, apiToken, model) {
    const ep = (endpoint || 'http://localhost:1234').replace(/\/$/, '');
    const v1Response = await fetch(`${ep}/api/v1/models`, {
        headers: lmstudioHeaders(apiToken)
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
        headers: lmstudioHeaders(apiToken)
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

async function unloadLmstudioModel(endpoint, apiToken, model) {
    const ep = (endpoint || 'http://localhost:1234').replace(/\/$/, '');
    const instanceId = await getLmstudioLoadedInstanceId(ep, apiToken, model);
    if (!instanceId) return;
    const unloadResponse = await fetch(`${ep}/api/v1/models/unload`, {
        method: 'POST',
        headers: lmstudioHeaders(apiToken),
        body: JSON.stringify({ instance_id: instanceId })
    });
    if (unloadResponse.status === 404) return;
    if (!unloadResponse.ok) throw new Error(`HTTP ${unloadResponse.status}`);
}

async function warmupLmstudioModel(endpoint, apiToken, model) {
    const ep = (endpoint || 'http://localhost:1234').replace(/\/$/, '');
    const response = await fetch(`${ep}/api/v1/chat`, {
        method: 'POST',
        headers: lmstudioHeaders(apiToken),
        body: JSON.stringify({
            model,
            input: 'OK',
            system_prompt: 'Reply with OK only.',
            stream: false,
            temperature: 0,
            store: false
        })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        if (request.action === 'lmstudioListModels') {
            try {
                const models = await listLmstudioModels(request.endpoint, request.apiToken);
                sendResponse({ ok: true, models });
            } catch (e) {
                sendResponse({ ok: false, error: String(e.message || e) });
            }
            return;
        }
        if (request.action === 'lmstudioSetActive') {
            const { active, endpoint, model, apiToken } = request;
            const ep = (endpoint || 'http://localhost:1234').replace(/\/$/, '');
            const m = model || '';
            try {
                if (active) {
                    if (!m) throw new Error('モデルが選択されていません');
                    const response = await fetch(`${ep}/api/v1/models/load`, {
                        method: 'POST',
                        headers: lmstudioHeaders(apiToken),
                        body: JSON.stringify({ model: m })
                    });
                    if (response.status === 404) {
                        await warmupLmstudioModel(ep, apiToken, m);
                    } else if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                } else if (m) {
                    await unloadLmstudioModel(ep, apiToken, m);
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
            const settings = normalizeSettings(await new Promise(r => chrome.storage.sync.get(SETTINGS_DEFAULTS, r)));
            const useLmstudio = settings.translator === 'lmstudio' && settings.lmstudioModelActive === true;
            const usedTranslator = useLmstudio ? 'lmstudio' : 'google';
            const cacheKey = `${usedTranslator}:${usedTranslator === 'lmstudio' ? (settings.lmstudioModel || '') : ''}:${text}`;
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
