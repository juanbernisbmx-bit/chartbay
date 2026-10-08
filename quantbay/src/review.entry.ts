import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createIcons, Check, LogOut, RotateCw, Send, Trash2, X } from 'lucide';

type Row = Record<string, unknown>;
type Panel = {
  abiertos: Row[];
  fallidas: Row[];
  historial: Row[];
  release: Row;
};
type Detail = {
  candidato: Row;
  revision: Row;
  diff: Row;
  archivos: Row[];
  hallazgos: Row[];
};

const icons = { Check, LogOut, RotateCw, Send, Trash2, X };
const $ = (id: string): HTMLElement => document.getElementById(`rv-${id}`)!;
const arr = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === 'object') : [];
const obj = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const str = (value: unknown): string => value == null ? '' : String(value);
const count = (value: unknown): number => Number(value) || 0;
const fmt = (value: unknown): string => {
  if (!value) return 'Sin fecha';
  const date = new Date(str(value));
  return Number.isNaN(date.valueOf()) ? str(value) : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value?: unknown): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = str(value);
  return element;
};
const label = (value: unknown, tone = ''): HTMLSpanElement => {
  const pill = node('span', 'rv-pill', value);
  if (tone) pill.dataset.tone = tone;
  return pill;
};
const action = (value: string, icon: string, handler: () => void, variant = ''): HTMLButtonElement => {
  const button = node('button');
  button.type = 'button';
  button.append(node('i'), document.createTextNode(value));
  button.firstElementChild!.setAttribute('data-lucide', icon);
  if (variant) button.dataset.variant = variant;
  button.addEventListener('click', handler);
  return button;
};
const section = (title: string): HTMLElement => {
  const element = node('section', 'rv-section');
  element.append(node('h3', '', title));
  return element;
};
const table = (headers: string[], rows: unknown[][]): HTMLElement => {
  const wrap = node('div', 'rv-table-wrap');
  const t = node('table', 'rv-table');
  const thead = node('thead');
  const heading = node('tr');
  headers.forEach(text => heading.append(node('th', '', text)));
  thead.append(heading);
  const tbody = node('tbody');
  rows.forEach(values => {
    const row = node('tr');
    values.forEach(value => row.append(node('td', '', value)));
    tbody.append(row);
  });
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
};
const metric = (title: string, value: unknown): HTMLDivElement => {
  const pair = node('div');
  pair.append(node('dt', '', title), node('dd', '', value));
  return pair;
};
const field = (title: string, maxLength = 500): HTMLLabelElement => {
  const outer = node('label', 'rv-field', title);
  const input = node('input');
  input.maxLength = maxLength;
  outer.append(input);
  return outer;
};
const fieldValue = (outer: HTMLElement): string => outer.querySelector('input')!.value.trim();
const refreshIcons = (): void => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });

let client: SupabaseClient | null = null;
let panel: Panel | null = null;
let selectedId: number | null = null;
let currentTab: 'attention' | 'history' = 'attention';
let busy = false;
const redirect = new URLSearchParams(window.location.hash.slice(1));
let passwordSetupRequired = redirect.get('type') === 'invite' || redirect.get('type') === 'recovery';
const redirectFailed = redirect.has('error') || new URLSearchParams(window.location.search).has('error');

function message(text = '', tone = ''): void {
  const target = $('message');
  target.textContent = text;
  target.hidden = !text;
  target.dataset.tone = tone;
}

function setBusy(value: boolean): void {
  busy = value;
  document.querySelectorAll<HTMLButtonElement>('.rv-page button').forEach(button => {
    if (value && !button.disabled) {
      button.dataset.busyDisabled = 'true';
      button.disabled = true;
    } else if (!value && button.dataset.busyDisabled) {
      button.disabled = false;
      delete button.dataset.busyDisabled;
    }
  });
}

