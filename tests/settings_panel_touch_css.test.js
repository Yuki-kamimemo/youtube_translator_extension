/**
 * モバイルのページ内設定パネルが新規タブ/iframe経路へ戻らないための回帰テスト。
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'content_script.css'), 'utf8');
const contentScript = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
const popupCss = fs.readFileSync(path.join(__dirname, '..', 'popup.css'), 'utf8');

let failures = 0;
function assert(cond, label) {
    if (cond) {
        console.log(`PASS: ${label}`);
    } else {
        failures++;
        console.error(`FAIL: ${label}`);
    }
}

const mobileBlockMatch = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/);
const mobileBlock = mobileBlockMatch ? mobileBlockMatch[1] : '';
const panelRuleMatch = css.match(/#ylc-settings-panel\s*\{([\s\S]*?)\}/);
const panelRule = panelRuleMatch ? panelRuleMatch[1] : '';
const backdropRuleMatch = css.match(/#ylc-settings-backdrop\s*\{([\s\S]*?)\}/);
const backdropRule = backdropRuleMatch ? backdropRuleMatch[1] : '';
const shadowBodyRuleMatch = css.match(/#ylc-settings-shadow-body\s*\{([\s\S]*?)\}/);
const shadowBodyRule = shadowBodyRuleMatch ? shadowBodyRuleMatch[1] : '';

assert(!/#ylc-settings-panel\s*\{[\s\S]*?touch-action\s*:\s*none\s*;/.test(mobileBlock),
    'モバイル設定パネルはiframe入力を潰す touch-action:none を持たない');
assert(/pointer-events\s*:\s*auto\s*;/.test(panelRule),
    '設定パネルは明示的にpointer-events:auto');
assert(/z-index\s*:\s*2147483647\s*;/.test(panelRule),
    '設定パネルはYouTube側UIより前面に出る最大z-index');
assert(/#ylc-settings-backdrop/.test(css), '設定パネル用バックドロップが定義されている');
assert(/pointer-events\s*:\s*auto\s*;/.test(backdropRule),
    'バックドロップは背後ページへのタップ貫通を止める');
assert(/#ylc-settings-shadow-body/.test(css), 'Shadow DOM内設定パネル用コンテナが定義されている');
assert(/pointer-events\s*:\s*auto\s*;/.test(shadowBodyRule),
    'Shadow DOM内設定パネルは明示的にpointer-events:auto');
assert(/touch-action\s*:\s*manipulation\s*;/.test(shadowBodyRule),
    'Shadow DOM内設定パネルはタップ操作を受け付けるtouch-actionを明示する');
assert(/backdrop\.id\s*=\s*['"]ylc-settings-backdrop['"]/.test(contentScript),
    '設定パネル生成時にバックドロップDOMを作る');
assert(/getElementById\(['"]ylc-settings-backdrop['"]\)\?\.\s*remove\(\)/.test(contentScript),
    '設定パネル削除時にバックドロップも削除する');
assert(!/panel\.addEventListener\([^,]+,\s*stopPanelEventPropagation,\s*true\)/.test(contentScript),
    '設定パネルはcapture段階で子要素のタップを止めない');
assert(!/panel\.addEventListener\([^,]+,\s*stopPanelEventPropagation,\s*\{\s*capture:\s*true/.test(contentScript),
    '設定パネルはcaptureオプションで子要素のタッチを止めない');
assert(/function lockPageScrollForSettingsPanel\(\)/.test(contentScript),
    '設定パネル表示中に背後ページのスクロールをロックする関数がある');
assert(/function unlockPageScrollForSettingsPanel\(\)/.test(contentScript),
    '設定パネル削除時に背後ページのスクロールを復元する関数がある');
assert(/lockPageScrollForSettingsPanel\(\)/.test(contentScript),
    '設定パネル生成時に背後ページのスクロールをロックする');
assert(/unlockPageScrollForSettingsPanel\(\)/.test(contentScript),
    '設定パネル削除時に背後ページのスクロールを復元する');
assert(!/window\.open\s*\(/.test(contentScript),
    '設定ボタン経路に新規タブを開くwindow.openが存在しない');
assert(!/function openSettingsAsTopLevelPage\(\)/.test(contentScript),
    'トップレベル設定ページを開く旧関数が削除されている');
assert(/function shouldUseShadowSettingsPanel\(\)/.test(contentScript),
    'モバイルではShadow DOMパネルを使う判定関数がある');
assert(/attachShadow\s*\(\s*\{\s*mode\s*:\s*['"]open['"]\s*\}\s*\)/.test(contentScript),
    '設定パネルはopen Shadow DOMを生成する');
assert(/initSettingsPanel\s*\([^)]*context\s*:\s*['"]inpage['"]/.test(contentScript),
    'content scriptはShadow DOM内でpopup.jsの初期化関数をinpage文脈として呼ぶ');
assert(/function initSettingsPanel\s*\(/.test(popupJs),
    'popup.jsはroot指定の初期化関数を公開する');

// --- 文脈判定の回帰ガード（PC iframeがtoolbar扱いになる退行を防ぐ） ---
assert(/data-ylc-popup/.test(popupHtml),
    'popup.htmlのbodyに拡張ページマーカー(data-ylc-popup)がある');
assert(/hasAttribute\(['"]data-ylc-popup['"]\)/.test(popupJs),
    'popup.jsの自動初期化は拡張ページマーカーで判定する');
assert(!/initSettingsPanel\s*\(\s*document\s*,\s*\{\s*context/.test(popupJs),
    '自動初期化はcontextを固定せずwindow.parent判定に委ねる');

// --- Shadow DOMパネルの堅牢性 ---
const shouldUseFnMatch = contentScript.match(/function shouldUseShadowSettingsPanel\(\)\s*\{([\s\S]*?)\n\}/);
const shouldUseFnBody = shouldUseFnMatch ? shouldUseFnMatch[1] : '';
assert(/isAppleTouchEnvironment\(\)/.test(shouldUseFnBody),
    'iOS/iPadOS系では幅に関わらずShadow DOMパネルを使う');
assert(/settingsPanelTemplatePromise\s*=\s*null/.test(contentScript),
    'テンプレート取得失敗をキャッシュせず再試行できる');
assert(/ylc-settings-shadow-error/.test(contentScript),
    'テンプレート読み込み失敗時にユーザーへエラーを表示する');
assert(/#ylc-settings-shadow-error/.test(popupCss),
    'Shadow DOM内エラー表示のスタイルがpopup.cssに定義されている');

// --- リスナーのライフサイクル（開閉を繰り返してもリークしない） ---
assert(/return\s*\{[\s\S]*?dispose\(\)/.test(popupJs),
    'initSettingsPanelはdisposeを持つハンドルを返す');
assert(/settingsPanelDispose\s*=/.test(contentScript) && /settingsPanelDispose\(\)/.test(contentScript),
    'content scriptはパネル破棄時にpopup.js側のdisposeを呼ぶ');

// --- CSSトークンの一元化（popup.css :root,:host が唯一の定義元） ---
assert(/:root\s*,\s*:host\s*\{/.test(popupCss),
    'popup.cssのデザイントークンはShadow DOM内(:host)でも適用される');
assert(!/--bg-color/.test(shadowBodyRule),
    'content_script.css側にトークンの重複定義がない');

process.exit(failures ? 1 : 0);
