/**
 * flow.js
 * フローコメント（弾幕）関連の機能
 */

// グローバル変数（content_script.jsで定義・初期化される）
// - settings
// - flowContainer

const lanes = new Map();
const LANE_COUNT = 15;

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

    const el = document.createElement('div');
    el.className = 'flow-comment';
    el.style.fontFamily = settings.customFontFamily || settings.flowFontFamily;
    el.style.fontSize = `${settings.fontSize}px`;
    el.style.opacity = '0';
    el.style.position = 'absolute';
    el.style.top = '-9999px';
    
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
    
    flowContainer.appendChild(el);
    const commentWidth = el.offsetWidth;
    flowContainer.removeChild(el);
    el.style.opacity = settings.opacity;
    el.style.position = '';
    el.style.top = '';

    const topPosition = findAvailableLane(commentWidth);
    if (topPosition === null) return;

    el.style.transition = `transform ${settings.flowTime}s linear`;
    el.style.top = `${topPosition}px`;
    el.style.left = `${flowContainer.offsetWidth}px`;
    flowContainer.appendChild(el);

    requestAnimationFrame(() => {
        el.style.transform = `translateX(-${flowContainer.offsetWidth + commentWidth}px)`;
    });

    setTimeout(() => el.remove(), settings.flowTime * 1000 + 500);
}
