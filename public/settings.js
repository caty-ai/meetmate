(function () {
  "use strict";

  const form = document.getElementById("mockSettingsForm");
  const toast = document.getElementById("settingsToast");
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  let toastTimer = null;

  function showToast(message) {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function activateTab(nextTab, focus) {
    tabs.forEach((tab) => {
      const selected = tab === nextTab;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (panel) panel.hidden = !selected;
    });
    if (focus) nextTab.focus();
  }

  function initTabs() {
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab, false));
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        activateTab(tabs[nextIndex], true);
      });
    });
  }

  function closeCredentialEditor(item) {
    const editor = item.querySelector(".credential-editor");
    const changeButton = item.querySelector(".credential-change");
    const input = editor && editor.querySelector("input");
    const state = editor && editor.querySelector(".credential-edit-state");
    if (!editor || !changeButton || !input || !state) return;
    input.value = "";
    state.textContent = "現在の値は表示されません";
    editor.classList.add("is-hidden");
    changeButton.setAttribute("aria-expanded", "false");
    changeButton.textContent = "変更";
  }

  function initCredentialEditors() {
    document.querySelectorAll(".credential-item").forEach((item) => {
      const editor = item.querySelector(".credential-editor");
      const changeButton = item.querySelector(".credential-change");
      const cancelButton = item.querySelector(".credential-cancel");
      const input = editor && editor.querySelector("input");
      const state = editor && editor.querySelector(".credential-edit-state");
      if (!editor || !changeButton || !cancelButton || !input || !state) return;

      changeButton.addEventListener("click", () => {
        const willOpen = editor.classList.contains("is-hidden");
        if (!willOpen) {
          closeCredentialEditor(item);
          return;
        }
        editor.classList.remove("is-hidden");
        changeButton.setAttribute("aria-expanded", "true");
        changeButton.textContent = "閉じる";
        input.focus();
      });

      input.addEventListener("input", () => {
        state.textContent = input.value
          ? "新しい値を入力済み（内容は表示しません）"
          : "現在の値は表示されません";
      });

      cancelButton.addEventListener("click", () => {
        closeCredentialEditor(item);
        changeButton.focus();
      });
    });
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    showToast("モック: 保存は本実装で有効化");
  });
  form?.querySelectorAll("[data-mock-action]").forEach((button) => {
    button.addEventListener("click", () => showToast("モックです"));
  });

  initTabs();
  initCredentialEditors();
})();
