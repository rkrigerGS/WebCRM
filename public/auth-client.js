// auth-client.js — runs before the app. Shows a login gate until authenticated,
// then reveals the app. Handles first-run (set a password) and normal login.

(async function () {
  const gate = document.getElementById('loginGate');
  const appRoot = document.getElementById('appRoot');
  const msg = document.getElementById('loginMsg');
  const pw = document.getElementById('loginPw');
  const btn = document.getElementById('loginBtn');

  let firstRun = false;

  function showApp() {
    gate.hidden = true;
    appRoot.hidden = false;
    // Signal the main app to start (renderer.js waits for this).
    window.__authed = true;
    document.dispatchEvent(new Event('authed'));
  }

  async function checkStatus() {
    try {
      const r = await fetch('/api/auth/status');
      const s = await r.json();
      if (s.authed) return showApp();
      firstRun = !s.passwordSet;
      gate.hidden = false;
      msg.textContent = firstRun
        ? 'First time here. Choose a password for this app.'
        : 'Enter the password to continue.';
      pw.placeholder = firstRun ? 'Choose a password' : 'Password';
      pw.focus();
    } catch {
      msg.textContent = 'Cannot reach the server.';
      msg.classList.add('error');
      gate.hidden = false;
    }
  }

  async function submit() {
    const password = pw.value;
    if (!password) return;
    msg.classList.remove('error');
    const endpoint = firstRun ? '/api/auth/setup' : '/api/auth/login';
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (r.ok) { showApp(); return; }
      const e = await r.json().catch(() => ({}));
      msg.textContent = e.error || 'Login failed.';
      msg.classList.add('error');
      pw.value = '';
      pw.focus();
    } catch {
      msg.textContent = 'Cannot reach the server.';
      msg.classList.add('error');
    }
  }

  btn.addEventListener('click', submit);
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  checkStatus();
})();
