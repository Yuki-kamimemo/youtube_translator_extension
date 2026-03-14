const translationCache = new Map();
const pendingTranslations = new Map(); // 実行中の翻訳リクエストを保持
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 2000;

// ★追加: タブが閉じられたらタブ固有の設定をクリアしてメモリを節約
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove(`tabState_${tabId}`);
});

// Service Worker ライフサイクルに準拠したキャッシュクリーンアップ
// (setInterval はSW停止で失われるため chrome.alarms を使用)
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('cleanupCache', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'cleanupCache') {
        const now = Date.now();
        for (const [key, value] of translationCache.entries()) {
            if (now - value.timestamp > CACHE_EXPIRY_MS) {
                translationCache.delete(key);
            }
        }
    }
});

// スラング辞書（slang_dict.json から起動時に非同期ロード）
let slangMap = {};
fetch(chrome.runtime.getURL('slang_dict.json'))
    .then(res => res.json())
    .then(data => { slangMap = data; })
    .catch(() => {}); // ロード失敗時は空のまま処理を継続

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

    // 3. 典型的なネットスラング・略語を標準的な英語に置換
    for (const [pattern, replacement] of Object.entries(slangMap)) {
        processed = processed.replace(new RegExp(pattern, 'gi'), replacement);
    }

    return processed;
}

/**
 * 辞書処理（コンパイル済み正規表現をキャッシュして再利用）
 */
let cachedDictionaryStr = null;
let cachedRegexEntries = [];

function preprocessWithDictionary(text, dictionaryStr) {
    if (!dictionaryStr || !text) return text;

    // 辞書文字列が変わった時だけ再パース・再コンパイル
    if (cachedDictionaryStr !== dictionaryStr) {
        cachedDictionaryStr = dictionaryStr;
        const lines = dictionaryStr.split('\n');
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
        cachedRegexEntries = entries.map(({ original, translated }) => {
            const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return { regex: new RegExp(escaped, 'gi'), translated };
        });
    }

    let processedText = text;
    for (const { regex, translated } of cachedRegexEntries) {
        regex.lastIndex = 0; // gフラグ付きRegExpは状態を持つためリセット
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
    text = text.replace(/ではありません/g, 'じゃない'); // ← ありません より先

    // 長いフレーズから短い順で適用（競合による誤爆防止）
    text = text.replace(/することができません/g, 'できない');
    text = text.replace(/することができます/g, 'できる');
    text = text.replace(/てしまいました/g, 'てしまった');
    text = text.replace(/ということです/g, 'ってこと');
    text = text.replace(/かもしれません/g, 'かもしれない');
    text = text.replace(/なのです/g, 'なんだ');
    text = text.replace(/しています/g, 'してる');
    text = text.replace(/ています/g, 'てる');
    text = text.replace(/ありません/g, 'ない'); // ← ではありません の後

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

    // 3. 日本語のチャット向け後処理を適用
    const finalResult = postprocessJapanese(result);

    // 4. キャッシュ書き込みを一元管理（元テキスト text をキーに、後処理済み翻訳を格納）
    if (finalResult && finalResult.translation) {
        if (translationCache.size >= MAX_CACHE_SIZE) {
            const firstKey = translationCache.keys().next().value;
            translationCache.delete(firstKey);
        }
        translationCache.set(text, { translation: finalResult.translation, timestamp: Date.now() });
    }

    return finalResult;
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
