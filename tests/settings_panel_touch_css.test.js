/**
 * モバイルのページ内設定パネルがiframe内操作を奪わないためのCSS回帰テスト。
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'content_script.css'), 'utf8');

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
const iframeRuleMatch = css.match(/#ylc-settings-iframe\s*\{([\s\S]*?)\}/);
const iframeRule = iframeRuleMatch ? iframeRuleMatch[1] : '';

assert(!/#ylc-settings-panel\s*\{[\s\S]*?touch-action\s*:\s*none\s*;/.test(mobileBlock),
    'モバイル設定パネルはiframe入力を潰す touch-action:none を持たない');
assert(/pointer-events\s*:\s*auto\s*;/.test(iframeRule),
    '設定iframeは明示的にpointer-events:auto');
assert(/touch-action\s*:\s*manipulation\s*;/.test(iframeRule),
    '設定iframeはタップ操作を受け付けるtouch-actionを明示する');

process.exit(failures ? 1 : 0);
