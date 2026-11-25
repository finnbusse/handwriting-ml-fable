// What the Training tab shows, decided from what the model repo and the trainer
// Space say (pure functions, no DOM).  Nothing here is remembered by the page:
// reopening it during a run gives the same picture.

export const MIN_LINES = 20;
/** The driver's defaults (scripts/retrain.py); the runner reports the real ones when it is awake. */
export const FALLBACK_DEFAULTS = { epochs: 30, lines_only: false, sample_every: 1 };

const ACTIVE = ['starting', 'running', 'publishing'];
const WHERE = { space: 'auf Hugging Face', github: 'auf GitHub', colab: 'in Google Colab', local: 'auf einem Computer' };

export const where = (runner) => WHERE[runner] || WHERE.local;
export const isActive = (status) => !!status && ACTIVE.includes(status.state);

/** A status that says "running" but has not moved for much longer than a round takes. */
export function isStale(status, runner, now) {
  if (!isActive(status)) return false;
  const age = now - Date.parse(status.updated || status.started || 0);
  if (!Number.isFinite(age)) return false;
  const limitMin = status.state === 'starting' ? 30 : Math.max(20, 4 * (status.epoch_minutes || 0));
  if (age > limitMin * 60000) return true;
  // The trainer Space answers, but has no job for this run (it restarted) or the job has ended.
  if (status.runner === 'space' && runner && runner.kind === 'ok' && age > 60000) {
    const job = runner.data.job;
    if (!job || job.run_id !== status.run_id) return !runner.data.running;
    if (job.exit_code !== null && job.exit_code !== undefined) return true;
  }
  return false;
}

/**
 * The screen to show.  in: {signedIn, loaded, error, status, lines, trainedOn, runner, action, pending, now}
 *   action:  null | {kind: 'waking'|'launching'|'wakefail'|'startfail'|'refused'|'nosetup'|'auth', message?}
 *   pending: null | {run_id, at}   a start that the status does not show yet
 */
export function decide(i) {
  if (!i.signedIn) return 'signedout';
  if (i.error === 'auth') return 'auth';
  const st = i.status;
  if (i.action && ['waking', 'launching'].includes(i.action.kind)) return i.action.kind;
  if (!i.loaded) return i.error ? 'offline' : 'loading';
  if (isActive(st)) {
    if (isStale(st, i.runner, i.now)) return 'interrupted';
    return st.state;
  }
  if (i.pending) {
    const job = i.runner && i.runner.kind === 'ok' && i.runner.data.job;
    if (job && job.run_id === i.pending.run_id && job.exit_code !== null && job.exit_code !== undefined && job.exit_code !== 0) return 'startfail';
    if (i.now - i.pending.at < 5 * 60000) return 'starting';
  }
  if (i.action && ['wakefail', 'startfail', 'refused', 'nosetup', 'auth'].includes(i.action.kind)) return i.action.kind;
  if ((i.lines || 0) < MIN_LINES) return 'few';
  const r = i.runner && i.runner.kind;
  if (r === 'missing') return 'nosetup';
  if (r === 'broken') return 'broken';
  if (r === 'paused') return 'paused';
  if (r === 'ok' && i.runner.data.owner && i.signedIn && String(i.runner.data.owner).toLowerCase() !== String(i.signedIn).toLowerCase()) return 'refused';
  if (st && st.state === 'failed') return 'failed';
  if (st && st.state === 'stopped') return 'stopped';
  if (st && st.state === 'done' && newLines(i) === 0) return 'done';
  return 'ready';
}

/** Lines written since the published model was trained (null: never trained). */
export function newLines(i) {
  const known = i.trainedOn && Number.isFinite(i.trainedOn.lines) ? i.trainedOn.lines : null;
  if (known === null) return null;
  return Math.max(0, (i.lines || 0) - known);
}

// ---------- words ----------

const zeilen = (n) => (n === 1 ? 'eine Zeile' : `${n} Zeilen`);

/** "etwa 40 Minuten", "etwa eine Stunde", "etwa eineinhalb Stunden" */
export function duration(min) {
  if (!Number.isFinite(min)) return null;
  if (min < 2) return 'wenige Minuten';
  if (min < 55) return `etwa ${Math.max(5, Math.round(min / 5) * 5)} Minuten`;
  if (min < 75) return 'etwa eine Stunde';
  if (min < 105) return 'etwa eineinhalb Stunden';
  if (min < 150) return 'etwa zwei Stunden';
  return `etwa ${Math.round(min / 60)} Stunden`;
}

