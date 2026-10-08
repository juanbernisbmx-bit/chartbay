import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  listener: null as null | ((event: string, session: { user: { email: string } } | null) => void),
  resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
  updateUser: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: (listener: typeof mocks.listener) => { mocks.listener = listener; },
      signInWithPassword: vi.fn(), updateUser: mocks.updateUser, signOut: vi.fn(), resetPasswordForEmail: mocks.resetPasswordForEmail,
    },
    schema: (name: string) => { if (name !== 'revision') throw new Error('Wrong schema'); return { rpc: mocks.rpc }; },
  }),
}));
vi.mock('lucide', () => ({ createIcons: () => {}, Check: {}, LogOut: {}, RotateCw: {}, Send: {}, Trash2: {}, X: {} }));

beforeEach(() => {
  window.location.hash = '#type=invite';
  document.body.innerHTML = `
    <main class="rv-page">
      <p id="rv-message" hidden></p><section id="rv-login" hidden><form id="rv-login-form"><input id="rv-login-email"><input id="rv-login-password"></form><button id="rv-recover"></button></section>
      <section id="rv-password-setup" hidden><form id="rv-password-form"><input id="rv-new-password"><input id="rv-repeat-password"></form></section>
      <div id="rv-account" hidden><span id="rv-email"></span><button id="rv-sign-out"></button></div>
      <section id="rv-workspace" hidden><button id="rv-refresh"></button><button id="rv-tab-attention"></button><button id="rv-tab-history"></button>
      <dl id="rv-summary"></dl><div id="rv-items"></div><div id="rv-detail"></div></section>
    </main>`;
  document.body.dataset.supabaseUrl = 'https://oqbqdngieifjlgbppvey.supabase.co';
  document.body.dataset.supabaseKey = 'sb_publishable_test';
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'cola') return { data: { abiertos: [{ id: 7, fuente_id: 'INDEC_IPC', pendientes: 1 }], fallidas: [], historial: [], release: null }, error: null };
    if (name === 'candidato') return { data: { candidato: { id: 7, estado: 'abierto', corrida_id: 3 }, estado: { total: 1, aceptados: 0, pendientes: 1, rechazados: 0 }, diferencias: { nuevos: 1, cambiados: 0, faltantes: 0, total: 1, filas: [] }, archivos: [], hallazgos: [{ id: 9, regla: 'salto_mensual', detalle: 'Salto a revisar', decision: null, propuestas: [] }] }, error: null };
    return { data: null, error: null };
  });
});

it('recovers an invite session and keeps publication disabled while findings are pending', async () => {
  await import('../../src/review.entry');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.waitFor(() => expect(document.getElementById('rv-login')!.hidden).toBe(false));
  (document.getElementById('rv-login-email') as HTMLInputElement).value = 'juanbernisbmx@gmail.com';
  document.getElementById('rv-recover')!.click();
  await vi.waitFor(() => expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith('juanbernisbmx@gmail.com', { redirectTo: `${window.location.origin}${window.location.pathname}` }));
  await vi.waitFor(() => expect(document.getElementById('rv-message')!.textContent).toContain('Te enviamos'));

  mocks.listener!('SIGNED_IN', { user: { email: 'juanbernisbmx@gmail.com' } });
  await vi.waitFor(() => expect(document.getElementById('rv-password-setup')!.hidden).toBe(false));
  (document.getElementById('rv-new-password') as HTMLInputElement).value = 'una-clave-de-prueba-123';
  (document.getElementById('rv-repeat-password') as HTMLInputElement).value = 'una-clave-de-prueba-123';
  document.getElementById('rv-password-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith({ password: 'una-clave-de-prueba-123' }));
  await vi.waitFor(() => expect(document.getElementById('rv-workspace')!.hidden).toBe(false));
  expect(mocks.rpc).toHaveBeenCalledWith('cola', {});
  (document.querySelector('.rv-item') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.getElementById('rv-detail')!.textContent).toContain('Salto a revisar'));
  expect(mocks.rpc).toHaveBeenCalledWith('candidato', { candidato_id: 7 });
  const publish = Array.from(document.querySelectorAll<HTMLButtonElement>('.rv-actions button')).find(button => button.textContent?.includes('Publicar versión'))!;
  expect(publish.disabled).toBe(true);
  const reject = Array.from(document.querySelectorAll<HTMLButtonElement>('.rv-actions button')).find(button => button.textContent?.includes('Rechazar'))!;
  reject.click();
  expect(mocks.rpc).not.toHaveBeenCalledWith('revisar', expect.anything());
  (document.querySelector('.rv-finding input') as HTMLInputElement).value = 'Dato inconsistente';
  reject.click();
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('revisar', { hallazgo_id: 9, decision: 'rechazado', comentario: 'Dato inconsistente' }));
  window.location.hash = '';
});
