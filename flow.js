/**
 * flow.js
 * フローコメント（弾幕）関連の機能
 * ★モバイル向け軽量化・パフォーマンスチューニング版
 */

// グローバル変数（content_script.jsで定義・初期化される）
// - settings
// - flowContainer

const lanes = new Map();
const LANE_COUNT = 15;

/**
 * フローコメントを表示するための空きレーンを探す (メモリ・CPU最適化済)
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
    
    // 無駄な配列生成を避け、空いているレーンのインデックスのみを収集
    const availableIndices = [];
    for (let i = 0; i < LANE_COUNT; i++) {
        const laneBecomesFreeAt = lanes.get(i);
        if (!laneBecomesFreeAt || now > laneBecomesFreeAt) {
            availableIndices.push(i);
        }
    }

    if (availableIndices.length === 0) return null;

    let selectedLane;
    if (settings.position === 'random') {
        selectedLane = availableIndices[Math.floor(Math.random() * availableIndices.length)];
    } else if (settings.position === 'bottom_priority') {
        selectedLane = availableIndices[availableIndices.length - 1]; // 一番下の空きレーン
    } else {
        selectedLane = availableIndices[0]; // 一番上の空きレーン
    }

    lanes.set(selectedLane, now + requiredTime);
    return (selectedLane * laneHeight) + marginTop;
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

    if (!textToFlow.trim()) return;

    const el = document.createElement('div');
    el.className = 'flow-comment';
    el.style.fontFamily = settings.customFontFamily || settings.flowFontFamily;
    el.style.fontSize = `${settings.fontSize}px`;
    // DOM追加時の画面のチラつきを防ぐため透明にする
    el.style.opacity = '0';
    el.style.position = 'absolute';
    el.style.fontWeight = 'bold';
    el.style.willChange = 'transform';
    // 初期配置を画面外にしておく
    el.style.left = '100%'; 
    
    // 軽量化された縁取り設定 (paint-orderを使用して超軽量かつ綺麗な縁取りを実現)
    const dropShadow = '1.5px 1.5px 3px rgba(0,0,0,0.9)';
    const width = Number(settings.strokeWidth) || 0;
    const color = settings.strokeColor || '#000000';
    
    if (width > 0) {
        el.style.webkitTextStroke = `${width}px ${color}`;
        el.style.textStroke = `${width}px ${color}`;
        // 縁取りを文字の「内側」ではなく「外側・裏側」に描画させる（文字が細くならない）
        el.style.paintOrder = 'stroke fill';
        el.style.textShadow = dropShadow; 
    } else {
        el.style.textShadow = dropShadow;
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
    
    // ★ DOM操作の最小化: 要素の追加・削除（レイアウトスラッシング）を1回で済ませる
    flowContainer.appendChild(el);
    let commentWidth = el.offsetWidth;
    
    // 画像の幅補正
    const imgMatch = textToFlow.match(/<img/gi);
    const imgCount = imgMatch ? imgMatch.length : 0;
    const hasSticker = textToFlow.includes('style="height: 80px') || textToFlow.includes('yt-live-chat-paid-sticker-renderer');
    
    if (commentWidth < (imgCount * settings.fontSize)) {
        if (hasSticker) {
            commentWidth += 100; 
        } else {
            commentWidth += (imgCount * (settings.fontSize * 1.2));
        }
    }

    // 空きレーンを取得
    const topPosition = findAvailableLane(commentWidth);
    
    // 空きがない場合は削除して終了
    if (topPosition === null) {
        el.remove();
        return;
    }

    // 配置とアニメーションの適用
    el.style.top = `${topPosition}px`;
    el.style.left = `${flowContainer.offsetWidth}px`;
    el.style.transition = `transform ${settings.flowTime}s linear`;
    
    // 透明状態を解除
    el.style.opacity = settings.opacity;

    // 次の描画フレームでアニメーションを開始
    requestAnimationFrame(() => {
        el.style.transform = `translateX(-${flowContainer.offsetWidth + commentWidth}px)`;
    });

    // アニメーション完了後に要素を削除
    setTimeout(() => el.remove(), settings.flowTime * 1000 + 500);
}