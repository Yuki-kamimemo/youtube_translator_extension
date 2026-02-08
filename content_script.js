/**
 * content_script.js (Optimized & Expanded)
 * パフォーマンス最適化 + 特殊メッセージ対応版
 */

const IS_IN_IFRAME = (window.self !== window.top);
let settings = {};
let chatObserver = null;
let ngUserList = [];
let ngWordList = [];
let flowContainer = null;
let isInitialized = false;
let initializationRetryTimer = null;

let commentQueue = [];
let processingTimer = null;
const BATCH_INTERVAL = 200;

const DEFAULTS = {
    translator: 'google', deeplApiKey: '', enableInlineTranslation: true,
    enableGoogleTranslateFallback: true, enableFlowComments: true, flowContent: 'translation',
    flowTime: 8, fontSize: 24, opacity: 0.9, position: 'top_priority',
    strokeWidth: 1.5, strokeColor: '#000000',
    flowFontFamily: "'ヒラギノ角ゴ Pro W3', 'Hiragino Kaku Gothic Pro', 'メイリオ', Meiryo, sans-serif",
    customFontFamily: '', flowMarginTop: 10, flowMarginBottom: 10,
    normalColor: '#FFFFFF', memberColor: '#28a745', moderatorColor: '#007bff',
    superchatColor: '#FFFFFF',
    membershipColorFlow: '#00e676',
    dictionary: '',
    ngUsers: '', ngWords: '',
};

function updateNgLists() {
    ngUserList = settings.ngUsers ? settings.ngUsers.split('\n').map(u => u.trim()).filter(Boolean) : [];
    ngWordList = settings.ngWords ? settings.ngWords.split('\n').map(w => w.trim()).filter(Boolean) : [];
}

