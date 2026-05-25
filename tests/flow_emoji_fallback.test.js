const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeNode {
    constructor(nodeType, tagName = '', textContent = '') {
        this.nodeType = nodeType;
        this.tagName = tagName;
        this.textContent = textContent;
        this.childNodes = [];
        this.children = [];
        this.attributes = {};
    }

    appendChild(child) {
        this.childNodes.push(child);
        if (child.nodeType === 1) this.children.push(child);
        return child;
    }

    get src() { return this.attributes.src || ''; }
    set src(value) { this.attributes.src = value; }
    get alt() { return this.attributes.alt || ''; }
    set alt(value) { this.attributes.alt = value; }
    get className() { return this.attributes.className || ''; }
    set className(value) { this.attributes.className = value; }
}

function parseAttributes(raw) {
    const attrs = {};
    raw.replace(/([a-zA-Z-]+)="([^"]*)"/g, (_, key, value) => {
        attrs[key] = value;
        return '';
    });
    return attrs;
}

function parseHtml(html) {
    const root = new FakeNode(11);
    const imgOnly = html.match(/^\s*<img\b([^>]*)>\s*$/i);
    if (imgOnly) {
        const attrs = parseAttributes(imgOnly[1]);
        const img = new FakeNode(1, 'IMG');
        img.src = attrs.src || '';
        img.alt = attrs.alt || '';
        img.className = attrs.class || '';
        root.appendChild(img);
        return root.childNodes;
    }
    if (html) root.appendChild(new FakeNode(3, '', html));
    return root.childNodes;
}

const sandbox = {
    console,
    URL,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    document: {
        createElement(tagName) {
            if (tagName === 'template') {
                return {
                    content: { childNodes: [] },
                    set innerHTML(value) { this.content.childNodes = parseHtml(value); },
                    get innerHTML() { return ''; },
                };
            }
            return new FakeNode(1, tagName.toUpperCase());
        },
        createTextNode(text) {
            return new FakeNode(3, '', text);
        },
        createDocumentFragment() {
            return new FakeNode(11);
        },
    },
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'flow.js'), 'utf8'), sandbox);

const fragment = sandbox.createSafeContent('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="😂">');

assert.strictEqual(fragment.childNodes.length, 1);
assert.strictEqual(fragment.childNodes[0].nodeType, 3);
assert.strictEqual(fragment.childNodes[0].textContent, '😂');

const allowedImageFragment = sandbox.createSafeContent('<img src="https://yt3.ggpht.com/sticker.png" alt="stamp">');

assert.strictEqual(allowedImageFragment.childNodes.length, 1);
assert.strictEqual(allowedImageFragment.childNodes[0].nodeType, 1);
assert.strictEqual(allowedImageFragment.childNodes[0].tagName, 'IMG');
assert.strictEqual(allowedImageFragment.childNodes[0].alt, 'stamp');
