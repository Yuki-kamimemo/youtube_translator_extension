/**
 * content_script.js (Main)
 * 拡張機能のメインロジック、初期化、イベント監視
 */

const IS_IN_IFRAME = (window.self !== window.top);
let settings = {};
let chatObserver = null;
let ngUserList = [];
let ngWordList = [];
let flowContainer = null; 
let isInitialized = false; 
let initializationRetryTimer = null; 
let hiddenChatIframe = null;
let currentTabId = null;

const DEFAULTS = {
    translator: 'gemini', geminiApiKey: '', geminiApiKey2: '', deeplApiKey: '', enableInlineTranslation: true,
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

function waitForElement(selector, parent = document, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const element = parent.querySelector(selector);
        if (element) {
            resolve(element);
            return;
        }

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
            reject(new Error(`Element not found: ${selector}`));
        }, timeout);

        observer.observe(parent.documentElement || parent, { childList: true, subtree: true });
    });
}

function parseComment(node) {
    const authorEl = node.querySelector('#author-name');
    const messageEl = node.querySelector('#message');
    
    const authorTypeAttr = node.getAttribute('author-type');
    let userType = 'normal';
    if (authorTypeAttr === 'moderator') userType = 'moderator';
    else if (authorTypeAttr === 'member') userType = 'member';

    const baseComment = {
        id: node.id || '',
        html: '', text: '', userType: userType,
        authorName: authorEl ? authorEl.textContent || '' : '',
        specialType: null,
    };

    const tagName = node.tagName.toUpperCase();

    if (tagName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER') {
        if (messageEl) {
            baseComment.html = messageEl.innerHTML;
            baseComment.text = messageEl.textContent || '';
            if (!baseComment.text.trim() && messageEl.querySelector('img')) {
                 baseComment.text = ' '; 
            }
        }
    } 
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
    else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER') {
        const headerSubtextEl = node.querySelector('#header-subtext');
        let membershipHtml = '';
        let membershipText = '';
        if (headerSubtextEl) {
            membershipHtml = headerSubtextEl.innerHTML;
            membershipText = headerSubtextEl.textContent || '';
        }
        if (messageEl) {
            baseComment.html = membershipHtml ? `${membershipHtml}<br>${messageEl.innerHTML}` : messageEl.innerHTML;
            baseComment.text = membershipText ? `${membershipText} ${(messageEl.textContent || '')}`.trim() : (messageEl.textContent || '').trim();
        } else {
            baseComment.html = membershipHtml;
            baseComment.text = membershipText;
        }
        baseComment.specialType = 'membership';
    }
    else if (tagName === 'YT-LIVE-CHAT-PAID-STICKER-RENDERER') {
        const purchaseAmountEl = node.querySelector('#purchase-amount-chip');
        const stickerImg = node.querySelector('#sticker > img');
        
        baseComment.specialType = 'superchat'; 
        baseComment.purchaseAmount = purchaseAmountEl ? purchaseAmountEl.textContent.trim() : '';
        baseComment.bgColor = node.style.getPropertyValue('--yt-live-chat-paid-sticker-background-color') || '#ff0000';
        
        if (stickerImg) {
            baseComment.html = `<img src="${stickerImg.src}" style="height: 80px; width: auto; vertical-align: middle;">`;
            baseComment.text = '[Super Sticker]';
        }
    }
    else if (tagName === 'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER') {
        const headerEl = node.querySelector('#header');
        const giftImg = node.querySelector('#gift-image > img');
        
        baseComment.specialType = 'membership';
        baseComment.html = (headerEl ? headerEl.innerHTML : '') + (giftImg ? `<br><img src="${giftImg.src}" style="height: 1.5em; vertical-align: middle;">` : '');
        baseComment.text = headerEl ? headerEl.textContent : '[Gift Purchase]';
    }
    else if (tagName === 'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER') {
        const msgEl = node.querySelector('#message');
        baseComment.specialType = 'membership';
        baseComment.html = msgEl ? msgEl.innerHTML : '';
        baseComment.text = msgEl ? msgEl.textContent : '[Gift Received]';
    }

    if (!baseComment.html.trim() && baseComment.specialType === null) return null;
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

