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
const safeContentTemplate = document.createElement('template');

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

// YouTube絵文字画像で許可するCDNドメイン
const ALLOWED_IMG_HOSTS = [
    'yt3.ggpht.com',
    'yt3.googleusercontent.com',
    'lh3.googleusercontent.com',
    'www.gstatic.com',
];

function walkSafeContent(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(node.textContent));
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    if (tag === 'img') {
        let imageAllowed = false;
        try {
            const url = new URL(node.src);
            if (ALLOWED_IMG_HOSTS.includes(url.hostname)) {
                const img = document.createElement('img');
                img.src = node.src;
                if (node.alt) img.alt = node.alt;
                if (node.className) img.className = node.className;
                parent.appendChild(img);
                imageAllowed = true;
            }
        } catch (_) { /* 不正なURLは無視 */ }
        if (!imageAllowed && node.alt) {
            parent.appendChild(document.createTextNode(node.alt));
        }
        return;
    }
    if (tag === 'span' || tag === 'br') {
        const el = document.createElement(tag);
        if (node.className) el.className = node.className;
        parent.appendChild(el);
        node.childNodes.forEach(child => walkSafeContent(child, el));
        return;
    }

    // 許可外タグは子ノードだけ再帰的に処理（タグ自体は無視）
    node.childNodes.forEach(child => walkSafeContent(child, parent));
}

/**
 * HTML文字列をtemplateで解析し、許可タグ（text/img/span/br）のみを
 * DocumentFragmentとして安全に再構築する（XSS対策）
 */
function createSafeContent(htmlString) {
    safeContentTemplate.innerHTML = htmlString || '';
    const fragment = document.createDocumentFragment();

    safeContentTemplate.content.childNodes.forEach(child => walkSafeContent(child, fragment));
    safeContentTemplate.innerHTML = '';
    return fragment;
}

/**
 * 画面にコメントを流す
 */
function flowComment(data) {
    if (!flowContainer || !settings.enableFlowComments) return;

    // 二重の安全策：画面上のフローコメント数が多すぎる場合は描画をスキップ（VODシーク時の暴発対策）
    const MAX_ONSCREEN_COMMENTS = 60;
    if (flowContainer.childElementCount > MAX_ONSCREEN_COMMENTS) {
        return;
    }

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

        const authorSpan = document.createElement('span');
        authorSpan.className = 'superchat-author';
        authorSpan.textContent = data.authorName;

        const amountSpan = document.createElement('span');
        amountSpan.className = 'superchat-amount';
        amountSpan.textContent = data.purchaseAmount;

        const messageDiv = document.createElement('div');
        messageDiv.className = 'superchat-message';
        messageDiv.appendChild(createSafeContent(textToFlow));

        el.appendChild(authorSpan);
        el.appendChild(amountSpan);
        el.appendChild(messageDiv);
    } else if (data.specialType === 'membership') {
        el.classList.add('flow-membership');
        el.style.color = settings.membershipColorFlow;
        el.appendChild(createSafeContent(textToFlow));
    } else {
        el.appendChild(createSafeContent(textToFlow));
        el.style.color = settings[`${data.userType}Color`] || settings.normalColor;
    }

    // READ: appendChild 前にコンテナ幅を読む（子追加では変化しないため強制レイアウト不要）
    const containerWidth = flowContainer.offsetWidth;

    // 画像カウントは文字列操作なので appendChild 前に実施
    const imgCount = (textToFlow.match(/<img/gi) || []).length;

    // WRITE: DOMに追加
    flowContainer.appendChild(el);

    // double-rAF: Read フェーズと Write フェーズを分離して強制同期レイアウドを回避
    requestAnimationFrame(() => {
        // READ フェーズ: 前フレームのレイアウト結果を利用（強制 reflow なし）
        let commentWidth = el.offsetWidth;

        if (commentWidth < (imgCount * settings.fontSize)) {
            commentWidth += (imgCount * (settings.fontSize * 1.2));
        }

        const topPosition = findAvailableLane(commentWidth);

        if (topPosition === null) {
            el.remove();
            return;
        }

        // WRITE フェーズ: 配置スタイルを一括適用
        el.style.top = `${topPosition}px`;
        el.style.left = `${containerWidth}px`;
        el.style.transition = `transform ${settings.flowTime}s linear`;
        el.style.opacity = settings.opacity;

        // アニメーション開始は次フレームに委ねる（transition が確実に有効になってから）
        requestAnimationFrame(() => {
            el.style.transform = `translateX(-${containerWidth + commentWidth}px)`;
        });

        // アニメーション完了後に要素を削除
        setTimeout(() => {
            el.style.willChange = 'auto';
            el.remove();
        }, settings.flowTime * 1000 + 500);
    });
}