async function rpc<T>(name: string, args: Row = {}): Promise<T> {
  if (!client) throw new Error('Supabase no está configurado');
  const { data, error } = await client.schema('revision').rpc(name, args);
  if (error) throw error;
  return data as T;
}

function errorText(error: unknown): string {
  const code = str(obj(error).code);
  if (code === '42501' || code === 'PGRST301' || code === 'PGRST302') return 'Esta cuenta no tiene permiso de revisión. Consultá al administrador.';
  if (code === 'PGRST202' || code === 'PGRST106') return 'La API de revisión todavía no está preparada en Supabase.';
  return 'No se pudo completar la operación. Volvé a intentar.';
}

function showError(error: unknown): void {
  console.error('Revisión de datos:', error);
  message(errorText(error), 'error');
}

async function loadPanel(): Promise<void> {
  if (busy) return;
  setBusy(true);
  message('Cargando cola de revisión...');
  try {
    const data = obj(await rpc<unknown>('cola'));
    if (!Array.isArray(data.abiertos) || !Array.isArray(data.fallidas) || !Array.isArray(data.historial)) {
      throw new Error('Respuesta de panel incompleta');
    }
    panel = { release: obj(data.release), abiertos: arr(data.abiertos), fallidas: arr(data.fallidas), historial: arr(data.historial) };
    $('workspace').hidden = false;
    message();
    renderPanel();
    if (selectedId !== null) await loadDetail(selectedId);
  } catch (error) {
    panel = null;
    $('workspace').hidden = true;
    showError(error);
  } finally {
    setBusy(false);
  }
}

function renderPanel(): void {
  if (!panel) return;
  const summary = $('summary');
  summary.replaceChildren(
    metric('Esperan revisión', panel.abiertos.length),
    metric('Corridas fallidas', panel.fallidas.length),
    metric('Release vigente', panel.release.release_id || 'Todavía no hay'),
    metric('Publicado', panel.release.publicado_en ? fmt(panel.release.publicado_en) : 'Sin publicación'),
  );
  $('tab-attention').setAttribute('aria-selected', String(currentTab === 'attention'));
  $('tab-history').setAttribute('aria-selected', String(currentTab === 'history'));
  const items = $('items');
  items.replaceChildren();
  const rows = currentTab === 'attention'
    ? [...panel.fallidas.map(row => ({ type: 'run', row })), ...panel.abiertos.map(row => ({ type: 'candidate', row }))]
    : panel.historial.map(row => ({ type: 'candidate', row }));
  if (!rows.length) items.append(node('p', 'rv-empty', currentTab === 'history' ? 'Todavía no hay historial.' : 'No hay candidatos ni corridas fallidas.'));
  rows.forEach(({ type, row }) => {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id)) return;
    const item = node('button', 'rv-item');
    item.type = 'button';
    item.setAttribute('aria-current', String(type === 'candidate' && id === selectedId));
    const head = node('span', 'rv-item-head');
    head.append(node('strong', '', `${type === 'run' ? 'Corrida' : 'Candidato'} ${id}`));
    const status = type === 'run' ? 'Falló' : str(row.estado || (count(row.rechazados) ? 'Con rechazos' : count(row.pendientes) ? 'Pendiente' : 'Listo'));
    head.append(label(status, type === 'run' || count(row.rechazados) ? 'error' : status === 'publicado' || status === 'Listo' ? 'ok' : 'warn'));
    item.append(head, node('span', 'rv-item-sub', `${str(row.fuente_id || '')} · ${fmt(row.creado_en || row.iniciada_en || row.decidido_en)}`));
    item.addEventListener('click', () => { if (!busy) void (type === 'run' ? loadRun(row) : loadDetail(id)); });
    items.append(item);
  });
}

function loadRun(run: Row): void {
  const detail = $('detail');
  detail.replaceChildren(node('h2', '', `Corrida ${str(run.id)}`), label('Fallida', 'error'));
  const error = node('p', 'rv-message', run.error || 'Sin detalle del error.');
  error.dataset.tone = 'error';
  detail.append(error, node('p', 'db-muted', `${str(run.fuente_id)} · ${fmt(run.iniciada_en)}`));
  selectedId = null;
  renderPanel();
}

