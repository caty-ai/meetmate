/* Attendee injects #attendee-audio-error with CSSOM styling.
 * CSP pins style-src 'none', so DOM removal is the only page-side suppression channel; issue #67. */
(() => {
  "use strict";

  const ERROR_ID = "attendee-audio-error";
  let observedBody = null;

  function removeOverlay() {
    const overlay = document.getElementById(ERROR_ID);
    if (overlay) overlay.remove();
  }

  const observer = new MutationObserver(() => {
    removeOverlay();
    observeBody();
  });

  function observeBody() {
    if (!document.body || document.body === observedBody) return;
    observedBody = document.body;
    observer.observe(observedBody, { childList: true });
  }

  removeOverlay();
  observeBody();
  if (!observedBody && document.documentElement) {
    observer.observe(document.documentElement, { childList: true });
  }
})();
