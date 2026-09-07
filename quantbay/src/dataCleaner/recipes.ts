import { DEFAULT_RULES, type ColumnType, type Rules } from './model';
import { validateRules } from './validation';
export interface Recipe {
  schemaVersion: 1; id: string; name: string; savedAt: string;
  headers: string[]; rules: Rules; typesByColumn: Record<string, ColumnType>;
}
const STORAGE_KEY = 'chartbay-cleaner-recipes-v1';
const MAX_BYTES = 1024 * 1024;
export function createRecipe(name: string, headers: string[], rules: Rules): Recipe {
  if (!name.trim() || name.trim().length > 100) throw new Error('La receta necesita un nombre de hasta 100 caracteres.');
  validateRules(rules, headers);
  const typesByColumn = Object.fromEntries(Object.entries(rules.types).map(([i, type]) => [headers[Number(i)], type]));
  return {schemaVersion: 1, id: crypto.randomUUID(), name: name.trim(), savedAt: new Date().toISOString(), headers: [...headers], rules: structuredClone(rules), typesByColumn};
}
export function parseRecipe(text: string): Recipe {
  if (text.length * 2 > MAX_BYTES) throw new Error('La receta supera 1 MiB.');
  const value = JSON.parse(text) as Recipe;
  if (!value || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || !Array.isArray(value.headers) || value.headers.length > 4096 || value.headers.some(h => typeof h !== 'string') || new Set(value.headers).size !== value.headers.length || !value.rules || !value.typesByColumn || typeof value.typesByColumn !== 'object') throw new Error('Archivo de receta inválido o versión incompatible.');
  const r = value.rules;
  if (['normalizeHeaders','trimText','normalizeIdentifiers','dropDuplicates'].some(k => typeof r[k as keyof Rules] !== 'boolean') || !['keep','blank','drop'].includes(r.missing) || !['keep','blank'].includes(r.invalid)) throw new Error('Políticas de limpieza inválidas.');
  for (const [column, type] of Object.entries(value.typesByColumn)) {
    if (!value.headers.includes(column) || !['texto','número','fecha','identificador','CUIT/CUIL'].includes(type)) throw new Error('Tipos de columna inválidos en la receta.');
  }
  validateRules(r, value.headers);
  return value;
}
export function recipeRules(recipe: Recipe, headers: string[]): Rules {
  const validated = parseRecipe(JSON.stringify(recipe));
  const rules: Rules = {...structuredClone(DEFAULT_RULES), ...structuredClone(validated.rules), types: {}};
  for (const [name, type] of Object.entries(validated.typesByColumn)) {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`La receta requiere la columna “${name}”.`);
    rules.types[index] = type;
  }
  validateRules(rules, headers);
  return rules;
}
export function listRecipes(storage: Pick<Storage, 'getItem'> = localStorage): Recipe[] {
  const text = storage.getItem(STORAGE_KEY);
  if (!text) return [];
  if (text.length * 2 > MAX_BYTES) throw new Error('El archivo local de recetas supera 1 MiB.');
  const recipes = JSON.parse(text);
  if (!Array.isArray(recipes) || recipes.length > 50) throw new Error('Archivo local de recetas inválido.');
  return recipes.map(value => parseRecipe(JSON.stringify(value)));
}
export function saveRecipe(recipe: Recipe, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  const valid = parseRecipe(JSON.stringify(recipe));
  const previous = listRecipes(storage).filter(r => r.id !== valid.id);
  if (previous.length >= 50) throw new Error('Máximo 50 recetas; eliminá alguna antes de guardar otra.');
  const text = JSON.stringify([...previous, valid]);
  if (text.length * 2 > MAX_BYTES) throw new Error('Las recetas superan el límite local de 1 MiB.');
  storage.setItem(STORAGE_KEY, text);
}
export function deleteRecipe(id: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(listRecipes(storage).filter(r => r.id !== id)));
}
