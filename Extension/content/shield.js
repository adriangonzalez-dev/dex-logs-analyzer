// shield.js — Runs in the MAIN world (same as the page/Polymer).
// Intercepts keyboard and focus events that originate inside our overlay
// BEFORE Polymer's IronOverlayManager focus-trap can steal them.
(function () {
    // Do NOT shield 'input' — our content script relies on oninput to trigger filtering.
    // 'input' events aren't used by Polymer's focus trap anyway.
    ['keydown', 'keyup', 'keypress', 'focus', 'focusin'].forEach(function (evt) {
        document.addEventListener(evt, function (e) {
            var overlay = document.getElementById('ai-log-analyzer-overlay');
            if (overlay && overlay.contains(e.target)) {
                e.stopImmediatePropagation();
            }
        }, true);
    });
})();
