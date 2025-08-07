/**
 * translation.js
 * 翻訳関連の機能
 */

/**
 * 翻訳をスキップすべきか判定する
 * @param {string} text - 判定するテキスト
 * @returns {boolean} - スキップすべきならtrue
 */
function shouldSkipTranslation(text) {
    if (!text || !text.trim()) return true;
    const trimmedText = text.trim();
    if (/[一-龠ぁ-んァ-ヶー]/.test(trimmedText)) return true;
    if (/^(w|ｗ|草)+$/i.test(trimmedText)) return true;
    if (/^https?:\/\/[^\s]+$/.test(trimmedText)) return true;
    if (/^[ｦ-ﾟ\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    if (/^[\p{Emoji}\s]+$/u.test(trimmedText) && !/[a-zA-Z0-9]/.test(trimmedText)) return true;
    if (/^([a-zA-Z0-9])\1{2,}$/.test(trimmedText)) return true;
    const alphaCount = (trimmedText.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount <= 1) return true;
    return false;
}

/**
 * チャット欄に翻訳を表示する
 * @param {Element} node - コメントのDOMノード
 * @param {string} text - 表示する翻訳文
 * @param {boolean} isError - エラーメッセージかどうか
 */
function displayInlineTranslation(node, text, isError = false) {
    const content = node.querySelector('#content');
    if (!content) return;
    let container = content.querySelector('.inline-translation-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'inline-translation-container';
        content.appendChild(container);
    }
    container.textContent = isError ? text : `[訳] ${text}`;
    container.classList.toggle('error', isError);
}

/**
 * コメントの翻訳をリクエストし、結果をコールバックで返す
 * @param {string} text - 翻訳するテキスト
 * @param {function(object)} callback - 結果を受け取るコールバック e.g., callback({translation: '...', error: null})
 */
function requestTranslation(text, callback) {
    if (shouldSkipTranslation(text)) {
        callback({ translation: '', error: null, skipped: true });
        return;
    }
    if (!chrome.runtime?.id) {
        callback({ translation: '', error: 'Extension context lost.', skipped: false });
        return;
    }
    chrome.runtime.sendMessage({ action: "translate", text: text }, (response) => {
        if (response?.translation) {
            callback({ translation: response.translation, error: null, skipped: false });
        } else if (response?.error) {
            callback({ translation: '', error: response.error, skipped: false });
        } else {
            callback({ translation: '', error: 'Unknown response.', skipped: false });
        }
    });
}
