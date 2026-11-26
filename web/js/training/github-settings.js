// Einstellungen > "Training direkt starten": an optional GitHub token, so that
// "Training starten" starts the workflow from the app.  Without it the button
// opens the workflow on GitHub instead, which needs no setup at all.
// The token stays on this device, goes to api.github.com only and is never shown
// again in full (only its last four characters).

export function createGitHubSettings(root, gh) {
  root.innerHTML = `
    <h2 id="g-github">Training direkt starten</h2>
    <p>Freiwillig. Mit einem GitHub-Schlüssel startet „Training starten“ den Lauf sofort. Ohne Schlüssel öffnet sich GitHub, und du tippst dort selbst auf „Run workflow“.</p>
    <div id="gh-saved" hidden>
      <div class="row">
        <p id="gh-saved-text"></p>
        <div class="row-actions"><button class="btn" id="gh-remove" type="button">Schlüssel entfernen</button></div>
      </div>
    </div>
    <div id="gh-new" hidden>
      <ol class="gh-steps">
        <li>Öffne auf GitHub die Seite für einen neuen Schlüssel („fine-grained token“). Du musst dort angemeldet sein.
          <a class="btn gh-open" id="gh-token-link" target="_blank" rel="noopener">Seite öffnen</a></li>
        <li>Gib ihm einen Namen, zum Beispiel „Handschrift“.</li>
        <li>Wähle bei „Repository access“ „Only select repositories“ und dann <strong id="gh-repo"></strong>.</li>
        <li>Stelle bei „Permissions“ unter „Actions“ „Read and write“ ein. Mehr braucht es nicht.</li>
        <li>Tippe auf „Generate token“, kopiere den Schlüssel und füge ihn hier ein.</li>
      </ol>
      <form class="gh-form" id="gh-form">
        <label class="field" for="gh-input"><span>GitHub-Schlüssel</span>
          <input id="gh-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…"></label>
        <p class="err" id="gh-err" role="alert" hidden></p>
        <div class="row-actions gh-form-actions"><button class="btn primary" id="gh-save" type="submit">Speichern</button></div>
      </form>
    </div>`;
  const $ = (id) => root.querySelector(`#${id}`);
  $('gh-token-link').href = gh.tokenPage();
  $('gh-repo').textContent = gh.repo;

  const ERR = {
    auth: 'Dieser Schlüssel funktioniert nicht. Bitte prüfe, ob er vollständig kopiert ist.',
    forbidden: 'Dieser Schlüssel darf das Repository nicht sehen. Wähle bei „Repository access“ genau dieses eine Repository.',
    notfound: 'Dieser Schlüssel darf das Repository nicht sehen. Wähle bei „Repository access“ genau dieses eine Repository.',
    rate: 'GitHub bittet um eine kurze Pause. Bitte versuch es in ein paar Minuten noch einmal.',
    network: 'Keine Verbindung zu GitHub. Bitte später noch einmal.',
    other: 'Das hat nicht geklappt. Bitte später noch einmal.',
  };

  function render() {
    const end = gh.tokenEnd();
    $('gh-saved').hidden = !end;
    $('gh-new').hidden = !!end;
    if (end) $('gh-saved-text').textContent = `Ein Schlüssel ist gespeichert (endet auf „${end}“). Er liegt nur auf diesem Gerät.`;
  }

  $('gh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const save = $('gh-save');
    if (save.disabled) return;
    const token = $('gh-input').value.trim();
    $('gh-err').hidden = true;
    if (!token) { $('gh-err').textContent = 'Bitte füge zuerst den Schlüssel ein.'; $('gh-err').hidden = false; return; }
    save.disabled = true;
    try {
      await gh.check(token);
      gh.saveToken(token);
      $('gh-input').value = '';
      render();
    } catch (err) {
      $('gh-err').textContent = ERR[err.kind] || ERR.other;
      $('gh-err').hidden = false;
    } finally { save.disabled = false; }
  });
  $('gh-remove').addEventListener('click', () => { gh.removeToken(); render(); });
  render();
  return { render };
}