function waitForElement(selector, parent = document, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const existing = parent.querySelector(selector);
        if (existing) return resolve(existing);

        const observer = new MutationObserver(() => {
            const el = parent.querySelector(selector);
            if (el) {
                observer.disconnect();
                clearTimeout(timer);
                resolve(el);
            }
        });
        const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout: ${selector}`));
        }, timeout);
        observer.observe(parent.documentElement || parent, { childList: true, subtree: true });
    });
}

// コメント解析（特殊メッセージ対応強化）
function parseComment(node) {
    const authorEl = node.querySelector('#author-name');
    const messageEl = node.querySelector('#message');
    
    const authorTypeAttr = node.getAttribute('author-type');
    let userType = 'normal';
    if (authorTypeAttr === 'moderator') userType = 'moderator';
    else if (authorTypeAttr === 'member') userType = 'member';

    const baseComment = {
        html: '', text: '', userType: userType,
        authorName: authorEl ? authorEl.textContent : '',
        specialType: null,
    };

    const tagName = node.tagName.toUpperCase();

    // 1. 通常コメント
    if (tagName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER') {
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
            // 画像(絵文字)のみの場合、alt属性などからテキストを補完して空判定を防ぐ
            if (!baseComment.text.trim()) {
                const imgs = messageEl.querySelectorAll('img');
                if (imgs.length > 0) {
                    baseComment.text = Array.from(imgs).map(img => img.alt || 'emoji').join(' ');
                }
            }
        }
    } 
    // 2. スーパーチャット (赤スパなど)
    else if (tagName === 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount');
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
        }
        baseComment.specialType = 'superchat';
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-message-primary-color') || '#ff0000';
    } 
    // 3. メンバーシップ加入/更新
    else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER') {
        const headerSubtextEl = node.querySelector('#header-subtext');
        let membershipHtml = headerSubtextEl ? headerSubtextEl.innerHTML : '';
        let membershipText = headerSubtextEl ? headerSubtextEl.textContent : '';
        
        if (messageEl) {
            baseComment.html = membershipHtml ? `${membershipHtml}<br>${messageEl.innerHTML}` : messageEl.innerHTML;
            baseComment.text = (membershipText + ' ' + (messageEl.textContent || '')).trim();
        } else {
            baseComment.html = membershipHtml;
            baseComment.text = membershipText;
        }
        baseComment.specialType = 'membership';
    }
    // 4. スーパーステッカー (投げ銭スタンプ)
    else if (tagName === 'YT-LIVE-CHAT-PAID-STICKER-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount-chip');
        const stickerImg = node.querySelector('#sticker > img');
        
        baseComment.specialType = 'superchat'; // フロー上はスパチャと同じ扱いでOK
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-sticker-background-color') || '#ff0000';
        
        if (stickerImg) {
            // 画像を大きく表示するためのHTMLを生成
            baseComment.html = `<img src="${stickerImg.src}" style="height: 80px; width: auto;">`;
            baseComment.text = '[Super Sticker]';
        }
    }
    // 5. メンバーシップギフト購入
    else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER') {
        const headerEl = node.querySelector('#header');
        const giftImg = node.querySelector('#gift-image > img');
        
        baseComment.specialType = 'membership';
        baseComment.html = (headerEl ? headerEl.innerHTML : '') + (giftImg ? `<br><img src="${giftImg.src}" style="height: 1.5em;">` : '');
        baseComment.text = headerEl ? headerEl.textContent : '[Gift Purchase]';
    }
    // 6. ギフト受け取り (ログが大量に出るので不要なら外しても良い)
    else if (tagName === 'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER') {
        const msgEl = node.querySelector('#message');
        baseComment.specialType = 'membership';
        baseComment.html = msgEl ? msgEl.innerHTML : '';
        baseComment.text = msgEl ? msgEl.textContent : '[Gift Received]';
    }

    // HTMLもテキストもなければ無効
    if (!baseComment.html && !baseComment.text && !baseComment.specialType) return null;
    return baseComment;
}

function isCommentFiltered(comment) {
    if (ngUserList.length > 0 && ngUserList.includes(comment.authorName)) return true;
    if (ngWordList.length > 0 && comment.text) {
        for (const word of ngWordList) {
            if (comment.text.includes(word)) return true;
        }
    }
    return false;
}

function processQueue() {
    if (commentQueue.length === 0) return;
    const batch = [...commentQueue];
    commentQueue = [];

    batch.forEach(({ node, comment }) => {
        if (isCommentFiltered(comment)) {
            node.style.display = 'none';
            return;
        }

        const sendToFlow = (translatedText = '') => {
            if (settings.enableFlowComments && chrome.runtime?.id) {
                comment.translated = translatedText;
                chrome.runtime.sendMessage({ type: 'FLOW_COMMENT_DATA', data: comment });
            }
        };

        // テキストが存在し、かつ画像のみのメッセージ（[Super Sticker]など）でない場合に翻訳を実行
        const isTranslatable = comment.text && !comment.text.startsWith('[') && settings.enableInlineTranslation;

        if (isTranslatable) {
            requestTranslation(comment.text, (result) => {
                if (result.translation) {
                    displayInlineTranslation(node, result.translation);
                } else if (result.error) {
                    displayInlineTranslation(node, `[${result.error}]`, true);
                }
                sendToFlow(result.translation || '');
            });
        } else {
            sendToFlow('');
        }
    });
}

function queueCommentProcessing(node) {
    if (node.dataset.processed) return;
    node.dataset.processed = 'true';

    const comment = parseComment(node);
    if (!comment) return;

    commentQueue.push({ node, comment });

    if (!processingTimer) {
        processingTimer = setTimeout(() => {
            processQueue();
            processingTimer = null;
        }, BATCH_INTERVAL);
    }
}

// --- UI系 ---
function createToggleButton(id, key, prefix, parent) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.innerHTML = (id === 'toggle-translation-btn') ? '🌐' : '💬';
    const update = () => {
        btn.title = `${prefix}: ${settings[key] ? 'オン' : 'オフ'}`;
        btn.className = settings[key] ? 'enabled' : '';
    };
    update();
    btn.onclick = () => { settings[key] = !settings[key]; chrome.storage.sync.set({ [key]: settings[key] }); update(); };
    parent.appendChild(btn);
    return btn;
}

function toggleSettingsPanel() {
    const p = document.getElementById('ylc-settings-panel');
    if(p) p.style.display = p.style.display === 'flex' ? 'none' : 'flex';
}

function createSettingsPanel() {
    if (document.getElementById('ylc-settings-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ylc-settings-panel';
    panel.innerHTML = `
        <div id="ylc-settings-header">設定 <button id="ylc-settings-close-btn">×</button></div>
        <iframe id="ylc-settings-iframe" src="${chrome.runtime.getURL('popup.html')}"></iframe>
    `;
    document.body.appendChild(panel);
    
    const header = panel.querySelector('#ylc-settings-header');
    const close = panel.querySelector('#ylc-settings-close-btn');
    close.onclick = () => panel.style.display = 'none';
    
    let isDragging = false, offX, offY;
    header.onmousedown = e => { isDragging = true; offX = e.clientX - panel.offsetLeft; offY = e.clientY - panel.offsetTop; };
    document.addEventListener('mousemove', e => {
        if(isDragging) { panel.style.left = (e.clientX - offX)+'px'; panel.style.top = (e.clientY - offY)+'px'; }
    });
    document.addEventListener('mouseup', () => isDragging = false);
}

// --- Observer (ターゲットタグを追加) ---
function startChatObserver(chatItemsEl) {
    if (chatObserver) chatObserver.disconnect();
    
    const targetTags = new Set([
        'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER', 
        'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER', 
        'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
        'YT-LIVE-CHAT-PAID-STICKER-RENDERER',           // ★追加: スーパーステッカー
        'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER', // ★追加: ギフト購入
        'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER'  // ★追加: ギフト受領
    ]);

    chatObserver = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1 && targetTags.has(node.tagName.toUpperCase())) {
                    queueCommentProcessing(node);
                }
            }
        }
    });
    chatObserver.observe(chatItemsEl, { childList: true });
}

// --- 初期化 ---
async function initializeIframe() {
    if (isInitialized) return;
    try {
        const chatApp = await waitForElement('yt-live-chat-app');
        const header = await waitForElement('yt-live-chat-header-renderer', chatApp);
        
        let controls = document.getElementById('enhancer-controls');
        if (!controls) {
            controls = document.createElement('div');
            controls.id = 'enhancer-controls';
            header.after(controls);
            createToggleButton('toggle-translation-btn', 'enableInlineTranslation', '翻訳', controls);
            createToggleButton('toggle-flow-btn', 'enableFlowComments', 'コメント表示', controls);
            const sBtn = document.createElement('button');
            sBtn.id = 'ylc-settings-btn'; sBtn.innerHTML = '⚙️';
            sBtn.onclick = () => chrome.runtime.sendMessage({ action: 'toggleSettingsPanel' });
            controls.appendChild(sBtn);
        }
        
        const items = await waitForElement('#items.yt-live-chat-item-list-renderer', chatApp);
        startChatObserver(items);
        isInitialized = true;
        if(initializationRetryTimer) clearInterval(initializationRetryTimer);
    } catch (e) {
        isInitialized = false;
    }
}

async function initializeTopLevel() {
    if (isInitialized) return;
    if (!location.pathname.startsWith('/watch')) return;
    try {
        const player = await waitForElement('#movie_player');
        if (player && !document.getElementById('yt-flow-comment-container')) {
            flowContainer = document.createElement('div');
            flowContainer.id = 'yt-flow-comment-container';
            player.appendChild(flowContainer);
        }
        createSettingsPanel();
        isInitialized = true;
    } catch (e) {
        isInitialized = false;
    }
}

async function main() {
    if (window.ylcEnhancerLoaded) return;
    window.ylcEnhancerLoaded = true;

    try {
        const loaded = await chrome.storage.sync.get(DEFAULTS);
        Object.assign(settings, loaded);
        updateNgLists();
    } catch (e) { return; }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (let k in changes) {
            settings[k] = changes[k].newValue;
            if (k === 'ngUsers' || k === 'ngWords') updateNgLists();
            
            if (IS_IN_IFRAME && (k === 'enableInlineTranslation' || k === 'enableFlowComments')) {
                const btnId = k === 'enableInlineTranslation' ? 'toggle-translation-btn' : 'toggle-flow-btn';
                const btn = document.getElementById(btnId);
                if(btn) {
                    btn.className = settings[k] ? 'enabled' : '';
                    btn.title = settings[k] ? 'オン' : 'オフ';
                }
            }
        }
    });

    const init = () => {
        if (!isInitialized) {
            IS_IN_IFRAME && location.pathname.startsWith('/live_chat') ? initializeIframe() : initializeTopLevel();
        }
        if (isInitialized && initializationRetryTimer) {
            clearInterval(initializationRetryTimer);
            initializationRetryTimer = null;
        }
    };

    if (!IS_IN_IFRAME) {
        if (!window.ylcMsg) {
            window.ylcMsg = true;
            chrome.runtime.onMessage.addListener(r => {
                if (r.type === 'FLOW_COMMENT_DATA') flowComment(r.data);
                else if (r.action === 'toggleSettingsPanel') toggleSettingsPanel();
            });
        }
        document.body.addEventListener('yt-navigate-finish', () => {
            isInitialized = false;
            if (initializationRetryTimer) clearInterval(initializationRetryTimer);
            initializationRetryTimer = setInterval(init, 2000);
        });
    }

    initializationRetryTimer = setInterval(init, 2000);
}
main();