function createToggleButton(id, settingKey, labelPrefix, parentContainer) {
    const button = document.createElement('button');
    button.id = id;
    button.className = 'ylc-control-btn';
    
    const getIconHTML = (type) => {
        if (type === 'translation') {
            return `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg><span class="btn-text">翻訳</span>`;
        } else {
            return `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12zM7 9h10v2H7zm0-3h10v2H7zm0 6h7v2H7z"/></svg><span class="btn-text">フロー</span>`;
        }
    };
    
    button.innerHTML = getIconHTML(id === 'toggle-translation-btn' ? 'translation' : 'flow');

    const updateButton = (isEnabled) => {
        button.title = `${labelPrefix}: ${isEnabled ? 'オン' : 'オフ'}`;
        if (isEnabled) {
            button.classList.add('enabled');
        } else {
            button.classList.remove('enabled');
        }
    };
    updateButton(settings[settingKey]);

    button.onclick = () => {
        const newValue = !settings[settingKey];
        settings[settingKey] = newValue;
        updateButton(newValue);

        if (currentTabId) {
            chrome.storage.local.get(`tabState_${currentTabId}`, (data) => {
                const tabState = data[`tabState_${currentTabId}`] || {};
                tabState[settingKey] = newValue;
                chrome.storage.local.set({ [`tabState_${currentTabId}`]: tabState });
            });
        } else {
            chrome.storage.sync.set({ [settingKey]: newValue });
        }
    };
    parentContainer.appendChild(button);
}

function toggleSettingsPanel() {
    const panel = document.getElementById('ylc-settings-panel');
    if (panel) {
        const isVisible = panel.style.display === 'flex';
        panel.style.display = isVisible ? 'none' : 'flex';
    }
}

function createSettingsPanel() {
    if (document.getElementById('ylc-settings-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ylc-settings-panel';
    const header = document.createElement('div');
    header.id = 'ylc-settings-header';
    header.textContent = 'チャット翻訳・表示設定';
    const closeButton = document.createElement('button');
    closeButton.id = 'ylc-settings-close-btn';
    closeButton.textContent = '×';
    closeButton.onclick = () => panel.style.display = 'none';
    header.appendChild(closeButton);
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('popup.html');
    iframe.id = 'ylc-settings-iframe';
    panel.appendChild(header);
    panel.appendChild(iframe);
    document.body.appendChild(panel);
    let isDragging = false;
    let offsetX, offsetY;
    header.onmousedown = (e) => {
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        panel.style.transition = 'none';
    };
    document.onmousemove = (e) => {
        if (isDragging) {
            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;
        }
    };
    document.onmouseup = () => {
        isDragging = false;
        panel.style.transition = '';
    };
}

function processNewCommentNode(node) {
    if (node.dataset.processed) return;
    node.dataset.processed = 'true';

    const comment = parseComment(node);
    if (!comment) return;

    if (isCommentFiltered(comment)) {
        node.style.display = 'none';
        return;
    }

    const sendToFlow = (translatedText = '') => {
        if (settings.enableFlowComments) {
            comment.translated = translatedText;
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({ type: 'FLOW_COMMENT_DATA', data: comment });
            }
        }
    };

    // --- ★改修ポイント: 日本語・絵文字のみのコメントを除外する処理 ---
    
    // 日本語（ひらがな、カタカナ、漢字）が含まれているか
    const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/.test(comment.text);
    
    // 翻訳対象となる意味のある文字（英数字、ハングル、ラテン文字など）が含まれているか
    // ※これがない場合は、絵文字や記号だけのコメントと判定されます
    const hasForeignCharacters = /[a-zA-Z0-9\uac00-\ud7a3\u0400-\u04ff\u0e00-\u0e7f\xc0-\u017f]/.test(comment.text);

    // 翻訳を実行する条件
    const shouldTranslate = settings.enableInlineTranslation && 
                            comment.text && 
                            !comment.text.startsWith('[') && 
                            !comment.text.startsWith('<') &&
                            !hasJapanese && 
                            hasForeignCharacters;

    if (shouldTranslate) {
        chrome.runtime.sendMessage({ action: "translate", text: comment.text }, (result) => {
            if (result && result.error) {
                displayInlineTranslation(node, `[${result.error}]`, true);
            } else if (result && result.translation) {
                displayInlineTranslation(node, result.translation);
            }
            sendToFlow(result ? result.translation : '');
        });
    } else {
        // 日本語が含まれている、または絵文字・スタンプのみの場合は翻訳せず原文のまま流す
        sendToFlow('');
    }
}

function displayInlineTranslation(node, text, isError = false) {
    const messageEl = node.querySelector('#message');
    if (!messageEl) return;
    const transEl = document.createElement('div');
    transEl.className = 'ylc-inline-translation';
    transEl.textContent = text;
    transEl.style.color = isError ? '#ff4e4e' : '#3ea6ff';
    transEl.style.fontSize = '0.9em';
    transEl.style.marginTop = '2px';
    messageEl.appendChild(transEl);
}

function startChatObserver(chatItemsEl) {
    if (chatObserver) chatObserver.disconnect();
    const targetNodeTypes = [
        'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER',
        'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER',
        'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
        'YT-LIVE-CHAT-PAID-STICKER-RENDERER',           
        'YT-LIVE-CHAT-MEMBERSHIP-GIFT-PURCHASE-RENDERER', 
        'YT-LIVE-CHAT-GIFT-MEMBERSHIP-RECEIVED-RENDERER'  
    ];
    chatObserver = new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(node => {
            if (node.nodeType === 1 && targetNodeTypes.includes(node.tagName.toUpperCase())) { 
                processNewCommentNode(node);
            }
        }));
    });
    chatObserver.observe(chatItemsEl, { childList: true });
}

