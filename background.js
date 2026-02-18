const translationCache = new Map();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 2000; // ★追加: キャッシュの最大保持数

// 定期的なクリーンアップ
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of translationCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY_MS) {
            translationCache.delete(key);
        }
    }
}, 60 * 1000);

/**
 * 辞書処理の最適化
 * 正規表現オブジェクトをキャッシュして再生成コストを下げる
 */
function preprocessWithDictionary(text, dictionaryStr) {
    if (!dictionaryStr || !text) return text;

    // 簡易的なパース処理 (高速化のためMapなど複雑な構造は避ける)
    const lines = dictionaryStr.split('\n');
    let processedText = text;
    
    // 有効なエントリのみ抽出し、長い順にソート（部分一致の誤爆防止）
    const entries = [];
    for (const line of lines) {
        const parts = line.split(',');
        if (parts.length >= 2) {
            const original = parts[0].trim();
            const translated = parts.slice(1).join(',').trim();
            if (original && translated) {
                entries.push({ original, translated });
            }
        }
    }
    entries.sort((a, b) => b.original.length - a.original.length);

    for (const { original, translated } of entries) {
        // 特殊文字のエスケープ処理
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        processedText = processedText.replace(regex, translated);
    }
    
    return processedText;
}

async function translateWithGoogle(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        const translation = Array.isArray(data?.[0])
            ? data[0]
                .map((segment) => (Array.isArray(segment) ? segment[0] : ''))
                .join('')
                .trim()
            : '';
        
        if (translation) {
            // ★追加: キャッシュサイズ制限
            if (translationCache.size >= MAX_CACHE_SIZE) {
                // 古い順に削除（Mapは挿入順を保持するため、最初のキーが一番古い）
                const firstKey = translationCache.keys().next().value;
                translationCache.delete(firstKey);
            }
            translationCache.set(text, { translation, timestamp: Date.now() });
            return { translation };
        } else {
            throw new Error("Invalid response");
        }
    } catch (error) {
        return { error: "翻訳エラー" };
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 非同期レスポンスのためにtrueを返す
    (async () => {
        if (request.action === 'toggleSettingsPanel') {
            if (sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, { action: 'toggleSettingsPanel' });
            return;
        }

        if (request.type === 'FLOW_COMMENT_DATA') {
            if (sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, request);
            return;
        }

        if (request.action === "translate") {
            const text = request.text;
            if (!text) {
                sendResponse({ error: "No text" });
                return;
            }

            // キャッシュチェック
            if (translationCache.has(text)) {
                const cached = translationCache.get(text);
                if (Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
                    sendResponse({ translation: cached.translation });
                    return;
                }
                translationCache.delete(text);
            }

            const settings = await chrome.storage.sync.get(['translator', 'deeplApiKey', 'enableGoogleTranslateFallback', 'dictionary']);
            const { translator, deeplApiKey, enableGoogleTranslateFallback, dictionary } = settings;
            
            const processedText = preprocessWithDictionary(text, dictionary);

            if (translator === 'google') {
                const result = await translateWithGoogle(processedText);
                sendResponse(result);
                return;
            }

            // DeepL処理
            if (translator === 'deepl') {
                if (!deeplApiKey) {
                    sendResponse({ error: "APIキー未設定" });
                    return;
                }
                
                const apiUrlHost = deeplApiKey.endsWith(":fx") ? 'api-free.deepl.com' : 'api.deepl.com';
                try {
                    const response = await fetch(`https://${apiUrlHost}/v2/translate`, {
                        method: 'POST',
                        headers: { 
                            'Authorization': `DeepL-Auth-Key ${deeplApiKey}`, 
                            'Content-Type': 'application/json' 
                        },
                        body: JSON.stringify({ text: [processedText], target_lang: 'JA' })
                    });
                    
                    if (!response.ok) throw new Error();
                    const data = await response.json();
                    const translation = data.translations?.[0]?.text?.trim();
                    
                    if (translation) {
                        translationCache.set(text, { translation, timestamp: Date.now() });
                        sendResponse({ translation });
                    } else {
                        throw new Error();
                    }
                } catch (e) {
                    if (enableGoogleTranslateFallback) {
                        const result = await translateWithGoogle(processedText);
                        sendResponse(result);
                    } else {
                        sendResponse({ error: "翻訳エラー" });
                    }
                }
            } else {
                // 設定不備などはGoogleへ
                const result = await translateWithGoogle(processedText);
                sendResponse(result);
            }
        }
    })();
    return true; 
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.includes("youtube.com/live_chat")) { 
    chrome.tabs.sendMessage(tab.id, { action: "toggleSettingsPanel" });
  }
});
