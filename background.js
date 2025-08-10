// ★★★ ここからが修正箇所 ★★★
// Geminiのレート制限を管理するための変数
let geminiRequestTimestamps = [];
let lastUsedGeminiKeyIndex = 0; // 最後に使用したGeminiキーのインデックス

// --- ここからが翻訳キャッシュ機能の追加箇所 ---
const translationCache = new Map();
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // キャッシュの有効期間（5分）

/**
 * 定期的に古いキャッシュを削除するタイマー
 * 1分ごとに実行
 */
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of translationCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY_MS) {
            translationCache.delete(key);
            // console.log(`[Cache] Expired cache deleted for: ${key}`); // デバッグ用
        }
    }
}, 60 * 1000);
// --- ここまでが翻訳キャッシュ機能の追加箇所 ---
// ★★★ ここまでが修正箇所 ★★★


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
            // ★ 修正: 翻訳成功時にキャッシュへ保存
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

        // --- ここからが翻訳キャッシュ機能の追加箇所 ---
        // 1. キャッシュを確認する
        if (translationCache.has(text)) {
            const cached = translationCache.get(text);
            // キャッシュが有効期限内かチェック
            if (Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
                // console.log(`[Cache] Hit for: ${text}`); // デバッグ用
                // 有効ならキャッシュから翻訳結果を返して処理を終了
                sendResponse({ translation: cached.translation });
                return true; // 非同期処理であることを示す
            } else {
                // 期限切れならキャッシュから削除
                translationCache.delete(text);
            }
        }
        // --- ここまでが翻訳キャッシュ機能の追加箇所 ---

        chrome.storage.sync.get(['translator', 'geminiApiKey', 'geminiApiKey2', 'deeplApiKey', 'enableGoogleTranslateFallback'], async (settings) => {
            const { translator, geminiApiKey, geminiApiKey2, deeplApiKey, enableGoogleTranslateFallback } = settings;
            
            // 1. Google翻訳の場合
            if (translator === 'google') {
                const result = await translateWithGoogle(text);
                sendResponse(result);
                return;
            }
            
            let apiKey, apiUrl, fetchOptions;

            // 2. Geminiの場合
            if (translator === 'gemini') {
                const validGeminiKeys = [geminiApiKey, geminiApiKey2].filter(Boolean);

                if (validGeminiKeys.length === 0) {
                    return sendResponse({ error: "Gemini APIキー未設定" });
                }

                // レート制限のチェック
                if (enableGoogleTranslateFallback) {
                    const now = Date.now();
                    geminiRequestTimestamps = geminiRequestTimestamps.filter(ts => now - ts < 60000);
                    
                    const limit = validGeminiKeys.length > 1 ? 30 : 15;

                    if (geminiRequestTimestamps.length >= limit) {
                        const result = await translateWithGoogle(text);
                        sendResponse(result);
                        return; // フォールバックしたので以降の処理はしない
                    }
                }
                
                // 使用するAPIキーを交互に選択
                const currentKeyIndex = lastUsedGeminiKeyIndex % validGeminiKeys.length;
                apiKey = validGeminiKeys[currentKeyIndex];
                lastUsedGeminiKeyIndex++; // 次に使うキーのインデックスを更新
                
                geminiRequestTimestamps.push(Date.now()); // リクエストタイムスタンプを記録

                apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
                
                const prompt = `あなたは、海外のYouTubeライブ配信やネット文化に精通したプロの翻訳者です。以下のチャットコメントを、日本の視聴者が読んで自然に感じる口語的な日本語に翻訳してください。ネットスラング、略語、絵文字のニュアンスも汲み取って、元の感情や雰囲気が伝わるように訳してください。返答は、いかなる追加の説明や前置き（例：「翻訳結果：」）も付けず、翻訳された日本語テキストそのものだけを返してください。コメント：「${text}」`;
                
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
                    body: JSON.stringify({ text: [text], target_lang: 'JA' })
                };
            }

            // 4. APIリクエスト実行
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
                    // ★ 修正: 翻訳成功時にキャッシュへ保存
                    translationCache.set(text, { translation, timestamp: Date.now() });
                    sendResponse({ translation });
                } else {
                    throw new Error("APIからの翻訳結果が不正です。");
                }
            } catch (error) {
                // 5. APIエラー時のフォールバック
                if (enableGoogleTranslateFallback) {
                    const result = await translateWithGoogle(text);
                    sendResponse(result);
                } else {
                    sendResponse({ error: error.message || "API通信エラー" });
                }
            }
        });
        return true; // 非同期レスポンスを示すためにtrueを返す
    }
});

/**
 * 拡張機能のアイコンがクリックされたときに実行されるリスナー
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.includes("youtube.com/live_chat")) { // マッチパターンをより安全なものに修正
    chrome.tabs.sendMessage(tab.id, {
      action: "toggleSettingsPanel"
    });
  }
});