async function loadDetail(id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) return;
  setBusy(true);
  message(`Cargando candidato ${id}...`);
  try {
    const data = obj(await rpc<unknown>('candidato', { candidato_id: id }));
    if (!data.candidato) throw new Error('Detalle de candidato incompleto');
    selectedId = id;
    renderDetail({ candidato: obj(data.candidato), revision: obj(data.estado), diff: obj(data.diferencias), archivos: arr(data.archivos), hallazgos: arr(data.hallazgos) });
    renderPanel();
    message();
  } catch (error) { showError(error); }
  finally { setBusy(false); }
}

async function mutate(name: string, args: Row, success: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await rpc(name, args);
    selectedId = name === 'descartar' ? null : selectedId;
    setBusy(false);
    await loadPanel();
    message(success);
  } catch (error) { showError(error); }
  finally { setBusy(false); }
}

function renderDetail(detail: Detail): void {
  const target = $('detail');
  const candidate = detail.candidato;
  const id = Number(candidate.id);
  const isOpen = candidate.estado === 'abierto';
  const head = node('div', 'rv-detail-head');
  const title = node('div');
  title.append(node('h2', '', `Candidato ${id}`), node('p', 'db-muted', `${str(candidate.fuente_nombre || candidate.fuente_id)} · Corrida ${str(candidate.corrida_id)} · ${fmt(candidate.creado_en)}`));
  head.append(title, label(candidate.estado || 'Abierto', isOpen ? 'warn' : candidate.estado === 'publicado' ? 'ok' : ''));
  const metrics = node('dl', 'rv-metrics');
  metrics.append(metric('Períodos nuevos', count(detail.diff.nuevos)), metric('Valores cambiados', count(detail.diff.cambiados)), metric('Faltantes', count(detail.diff.faltantes)), metric('Hallazgos resueltos', `${count(detail.revision.aceptados)} de ${count(detail.revision.total)}`));
  target.replaceChildren(head, metrics);
  if (candidate.estado === 'publicado') target.append(node('p', 'rv-message', `Publicado como ${str(candidate.release_id)} por ${str(candidate.aprobado_por)}.`));
  if (candidate.estado === 'descartado') target.append(node('p', 'rv-message', `Descartado. ${str(candidate.motivo)}`));

  const files = section('Archivos de la corrida');
  files.append(detail.archivos.length ? table(['Archivo', 'SHA-256', 'Modificado en servidor', 'Estado'], detail.archivos.map(file => [file.archivo || file.url, file.sha256, fmt(file.http_last_modified), file.estado])) : node('p', 'rv-empty', 'Sin archivos registrados.'));
  target.append(files);

  const differences = arr(detail.diff.filas);
  if (differences.length) {
    const block = section(`Diferencias respecto de lo vigente (${count(detail.diff.total)})`);
    block.append(table(['Serie', 'Período', 'Vigente', 'Candidato', 'Tipo'], differences.map(row => [row.serie_id, row.periodo, row.vigente ?? '—', row.nuevo ?? '—', row.tipo])));
    target.append(block);
  }

  const findings = section(`Hallazgos (${detail.hallazgos.length})`);
  if (!detail.hallazgos.length) findings.append(node('p', 'rv-empty', 'Este candidato no tiene hallazgos.'));
  detail.hallazgos.forEach(finding => {
    const item = node('article', 'rv-finding');
    const top = node('div', 'rv-finding-head');
    const identity = node('div');
    identity.append(node('strong', '', str(finding.serie_nombre || finding.serie_id || finding.regla || 'Hallazgo')));
    identity.append(node('p', 'db-muted', `${str(finding.regla)} · ${str(finding.periodo)} · severidad ${str(finding.severidad)}`));
    const decided = str(finding.decision);
    top.append(identity, label(decided === 'aceptado' ? 'Aceptado' : decided === 'rechazado' ? 'Rechazado' : 'Sin resolver', decided === 'aceptado' ? 'ok' : decided === 'rechazado' ? 'error' : 'warn'));
    item.append(top, node('p', '', finding.detalle));
    arr(finding.propuestas).forEach(proposal => {
      const block = node('div', 'rv-proposal');
      block.append(node('p', '', `Propuesta del agente: ${str(proposal.accion_sugerida || proposal.tipo || 'Investigar')} · confianza ${str(proposal.confianza || 'sin indicar')}`));
      if (proposal.razonamiento) block.append(node('p', '', proposal.razonamiento));
      block.append(node('p', 'db-muted', 'Es una sugerencia; la decisión es humana.'));
      item.append(block);
    });
    if (decided) item.append(node('p', 'db-muted', `Decidido por ${str(finding.revisor)}. ${str(finding.comentario)}`));
    if (isOpen && Number.isSafeInteger(Number(finding.id))) {
      const comment = field('Comentario (obligatorio para rechazar)');
      const controls = node('div', 'rv-actions');
      controls.append(
        action('Aceptar', 'check', () => void mutate('revisar', { hallazgo_id: Number(finding.id), decision: 'aceptado', comentario: fieldValue(comment) || null }, 'Hallazgo aceptado.'), 'primary'),
        action('Rechazar', 'x', () => {
          const reason = fieldValue(comment);
          if (!reason) { message('Escribí un comentario para rechazar.', 'error'); comment.querySelector('input')!.focus(); return; }
          void mutate('revisar', { hallazgo_id: Number(finding.id), decision: 'rechazado', comentario: reason }, 'Hallazgo rechazado.');
        }),
      );
      const form = node('div', 'rv-form');
      form.append(comment, controls);
      item.append(form);
    }
    findings.append(item);
  });
  target.append(findings);

  if (isOpen) {
    const final = section('Decisión sobre el candidato');
    final.classList.add('rv-final');
    const pending = count(detail.revision.pendientes);
    const rejected = count(detail.revision.rechazados);
    const proposed = count(detail.revision.propuestas_pendientes);
    const publishable = !pending && !rejected && !proposed;
    final.append(node('p', '', publishable ? 'Todos los hallazgos están resueltos. La publicación crea un release nuevo.' : `${pending} pendientes, ${rejected} rechazados y ${proposed} propuestas sin decidir. No se puede publicar todavía.`));
    const controls = node('div', 'rv-actions');
    const publish = action('Publicar versión', 'send', () => {
      if (window.confirm(`¿Publicar el candidato ${id}? Esta decisión crea un release.`)) void mutate('publicar', { candidato_id: id }, 'Versión publicada.');
    }, 'primary');
    publish.disabled = !publishable;
    controls.append(publish);
    if (pending) controls.append(action(`Aceptar ${pending} pendientes`, 'check', () => {
      if (window.confirm(`¿Aceptar los ${pending} hallazgos pendientes del candidato ${id}?`)) void mutate('aceptar_pendientes', { candidato_id: id, comentario: null, regla: null }, 'Hallazgos aceptados.');
    }));
    final.append(controls);
    const discard = node('details');
    discard.append(node('summary', '', 'Descartar candidato'));
    const reason = field('Motivo (obligatorio)');
    const danger = node('div', 'rv-actions');
    danger.append(action('Descartar', 'trash-2', () => {
      const value = fieldValue(reason);
      if (!value) { message('Escribí un motivo para descartar.', 'error'); reason.querySelector('input')!.focus(); return; }
      if (window.confirm(`¿Descartar el candidato ${id}? Los datos publicados no cambian.`)) void mutate('descartar', { candidato_id: id, motivo: value }, 'Candidato descartado.');
    }, 'danger'));
    discard.append(reason, danger);
    final.append(discard);
    target.append(final);
  }
  refreshIcons();
}

