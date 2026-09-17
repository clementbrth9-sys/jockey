const input = document.getElementById('password-input');
const btn = document.getElementById('btn-login');
const errorEl = document.getElementById('login-error');

async function submit() {
  errorEl.classList.add('hidden');
  const password = input.value;
  if (!password) return;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    errorEl.textContent =
      data.error === 'TROP_DE_TENTATIVES'
        ? 'Trop de tentatives, réessaie plus tard.'
        : 'Mot de passe incorrect.';
    errorEl.classList.remove('hidden');
  } catch (e) {
    errorEl.textContent = 'Erreur de connexion.';
    errorEl.classList.remove('hidden');
  }
}

btn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