export function timeLeft(status) {
  const m = status && status.minutes_left;
  if (!Number.isFinite(m)) return '';
  if (m < 2.5) return 'gleich fertig';
  return `noch ${duration(m)}`;
}

function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `seit ${t} Uhr` : `seit ${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })}, ${t} Uhr`;
}

export function dateText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The round being worked on: "Runde 8 von 30" while round 8 runs. */
export function round(status) {
  const epochs = status.epochs || 0;
  if (status.state === 'publishing') return `Runde ${status.epoch} von ${epochs}`;
  return `Runde ${Math.min(epochs, (status.epoch || 0) + 1)} von ${epochs}`;
}

/** Share of the run that is done, 0..1. */
export function fraction(status) {
  if (!status || !status.epochs) return 0;
  if (status.state === 'publishing') return 1;
  return Math.max(0, Math.min(1, (status.epoch || 0) / status.epochs));
}

/**
 * {text, sub, main, second, progress, note}: the one sentence, a quieter line
 * under it, at most one main action and one quiet one.
 *   main / second: {id, label, href?, disabled?}
 */
export function view(kind, i) {
  const st = i.status || {};
  const lines = i.lines || 0;
  const ckpt = Number.isInteger(st.checkpoint_epoch) && st.checkpoint_epoch > 0 ? st.checkpoint_epoch : null;
  const saved = ckpt ? ` Bis Runde ${ckpt} ist alles gesichert.` : '';
  const again = ckpt ? { id: 'resume', label: 'Fortsetzen' } : { id: 'start', label: 'Nochmal versuchen' };
  const fresh = ckpt ? { id: 'start', label: 'Von vorn beginnen' } : null;
  const est = (i.defaults && i.defaults.epochs ? i.defaults.epochs : FALLBACK_DEFAULTS.epochs) * (st.epoch_minutes || 3) + 2;
  switch (kind) {
    case 'signedout': return { text: 'Melde dich an, dann kannst du hier dein Modell trainieren.', main: { id: 'signin', label: 'Anmelden' } };
    case 'auth': return { text: 'Deine Anmeldung gilt nicht mehr. Bitte melde dich neu an.', main: { id: 'signin', label: 'Anmelden' } };
    case 'loading': return { text: 'Einen Moment …' };
    case 'offline': return { text: 'Hugging Face ist gerade nicht erreichbar. Es wird gleich noch einmal versucht.' };
    case 'few': return {
      text: `Für ein Training braucht es mindestens ${MIN_LINES} Zeilen. ${lines === 0 ? 'Bisher ist noch keine da.' : lines === 1 ? 'Bisher ist es eine.' : `Bisher sind es ${lines}.`}`,
      main: { id: 'capture', label: 'Zeilen schreiben', href: '#/erfassen' },
    };
    case 'ready': {
      const n = newLines(i);
      const text = n === null ? `${lines} Zeilen sind da. Trainiert wurde noch nie.`
        : n === 0 ? `${lines} Zeilen sind da. Alle sind schon gelernt.`
          : `${lines} Zeilen sind da, ${n === 1 ? 'eine' : n} davon neu seit dem letzten Training.`;
      return { text, sub: `Ein Training dauert ${duration(est)}. Du kannst die App dabei schließen.`, main: { id: 'start', label: 'Training starten' }, options: true };
    }
    case 'waking': return { text: 'Der Trainingsrechner wird geweckt. Das dauert etwa eine Minute.', busy: true };
    case 'launching': return { text: 'Das Training wird gestartet …', busy: true };
    case 'wakefail': return { text: 'Der Trainingsrechner wacht gerade nicht auf. Bitte versuch es in ein paar Minuten noch einmal.', main: { id: 'start', label: 'Nochmal versuchen' } };
    case 'nosetup': return {
      text: 'Der Trainingsrechner ist noch nicht eingerichtet.',
      sub: `Er heißt ${i.spaceId || 'handschrift-training'} und wird einmal auf Hugging Face angelegt.`,
      main: { id: 'recheck', label: 'Nochmal prüfen' },
    };
    case 'refused': return {
      text: 'Der Trainingsrechner gehört zu einem anderen Konto.',
      sub: i.signedIn ? `Du bist als ${i.signedIn} angemeldet. Starten kann nur, wem der Rechner gehört.` : '',
    };
    case 'broken': return { text: 'Der Trainingsrechner hat ein Problem und startet nicht.', sub: 'Auf seiner Seite bei Hugging Face steht, was los ist.', main: { id: 'page', label: 'Seite öffnen', href: i.pageUrl, external: true } };
    case 'paused': return { text: 'Der Trainingsrechner ist pausiert.', sub: 'Auf seiner Seite bei Hugging Face kannst du ihn wieder einschalten.', main: { id: 'page', label: 'Seite öffnen', href: i.pageUrl, external: true } };
    case 'starting': {
      const stopping = i.stopPending;
      return {
        text: stopping ? 'Das Training wird beendet.' : 'Das Training beginnt. Deine Zeilen werden geladen.',
        sub: `Läuft ${where(st.runner || 'space')}. Du kannst die App dabei schließen.`,
        main: { id: 'stop', label: stopping ? 'Wird beendet …' : 'Abbrechen', disabled: !!stopping || !isActive(st) },
        busy: true,
      };
    }
    case 'running': {
      const stopping = i.stopPending;
      const since = clock(st.started);
      return {
        text: stopping ? 'Das Training wird nach dieser Runde beendet.' : 'Dein Modell lernt gerade.',
        sub: `Läuft ${where(st.runner)}${since ? `, ${since}` : ''}. Es lernt aus ${zeilen(st.lines || lines)}.`,
        progress: { round: round(st), left: st.epoch ? timeLeft(st) : 'Die erste Runde läuft.', fraction: fraction(st) },
        main: { id: 'stop', label: stopping ? 'Wird beendet …' : 'Abbrechen', disabled: !!stopping },
        sample: true, curve: true,
      };
    }
    case 'publishing': return {
      text: 'Fast fertig. Das neue Modell wird geprüft und gespeichert.',
      sub: `Läuft ${where(st.runner)}.`,
      progress: { round: round(st), left: 'gleich fertig', fraction: 1 },
      sample: true, curve: true, busy: true,
    };
    case 'done': {
      const date = dateText(st.updated);
      return {
        text: 'Fertig. Dein neues Modell ist jetzt in Gebrauch.',
        sub: `Gelernt aus ${zeilen(st.lines || lines)}${date ? ` am ${date}` : ''}. Am besten war Runde ${st.best_epoch}.`,
        main: { id: 'write', label: 'Ausprobieren', href: '#/schreiben' },
        second: { id: 'start', label: 'Neu trainieren' },
        sample: true, curve: true, options: true,
      };
    }
    case 'failed': return {
      text: 'Das Training hat nicht geklappt.',
      sub: `${st.message || 'Der Grund ist nicht bekannt.'}${saved}`,
      main: again, second: fresh, sample: true, curve: true, options: true,
    };
    case 'stopped': return {
      text: st.message && !/^Abgebrochen/.test(st.message) ? st.message : `Abgebrochen nach Runde ${st.epoch || 0}.`,
      sub: ckpt ? `Du kannst an dieser Stelle weitermachen.${saved}` : 'Du kannst es jederzeit neu starten.',
      main: again, second: fresh, sample: true, curve: true, options: true,
    };
    case 'interrupted': return {
      text: 'Das Training ist stehen geblieben.',
      sub: `${st.runner === 'space' ? 'Der Trainingsrechner hat sich vermutlich neu gestartet.' : `Der Lauf ${where(st.runner)} meldet sich seit einer Weile nicht mehr.`}${saved}`,
      main: again, second: fresh, sample: true, curve: true, options: true,
    };
    case 'startfail': return {
      text: 'Das Training konnte nicht beginnen.',
      sub: (i.action && i.action.message) || (i.runnerMessage) || 'Bitte versuch es noch einmal.',
      main: { id: 'start', label: 'Nochmal versuchen' }, options: true,
    };
    default: return { text: '' };
  }
}

/** "Die Abweichung ist seit dem Start gesunken." (for screen readers; no raw numbers) */
export function curveLabel(scores) {
  const v = (scores || []).filter((s) => Number.isFinite(s));
  if (v.length < 2) return '';
  const d = v[v.length - 1] - v[0];
  const span = Math.max(...v) - Math.min(...v) || 1;
  const trend = Math.abs(d) < 0.02 * span ? 'gleich geblieben' : d < 0 ? 'gesunken' : 'gestiegen';
  return `Abweichung von deiner Schrift: seit dem Start ${trend}.`;
}
