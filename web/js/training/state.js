// What the Training tab shows, decided from what the model repo and GitHub say
// (pure functions, no DOM).  Nothing here is remembered by the page: reopening it
// during a run, or while a run waits on GitHub, gives the same picture.

export const MIN_LINES = 20;
/** The driver's defaults (EPOCHS, LINES_ONLY, SAMPLE_EVERY in scripts/retrain.py). */
export const DEFAULTS = { epochs: 12, lines_only: false, sample_every: 1 };
/** From the start on GitHub to the first status.json: queue, checkout, installing. */
export const START_MINUTES = 2;

const ACTIVE = ['starting', 'running', 'publishing'];
const WHERE = { github: 'auf GitHub', colab: 'in Google Colab', local: 'auf einem Computer' };

export const where = (runner) => WHERE[runner] || WHERE.local;
export const isActive = (status) => !!status && ACTIVE.includes(status.state);
const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };
const runActive = (r) => !!r && r.status !== 'completed';
/** The GitHub run that wrote this status (its link is in runner_url). */
export function sameRun(status, run) {
  const m = status && run && /\/runs\/(\d+)/.exec(status.runner_url || '');
  return !!m && m[1] === String(run.id);
}

/** A status that says "running" but has not moved for much longer than a round takes, or whose GitHub run has ended. */
export function isStale(status, run, now) {
  if (!isActive(status)) return false;
  const age = now - ms(status.updated || status.started);
  const limitMin = status.state === 'starting' ? 30 : Math.max(20, 4 * (status.epoch_minutes || 0));
  if (age > limitMin * 60000) return true;
  return sameRun(status, run) && run.status === 'completed' && age > 60000;
}

/** The newest GitHub run started after the last status, that ended without writing one. */
function endedEarly(i) {
  const run = i.run, st = i.status;
  if (!run || run.status !== 'completed' || sameRun(st, run)) return null;
  if (i.pending && ms(run.created_at) < i.pending.at - 60000) return null;        // an older run, not the one just started
  if (st && ms(st.started) >= ms(run.created_at) - 60000) return null;
  if (i.now - ms(run.created_at) > 24 * 3600000 && !i.pending) return null;     // old news
  return run.conclusion === 'success' ? 'ghended' : 'ghfailed';
}

/**
 * The screen to show.  in: {signedIn, loaded, error, status, lines, trainedOn, run, pending, action, now}
 *   run:     the newest run of the workflow on GitHub, or null (unknown or none)
 *   pending: null | {at, manual}   a start that no run and no status shows yet
 *   action:  null | {kind: 'dispatching'}
 */
