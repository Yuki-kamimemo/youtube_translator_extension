/**
 * flow.js
 * フローコメント（弾幕）関連の機能
 * ★画像対応 ＆ モバイル縁取り対策版
 */

// グローバル変数（content_script.jsで定義・初期化される）
// - settings
// - flowContainer

const lanes = new Map();
const LANE_COUNT = 15;

/**
 * フローコメントを表示するための空きレーンを探す
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
 */
function flowComment(data) {
    if (!flowContainer || !settings.enableFlowComments) return;
    
    let textToFlow = '';
    switch (settings.flowContent) {
        case 'translation': textToFlow = data.translated || data.html; break;
        case 'original': textToFlow = data.html; break;
        case 'both': textToFlow = data.translated ? `${data.html} <span class="flow-translation">(${data.translated})</span>` : data.html; break;
    }

    // テキストも画像もなければ終了
    if (!textToFlow || (!textToFlow.trim() && !textToFlow.includes('<img'))) return;

    const el = document.createElement('div');
    el.className = 'flow-comment';
    el.style.fontFamily = settings.customFontFamily || settings.flowFontFamily;
    el.style.fontSize = `${settings.fontSize}px`;
    el.style.opacity = '0';
    el.style.position = 'absolute';
    el.style.top = '-9999px';
    el.style.fontWeight = 'bold';
    el.style.willChange = 'transform';
    
    // ★★★ 修正箇所: モバイル対応の縁取り設定 ★★★
    const width = Number(settings.strokeWidth) || 0;
    const color = settings.strokeColor || '#000000';

    // 影はドロップシャドウ1つだけにする（負荷軽減）
    el.style.textShadow = '1.5px 1.5px 3px rgba(0,0,0,0.9)';

    if (width > 0) {
        // 縁取り専用プロパティを使用
        el.style.webkitTextStrokeWidth = `${width}px`;
        el.style.webkitTextStrokeColor = color;
        
        // 標準プロパティ（将来用）
        el.style.textStrokeWidth = `${width}px`;
        el.style.textStrokeColor = color;
        
        // 文字の塗りつぶしが縁取りで消えないように描画順序を指定
        el.style.paintOrder = 'stroke fill';
    }
    // ★★★ 修正箇所終わり ★★★

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
    
    // DOMに追加して幅を測定
    flowContainer.appendChild(el);
    let commentWidth = el.offsetWidth;
    
    // 画像幅の補正ロジック（画像のロード待ちで幅が0になるのを防ぐ）
    const imgMatch = textToFlow.match(/<img/gi);
    const imgCount = imgMatch ? imgMatch.length : 0;
    
    // ステッカー（大きな画像）か、通常の絵文字かを判定
    const hasSticker = textToFlow.includes('style="height: 80px') || textToFlow.includes('yt-live-chat-paid-sticker-renderer');
    
    // 通常の測定幅が極端に小さい（画像未ロード）かつ、画像タグがある場合
    if (commentWidth < (imgCount * settings.fontSize)) {
        if (hasSticker) {
            // ステッカーの場合は大きく加算
            commentWidth += 100; 
        } else {
            // 絵文字の場合はフォントサイズ分を加算
            commentWidth += (imgCount * (settings.fontSize * 1.2));
        }
    }

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