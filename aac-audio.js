/*
 * aac-audio.js  --  iPad / Safari-safe sound + speech helper for the AAC activities.
 *
 * WHY THIS EXISTS
 * Safari on iPad only lets <audio>/new Audio() elements play when the call happens
 * inside a tap. The activities start the reward music AFTER the spoken sentence
 * finishes (a timer / speech callback, not a tap), and iOS also unloads unused
 * <audio> elements, so play() was silently rejected some of the time.
 *
 * This file uses the Web Audio API instead. One AudioContext is unlocked once
 * (on the START tap) and every sound is decoded into memory, so later playback
 * works at any time -- no tap required.
 *
 * USAGE
 *   const sounds = { drop: AACAudio.sound('sounds/drop.mp3'), ... };
 *   AACAudio.unlock();                 // call inside the START button handler
 *   sounds.drop.play();                // returns a Promise, never throws
 *   sounds.song.volume = 0.5;          // works live (used for fade-outs)
 *   sounds.song.pause();
 *   AACAudio.speak('The dog is running', () => { ...after speech... });
 *   AACAudio.cancelSpeech();           // also cancels any pending speak() callback
 *
 * DEBUG: add  #audiodebug  to the page URL to show a small status badge
 *        (AudioContext state + which sounds are loaded) -- handy on an iPad.
 */
