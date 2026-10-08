import { beforeEach, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { email: 'juanbernisbmx@gmail.com' } }, error: null }),
      signInWithPassword: vi.fn(), updateUser: vi.fn(), signOut: vi.fn(),
    },
    schema: (name: string) => { if (name !== 'revision') throw new Error('Wrong schema'); return { rpc }; },
  }),
}));
vi.mock('lucide', () => ({ createIcons: () => {}, Check: {}, LogOut: {}, RotateCw: {}, Send: {}, Trash2: {}, X: {} }));

beforeEach(() => {
  document.body.innerHTML = `
    <main class="rv-page">
      <p id="rv-message" hidden></p><section id="rv-login" hidden><form id="rv-login-form"><input id="rv-login-email"><input id="rv-login-password"></form></section>
      <section id="rv-password-setup" hidden><form id="rv-password-form"><input id="rv-new-password"><input id="rv-repeat-password"></form></section>
      <div id="rv-account" hidden><span id="rv-email"></span><button id="rv-sign-out"></button></div>
      <section id="rv-workspace" hidden><button id="rv-refresh"></button><button id="rv-tab-attention"></button><button id="rv-tab-history"></button>
      <dl id="rv-summary"></dl><div id="rv-items"></div><div id="rv-detail"></div></section>
    </main>`;
  document.body.dataset.supabaseUrl = 'https://oqbqdngieifjlgbppvey.supabase.co';
  document.body.dataset.supabaseKey = 'sb_publishable_test';
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'cola') return { data: { abiertos: [{ id: 7, fuente_id: 'INDEC_IPC', pendientes: 1 }], fallidas: [], historial: [], release: null }, error: null };
    if (name === 'candidato') return { data: { candidato: { id: 7, estado: 'abierto', corrida_id: 3 }, estado: { total: 1, aceptados: 0, pendientes: 1, rechazados: 0 }, diferencias: { nuevos: 1, cambiados: 0, faltantes: 0, total: 1, filas: [] }, archivos: [], hallazgos: [{ id: 9, regla: 'salto_mensual', detalle: 'Salto a revisar', decision: null, propuestas: [] }] }, error: null };
    return { data: null, error: null };
  });
});

it('uses authenticated review RPCs and keeps publication disabled while findings are pending', async () => {
  await import('../../src/review.entry');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.waitFor(() => expect(document.getElementById('rv-workspace')!.hidden).toBe(false));
  expect(rpc).toHaveBeenCalledWith('cola', {});
  (document.querySelector('.rv-item') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.getElementById('rv-detail')!.textContent).toContain('Salto a revisar'));
  expect(rpc).toHaveBeenCalledWith('candidato', { candidato_id: 7 });
  const publish = Array.from(document.querySelectorAll<HTMLButtonElement>('.rv-actions button')).find(button => button.textContent?.includes('Publicar versión'))!;
  expect(publish.disabled).toBe(true);
  const reject = Array.from(document.querySelectorAll<HTMLButtonElement>('.rv-actions button')).find(button => button.textContent?.includes('Rechazar'))!;
  reject.click();
  expect(rpc).not.toHaveBeenCalledWith('revisar', expect.anything());
  (document.querySelector('.rv-finding input') as HTMLInputElement).value = 'Dato inconsistente';
  reject.click();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('revisar', { hallazgo_id: 9, decision: 'rechazado', comentario: 'Dato inconsistente' }));
});
