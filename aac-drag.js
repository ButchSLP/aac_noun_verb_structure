/*
 * aac-drag.js  --  lightweight drag & drop for the AAC activities (replaces DragDropTouch).
 *
 * WHY
 * DragDropTouch fakes HTML5 drag events: on every drag start it clones the tile and copies
 * every computed CSS property onto the clone, and on iPadOS it can run alongside Safari's
 * own native touch dragging. Both cause lag. This uses plain Pointer Events and moves a
 * simple clone with a GPU-accelerated transform instead. No external script, no network.
 *
 * USAGE
 *   AACDrag.setup({ zones: [dropZone, wordBank], onDrop: (item, zone) => { ... } });
 *   AACDrag.attach(tileElement);     // for every draggable tile
 *   AACDrag.cancel();                // abort any drag in progress (call before rebuilding tiles)
 *   AACDrag.preload([urls]);         // warm the image cache so tiles/GIFs show instantly
 *
 * onDrop runs BEFORE the tile is moved, so a drop sound starts with the least possible delay.
 */
(function () {
    'use strict';

    const THRESHOLD = 6;   // px of finger movement before a touch becomes a drag (taps stay taps)
    const FORGIVE = 14;    // px of extra drop-target margin around each zone

    // Injected CSS so the pages don't need to change their stylesheets.
    const style = document.createElement('style');
    style.textContent =
        '.symbol{touch-action:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;' +
        '-webkit-user-select:none;user-select:none;}' +
        '.aac-drag-clone{position:fixed!important;left:0;top:0;margin:0!important;z-index:9999;' +
        'pointer-events:none;will-change:transform;opacity:.96;box-shadow:0 12px 24px rgba(0,0,0,.3);cursor:grabbing;}' +
        '.aac-drag-over{outline:4px solid rgba(52,152,219,.55);outline-offset:-4px;}';
    document.head.appendChild(style);

    let cfg = { zones: [], onDrop: null };
    let drag = null;

    function setup(opts) { cfg = Object.assign({ zones: [], onDrop: null }, opts); }

    function attach(el) { el.addEventListener('pointerdown', onDown); }

    function onDown(e) {
        if (drag) return;                                   // one finger at a time
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const el = e.currentTarget;
        drag = {
            el: el, id: e.pointerId,
            sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
            started: false, clone: null, rects: null, over: null, raf: 0, ox: 0, oy: 0
        };
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onCancel);
    }

    function startDrag() {
        const d = drag;
        const r = d.el.getBoundingClientRect();
        d.ox = d.sx - r.left;
        d.oy = d.sy - r.top;
        const clone = d.el.cloneNode(true);
        clone.removeAttribute('id');
        clone.classList.add('aac-drag-clone');
        clone.style.width = r.width + 'px';
        clone.style.height = r.height + 'px';
        clone.style.transform = 'translate3d(' + r.left + 'px,' + r.top + 'px,0)';
        document.body.appendChild(clone);
        d.el.classList.add('dragging');                     // the page's CSS dims the original tile
        // Measure drop zones ONCE per drag (not on every move) to avoid layout thrash.
        d.rects = cfg.zones.map(function (z) { return { z: z, r: z.getBoundingClientRect() }; });
        d.clone = clone;
        d.started = true;
    }

    function zoneAt(rects, x, y) {
        let i, r;
        for (i = 0; i < rects.length; i++) {                 // exact hit first
            r = rects[i].r;
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return rects[i].z;
        }
        for (i = 0; i < rects.length; i++) {                 // then a forgiving margin
            r = rects[i].r;
            if (x >= r.left - FORGIVE && x <= r.right + FORGIVE && y >= r.top - FORGIVE && y <= r.bottom + FORGIVE) return rects[i].z;
        }
        return null;
    }

    function frame() {
        const d = drag;
        if (!d || !d.started) return;
        d.raf = 0;
        d.clone.style.transform =
            'translate3d(' + (d.x - d.ox) + 'px,' + (d.y - d.oy) + 'px,0) scale(1.06)';
        const z = zoneAt(d.rects, d.x, d.y);
        if (z !== d.over) {
            if (d.over) d.over.classList.remove('aac-drag-over');
            if (z) z.classList.add('aac-drag-over');
            d.over = z;
        }
    }

    function onMove(e) {
        const d = drag;
        if (!d || e.pointerId !== d.id) return;
        d.x = e.clientX; d.y = e.clientY;
        if (!d.started) {
            if (Math.hypot(d.x - d.sx, d.y - d.sy) < THRESHOLD) return;
            startDrag();
        }
        if (!d.raf) d.raf = requestAnimationFrame(frame);   // at most one update per screen refresh
    }

    function teardown(d) {
        d.el.removeEventListener('pointermove', onMove);
        d.el.removeEventListener('pointerup', onUp);
        d.el.removeEventListener('pointercancel', onCancel);
        try { d.el.releasePointerCapture(d.id); } catch (err) {}
        if (d.raf) cancelAnimationFrame(d.raf);
        if (d.clone) d.clone.remove();
        if (d.over) d.over.classList.remove('aac-drag-over');
        d.el.classList.remove('dragging');
    }

    function onUp(e) {
        const d = drag;
        if (!d || e.pointerId !== d.id) return;
        drag = null;
        const zone = d.started ? zoneAt(d.rects, e.clientX, e.clientY) : null;
        teardown(d);
        if (zone) {
            if (cfg.onDrop) { try { cfg.onDrop(d.el, zone); } catch (err) { console.error(err); } }
            zone.appendChild(d.el);
        }
    }

    function onCancel(e) {
        const d = drag;
        if (!d || (e && e.pointerId !== d.id)) return;
        drag = null;
        teardown(d);
    }

    function cancel() { if (drag) { const d = drag; drag = null; teardown(d); } }

    // ---- Image preloading ---------------------------------------------------------
    const seen = new Set();
    const keep = [];
    function preload(urls) {
        (urls || []).forEach(function (u) {
            if (!u || seen.has(u)) return;
            seen.add(u);
            const img = new Image();
            img.decoding = 'async';
            img.src = u;
            keep.push(img);   // keep a reference so the browser keeps the decoded image
        });
    }

    window.AACDrag = { setup: setup, attach: attach, cancel: cancel, preload: preload };
})();
