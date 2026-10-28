(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const input = $('secret');
  let key = null, revision = 0, displayedStep = -1, currentCode = '', nextCode = '';
  let copyReset;

  function reset() {
    key = null;
    currentCode = nextCode = '';
    displayedStep = -1;
    $('code').textContent = '••• •••';
    $('copy').disabled = true;
    $('timer').hidden = true;
    $('copy-status').textContent = 'Enter a secret key to begin';
    $('error').textContent = '';
    input.removeAttribute('aria-invalid');
    clearTimeout(copyReset);
  }

  async function update() {
    if (!key) return;
    const version = revision;
    const now = Date.now();
    const step = Math.floor(now / 30000);
    // Disable the old code immediately when a new time window starts.
    if (step !== displayedStep) {
      $('copy').disabled = true;
      const codes = await Promise.all([
        MailReaderTOTP.generateCode(key, now),
        MailReaderTOTP.generateCode(key, now + 30000),
      ]);
      if (version !== revision || step !== Math.floor(Date.now() / 30000)) return;
      [currentCode, nextCode] = codes;
      displayedStep = step;
      $('code').textContent = currentCode.slice(0, 3) + ' ' + currentCode.slice(3);
      $('next-code').textContent = nextCode;
      $('copy').disabled = false;
      $('timer').hidden = false;
      $('copy-status').textContent = 'Click to copy';
    }
    $('seconds').textContent = Math.ceil((30000 - Date.now() % 30000) / 1000);
    $('progress').value = (30000 - Date.now() % 30000) / 1000;
  }

  function showError(error) {
    reset();
    $('error').textContent = error.message;
    input.setAttribute('aria-invalid', 'true');
  }

  input.addEventListener('input', async () => {
    const version = ++revision;
    reset();
    if (!input.value.trim()) return;
    try {
      const imported = await MailReaderTOTP.importSecret(input.value);
      if (version !== revision) return;
      key = imported;
      await update();
    } catch (error) {
      if (version === revision) showError(error);
    }
  });

  $('clear').addEventListener('click', () => {
    ++revision;
    input.value = '';
    reset();
    input.focus();
  });

  $('copy').addEventListener('click', async () => {
    if (!currentCode) return;
    const version = revision;
    try {
      // Refresh before copying in case this tab was suspended at rollover.
      await update();
      if (version !== revision || displayedStep !== Math.floor(Date.now() / 30000)) return;
      await navigator.clipboard.writeText(currentCode);
      if (version !== revision) return;
      $('copy-status').textContent = 'Code copied';
      clearTimeout(copyReset);
      copyReset = setTimeout(() => { if (key) $('copy-status').textContent = 'Click to copy'; }, 2000);
    } catch (_) {
      if (version === revision) $('copy-status').textContent = 'Select the code and copy it manually';
    }
  });
  setInterval(() => update().catch(showError), 250);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) update().catch(showError);
  });
  // Avoid keeping a key in a restored back/forward-cache page.
  window.addEventListener('pagehide', () => { ++revision; input.value = ''; reset(); });
})();
