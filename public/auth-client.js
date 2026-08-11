// auth-client.js — runs before the app. Shows a login gate until authenticated,
// then reveals the app. Handles first-run (create the admin account) and normal login.
// Uses raw fetch() rather than window.api, since this script loads before api.js.

(async function () {
  const gate = document.getElementById('loginGate');
  const appRoot = document.getElementById('appRoot');
  const msg = document.getElementById('loginMsg');
  const user = document.getElementById('loginUser');
  const pw = document.getElementById('loginPw');
  const btn = document.getElementById('loginBtn');
  const pwToggle = document.getElementById('loginPwToggle');

  const inviteGate = document.getElementById('inviteGate');
  const inviteMsg = document.getElementById('inviteMsg');
  const inviteFormRow = document.getElementById('inviteFormRow');
  const invitePw = document.getElementById('invitePw');
  const inviteBtn = document.getElementById('inviteBtn');
  const invitePwToggle = document.getElementById('invitePwToggle');

  let firstRun = false;

  // A user-invitation link (?invite=TOKEN) bypasses the normal login gate entirely and
  // shows a one-time set-password form instead. Checked before the normal checkStatus()
  // flow below since it's a completely separate path with no session yet.
  async function checkInvite() {
    const token = new URLSearchParams(location.search).get('invite');
    if (!token) return false;
    inviteGate.hidden = false;
    try {
      const r = await fetch('/api/auth/invite-status?token=' + encodeURIComponent(token));
      const s = await r.json();
      if (!s.valid) {
        inviteMsg.textContent = s.reason || 'Invalid or expired invitation link.';
        inviteMsg.classList.add('error');
        inviteFormRow.hidden = true;
        inviteBtn.hidden = true;
        return true;
      }
      inviteMsg.textContent = `Welcome, ${s.username}. Choose a password (8+ characters) to finish setting up your account.`;
      invitePw.focus();
    } catch {
      inviteMsg.textContent = 'Cannot reach the server.';
      inviteMsg.classList.add('error');
      inviteFormRow.hidden = true;
      inviteBtn.hidden = true;
      return true;
    }
    async function submitInvite() {
      const password = invitePw.value;
      if (!password) return;
      inviteMsg.classList.remove('error');
      try {
        const r = await fetch('/api/auth/accept-invite', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password })
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) { inviteGate.hidden = true; history.replaceState(null, '', location.pathname); showApp(body.user); return; }
        inviteMsg.textContent = body.error || 'Could not set password.';
        inviteMsg.classList.add('error');
      } catch {
        inviteMsg.textContent = 'Cannot reach the server.';
        inviteMsg.classList.add('error');
      }
    }
    inviteBtn.addEventListener('click', submitInvite);
    invitePw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitInvite(); });
    invitePwToggle.addEventListener('click', () => {
      const showing = invitePw.type === 'text';
      invitePw.type = showing ? 'password' : 'text';
      invitePwToggle.textContent = showing ? 'Show' : 'Hide';
    });
    return true;
  }

  function showApp(currentUser) {
    window.__currentUser = currentUser || null;
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
      if (s.authed) return showApp(s.user);
      firstRun = !s.usersExist;
      gate.hidden = false;
      msg.textContent = firstRun
        ? 'First time here. Create the admin account (password: 8+ characters).'
        : 'Enter your username and password to continue.';
      user.focus();
    } catch {
      msg.textContent = 'Cannot reach the server.';
      msg.classList.add('error');
      gate.hidden = false;
    }
  }

  async function submit() {
    const username = user.value.trim();
    const password = pw.value;
    if (!username || !password) return;
    msg.classList.remove('error');
    const endpoint = firstRun ? '/api/auth/setup' : '/api/auth/login';
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { showApp(body.user); return; }
      msg.textContent = body.error || 'Login failed.';
      msg.classList.add('error');
      pw.value = '';
      pw.focus();
    } catch {
      msg.textContent = 'Cannot reach the server.';
      msg.classList.add('error');
    }
  }

  btn.addEventListener('click', submit);
  user.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  pwToggle.addEventListener('click', () => {
    const showing = pw.type === 'text';
    pw.type = showing ? 'password' : 'text';
    pwToggle.textContent = showing ? 'Show' : 'Hide';
    pwToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });

  checkInvite().then(handled => { if (!handled) checkStatus(); });
})();
