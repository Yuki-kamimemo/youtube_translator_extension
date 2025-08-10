// Geminiのレート制限を管理するための変数
let geminiRequestTimestamps = [];
let lastUsedGeminiKeyIndex = 0; // 最後に使用したGeminiキーのインデックス

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

// ★★★ ここからが追加箇所 ★★★
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
// ★★★ ここまでが追加箇所 ★★★

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
        return { error: "Google翻訳フォールバック失敗" };
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
        
        // ★★★ ここからが修正箇所 ★★★
        // chrome.storageから設定（辞書も含む）を取得する
        chrome.storage.sync.get(['translator', 'geminiApiKey', 'geminiApiKey2', 'deeplApiKey', 'enableGoogleTranslateFallback', 'dictionary'], async (settings) => {
            const { translator, geminiApiKey, geminiApiKey2, deeplApiKey, enableGoogleTranslateFallback, dictionary } = settings;
            
            // 辞書を使ってテキストを前処理
            const processedText = preprocessWithDictionary(text, dictionary);

            // 1. Google翻訳の場合
            if (translator === 'google') {
                const result = await translateWithGoogle(processedText);
                sendResponse(result);
                return;
            }
            // ★★★ ここまでが修正箇所 ★★★
            
            let apiKey, apiUrl, fetchOptions;

            // 2. Geminiの場合
            if (translator === 'gemini') {
                const validGeminiKeys = [geminiApiKey, geminiApiKey2].filter(Boolean);

                if (validGeminiKeys.length === 0) {
                    return sendResponse({ error: "Gemini APIキー未設定" });
                }

                if (enableGoogleTranslateFallback) {
                    const now = Date.now();
                    geminiRequestTimestamps = geminiRequestTimestamps.filter(ts => now - ts < 60000);
                    
                    const limit = validGeminiKeys.length > 1 ? 30 : 15;

                    if (geminiRequestTimestamps.length >= limit) {
                        const result = await translateWithGoogle(processedText); // ★修正: processedText を使用
                        sendResponse(result);
                        return;
                    }
                }
                
                const currentKeyIndex = lastUsedGeminiKeyIndex % validGeminiKeys.length;
                apiKey = validGeminiKeys[currentKeyIndex];
                lastUsedGeminiKeyIndex++;
                
                geminiRequestTimestamps.push(Date.now());

                apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
                
                 // ★修正: processedText を使用
                const prompt = `あなたは、海外のYouTubeライブ配信やネット文化に精通したプロの翻訳者です。以下のチャットコメントを、日本の視聴者が読んで自然に感じる口語的な日本語に翻訳してください。ネットスラング、略語、絵文字のニュアンスも汲み取って、元の感情や雰囲気が伝わるように訳してください。返答は、いかなる追加の説明や前置き（例：「翻訳結果：」）も付けず、翻訳された日本語テキストそのものだけを返してください。コメント：「${processedText}」`;
                
                fetchOptions = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                };

            } else { // 3. DeepLの場合
                apiKey = deeplApiKey;
                if (!apiKey) return sendResponse({ error: "DeepL APIキー未設定" });
                const apiUrlHost = apiKey.endsWith(":fx") ? 'api-free.deepl.com' : 'api.deepl.com';
                apiUrl = `https://${apiUrlHost}/v2/translate`;
                fetchOptions = {
                    method: 'POST',
                    headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: [processedText], target_lang: 'JA' }) // ★修正: processedText を使用
                };
            }

            try {
                const response = await fetch(apiUrl, fetchOptions);
                if (!response.ok) {
                    const err = await response.json();
                    throw new Error(err.error?.message || `HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                const translation = (translator === 'gemini'
                    ? data.candidates?.[0]?.content?.parts?.[0]?.text
                    : data.translations?.[0]?.text)?.trim();

                if (translation) {
                    translationCache.set(text, { translation, timestamp: Date.now() }); // キャッシュのキーは元のテキスト
                    sendResponse({ translation });
                } else {
                    throw new Error("APIからの翻訳結果が不正です。");
                }
            } catch (error) {
                if (enableGoogleTranslateFallback) {
                    const result = await translateWithGoogle(processedText); // ★修正: processedText を使用
                    sendResponse(result);
                } else {
                    sendResponse({ error: error.message || "API通信エラー" });
                }
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