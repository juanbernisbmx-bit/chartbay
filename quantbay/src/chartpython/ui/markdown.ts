/**
 * Markdown para las celdas de texto. Es un subconjunto deliberado —títulos,
 * listas, código, citas, tablas, énfasis y enlaces— escrito acá en vez de sumar
 * una dependencia: alcanza para las notas de un trabajo práctico y, sobre todo,
 * arma nodos con `createElement`/`textContent`, así que no hay forma de que el
 * texto de una celda termine ejecutándose como HTML.
 */
const ESQUEMAS = /^(https?:|mailto:)/i;

interface Inline { tipo: 'texto' | 'code' | 'strong' | 'em' | 'link'; valor: string; href?: string }

/** Corta una línea en pedazos: `código`, **negrita**, *cursiva* y [enlaces](url). */
export function partirInline(texto: string): Inline[] {
  const piezas: Inline[] = [];
  const patron = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]*\]\([^)\s]+\))/;
  let resto = texto;
  while (resto) {
    const encontrado = patron.exec(resto);
    if (!encontrado || encontrado.index === undefined) { piezas.push({ tipo: 'texto', valor: resto }); break; }
    if (encontrado.index > 0) piezas.push({ tipo: 'texto', valor: resto.slice(0, encontrado.index) });
    const trozo = encontrado[0];
    if (trozo.startsWith('`')) piezas.push({ tipo: 'code', valor: trozo.slice(1, -1) });
    else if (trozo.startsWith('**') || trozo.startsWith('__')) piezas.push({ tipo: 'strong', valor: trozo.slice(2, -2) });
    else if (trozo.startsWith('[')) {
      const corte = trozo.indexOf('](');
      const etiqueta = trozo.slice(1, corte);
      const href = trozo.slice(corte + 2, -1);
      if (ESQUEMAS.test(href)) piezas.push({ tipo: 'link', valor: etiqueta || href, href });
      else piezas.push({ tipo: 'texto', valor: etiqueta || href });
    } else piezas.push({ tipo: 'em', valor: trozo.slice(1, -1) });
    resto = resto.slice(encontrado.index + trozo.length);
  }
  return piezas;
}

function inline(texto: string, destino: Node, doc: Document): void {
  for (const pieza of partirInline(texto)) {
    if (pieza.tipo === 'texto') { destino.appendChild(doc.createTextNode(pieza.valor)); continue; }
    if (pieza.tipo === 'link') {
      const enlace = doc.createElement('a');
      enlace.href = pieza.href!;
      enlace.textContent = pieza.valor;
      enlace.rel = 'noopener noreferrer';
      enlace.target = '_blank';
      destino.appendChild(enlace);
      continue;
    }
    const etiqueta = pieza.tipo === 'code' ? 'code' : pieza.tipo;
    const elemento = doc.createElement(etiqueta);
    elemento.textContent = pieza.valor;
    destino.appendChild(elemento);
  }
}

function fila(linea: string): string[] {
  return linea.replace(/^\||\|$/g, '').split('|').map(celda => celda.trim());
}

const ES_SEPARADOR = (linea: string): boolean => /^\|?[\s:-]*-[\s:|-]*\|?$/.test(linea) && linea.includes('-');

export function renderMarkdown(fuente: string, doc: Document = document): DocumentFragment {
  const fragmento = doc.createDocumentFragment();
  const lineas = fuente.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const parrafo = (buffer: string[]): void => {
    if (!buffer.length) return;
    const p = doc.createElement('p');
    buffer.forEach((linea, indice) => {
      if (indice) p.appendChild(doc.createElement('br'));
      inline(linea, p, doc);
    });
    fragmento.appendChild(p);
    buffer.length = 0;
  };

  const buffer: string[] = [];
  while (i < lineas.length) {
    const linea = lineas[i];

    if (/^```/.test(linea)) {                                   // bloque de código
      parrafo(buffer);
      const codigo: string[] = [];
      i++;
      while (i < lineas.length && !/^```/.test(lineas[i])) codigo.push(lineas[i++]);
      i++;
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = codigo.join('\n');
      pre.appendChild(code);
      fragmento.appendChild(pre);
      continue;
    }

    const titulo = /^(#{1,6})\s+(.*)$/.exec(linea);
    if (titulo) {
      parrafo(buffer);
      const h = doc.createElement(`h${titulo[1].length}`);
      inline(titulo[2], h, doc);
      fragmento.appendChild(h);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(linea.trim())) {
      parrafo(buffer);
      fragmento.appendChild(doc.createElement('hr'));
      i++;
      continue;
    }

    if (/^>\s?/.test(linea)) {
      parrafo(buffer);
      const cita = doc.createElement('blockquote');
      const dentro: string[] = [];
      while (i < lineas.length && /^>\s?/.test(lineas[i])) dentro.push(lineas[i++].replace(/^>\s?/, ''));
      cita.appendChild(renderMarkdown(dentro.join('\n'), doc));
      fragmento.appendChild(cita);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(linea)) {
      parrafo(buffer);
      const ordenada = /^\s*\d+[.)]\s+/.test(linea);
      const lista = doc.createElement(ordenada ? 'ol' : 'ul');
      while (i < lineas.length && /^\s*([-*+]|\d+[.)])\s+/.test(lineas[i])) {
        const item = doc.createElement('li');
        inline(lineas[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''), item, doc);
        lista.appendChild(item);
        i++;
      }
      fragmento.appendChild(lista);
      continue;
    }

    if (linea.includes('|') && i + 1 < lineas.length && ES_SEPARADOR(lineas[i + 1])) {
      parrafo(buffer);
      const tabla = doc.createElement('table');
      tabla.className = 'cp-tabla';
      const thead = doc.createElement('thead');
      const encabezado = doc.createElement('tr');
      for (const celda of fila(linea)) {
        const th = doc.createElement('th');
        inline(celda, th, doc);
        encabezado.appendChild(th);
      }
      thead.appendChild(encabezado);
      tabla.appendChild(thead);
      const tbody = doc.createElement('tbody');
      i += 2;
      while (i < lineas.length && lineas[i].includes('|')) {
        const tr = doc.createElement('tr');
        for (const celda of fila(lineas[i])) {
          const td = doc.createElement('td');
          inline(celda, td, doc);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      tabla.appendChild(tbody);
      fragmento.appendChild(tabla);
      continue;
    }

    if (!linea.trim()) { parrafo(buffer); i++; continue; }
    buffer.push(linea);
    i++;
  }
  parrafo(buffer);
  return fragmento;
}
