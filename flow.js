/**
 * flow.js (Optimized)
 * Canvasを利用した軽量描画版
 */

const lanes = new Map();
const LANE_COUNT = 15;
// ★追加: 幅計算用のCanvas
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
    // DOMアクセスは最小限に。flowContainerのサイズが変わることは稀なので
    // 本来はここもキャッシュすべきだが、安全のため取得
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
    // HTMLタグが含まれる可能性があるため、Canvas計算用にテキストのみ抽出する必要があるが、
    // 厳密な幅計算よりパフォーマンスを優先し、textToFlowの文字数から概算するか、
    // あるいは割り切ってシンプルなテキストとして扱う。
    // ここではHTMLが含まれる場合の簡易的なタグ除去を行う
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

    // ★最適化: Canvasで幅を計算
    const currentFont = settings.customFontFamily || settings.flowFontFamily;
    // スーパーチャットなどはパディング分少し広めに取る
    const padding = data.specialType ? 40 : 20; 
    const commentWidth = measureTextWidth(pureText, settings.fontSize, currentFont) + padding;

    // レーンを探す
    const topPosition = findAvailableLane(commentWidth);
    if (topPosition === null) return; // 空きがなければ描画しない（間引き）

    // DOM生成
    const el = document.createElement('div');
    el.className = 'flow-comment';
    el.style.fontFamily = currentFont;
    el.style.fontSize = `${settings.fontSize}px`;
    el.style.top = `${topPosition}px`;
    el.style.left = '100%'; // CSSで制御するため初期位置は右端
    // el.style.willChange = 'transform'; // CSSで指定済み

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
        // HTMLを含むためinnerHTML
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

    // 強制リフローを起こさないように requestAnimationFrame を使用
    requestAnimationFrame(() => {
        // コンテナ幅はキャッシュしておいたほうが良いが、ここは安全策で取得
        const containerWidth = flowContainer.offsetWidth; 
        el.style.transform = `translateX(-${containerWidth + commentWidth}px)`;
    });

    // 完了後の削除には transitionend を使用して確実に行う
    // (万が一イベントが発火しない場合のためにsetTimeoutも併用すると盤石だが、軽量化のためイベントリスナのみ)
    el.addEventListener('transitionend', () => {
        el.remove();
    });
}