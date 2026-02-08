/**
 * flow.js (Final Fix)
 * 透過度・画像対応・特殊メッセージ対応版
 */

const lanes = new Map();
const LANE_COUNT = 15;
let measureContext = null;

function getMeasureContext() {
    if (!measureContext) {
        const canvas = document.createElement('canvas');
        measureContext = canvas.getContext('2d');
    }
    return measureContext;
}

/**
 * 幅計算（テキスト幅 + 画像幅）
 * 画像はHTML内のimgタグ数をカウントして概算
 */
function measureContentWidth(text, html, fontSize, fontFamily) {
    const ctx = getMeasureContext();
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    
    // テキスト部分の幅
    const textWidth = ctx.measureText(text || '').width;
    
    // 画像部分の幅（概算）
    // imgタグの数を数える
    const imgCount = (html.match(/<img/gi) || []).length;
    // 絵文字やアイコンはフォントサイズと同程度と仮定して加算
    const imagesWidth = imgCount * (fontSize * 1.2); 

    return textWidth + imagesWidth;
}

function findAvailableLane(commentWidth) {
    if (!flowContainer) return null;
    const now = Date.now();
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

    // ★変更: テキストがなくても、表示するHTMLがあれば処理を続行する
    if ((!pureText || !pureText.trim()) && !textToFlow) return;

    // Canvasで幅を計算 (テキスト + 画像)
    const currentFont = settings.customFontFamily || settings.flowFontFamily;
    const padding = data.specialType ? 40 : 20; 
    
    // ★変更: measureContentWidthを使用
    const commentWidth = measureContentWidth(pureText, textToFlow, settings.fontSize, currentFont) + padding;

    // レーンを探す
    const topPosition = findAvailableLane(commentWidth);
    if (topPosition === null) return;

    // DOM生成
    const el = document.createElement('div');
    el.className = 'flow-comment';
    el.style.fontFamily = currentFont;
    el.style.fontSize = `${settings.fontSize}px`;
    el.style.top = `${topPosition}px`;
    el.style.left = '100%'; 
    
    el.style.opacity = settings.opacity; 
    
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
        // スーパーステッカーなどの巨大画像が含まれる場合のレイアウト調整
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