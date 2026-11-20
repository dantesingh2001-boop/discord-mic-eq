/* ISOLATED world: relay between chrome.storage / popup and the MAIN world hook. */
(function () {
  'use strict';
  const KEY = 'meqSettings';
  let current = null;

  function push() {
    if (!current) return;
    window.postMessage({ meq: 'settings', settings: current }, '*');
  }

  chrome.storage.local.get(KEY).then(function (res) {
    if (res && res[KEY]) current = res[KEY];
    push();
  });

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.meq === 'hello') push();
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, respond) {
    if (!msg) return;
    if (msg.type === 'setSettings' && msg.settings) {
      current = msg.settings;
      chrome.storage.local.set({ [KEY]: current });
      push();
      respond && respond({ ok: true });
    } else if (msg.type === 'getSettings') {
      respond && respond({ settings: current });
    }
    return true;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[KEY]) {
      current = changes[KEY].newValue;
      push();
    }
  });
})();
