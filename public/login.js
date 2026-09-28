const input = document.getElementById('password-input');
const btn = document.getElementById('btn-login');
const errorEl = document.getElementById('login-error');

// Arrivee depuis une page admin sans les droits : on le dit clairement.
const wantsAdmin = new URLSearchParams(location.search).get('admin') === '1';
document.getElementById('login-admin-hint').classList.toggle('hidden', !wantsAdmin);

// La zone d'erreur garde sa hauteur : on vide le texte au lieu de la masquer.
function showError(message) {
  errorEl.textContent = message;
}

async function submit() {
  showError('');
  const password = input.value;
  if (!password) {
    showError('Saisis le mot de passe.');
    input.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Connexion…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const { role } = await res.json().catch(() => ({}));
      if (wantsAdmin && role !== 'admin') {
        showError("Ce mot de passe ne donne pas accès au tableau de bord.");
        btn.disabled = false;
        btn.textContent = 'Se connecter';
        return;
      }
      window.location.href = wantsAdmin ? '/admin.html' : '/';
      return;
    }
    const data = await res.json().catch(() => ({}));
    showError(
      data.error === 'TROP_DE_TENTATIVES'
        ? 'Trop de tentatives, réessaie plus tard.'
        : 'Mot de passe incorrect.'
    );
  } catch (e) {
    showError('Pas de connexion au serveur, réessaie.');
  }
  btn.disabled = false;
  btn.textContent = 'Se connecter';
  input.select();
}

btn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
});
