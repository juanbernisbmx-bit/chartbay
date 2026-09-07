import { cleanText, type Profile } from './model';
import type { CategorySuggestion } from './advancedTypes';
export const PROVINCES = ['Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Ciudad Autónoma de Buenos Aires', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero', 'Tierra del Fuego', 'Tucumán'];
export function categoryKey(value: string): string { return cleanText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' '); }
export function categorySuggestions(profiles: Profile[]): CategorySuggestion[] {
  const suggestions: CategorySuggestion[] = [];
  for (const p of profiles) {
    if (p.type !== 'texto') continue;
    const groups = new Map<string, { value: string; count: number }[]>();
    for (const category of p.advanced?.topCategories ?? []) {
      let key = categoryKey(category.value);
      if (['bs as', 'buenos aires', 'pcia bs as', 'provincia de buenos aires', 'pcia de bs as'].includes(key)) key = 'buenos aires';
      const group = groups.get(key) ?? []; group.push(category); groups.set(key, group);
    }
    for (const [key, variants] of groups) {
      if (variants.length < 2) continue;
      suggestions.push({column: p.key ?? p.name, variants, canonical: key === 'buenos aires' ? 'Buenos Aires' : variants[0].value.trim(), reason: key === 'buenos aires' ? 'Abreviaturas habituales de Buenos Aires; confirmar según el contexto' : 'Diferencias de mayúsculas, acentos, puntos o espacios; confirmar equivalencia'});
      if (suggestions.length >= 100) return suggestions;
    }
  }
  return suggestions;
}
