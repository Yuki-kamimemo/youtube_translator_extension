const translationCache = new Map();
const pendingTranslations = new Map(); // 実行中の翻訳リクエストを保持
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 2000;

// ★追加: タブが閉じられたらタブ固有の設定をクリアしてメモリを節約
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove(`tabState_${tabId}`);
});

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
 * YouTubeチャット特有のテキスト前処理 (Google翻訳の精度向上)
 */
function preprocessForYouTubeChat(text) {
    if (!text) return text;
    let processed = text;
    
    // 1. 絵文字とテキストが密着していると翻訳が崩れるため、前後にスペースを挿入
    processed = processed.replace(/([\p{Emoji}])([a-zA-Z0-9])/gu, '$1 $2');
    processed = processed.replace(/([a-zA-Z0-9])([\p{Emoji}])/gu, '$1 $2');

    // 2. 連続する文字の正規化 (例: "soooo good" -> "so good", "omgggg" -> "omg")
    processed = processed.replace(/([a-zA-Z])\1{2,}/gi, '$1$1');

    // 3. 典型的なネットスラング・略語を標準的な英語に置換（翻訳エンジンが正しく認識できるようにする）
    const slangMap = {
        "\\blol\\b": "haha",
        "\\blmao\\b": "haha",
        "\\bwtf\\b": "what the hell",
        "\\bomg\\b": "oh my god",
        "\\bidk\\b": "i don't know",
        "\\btbh\\b": "to be honest",
        "\\bbtw\\b": "by the way",
        "\\bafk\\b": "away from keyboard",
        "\\bbrb\\b": "be right back",
        "\\bnvm\\b": "nevermind",
        "\\bthx\\b": "thanks",
        "\\bty\\b": "thank you",
        "\\bpls\\b": "please",
        "\\bplz\\b": "please",
        "\\bu\\b": "you",
        "\\bur\\b": "your",
        "\\br\\b": "are",
        "\\bgg\\b": "good game",
        "\\bwp\\b": "well played",
        "\\bgl\\b": "good luck",
        "\\bglhf\\b": "good luck have fun",
        "\\bimo\\b": "in my opinion",
        "\\bimho\\b": "in my humble opinion",
        "\\bfr\\b": "for real",
        "\\bngl\\b": "not gonna lie",
        "\\bjk\\b": "just kidding",
        "\\bmb\\b": "my bad",
        "\\bwdym\\b": "what do you mean"
    };

    for (const [pattern, replacement] of Object.entries(slangMap)) {
        processed = processed.replace(new RegExp(pattern, 'gi'), replacement);
    }

    return processed;
}

/**
 * 辞書処理の最適化
 */
function preprocessWithDictionary(text, dictionaryStr) {
    if (!dictionaryStr || !text) return text;

    const lines = dictionaryStr.split('\n');
    let processedText = text;
    
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
        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        processedText = processedText.replace(regex, translated);
    }
    
    return processedText;
}

/**
 * 日本語翻訳のチャット向け後処理 (硬い表現を少しカジュアルに)
 */
function postprocessJapanese(translationObj) {
    if (!translationObj || !translationObj.translation) return translationObj;
    let text = translationObj.translation;
    
    // Google翻訳特有の不自然に硬い表現を少しだけマイルドにする
    // ※やりすぎると誤爆するため、安全な語尾のみ変換
    text = text.replace(/ですね/g, 'だね');
    text = text.replace(/ですよ/g, 'だよ');
    text = text.replace(/でしょう/g, 'だろう');
    text = text.replace(/ますか\？/g, '？');
    text = text.replace(/ではありません/g, 'じゃない');
    
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
            ? data[0]
                .map((segment) => (Array.isArray(segment) ? segment[0] : ''))
                .join('')
                .trim()
            : '';
        
        if (translation) {
            if (translationCache.size >= MAX_CACHE_SIZE) {
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

// 翻訳リクエストを処理する共通関数
async function handleTranslationRequest(text, settings) {
    const { translator, deeplApiKey, enableGoogleTranslateFallback, dictionary } = settings;
    
    // 1. YouTubeチャット向けの前処理 (スラング等の標準化)
    let processedText = preprocessForYouTubeChat(text);
    
    // 2. ユーザー辞書の適用
    processedText = preprocessWithDictionary(processedText, dictionary);

    let result;
    if (translator === 'google') {
        result = await translateWithGoogle(processedText);
    } else if (translator === 'deepl') {
        if (!deeplApiKey) return { error: "APIキー未設定" };
        
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
                result = { translation };
            } else {
                throw new Error();
            }
        } catch (e) {
            if (enableGoogleTranslateFallback) {
                result = await translateWithGoogle(processedText);
            } else {
                return { error: "翻訳エラー" };
            }
        }
    } else {
        result = await translateWithGoogle(processedText);
    }

    // 3. 日本語のチャット向け後処理を適用して返す
    return postprocessJapanese(result);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        if (request.action === 'toggleSettingsPanel') {
            if (sender.tab?.id) chrome.tabs.sendMessage(sender.tab.id, { action: 'toggleSettingsPanel' });
            return;
        }

        // ★追加: 現在のタブIDを返す
        if (request.action === 'getTabId') {
            sendResponse({ tabId: sender.tab?.id });
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

            // 1. キャッシュチェック
            if (translationCache.has(text)) {
                const cached = translationCache.get(text);
                if (Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
                    sendResponse({ translation: cached.translation });
                    return;
                }
                translationCache.delete(text);
            }

            // 2. 既に同じテキストを別のフレームが翻訳中なら、完了を待つ（重複API呼び出し防止）
            if (pendingTranslations.has(text)) {
                const result = await pendingTranslations.get(text);
                sendResponse(result);
                return;
            }

            const settings = await chrome.storage.sync.get(['translator', 'deeplApiKey', 'enableGoogleTranslateFallback', 'dictionary']);
            
            // 3. 翻訳タスクを作成し、Pendingマップに登録
            const task = handleTranslationRequest(text, settings);
            pendingTranslations.set(text, task);

            try {
                const result = await task;
                sendResponse(result);
            } finally {
                // 完了したらマップから削除
                pendingTranslations.delete(text);
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