export function decide(i) {
  if (!i.signedIn) return 'signedout';
  if (i.error === 'auth') return 'auth';
  if (i.action && i.action.kind === 'dispatching') return 'dispatching';
  if (!i.loaded) return i.error ? 'offline' : 'loading';
  const st = i.status;
  if (isActive(st)) return isStale(st, i.run, i.now) ? 'interrupted' : st.state;
  const early = endedEarly(i);
  if (early) return early;
  if (runActive(i.run) && !sameRun(st, i.run)) return i.pending ? 'ghstarting' : 'ghbusy';
  if (i.pending) return i.pending.manual ? 'ghwait' : 'ghstarting';
  if ((i.lines || 0) < MIN_LINES) return 'few';
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
 * {text, sub, main, second, progress, busy, sample, curve, options, offer}: the one
 * sentence, a quieter line, at most one main action and one quiet one.
 *   main / second: {id, label, href?, external?, disabled?}
 * i also carries: hasToken, stopPending, page (the workflow on GitHub), canCancel.
 */
export function view(kind, i) {
  const st = i.status || {};
  const run = i.run;
  const lines = i.lines || 0;
  const ckpt = Number.isInteger(st.checkpoint_epoch) && st.checkpoint_epoch > 0 ? st.checkpoint_epoch : null;
  const saved = ckpt ? ` Bis Runde ${ckpt} ist alles gesichert.` : '';
  // Starting: with a token straight from here, without one on GitHub's page.
  // While a run is queued or running on GitHub there is no way to start another.
  const start = (id, label) => (runActive(run) ? null : i.hasToken ? { id, label } : { id: id === 'resume' ? 'manual-resume' : 'manual', label, href: i.page, external: true });
  const again = ckpt ? start('resume', 'Fortsetzen') : start('start', 'Nochmal versuchen');
  const fresh = ckpt ? start('start', 'Von vorn beginnen') : null;
  const onGitHub = run && run.html_url ? { id: 'run', label: 'Auf GitHub ansehen', href: run.html_url, external: true } : null;
  const est = DEFAULTS.epochs * (st.epoch_minutes || 2.5) + START_MINUTES + 3;
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
      return {
        text, sub: `Ein Training dauert ${duration(est)} und läuft kostenlos auf GitHub. Du kannst die App dabei schließen.`,
        main: start('start', 'Training starten'), options: i.hasToken, offer: !i.hasToken,
      };
    }
    case 'dispatching': return { text: 'Das Training wird gestartet …', busy: true };
    case 'ghwait': return {
      text: i.pending && i.pending.resume
        ? 'Tippe auf GitHub auf „Run workflow“, setze den Haken bei „fortsetzen“ und tippe auf den grünen Knopf „Run workflow“.'
        : 'Tippe auf GitHub auf „Run workflow“ und dann auf den grünen Knopf „Run workflow“.',
      sub: 'Danach erscheint das Training hier von selbst. Dafür musst du bei GitHub angemeldet sein.',
      main: { id: i.pending && i.pending.resume ? 'manual-resume' : 'manual', label: 'GitHub öffnen', href: i.page, external: true },
      second: { id: 'forget', label: 'Doch nicht' },
    };
    case 'ghstarting': return {
      text: `Das Training startet auf GitHub. Das dauert etwa ${START_MINUTES === 2 ? 'zwei' : START_MINUTES} Minuten.`,
      sub: !run || !runActive(run) ? 'GitHub nimmt den Start gerade an.'
        : run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' ? 'Der Lauf wartet noch auf einen freien Rechner.'
          : 'Der Rechner wird gerade eingerichtet.',
      main: i.canCancel ? { id: 'cancel', label: 'Abbrechen' } : null,
      second: onGitHub, busy: true,
    };
    case 'ghbusy': {
      const long = run && i.now - ms(run.created_at) > 20 * 60000;
      return {
        text: long ? 'Auf GitHub läuft gerade ein Training, das hier keinen Fortschritt zeigt.' : 'Auf GitHub startet gerade ein Lauf. Sobald das Training beginnt, siehst du es hier.',
        sub: long ? 'Wenn es fertig ist, kannst du hier ein neues starten.' : '',
        main: i.canCancel && !long ? { id: 'cancel', label: 'Abbrechen' } : null,
        second: onGitHub, busy: !long,
      };
    }
    case 'ghfailed': return {
      text: run && run.conclusion === 'cancelled' ? 'Der Lauf auf GitHub wurde abgebrochen, bevor das Training begonnen hat.'
        : 'Der Lauf auf GitHub ist abgebrochen, bevor das Training begonnen hat.',
      sub: 'Auf GitHub steht, woran es lag.',
      main: start('start', 'Nochmal versuchen'), second: onGitHub, options: i.hasToken,
    };
    case 'ghended': return {
      text: 'Der Lauf auf GitHub ist fertig, hat aber nicht trainiert.',
      sub: 'Vermutlich gab es zu wenig neue Zeilen. Ein Start von hier trainiert immer.',
      main: start('start', 'Training starten'), second: onGitHub, options: i.hasToken,
    };
    case 'starting': {
      const stopping = i.stopPending;
      return {
        text: stopping ? 'Das Training wird beendet.' : 'Das Training beginnt. Deine Zeilen werden geladen.',
        sub: `Läuft ${where(st.runner)}. Du kannst die App dabei schließen.`,
        main: { id: 'stop', label: stopping ? 'Wird beendet …' : 'Abbrechen', disabled: !!stopping },
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
        second: start('start', 'Neu trainieren'),
        sample: true, curve: true, options: i.hasToken,
      };
    }
    case 'failed': return {
      text: 'Das Training hat nicht geklappt.',
      sub: `${st.message || 'Der Grund ist nicht bekannt.'}${saved}`,
      main: again, second: fresh, sample: true, curve: true, options: i.hasToken,
    };
    case 'stopped': return {
      text: st.message && !/^Abgebrochen/.test(st.message) ? st.message : `Abgebrochen nach Runde ${st.epoch || 0}.`,
      sub: ckpt ? `Du kannst an dieser Stelle weitermachen.${saved}` : 'Du kannst es jederzeit neu starten.',
      main: again, second: fresh, sample: true, curve: true, options: i.hasToken,
    };
    case 'interrupted': return {
      text: 'Das Training ist stehen geblieben.',
      sub: `Der Lauf ${where(st.runner)} meldet sich nicht mehr.${saved}`,
      main: again, second: fresh, sample: true, curve: true, options: i.hasToken,
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
