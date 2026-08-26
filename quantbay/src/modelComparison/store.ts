import type { ModelSnapshot } from './types';

export interface ModelComparisonStoreState {
  datasetId: string;
  datasetLabel?: string;
  current: ModelSnapshot | null;
  saved: ModelSnapshot[];
}

type Listener = (state: Readonly<ModelComparisonStoreState>) => void;

let datasetSequence = 0;
let modelSequence = 0;
const listeners = new Set<Listener>();
const state: ModelComparisonStoreState = { datasetId: '', current: null, saved: [] };

function emit(): void {
  listeners.forEach(listener => listener(state));
}

function nextModelId(): string {
  modelSequence += 1;
  return `model-${modelSequence}`;
}

export function startComparisonDataset(label?: string): string {
  datasetSequence += 1;
  state.datasetId = `dataset-${datasetSequence}`;
  state.datasetLabel = label;
  state.current = null;
  emit();
  return state.datasetId;
}

export function setCurrentComparisonModel(snapshot: ModelSnapshot): ModelSnapshot {
  if (!state.datasetId) startComparisonDataset(snapshot.datasetLabel);
  state.current = {
    ...snapshot,
    id: snapshot.id || nextModelId(),
    createdAt: snapshot.createdAt || new Date().toISOString(),
    datasetId: snapshot.datasetId || state.datasetId,
    datasetLabel: snapshot.datasetLabel ?? state.datasetLabel,
  };
  emit();
  return state.current;
}

export function clearCurrentComparisonModel(): void {
  state.current = null;
  emit();
}

export function saveCurrentComparisonModel(name?: string): ModelSnapshot | null {
  if (!state.current) return null;
  const defaultName = `Modelo ${state.saved.length + 1}`;
  const saved = { ...state.current, id: nextModelId(), name: name?.trim() || defaultName };
  state.saved.push(saved);
  emit();
  return saved;
}

export function renameComparisonModel(id: string, name: string): boolean {
  const model = state.saved.find(item => item.id === id);
  if (!model || !name.trim()) return false;
  model.name = name.trim();
  emit();
  return true;
}

export function removeComparisonModel(id: string): boolean {
  const index = state.saved.findIndex(item => item.id === id);
  if (index < 0) return false;
  state.saved.splice(index, 1);
  emit();
  return true;
}

export function getComparisonStoreState(): Readonly<ModelComparisonStoreState> {
  return state;
}

export function subscribeComparisonStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Solo para pruebas: los modelos guardados viven exclusivamente en memoria. */
export function resetComparisonStore(): void {
  state.datasetId = '';
  state.datasetLabel = undefined;
  state.current = null;
  state.saved.splice(0);
  datasetSequence = 0;
  modelSequence = 0;
  emit();
}
