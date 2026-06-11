/**
 * モバイルのページ内設定パネルがiframe内操作を奪わないためのCSS回帰テスト。
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'content_script.css'), 'utf8');
const contentScript = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');

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
const iframeRuleMatch = css.match(/#ylc-settings-iframe\s*\{([\s\S]*?)\}/);
const iframeRule = iframeRuleMatch ? iframeRuleMatch[1] : '';

assert(!/#ylc-settings-panel\s*\{[\s\S]*?touch-action\s*:\s*none\s*;/.test(mobileBlock),
    'モバイル設定パネルはiframe入力を潰す touch-action:none を持たない');
assert(/pointer-events\s*:\s*auto\s*;/.test(panelRule),
    '設定パネルは明示的にpointer-events:auto');
assert(/z-index\s*:\s*2147483647\s*;/.test(panelRule),
    '設定パネルはYouTube側UIより前面に出る最大z-index');
assert(/#ylc-settings-backdrop/.test(css), '設定パネル用バックドロップが定義されている');
assert(/pointer-events\s*:\s*auto\s*;/.test(backdropRule),
    'バックドロップは背後ページへのタップ貫通を止める');
assert(/pointer-events\s*:\s*auto\s*;/.test(iframeRule),
    '設定iframeは明示的にpointer-events:auto');
assert(/touch-action\s*:\s*manipulation\s*;/.test(iframeRule),
    '設定iframeはタップ操作を受け付けるtouch-actionを明示する');
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
assert(/function shouldOpenSettingsAsTopLevelPage\(\)/.test(contentScript),
    'モバイルではページ内iframeを避ける判定関数がある');
assert(/function openSettingsAsTopLevelPage\(\)/.test(contentScript),
    'モバイルでは設定ページをトップレベルで開く関数がある');
assert(/shouldOpenSettingsAsTopLevelPage\(\)[\s\S]*openSettingsAsTopLevelPage\(\)/.test(contentScript),
    '設定ボタンはモバイル時にトップレベル設定ページを開く');

process.exit(failures ? 1 : 0);