(function () {
    'use strict';

    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let unlocked = false;
    const registry = [];
    let speechToken = 0;
    let keepUtterance = null; // hold a reference so iOS doesn't garbage-collect it mid-speech

    function ensureContext() {
        if (!AC) return null;
        if (!ctx) {
            try { ctx = new AC(); } catch (e) { ctx = null; }
        }
        return ctx;
    }

    // Safari can leave the context "suspended" or "interrupted" (after speech, the
    // screen locking, switching apps...). Calling resume() is cheap and safe.
    function resume() {
        if (ctx && ctx.state !== 'running') {
            try {
                const p = ctx.resume();
                if (p && p.catch) p.catch(function () {});
            } catch (e) {}
        }
    }
    function ensureRunning() {
        resume();
        if (ctx && ctx.state !== 'running') {
            setTimeout(resume, 150);
            setTimeout(resume, 600);
        }
    }

    // Every touch re-resumes the context, so it recovers on its own during a session.
    ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'].forEach(function (ev) {
        document.addEventListener(ev, resume, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });
    window.addEventListener('pageshow', resume);

    class AACSound {
        constructor(url) {
            this.url = url;
            this.buffer = null;
            this.loading = null;
            this.failed = false;
            this.source = null;
            this._volume = 1;
            this._token = 0;
            this._el = null; // HTMLAudio fallback (only used if Web Audio can't load the file)
            this.gain = null;
            registry.push(this);
        }

        // Behaves like HTMLAudioElement.volume (live changes are applied to the playing sound)
        get volume() { return this._volume; }
        set volume(v) {
            this._volume = Math.max(0, Math.min(1, v));
            if (this.gain) this.gain.gain.value = this._volume;
            if (this._el) { try { this._el.volume = this._volume; } catch (e) {} }
        }
        // play() always starts from the beginning, so these are accepted but not needed
        get currentTime() { return 0; }
        set currentTime(t) {}
        get muted() { return false; }
        set muted(m) {}

        load() {
            if (this.buffer || this.failed) return Promise.resolve();
            if (this.loading) return this.loading;
            if (!ctx) { this.failed = true; return Promise.resolve(); }
            const self = this;
            this.loading = fetch(this.url)
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.arrayBuffer();
                })
                .then(function (buf) {
                    return new Promise(function (resolve, reject) {
                        // callback form + promise form, so old and new Safari both work
                        const p = ctx.decodeAudioData(buf, resolve, reject);
                        if (p && p.catch) p.catch(reject);
                    });
                })
                .then(function (decoded) { self.buffer = decoded; })
                .catch(function (err) {
                    console.warn('[aac-audio] could not load ' + self.url + ' (using fallback):', err);
                    self.failed = true;
                });
            return this.loading;
        }

        play() {
            const token = ++this._token;
            this._stopNow();
            this._volume = 1; // every play starts at full volume (fade-outs reset cleanly)
            if (!ctx || this.failed) return this._playElement();
            ensureRunning();
            const self = this;
            const start = function () {
                if (token !== self._token) return;            // paused/replaced while loading
                if (self.failed || !self.buffer) { self._playElement(); return; }
                try {
                    const src = ctx.createBufferSource();
                    src.buffer = self.buffer;
                    const g = ctx.createGain();
                    g.gain.value = self._volume;
                    src.connect(g);
                    g.connect(ctx.destination);
                    src.onended = function () { if (self.source === src) self.source = null; };
                    self.source = src;
                    self.gain = g;
                    src.start(0);
                    ensureRunning();
                } catch (e) {
                    console.warn('[aac-audio] play failed, using fallback:', e);
                    self._playElement();
                }
            };
            if (this.buffer) { start(); return Promise.resolve(); }
            return this.load().then(start);
        }

        pause() {
            this._token++;     // cancels a play() that is still waiting for the file to load
            this._stopNow();
        }

        _stopNow() {
            if (this.source) {
                try { this.source.onended = null; this.source.stop(0); } catch (e) {}
                try { this.source.disconnect(); } catch (e) {}
                this.source = null;
            }
            if (this._el) { try { this._el.pause(); } catch (e) {} }
        }

        _playElement() {
            try {
                if (!this._el) { this._el = new Audio(this.url); this._el.preload = 'auto'; }
                this._el.volume = this._volume;
                this._el.currentTime = 0;
                const p = this._el.play();
                return (p && p.catch) ? p.catch(function () {}) : Promise.resolve();
            } catch (e) {
                return Promise.resolve();
            }
        }
    }

    // ---- Speech -----------------------------------------------------------------
    // speak(text, callback): the callback runs when speech ends. iOS doesn't always
    // fire onend, so a polling fallback guarantees the callback still runs.
    function speak(text, callback) {
        const synth = window.speechSynthesis;
        if (!synth) { if (callback) setTimeout(callback, 600); return; }

        const token = speechToken;
        let done = false;
        let timer = null;
        const finish = function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (callback && token === speechToken) callback();
        };

        const wasBusy = synth.speaking || synth.pending;
        synth.cancel();

        const u = new SpeechSynthesisUtterance(text);
        u.onend = finish;
        u.onerror = finish;
        keepUtterance = u;

        // iOS can drop an utterance that is queued in the same tick as cancel()
        if (wasBusy) setTimeout(function () { synth.speak(u); }, 60);
        else synth.speak(u);

        if (callback) {
            const started = Date.now();
            const minWait = Math.max(1800, text.length * 130);
            const maxWait = Math.max(4500, text.length * 300);
            const poll = function () {
                if (done) return;
                const elapsed = Date.now() - started;
                if (elapsed >= maxWait || (elapsed >= minWait && !synth.speaking)) finish();
                else timer = setTimeout(poll, 250);
            };
            timer = setTimeout(poll, 250);
        }
    }

    function cancelSpeech() {
        speechToken++; // drops any speak() callback that has not run yet
        try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
    }

    // ---- Unlock (call from inside the START tap) ----------------------------------
    function unlock() {
        // Safari 16.4+: treat page audio as "playback" so the iPad's silent/mute
        // switch doesn't silence Web Audio.
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

        ensureContext();
        resume();

        if (ctx && !unlocked) {
            unlocked = true;
            try { // inaudible blip inside the tap -- fully unlocks the context on iOS
                const b = ctx.createBuffer(1, 1, 22050);
                const s = ctx.createBufferSource();
                s.buffer = b;
                s.connect(ctx.destination);
                s.start(0);
            } catch (e) {}
            // Decode sounds one at a time (small ones first) to keep memory spikes low.
            // (small pause between files so decoding never hogs the CPU while a student is dragging)
            registry.reduce(function (chain, s) {
                return chain
                    .then(function () { return s.load(); })
                    .then(function () { return new Promise(function (r) { setTimeout(r, 250); }); });
            }, Promise.resolve());
        }

        // Prime speech synthesis inside the tap
        try {
            const synth = window.speechSynthesis;
            synth.cancel();
            const u = new SpeechSynthesisUtterance('');
            u.volume = 0;
            synth.speak(u);
        } catch (e) {}
    }

    window.AACAudio = {
        sound: function (url) { return new AACSound(url); },
        unlock: unlock,
        speak: speak,
        cancelSpeech: cancelSpeech,
        state: function () { return ctx ? ctx.state : 'none'; }
    };

    // ---- Optional on-screen debug badge: add #audiodebug to the URL ---------------
    if (/audiodebug/.test(location.search + location.hash)) {
        document.addEventListener('DOMContentLoaded', function () {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;background:rgba(0,0,0,.75);' +
                'color:#fff;font:12px monospace;padding:4px 8px;border-radius:6px;pointer-events:none;white-space:pre';
            document.body.appendChild(el);
            setInterval(function () {
                el.textContent = 'audio: ' + (ctx ? ctx.state : 'not started') + '\n' +
                    registry.map(function (s) {
                        return (s.buffer ? '\u2713' : s.failed ? '\u2717 (fallback)' : '\u2026') + ' ' + s.url.split('/').pop();
                    }).join('\n');
            }, 500);
        });
    }
})();
