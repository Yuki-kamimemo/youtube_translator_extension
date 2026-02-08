/**
 * flow.js (Optimized & Fixed)
 * Canvasを利用した軽量描画版（透過度修正済み）
 */

const lanes = new Map();
const LANE_COUNT = 15;
// 幅計算用のCanvasをキャッシュ
let measureContext = null;

function getMeasureContext() {
    if (!measureContext) {
        const canvas = document.createElement('canvas');
        measureContext = canvas.getContext('2d');
    }
    return measureContext;
}

/**
 * テキストの描画幅をCanvasで高速に計算する
 * DOMに追加しないためLayout Thrashingが発生しない
 */
function measureTextWidth(text, fontSize, fontFamily) {
    const ctx = getMeasureContext();
    ctx.font = `bold ${fontSize}px ${fontFamily}`; // CSSと合わせる
    return ctx.measureText(text).width;
}

function findAvailableLane(commentWidth) {
    if (!flowContainer) return null;
    const now = Date.now();
    
    // flowContainerのサイズを取得
    const containerWidth = flowContainer.offsetWidth;
    const containerHeight = flowContainer.offsetHeight;
    
    const requiredTime = (commentWidth / containerWidth) * (settings.flowTime * 1000) + 500;
    
    const marginTop = Number(settings.flowMarginTop) || 0;
    const marginBottom = Number(settings.flowMarginBottom) || 0;
    const drawableHeight = containerHeight - marginTop - marginBottom;
    
    if (drawableHeight <= 0) return null;
    const laneHeight = drawableHeight / LANE_COUNT;
    
    let laneCheckOrder = Array.from({ length: LANE_COUNT }, (_, i) => i);
    if (settings.position === 'bottom_priority') {
        laneCheckOrder.reverse();
    } else if (settings.position === 'random') {
        // フィッシャー–イェーツのシャッフル
        for (let i = laneCheckOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [laneCheckOrder[i], laneCheckOrder[j]] = [laneCheckOrder[j], laneCheckOrder[i]];
        }
    }

    for (const i of laneCheckOrder) {
        const laneBecomesFreeAt = lanes.get(i) || 0;
        if (now > laneBecomesFreeAt) {
            lanes.set(i, now + requiredTime);
            return (i * laneHeight) + marginTop;
        }
    }
    return null;
}

function flowComment(data) {
    if (!flowContainer || !settings.enableFlowComments) return;
    
    let textToFlow = '';
    let pureText = '';

    switch (settings.flowContent) {
        case 'translation': 
            textToFlow = data.translated || data.html; 
            pureText = data.translated || data.text;
            break;
        case 'original': 
            textToFlow = data.html; 
            pureText = data.text;
            break;
        case 'both': 
            textToFlow = data.translated ? `${data.html} <span class="flow-translation">(${data.translated})</span>` : data.html; 
            pureText = data.translated ? `${data.text} (${data.translated})` : data.text;
            break;
    }

    if (!pureText || !pureText.trim()) return;

    // Canvasで幅を計算
    const currentFont = settings.customFontFamily || settings.flowFontFamily;
    const padding = data.specialType ? 40 : 20; 
    const commentWidth = measureTextWidth(pureText, settings.fontSize, currentFont) + padding;

    // レーンを探す
    const topPosition = findAvailableLane(commentWidth);
    if (topPosition === null) return; // 空きがなければ描画しない

    // DOM生成
    const el = document.createElement('div');
    el.className = 'flow-comment';
    el.style.fontFamily = currentFont;
    el.style.fontSize = `${settings.fontSize}px`;
    el.style.top = `${topPosition}px`;
    el.style.left = '100%'; // CSSで制御するため初期位置は右端
    
    // ★★★ 修正箇所: ここに透過度設定を追加 ★★★
    el.style.opacity = settings.opacity; 
    
    // 縁取り設定
    const width = Number(settings.strokeWidth) || 0;
    const color = settings.strokeColor || '#000000';
    if (width > 0) {
        const shadow = `1.5px 1.5px 3px rgba(0,0,0,0.9), -${width}px -${width}px 0 ${color}, ${width}px -${width}px 0 ${color}, -${width}px ${width}px 0 ${color}, ${width}px ${width}px 0 ${color}`;
        el.style.textShadow = shadow;
    } else {
        el.style.textShadow = '1.5px 1.5px 3px rgba(0,0,0,0.9)';
    }

    if (data.specialType === 'superchat') {
        el.classList.add('flow-superchat');
        el.style.backgroundColor = data.bgColor;
        el.style.color = settings.superchatColor;
        el.innerHTML = `<span class="superchat-author">${data.authorName}</span><span class="superchat-amount">${data.purchaseAmount}</span><div class="superchat-message">${textToFlow}</div>`;
    } else if (data.specialType === 'membership') {
        el.classList.add('flow-membership');
        el.style.color = settings.membershipColorFlow;
        el.innerHTML = textToFlow;
    } else {
        el.innerHTML = textToFlow;
        el.style.color = settings[`${data.userType}Color`] || settings.normalColor;
    }

    // アニメーション設定
    el.style.transition = `transform ${settings.flowTime}s linear`;
    
    flowContainer.appendChild(el);

    requestAnimationFrame(() => {
        const containerWidth = flowContainer.offsetWidth; 
        el.style.transform = `translateX(-${containerWidth + commentWidth}px)`;
    });

    el.addEventListener('transitionend', () => {
        el.remove();
    });
}