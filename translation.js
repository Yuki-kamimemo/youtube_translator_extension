/**
 * translation.js
 * 翻訳スキップ判定ユーティリティ
 */

function shouldSkipTranslation(text) {
    if (!text || !text.trim()) return true;
    const trimmedText = text.trim();
    if (/[一-龠ぁ-んァ-ヶー]/.test(trimmedText)) return true;
    if (/^(w|ｗ|草)+$/i.test(trimmedText)) return true;
    if (/^https?:\/\/[^\s]+$/.test(trimmedText)) return true;
    if (/^[ｦ-ﾟ\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    if (/^[\p{Emoji}\s]+$/u.test(trimmedText) && !/[a-zA-Z0-9]/.test(trimmedText)) return true;
    if (/^([a-zA-Z])\1+$/.test(trimmedText)) return true;
    if (/^(xd|lol|lmao|kek|haha|hehe|lul|kekw|lolol)+[!?]*$/i.test(trimmedText)) return true;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmedText)) return true;
    const alphaCount = (trimmedText.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount <= 1) return true;
    return false;
}