function setupHiddenChat() {
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('v');
    if (!videoId) return;

    if (hiddenChatIframe) {
        if (hiddenChatIframe.dataset.videoId === videoId) return; 
        hiddenChatIframe.remove();
        hiddenChatIframe = null;
    }

    const checkAndCreate = () => {
        if (document.querySelector('ytd-live-chat-frame')) {
            createHiddenIframe(videoId);
            return true;
        }
        return false;
    };

    if (!checkAndCreate()) {
        const observer = new MutationObserver((mutations, obs) => {
            if (checkAndCreate()) {
                obs.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 10000);
    }
}

function createHiddenIframe(videoId) {
    if (document.getElementById('ylc-enhancer-hidden-chat')) return;
    hiddenChatIframe = document.createElement('iframe');
    hiddenChatIframe.id = 'ylc-enhancer-hidden-chat';
    hiddenChatIframe.dataset.videoId = videoId;
    hiddenChatIframe.src = `https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`;
    hiddenChatIframe.style.position = 'fixed';
    hiddenChatIframe.style.width = '300px'; 
    hiddenChatIframe.style.height = '500px';
    hiddenChatIframe.style.opacity = '0';
    hiddenChatIframe.style.pointerEvents = 'none';
    hiddenChatIframe.style.zIndex = '-9999';
    hiddenChatIframe.style.left = '-9999px';
    hiddenChatIframe.style.top = '0px';
    document.body.appendChild(hiddenChatIframe);
}

const processedCommentIds = new Set();
const processedCommentIdsQueue = [];

function handleFlowCommentData(data) {
    if (!data) return;
    if (data.id) {
        if (processedCommentIds.has(data.id)) return; 
        processedCommentIds.add(data.id);
        processedCommentIdsQueue.push(data.id);
        if (processedCommentIdsQueue.length > 2000) {
            const oldId = processedCommentIdsQueue.shift();
            processedCommentIds.delete(oldId);
        }
    }
    if (typeof flowComment === 'function') {
        flowComment(data);
    }
}

async function initializeIframe() {
    if (isInitialized) return;
    
    try {
        const chatApp = await waitForElement('yt-live-chat-app');
        const header = await waitForElement('yt-live-chat-header-renderer', chatApp);
        
        let controls = document.getElementById('enhancer-controls');
        if (!controls) {
            controls = document.createElement('div');
            controls.id = 'enhancer-controls';
            controls.className = 'ylc-enhancer-controls';
            header.after(controls); 
            
            createToggleButton('toggle-translation-btn', 'enableInlineTranslation', '翻訳', controls);
            createToggleButton('toggle-flow-btn', 'enableFlowComments', 'コメント表示', controls);
            const settingsBtn = document.createElement('button');
            settingsBtn.id = 'ylc-settings-btn';
            settingsBtn.className = 'ylc-control-btn settings-btn';
            settingsBtn.title = '詳細設定を開く';
            settingsBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .43-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;
            settingsBtn.onclick = () => chrome.runtime.sendMessage({ action: 'toggleSettingsPanel' });
            controls.appendChild(settingsBtn);
        }
        
        const items = await waitForElement('#items.yt-live-chat-item-list-renderer', chatApp);
        startChatObserver(items);
        isInitialized = true; 
        clearInterval(initializationRetryTimer); 
    } catch (error) {
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
    } catch (error) {
        isInitialized = false;
    }
}

async function main() {
    if (window.ylcEnhancerLoaded) return;
    window.ylcEnhancerLoaded = true;

    try {
        currentTabId = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'getTabId' }, response => {
                resolve(response?.tabId || null);
            });
        });

        const loadedSettings = await new Promise(resolve => chrome.storage.sync.get(DEFAULTS, resolve));
        Object.assign(settings, loadedSettings);
        
        if (currentTabId) {
            const localData = await new Promise(resolve => chrome.storage.local.get(`tabState_${currentTabId}`, resolve));
            const tabState = localData[`tabState_${currentTabId}`] || {};
            if (tabState.enableInlineTranslation !== undefined) settings.enableInlineTranslation = tabState.enableInlineTranslation;
            if (tabState.enableFlowComments !== undefined) settings.enableFlowComments = tabState.enableFlowComments;
        }

        updateNgLists();
    } catch (e) {
        console.error('[YLC Enhancer] Failed to load settings:', e);
        return; 
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        let ngListsChanged = false;
        let uiUpdateTrans = false;
        let uiUpdateFlow = false;

        if (area === 'sync') {
            for (let key in changes) {
                if (key !== 'enableInlineTranslation' && key !== 'enableFlowComments') {
                    settings[key] = changes[key].newValue;
                }
                if (key === 'ngUsers' || key === 'ngWords') ngListsChanged = true;
            }
        }

        if (area === 'local' && currentTabId && changes[`tabState_${currentTabId}`]) {
            const newTabState = changes[`tabState_${currentTabId}`].newValue || {};
            if (newTabState.enableInlineTranslation !== undefined && settings.enableInlineTranslation !== newTabState.enableInlineTranslation) {
                settings.enableInlineTranslation = newTabState.enableInlineTranslation;
                uiUpdateTrans = true;
            }
            if (newTabState.enableFlowComments !== undefined && settings.enableFlowComments !== newTabState.enableFlowComments) {
                settings.enableFlowComments = newTabState.enableFlowComments;
                uiUpdateFlow = true;
            }
        }

        if (ngListsChanged) updateNgLists();
        
        if (IS_IN_IFRAME) {
            const transBtn = document.getElementById('toggle-translation-btn');
            if (transBtn && uiUpdateTrans) {
                transBtn.title = `翻訳: ${settings.enableInlineTranslation ? 'オン' : 'オフ'}`;
                transBtn.classList.toggle('enabled', settings.enableInlineTranslation);
            }
            const flowBtn = document.getElementById('toggle-flow-btn');
            if (flowBtn && uiUpdateFlow) {
                flowBtn.title = `コメント表示: ${settings.enableFlowComments ? 'オン' : 'オフ'}`;
                flowBtn.classList.toggle('enabled', settings.enableFlowComments);
            }
        }
    });

    const attemptInitialization = () => {
        if (!isInitialized) {
            if (IS_IN_IFRAME && location.pathname.startsWith('/live_chat')) {
                initializeIframe();
            } else if (!IS_IN_IFRAME) {
                initializeTopLevel();
            }
        }
        if (isInitialized && initializationRetryTimer) {
            clearInterval(initializationRetryTimer);
            initializationRetryTimer = null; 
        }
    };

    if (!IS_IN_IFRAME) {
        if (!window.ylcEnhancerMessageListener) {
            window.ylcEnhancerMessageListener = true;
            chrome.runtime.onMessage.addListener(req => {
                if (req.type === 'FLOW_COMMENT_DATA') { handleFlowCommentData(req.data); }
                else if (req.action === 'toggleSettingsPanel') { toggleSettingsPanel(); }
            });
        }

        if (!window.ylcNavigateListener) {
            window.ylcNavigateListener = true;
            document.body.addEventListener('yt-navigate-finish', () => {
                isInitialized = false;
                if (initializationRetryTimer) clearInterval(initializationRetryTimer);
                initializationRetryTimer = setInterval(attemptInitialization, 2000);
                setupHiddenChat();
            });
        }
        setupHiddenChat();
    }

    initializationRetryTimer = setInterval(attemptInitialization, 2000);
}

main();