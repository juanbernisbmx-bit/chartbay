"""Bounded catalogue queries; observations are requested only for a selected series."""
from functools import lru_cache
import json
import math
import re
import time
from datetime import date
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def rpc(url: str, key: str, name: str, parameters: dict):
    if not url or not key:
        raise ValueError('Falta configurar la lectura de Supabase')
    request = Request(url.rstrip('/') + '/rest/v1/rpc/' + name,
                      data=json.dumps(parameters).encode(),
                      headers={'apikey': key, 'Content-Type': 'application/json'}, method='POST')
    # Both RPCs are read-only. Retry one transient upstream failure without
    # caching an error or changing the selected release.
    for attempt in range(2):
        try:
            with urlopen(request, timeout=5) as response:
                raw = response.read(2_000_001)
            break
        except HTTPError as error:
            if attempt or error.code not in (500, 502, 503, 504):
                raise
        except (URLError, TimeoutError):
            if attempt:
                raise
        time.sleep(0.2)
    if len(raw)>2_000_000:
        raise ValueError('La consulta excede el tamaño permitido')
    return json.loads(raw)


@lru_cache(maxsize=128)
def _page(url, key, text, topic, level, page, frequency, time_bucket):
    payload = rpc(url, key, 'buscar_series_economicas', {
        'p_texto': text, 'p_tema': topic, 'p_cobertura': level, 'p_pagina': page, 'p_frecuencia': frequency})
    if not isinstance(payload, dict) or payload.get('schema_version') != 1 or payload.get('paginated') is not True:
        raise ValueError('Catálogo paginado incompatible')
    items = payload.get('series')
    if not isinstance(items, list) or len(items)>50 or any(item.get('observations') for item in items):
        raise ValueError('El catálogo debe contener solo metadatos')
    return payload


def catalogue_page(url, key, text='', topic='', level='', page=1, frequency=''):
    if not isinstance(page, int) or page<1 or page>100000 or len(text)>200 or len(topic)>100 or len(level)>100 or frequency not in ('','Diaria','Mensual','Anual'):
        raise ValueError('Filtros o página inválidos')
    return _page(url, key, text, topic, level, page, frequency, int(time.monotonic()//300))


def selected_series(url, key, identifier):
    if not re.fullmatch(r'[a-z0-9_]{1,100}', identifier):
        raise ValueError('Identificador inválido')
    payload = rpc(url, key, 'serie_economica_publicada', {'p_id': identifier})
    if payload is None:
        return None
    if not isinstance(payload, dict) or payload.get('id')!=identifier or not payload.get('release_id') or not payload.get('license'):
        raise ValueError('La serie publicada no tiene una ficha válida')
    observations=payload.get('observations')
    if not isinstance(observations,list) or len(observations)!=payload.get('count') or len(observations)>12000:
        raise ValueError('La serie no coincide con su ficha')
    dates=[point.get('date') for point in observations if isinstance(point,dict)]
    if len(dates)!=len(observations) or any(not isinstance(d,str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])-\d{2}',d) for d in dates):
        raise ValueError('Períodos inválidos')
    frequency=payload.get('frequency')
    if frequency not in ('Diaria','Mensual','Anual'):
        raise ValueError('Frecuencia incompatible')
    for d in dates:
        parsed=date.fromisoformat(d)
        if frequency=='Mensual' and parsed.day!=1 or frequency=='Anual' and (parsed.month,parsed.day)!=(1,1):
            raise ValueError('Período incompatible con la frecuencia')
    if dates!=sorted(set(dates)) or any(isinstance(p.get('value'),bool) or not isinstance(p.get('value'),(int,float)) or not math.isfinite(p['value']) for p in observations):
        raise ValueError('Valores publicados inválidos')
    return payload
