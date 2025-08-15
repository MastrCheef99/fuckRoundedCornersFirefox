// === Corner Unrounding — hybrid version between upstream and fork ===

// Defaults / user settings
var userSettings = {
    mode: "1",          // 1: absolute, 2: ratio, 3: clamp
    roundAmount: 0,     // px for mode 1
    ratioAmount: 0,     // fraction for mode 2
    minRounding: 0,     // min radius for mode 2/3
    maxRounding: 0,     // max radius for mode 2/3
    editAll: false,     // force all elements
    excludeClasses: [], // classes to skip
    excludeIds: []      // ids to skip
};

// Cross-browser storage API
const storage = (typeof browser !== "undefined" && browser.storage) ? browser.storage : chrome.storage;
const runtime = (typeof browser !== "undefined" && browser.runtime) ? browser.runtime : chrome.runtime;

// Caches / trackers
const lastAppliedRadius = new WeakMap();   // element -> last radius we set
const watchedElements   = new WeakSet();   // elements we attached observers to (attr + resize)
let pendingElements = new Set();
let flushScheduled = false;
let pendingReload = false;

// ------------------- Queue & batching -------------------
function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    const runner = () => {
        flushScheduled = false;
        const list = Array.from(pendingElements);
        pendingElements.clear();
        fixRounds(list);
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(runner, { timeout: 100 });
    else setTimeout(runner, 50);
}

function queueElements(elements) {
    for (const el of elements) if (el && el.nodeType === 1) pendingElements.add(el);
    scheduleFlush();
}

// ------------------- Settings load & reload -------------------
storage.sync.get(null).then(data => {
    if (data != null) userSettings = data;
    queueElements(document.querySelectorAll('*'));
});

(storage.onChanged || chrome.storage.onChanged).addListener(() => {
    pendingReload = true;
});

window.addEventListener('focus', () => {
    if (pendingReload) location.reload();
});

runtime.onMessage.addListener(msg => {
    if (msg.action === 'reloadPage') pendingReload = true;
});

// ------------------- Helpers -------------------
function shouldExclude(element) {
    if (userSettings.excludeClasses && Array.isArray(userSettings.excludeClasses)) {
        for (const cls of userSettings.excludeClasses) {
            if (element.classList && element.classList.contains(cls)) return true;
        }
    }
    if (userSettings.excludeIds && Array.isArray(userSettings.excludeIds)) {
        if (element.id && userSettings.excludeIds.includes(element.id)) return true;
    }
    return false;
}

function applyRadius(element, desired) {
    element.style.setProperty('border-radius', desired, 'important'); // upstream: override !important
    lastAppliedRadius.set(element, desired);
}

// ------------------- Core rounding -------------------
function computeNewRadius(element, style, currentBorderRadius) {
    const rect = element.getBoundingClientRect();
    const width  = rect.width  || parseFloat(style.getPropertyValue("width"))  || 0;
    const height = rect.height || parseFloat(style.getPropertyValue("height")) || 0;
    const shortestSide = Math.min(width, height);

    // Ratio mode: wait for element to render
    if ((shortestSide === 0 || style.getPropertyValue("display") === "none") && userSettings.mode === "2") {
        ensureWatching(element);
        return null;
    }

    let newRadius = null;
    const numericCurrent = parseFloat(currentBorderRadius) || 0;

    switch(userSettings.mode) {
        case "1":
            newRadius = userSettings.roundAmount + "px";
            break;
        case "2":
            if (userSettings.ratioAmount !== null && shortestSide > 0) {
                let r = shortestSide * userSettings.ratioAmount;
                if (r < userSettings.minRounding) r = userSettings.minRounding;
                else if (userSettings.maxRounding !== 0 && r > userSettings.maxRounding) r = userSettings.maxRounding;
                newRadius = r + "px";
            }
            break;
        case "3":
            if (numericCurrent < userSettings.minRounding) newRadius = userSettings.minRounding + "px";
            else if (userSettings.maxRounding !== 0 && numericCurrent > userSettings.maxRounding) newRadius = userSettings.maxRounding + "px";
            break;
    }

    return newRadius;
}

function fixRounds(elements) {
    elements.forEach(element => {
        if (!element || element.nodeType !== 1 || shouldExclude(element)) return;

        const style = window.getComputedStyle(element);
        const currentBorderRadius = style.getPropertyValue("border-radius");

        const isCandidate = (currentBorderRadius && currentBorderRadius !== "0px") || userSettings.editAll;
        if (!isCandidate) return;

        const desired = computeNewRadius(element, style, currentBorderRadius);
        if (!desired) return;

        if (lastAppliedRadius.get(element) === desired && element.style.borderRadius === desired) return;

        applyRadius(element, desired);
        ensureWatching(element);
    });
}

// ------------------- Observers -------------------
const attrObserver = new MutationObserver(records => {
    const changed = new Set();
    for (const r of records) {
        if (r.type === "attributes" && r.target) changed.add(r.target);
        else if (r.type === "childList" && r.addedNodes.length) {
            for (const n of r.addedNodes) {
                if (n.nodeType === 1) {
                    changed.add(n);
                    const descendants = n.querySelectorAll ? n.querySelectorAll('*') : [];
                    descendants.forEach(d => changed.add(d));
                }
            }
        }
    }
    if (changed.size) queueElements(changed);
});

const resizeObserver = new ResizeObserver(entries => {
    const changed = new Set();
    for (const e of entries) if (e && e.target) changed.add(e.target);
    if (changed.size) queueElements(changed);
});

function ensureWatching(element) {
    if (watchedElements.has(element)) return;
    watchedElements.add(element);

    try {
        attrObserver.observe(element, { attributes: true, attributeFilter: ['style','class','src'] });
    } catch (_) {}
    try {
        resizeObserver.observe(element);
    } catch (_) {}

    if (element.shadowRoot && !element.shadowRoot.__cu_observed) {
        element.shadowRoot.__cu_observed = true;
        observeChildList(element.shadowRoot);
        queueElements(element.shadowRoot.querySelectorAll('*'));
    }
}

// ------------------- ChildList observer -------------------
function observeChildList(root) {
    const mo = new MutationObserver(mutations => {
        const toProcess = new Set();
        for (const m of mutations) {
            if (m.type === 'childList' && m.addedNodes.length) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === 1) {
                        toProcess.add(n);
                        const descendants = n.querySelectorAll ? n.querySelectorAll('*') : [];
                        descendants.forEach(d => toProcess.add(d));
                    }
                }
            }
        }
        if (toProcess.size) queueElements(toProcess);
    });
    mo.observe(root, { childList: true, subtree: true });
}

// ------------------- Start observing -------------------
observeChildList(document);
