const translationCache = new Map();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // キャッシュの有効期間（5分）

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of translationCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY_MS) {
            translationCache.delete(key);
        }
    }
}, 60 * 1000);

/**
 * 登録された単語辞書を使ってテキストを前処理（置換）する
 * @param {string} text - 元のテキスト
 * @param {string} dictionaryStr - 'original,translation\n...' 形式の辞書文字列
 * @returns {string} - 置換後のテキスト
 */
function preprocessWithDictionary(text, dictionaryStr) {
    if (!dictionaryStr || !text) {
        return text;
    }
    const lines = dictionaryStr.split('\n').filter(line => line.includes(','));
    let processedText = text;
    
    // 長い単語から先に置換するために、キーの長さでソートする
    const dictionary = lines.map(line => {
        const parts = line.split(',');
        return { original: parts[0].trim(), translated: parts.slice(1).join(',').trim() };
    }).filter(item => item.original && item.translated)
      .sort((a, b) => b.original.length - a.original.length);

    for (const item of dictionary) {
        // 大小文字を区別せずに置換する
        const regex = new RegExp(item.original.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
        processedText = processedText.replace(regex, item.translated);
    }
    
    return processedText;
}

/**
 * 無料Google翻訳（非公式）を使って翻訳を実行する関数
 */
async function translateWithGoogle(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        const translation = data[0]?.[0]?.[0];
        if (translation) {
            translationCache.set(text, { translation, timestamp: Date.now() });
            return { translation };
        } else {
            throw new Error("Invalid response structure from Google Translate.");
        }
    } catch (error) {
        return { error: "翻訳エラー" };
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggleSettingsPanel') {
        if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, { action: 'toggleSettingsPanel' });
        }
        return;
    }

    if (request.type === 'FLOW_COMMENT_DATA') {
        if (sender.tab?.id) {
            chrome.tabs.sendMessage(sender.tab.id, request);
        }
        return;
    }

    if (request.action === "translate") {
        if (!request.text) {
            return sendResponse({ error: "翻訳するテキストがありません" });
        }
        
        const { text } = request;

        if (translationCache.has(text)) {
            const cached = translationCache.get(text);
            if (Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
                sendResponse({ translation: cached.translation });
                return true;
            } else {
                translationCache.delete(text);
            }
        }
        
        // chrome.storageから設定（辞書も含む）を取得する
        chrome.storage.sync.get(['translator', 'deeplApiKey', 'enableGoogleTranslateFallback', 'dictionary'], async (settings) => {
            const { translator, deeplApiKey, enableGoogleTranslateFallback, dictionary } = settings;
            
            // 辞書を使ってテキストを前処理
            const processedText = preprocessWithDictionary(text, dictionary);

            // 1. Google翻訳の場合 (デフォルト)
            if (translator === 'google') {
                const result = await translateWithGoogle(processedText);
                sendResponse(result);
                return;
            }
            
            // 2. DeepLの場合
            if (translator === 'deepl') {
                const apiKey = deeplApiKey;
                if (!apiKey) return sendResponse({ error: "DeepL APIキー未設定" });
                
                const apiUrlHost = apiKey.endsWith(":fx") ? 'api-free.deepl.com' : 'api.deepl.com';
                const apiUrl = `https://${apiUrlHost}/v2/translate`;
                const fetchOptions = {
                    method: 'POST',
                    headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: [processedText], target_lang: 'JA' })
                };

                try {
                    const response = await fetch(apiUrl, fetchOptions);
                    if (!response.ok) {
                        const err = await response.json();
                        throw new Error(err.error?.message || `HTTP error! status: ${response.status}`);
                    }
                    const data = await response.json();
                    const translation = data.translations?.[0]?.text?.trim();

                    if (translation) {
                        translationCache.set(text, { translation, timestamp: Date.now() });
                        sendResponse({ translation });
                    } else {
                        throw new Error("APIからの翻訳結果が不正です。");
                    }
                } catch (error) {
                    // DeepLエラー時のフォールバック
                    if (enableGoogleTranslateFallback) {
                        const result = await translateWithGoogle(processedText);
                        sendResponse(result);
                    } else {
                        sendResponse({ error: error.message || "API通信エラー" });
                    }
                }
            } else {
                // 万が一設定値がおかしい場合はGoogle翻訳へ
                const result = await translateWithGoogle(processedText);
                sendResponse(result);
            }
        });
        return true; 
    }
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.includes("youtube.com/live_chat")) { 
    chrome.tabs.sendMessage(tab.id, {
      action: "toggleSettingsPanel"
    });
  }
});