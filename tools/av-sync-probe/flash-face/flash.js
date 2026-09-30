// av-sync-probe flash face (#266 §2.8(a)). A Face Protocol v1 package whose whole viewport
// brightness follows `level`, so the recorded video luminance encodes the mouth. No audio.
(() => {
  "use strict";
  let active = null;
  const paint = (v) => {
    const gray = Math.round(Math.max(0, Math.min(1, v)) * 255);
    document.body.style.background = `rgb(${gray},${gray},${gray})`;
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || !data || typeof data !== "object") return;
    if (data.type === "host-init") parent.postMessage({ type: "face-ready", spec: "face-package/1" }, "*");
    else if (data.type === "speak-start" && Number.isSafeInteger(data.id)) { active = data.id; paint(0); }
    else if (data.type === "level" && data.id === active && Number.isFinite(data.v)) paint(data.v);
    else if (data.type === "speak-end" && data.id === active) { active = null; paint(0); }
  });
  paint(0);
  parent.postMessage({ type: "face-hello", spec: "face-package/1" }, "*");
})();
