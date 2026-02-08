/**
 * flow.js
 * フローコメント（弾幕）関連の機能
 */

// グローバル変数（content_script.jsで定義・初期化される）
// - settings
// - flowContainer

const lanes = new Map();
const LANE_COUNT = 15;

// ★改善2: 計測用コンテキスト
let measureContext = null;

/**
 * ★改善2: テキストの幅をCanvasで計測する（高速化）
 * @param {string} text - 計測するテキスト
 * @param {string} font - フォント設定文字列 (例: "bold 24px Arial")
 * @returns {number} - テキストの幅(px)
 */
function getTextWidth(text, font) {
    if (!measureContext) {
        const canvas = document.createElement('canvas');
        measureContext = canvas.getContext('2d');
    }
    measureContext.font = font;
    return measureContext.measureText(text).width;
}

/**
 * フローコメントを表示するための空きレーンを探す
 * @param {number} commentWidth - コメントの幅
 * @returns {number|null} - 利用可能なレーンのtop位置(px)、またはnull
 */
function findAvailableLane(commentWidth) {
    if (!flowContainer) return null;
    const now = Date.now();
    const containerWidth = flowContainer.offsetWidth;
    const requiredTime = (commentWidth / containerWidth) * (settings.flowTime * 1000) + 500;
    const containerHeight = flowContainer.offsetHeight;
    const marginTop = Number(settings.flowMarginTop) || 0;
    const marginBottom = Number(settings.flowMarginBottom) || 0;
    const drawableHeight = containerHeight - marginTop - marginBottom;
    if (drawableHeight <= 0) return null;
    const laneHeight = drawableHeight / LANE_COUNT;
    
    let laneCheckOrder = Array.from({ length: LANE_COUNT }, (_, i) => i);
    if (settings.position === 'bottom_priority') {
        laneCheckOrder.reverse();
    } else if (settings.position === 'random') {
        for (let i = laneCheckOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [laneCheckOrder[i], laneCheckOrder[j]] = [laneCheckOrder[j], laneCheckOrder[i]];
        }
    }

    for (const i of laneCheckOrder) {
        const laneBecomesFreeAt = lanes.get(i);
        if (!laneBecomesFreeAt || now > laneBecomesFreeAt) {
            lanes.set(i, now + requiredTime);
            return (i * laneHeight) + marginTop;
        }
    }
    return null;
}

/**
 * 画面にコメントを流す
 * @param {object} data - コメントデータ
 */
function flowComment(data) {
    if (!flowContainer || !settings.enableFlowComments) return;
    
    let textToFlow = '';
    switch (settings.flowContent) {
        case 'translation': textToFlow = data.translated || data.html; break;
        case 'original': textToFlow = data.html; break;
        case 'both': textToFlow = data.translated ? `${data.html} <span class="flow-translation">(${data.translated})</span>` : data.html; break;
    }

    if (!textToFlow.trim()) return;

    // スタイル設定の準備
    const fontFamily = settings.customFontFamily || settings.flowFontFamily;
    const fontStyle = `bold ${settings.fontSize}px ${fontFamily}`;
    
    const dropShadow = '1.5px 1.5px 3px rgba(0,0,0,0.9)';
    const width = Number(settings.strokeWidth) || 0;
    const color = settings.strokeColor || '#000000';
    let textShadows = [dropShadow];
    if (width > 0) {
        textShadows.push(`-${width}px -${width}px 0 ${color}`);
        textShadows.push(`${width}px -${width}px 0 ${color}`);
        textShadows.push(`-${width}px  ${width}px 0 ${color}`);
        textShadows.push(`${width}px  ${width}px 0 ${color}`);
    }
    const textShadowStyle = textShadows.join(', ');

    // ★改善2: 高速化分岐
    // 特殊なコメント（SuperChat/Membership）は構造が複雑なため、従来のDOM計測を行う
    // 通常のコメントはCanvasで計測し、DOM操作を最小限にする
    const isSpecial = data.specialType === 'superchat' || data.specialType === 'membership';
    
    let commentWidth = 0;
    let el = null;

    if (isSpecial) {
        // --- 従来の方法 (DOM生成 -> 追加 -> 計測 -> 削除) ---
        el = document.createElement('div');
        el.className = 'flow-comment';
        el.style.fontFamily = fontFamily;
        el.style.fontSize = `${settings.fontSize}px`;
        el.style.fontWeight = 'bold';
        el.style.textShadow = textShadowStyle;
        
        if (data.specialType === 'superchat') {
            el.classList.add('flow-superchat');
            el.style.backgroundColor = data.bgColor;
            el.style.color = settings.superchatColor; 
            el.innerHTML = `<span class="superchat-author">${data.authorName}</span><span class="superchat-amount">${data.purchaseAmount}</span><div class="superchat-message">${textToFlow}</div>`;
        } else if (data.specialType === 'membership') {
            el.classList.add('flow-membership');
            el.style.color = settings.membershipColorFlow;
            el.innerHTML = textToFlow;
        }

        // 一時的に配置して幅を測る
        el.style.opacity = '0';
        el.style.position = 'absolute';
        el.style.top = '-9999px';
        flowContainer.appendChild(el);
        commentWidth = el.offsetWidth;
        flowContainer.removeChild(el); // すぐに削除
        
        // 設定をリセットして再利用
        el.style.opacity = settings.opacity;
        el.style.position = '';
        el.style.top = '';

    } else {
        // --- ★改善2: 高速化された方法 (Canvas計測) ---
        // HTMLタグを除去して純粋なテキスト幅を近似計算する
        // (注: 画像タグなどが含まれる場合は誤差が出るが、チャット弾幕としては許容範囲)
        const plainText = textToFlow.replace(/<[^>]*>?/gm, ''); 
        // 翻訳文の括弧やパディング分を少し加算 (+20px)
        commentWidth = getTextWidth(plainText, fontStyle) + 20;
    }

    // レーンの空きを探す（この時点で幅が必要）
    const topPosition = findAvailableLane(commentWidth);
    if (topPosition === null) return; // 空きがなければ表示しない

    // DOM要素の生成（Canvasルートの場合はここで初めて生成）
    if (!el) {
        el = document.createElement('div');
        el.className = 'flow-comment';
        el.style.font = fontStyle; // fontプロパティで一括指定
        el.style.textShadow = textShadowStyle;
        el.style.color = settings[`${data.userType}Color`] || settings.normalColor;
        el.innerHTML = textToFlow;
        el.style.opacity = settings.opacity;
        el.style.willChange = 'transform'; // GPU処理のヒント
        el.style.whiteSpace = 'nowrap';
    }

    // 位置設定とアニメーション
    el.style.position = 'absolute';
    el.style.top = `${topPosition}px`;
    el.style.left = `${flowContainer.offsetWidth}px`;
    
    // 実際にDOMに追加（Canvasルートの場合はこれが最初で最後の追加）
    flowContainer.appendChild(el);

    // アニメーション開始
    requestAnimationFrame(() => {
        el.style.transition = `transform ${settings.flowTime}s linear`;
        el.style.transform = `translateX(-${flowContainer.offsetWidth + commentWidth}px)`;
    });

    // 完了後の削除
    setTimeout(() => el.remove(), settings.flowTime * 1000 + 500);
}