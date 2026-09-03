const box = document.querySelector('#certificateVerification');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const date = value => value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(value)) : '—';
const token = new URLSearchParams(location.search).get('token') || '';

async function verify() {
  if (!token || token.length > 100) return showMissing('Le lien de vérification est incomplet.');
  try {
    const response = await fetch(`/api/certificates/verify/${encodeURIComponent(token)}`, { credentials: 'omit', cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) return showMissing(result.message || 'Certificat introuvable.');
    const valid = result.status === 'issued';
    const outdated = result.status === 'outdated';
    box.innerHTML = `<div class="verification-status ${valid ? 'valid' : outdated ? 'outdated' : 'revoked'}">
      <span>${valid ? '✓' : '!'}</span>
      <div><p class="eyebrow">${valid ? 'Document authentique' : outdated ? 'Résultat mis à jour' : 'Document révoqué'}</p>
      <h1>${valid ? 'Certificat valide' : outdated ? 'Certificat à régénérer' : 'Certificat non valide'}</h1></div>
    </div>
    <div class="verification-details">
      <div><small>Titulaire</small><b>${esc(result.first_name)} ${esc(result.last_name)}</b></div>
      <div><small>Thème</small><b>${esc(result.theme_name)}</b></div>
      <div><small>Groupe</small><b>${esc(result.group_name)}</b></div>
      <div><small>Période</small><b>${date(result.start_date)} – ${date(result.end_date)}</b></div>
      <div><small>Score global</small><b>${Number(result.global_score).toFixed(1).replace('.', ',')} %</b></div>
      <div><small>Délivré par</small><b>${esc(result.issuer_name)}</b></div>
      <div><small>Date de délivrance</small><b>${date(result.issued_at)}</b></div>
      <div><small>Numéro</small><b>${esc(result.certificate_number)}</b></div>
    </div>
    ${valid ? '' : `<p class="notice">${outdated ? 'Une note a été modifiée après la délivrance. Ce certificat doit être régénéré avant d’être considéré comme valide.' : 'Ce certificat a été révoqué par son émetteur et ne doit plus être considéré comme valide.'}</p>`}`;
  } catch {
    showMissing('Le service de vérification est momentanément indisponible.');
  }
}

function showMissing(message) {
  box.innerHTML = `<div class="verification-status missing"><span>?</span><div><p class="eyebrow">Vérification impossible</p><h1>Certificat introuvable</h1></div></div><p class="notice">${esc(message)}</p>`;
}

verify();