async function start(): Promise<void> {
  const body = document.body;
  const url = body.dataset.supabaseUrl || '';
  const key = body.dataset.supabaseKey || '';
  if (!url || !key) { message('Falta configurar la clave publicable de Supabase para habilitar la revisión.', 'error'); return; }
  client = createClient(url, key, { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } });
  client.auth.onAuthStateChange((event, session) => {
    if (!busy && (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') && session?.user) {
      queueMicrotask(() => showAuthenticated(session.user.email || '', passwordSetupRequired || event === 'PASSWORD_RECOVERY'));
    }
  });
  const { data, error } = await client.auth.getUser();
  if (error && error.name !== 'AuthSessionMissingError') console.error('Supabase Auth:', error);
  if (data.user) {
    showAuthenticated(data.user.email || '', passwordSetupRequired);
  } else if ($('account').hidden) {
    $('login').hidden = false;
    if (redirectFailed) message('El enlace ya se usó o venció. Pedí uno nuevo para crear tu contraseña.', 'error');
  }
}

function showAuthenticated(email: string, setupPassword: boolean): void {
  if (!$('account').hidden && !setupPassword) return;
  $('login').hidden = true;
  $('account').hidden = false;
  $('email').textContent = email;
  if (setupPassword) {
    $('workspace').hidden = true;
    $('password-setup').hidden = false;
    message();
  } else void loadPanel();
}

document.addEventListener('DOMContentLoaded', () => {
  refreshIcons();
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true);
    const email = ($('login-email') as HTMLInputElement).value.trim();
    const password = $('login-password') as HTMLInputElement;
    const result = await client.auth.signInWithPassword({ email, password: password.value });
    password.value = '';
    setBusy(false);
    if (result.error) { message('No se pudo ingresar. Revisá el correo y la contraseña, o creá una con el enlace.', 'error'); return; }
    showAuthenticated(result.data.user.email || '', false);
  });
  $('recover').addEventListener('click', async () => {
    if (!client || busy) return;
    const email = ($('login-email') as HTMLInputElement).value.trim();
    if (!email || !($('login-email') as HTMLInputElement).checkValidity()) {
      ($('login-email') as HTMLInputElement).reportValidity();
      return;
    }
    setBusy(true);
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${window.location.pathname}` });
    setBusy(false);
    message(error ? 'No se pudo enviar el enlace. Esperá unos minutos y volvé a intentar.' : 'Te enviamos un enlace para crear o restablecer tu contraseña. Usá el correo más reciente.', error ? 'error' : '');
  });
  $('password-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!client || busy) return;
    const password = $('new-password') as HTMLInputElement;
    const repeat = $('repeat-password') as HTMLInputElement;
    if (password.value !== repeat.value) { message('Las contraseñas no coinciden.', 'error'); return; }
    setBusy(true);
    const result = await client.auth.updateUser({ password: password.value });
    password.value = '';
    repeat.value = '';
    setBusy(false);
    if (result.error) { message('No se pudo guardar la contraseña. Probá con una más larga.', 'error'); return; }
    passwordSetupRequired = false;
    $('password-setup').hidden = true;
    message('Contraseña creada.');
    await loadPanel();
  });
  $('sign-out').addEventListener('click', async () => {
    if (!client) return;
    setBusy(true);
    const { error } = await client.auth.signOut({ scope: 'local' });
    setBusy(false);
    if (error) { showError(error); return; }
    panel = null; selectedId = null;
    $('workspace').hidden = true;
    $('account').hidden = true;
    $('password-setup').hidden = true;
    $('login').hidden = false;
    message();
  });
  $('refresh').addEventListener('click', () => void loadPanel());
  $('tab-attention').addEventListener('click', () => { currentTab = 'attention'; renderPanel(); });
  $('tab-history').addEventListener('click', () => { currentTab = 'history'; renderPanel(); });
  void start();
});
