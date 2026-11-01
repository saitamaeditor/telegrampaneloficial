import { api as apiBase, esc, avisar } from './api.js';

let clave = sessionStorage.getItem('fg-admin') ?? '';
const api = (ruta, op = {}) => apiBase(ruta, { ...op, clave });
const contenido = document.getElementById('contenido');
const dialogo = document.getElementById('dialogo');

const tamHumano = (b) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};

// ---------- Sesión ----------
document.getElementById('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clave = new FormData(ev.currentTarget).get('clave');
  try {
    await api('/admin/comprobar');
    sessionStorage.setItem('fg-admin', clave);
    entrar();
  } catch (err) {
    document.getElementById('login-error').textContent = err.status === 401 ? 'Clave incorrecta' : err.message;
  }
});
document.getElementById('salir').onclick = () => {
  sessionStorage.removeItem('fg-admin');
  location.reload();
};

async function entrar() {
  document.getElementById('login').hidden = true;
  document.getElementById('panel').hidden = false;
  const e = await apiBase('/estado');
  document.getElementById('estado').innerHTML = `
    <span class="${e.e2 ? 'ok' : ''}">IDrive e2 ${e.e2 ? 'conectado' : 'sin configurar'}</span>
    <span class="${e.tmdb ? 'ok' : ''}">TMDB ${e.tmdb ? 'conectado' : 'sin configurar'}</span>`;
  abrirPestana('resumen');
}

document.getElementById('pestanas').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-pestana]');
  if (b) abrirPestana(b.dataset.pestana);
});

function abrirPestana(nombre) {
  for (const b of document.querySelectorAll('[data-pestana]')) b.classList.toggle('activo', b.dataset.pestana === nombre);
  contenido.innerHTML = '<div class="cargando"><div class="spinner"></div></div>';
  const fn = { resumen: verResumen, ajustes: verAjustes, catalogo: verCatalogo, anadir: verAnadir, almacenamiento: verAlmacenamiento, notificaciones: verNotificaciones, usuarios: verUsuarios }[nombre];
  fn().catch((err) => (contenido.innerHTML = `<div class="vacio"><h2>Error</h2><p>${esc(err.message)}</p></div>`));
}

// ---------- Subida multiparte directa a e2 ----------
function subirParte(url, trozo, alAvanzar) {
  return new Promise((ok, ko) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => alAvanzar(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) ok(etag);
      else if (!etag && xhr.status < 300) ko(new Error('e2 no devolvió el ETag: ejecuta "npm run cors" en la carpeta api'));
      else ko(new Error(`e2 respondió ${xhr.status}`));
    };
    xhr.onerror = () => ko(new Error('Error de red al subir a e2 (¿CORS del bucket configurado?)'));
    xhr.send(trozo);
  });
}

async function subirArchivo(archivo, alProgreso) {
  const { key, uploadId, tamParte, urls } = await api('/admin/subidas/iniciar', {
    metodo: 'POST',
    cuerpo: { nombre: archivo.name, tipo: archivo.type || 'video/mp4', tamano: archivo.size },
  });
  const subido = new Array(urls.length).fill(0);
  const avisarProgreso = () => alProgreso(subido.reduce((a, b) => a + b, 0) / archivo.size);
  const partes = [];
  let siguiente = 0;

  async function trabajador() {
    while (siguiente < urls.length) {
      const i = siguiente++;
      const trozo = archivo.slice(i * tamParte, (i + 1) * tamParte);
      for (let intento = 1; ; intento++) {
        try {
          const ETag = await subirParte(urls[i], trozo, (n) => { subido[i] = n; avisarProgreso(); });
          partes.push({ PartNumber: i + 1, ETag });
          break;
        } catch (err) {
          if (intento >= 3) throw err;
          await new Promise((r) => setTimeout(r, 1500 * intento));
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, trabajador));
    await api('/admin/subidas/completar', { metodo: 'POST', cuerpo: { key, uploadId, partes } });
    return key;
  } catch (err) {
    api('/admin/subidas/abortar', { metodo: 'POST', cuerpo: { key, uploadId } }).catch(() => {});
    throw err;
  }
}

// Zona de arrastrar y soltar reutilizable. Llama a alTerminar(key) cuando el vídeo está en e2.
function zonaSubida(contenedor, alTerminar) {
  contenedor.innerHTML = `
    <label class="subida">
      <input type="file" accept="video/*,.mkv" />
      <b>Arrastra un vídeo aquí o pulsa para elegirlo</b>
      <div class="texto-3">MP4 (H.264 + AAC) es el formato que mejor se reproduce en web y móvil</div>
      <div class="estado-subida texto-2" style="margin-top:10px"></div>
      <div class="barra" hidden><span></span></div>
    </label>`;
  const zona = contenedor.querySelector('.subida');
  const input = zona.querySelector('input');
  const estado = zona.querySelector('.estado-subida');
  const barra = zona.querySelector('.barra');
  let ocupado = false;

  async function procesar(archivo) {
    if (!archivo || ocupado) return;
    ocupado = true;
    barra.hidden = false;
    const inicio = Date.now();
    try {
      const key = await subirArchivo(archivo, (f) => {
        const seg = (Date.now() - inicio) / 1000;
        const vel = (f * archivo.size) / Math.max(seg, 0.5);
        barra.firstElementChild.style.width = `${(f * 100).toFixed(1)}%`;
        estado.textContent = `${archivo.name} · ${(f * 100).toFixed(0)} % de ${tamHumano(archivo.size)} · ${tamHumano(vel)}/s`;
      });
      estado.textContent = `Subido: ${archivo.name}`;
      await alTerminar(key);
    } catch (err) {
      estado.textContent = '';
      barra.hidden = true;
      avisar(err.message, true);
    } finally {
      ocupado = false;
    }
  }

  input.onchange = () => procesar(input.files[0]);
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('encima'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
  zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('encima'); procesar(e.dataTransfer.files[0]); });
}

// ---------- Catálogo ----------
// Con vídeo / sin vídeo y, si ya está cifrado con Cifrar.bat, el candado
function estadoVideos(t) {
  if (t.tipo === 'pelicula') {
    if (!t.videoKey) return '<span class="pildora no">Sin vídeo</span>';
    return `<span class="pildora ok">Con vídeo</span> ${t.hls ? '<span class="pildora cifrado" title="Cifrado con AES-128">🔒 Cifrado</span>' : '<span class="pildora no" title="Ejecuta Cifrar.bat">Sin cifrar</span>'}`;
  }
  const eps = (t.temporadas ?? []).flatMap((s) => s.episodios);
  const con = eps.filter((e) => e.videoKey).length;
  const cifrados = eps.filter((e) => e.videoKey && e.hls).length;
  const cls = con === 0 ? 'no' : con === eps.length ? 'ok' : 'medio';
  return `<span class="pildora ${cls}">${con}/${eps.length} episodios</span>${con ? ` <span class="pildora ${cifrados === con ? 'cifrado' : 'no'}">🔒 ${cifrados}/${con}</span>` : ''}`;
}

// Las seis categorías del catálogo (salen del tipo y de los géneros «Documental» y «Anime»)
const CATEGORIAS = { pelicula: 'Película', serie: 'Serie', documental: 'Documental', docuserie: 'Docuserie', 'anime-pelicula': 'Película anime', 'anime-serie': 'Serie anime', programa: 'Programa de TV', 'novela-turca': 'Novela turca' };
const CATEGORIAS_PLURAL = { pelicula: 'Películas', serie: 'Series', documental: 'Documentales', docuserie: 'Docuseries', 'anime-pelicula': 'Películas anime', 'anime-serie': 'Series anime', programa: 'Programas de TV', 'novela-turca': 'Novelas turcas' };

async function verCatalogo() {
  const lista = await api('/admin/titulos');
  contenido.innerHTML = `
    <div class="contenido-cab">
      <h1>Catálogo</h1>
      <input class="entrada" id="filtro" placeholder="Filtrar…" style="max-width:220px" />
      <select class="entrada" id="filtro-tipo" style="max-width:190px">
        <option value="">Todo (${lista.length})</option>
        ${Object.entries(CATEGORIAS_PLURAL).map(([k, n]) => `<option value="cat:${k}">${n} (${lista.filter((t) => t.categoria === k).length})</option>`).join('')}
        <option value="sin-video">Sin vídeo (${lista.filter((t) => !t.disponible).length})</option>
        <option value="destacado">★ Destacados (${lista.filter((t) => t.destacado).length})</option>
      </select>
      <button class="btn btn-primario btn-chico" id="escanear">Buscar contenido nuevo</button>
    </div>
    <p class="texto-3" id="escaneo-info" style="margin:-8px 0 14px;font-size:13px"></p>
    <div class="lote" id="lote" hidden>
      <b id="lote-total"></b>
      <button class="btn btn-secundario btn-chico" data-lote="destacar">★ Destacar</button>
      <button class="btn btn-secundario btn-chico" data-lote="quitar-destacado">☆ Quitar destacado</button>
      <button class="btn btn-peligro btn-chico" data-lote="borrar">Borrar</button>
      <button class="btn btn-secundario btn-chico" data-lote="ninguno">Desmarcar</button>
    </div>
    ${lista.length ? `
      <div class="caja tabla-scroll">
        <table class="tabla">
          <thead><tr><th class="min"><input type="checkbox" id="marcar-todos" aria-label="Marcar todos" /></th><th></th><th>Título</th><th>Categoría</th><th>Año</th><th>Vídeos</th><th class="min"></th></tr></thead>
          <tbody>
            ${lista.map((t) => `
              <tr data-id="${t.id}" data-texto="${esc(t.titulo.toLowerCase())}" data-cat="${t.categoria}" data-video="${t.disponible ? 1 : 0}" data-destacado="${t.destacado ? 1 : 0}">
                <td class="min"><input type="checkbox" class="marcar" value="${t.id}" aria-label="Marcar ${esc(t.titulo)}" /></td>
                <td class="min">${t.poster ? `<img class="mini-poster" src="${esc(t.poster)}" alt="" loading="lazy" />` : '<div class="mini-poster"></div>'}</td>
                <td><b>${esc(t.titulo)}</b>${t.destacado ? ' <span class="pildora destacada" title="Sale en grande en la portada">★ Destacado</span>' : ''}</td>
                <td>${CATEGORIAS[t.categoria] ?? (t.tipo === 'serie' ? 'Serie' : 'Película')}</td>
                <td>${esc(t.anio ?? '')}</td>
                <td>${estadoVideos(t)}</td>
                <td class="min">
                  <button class="btn btn-secundario btn-chico ${t.destacado ? 'activo-destacado' : ''}" data-accion="destacar" title="${t.destacado ? 'Quitar de destacados' : 'Sacar en grande en la portada'}">${t.destacado ? '★' : '☆'}</button>
                  <button class="btn btn-primario btn-chico" data-accion="videos">Vídeos</button>
                  <button class="btn btn-secundario btn-chico" data-accion="editar">Editar</button>
                  ${t.tmdbId ? '<button class="btn btn-secundario btn-chico" data-accion="refrescar">TMDB</button>' : ''}
                  <button class="btn btn-secundario btn-chico" data-accion="telegram" title="Volver a publicar el aviso en Telegram">Telegram</button>
                  <button class="btn btn-peligro btn-chico" data-accion="borrar">Borrar</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="vacio"><h2>Catálogo vacío</h2><p>Ve a «Añadir título» para empezar.</p></div>'}`;

  // Importador automático: los vídeos nuevos del bucket se dan de alta solos
  const info = document.getElementById('escaneo-info');
  const pintarEscaneo = (e) => {
    const cuando = e.fecha ? new Date(e.fecha).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : 'todavía no';
    const auto = e.cadaMinutos ? `Revisión automática del bucket cada ${e.cadaMinutos} min.` : 'Revisión automática apagada en este servidor.';
    const errores = e.errores.map((x) => `${x.key ?? 'Bucket'}: ${x.error}`).join(' · ');
    info.textContent = `${auto} Última: ${cuando}${e.nuevos.length ? ` · ${e.nuevos.length} añadidos` : ''}${errores ? ` · Sin importar: ${errores}` : ''}`;
  };
  api('/admin/escaneo').then(pintarEscaneo).catch(() => {});
  document.getElementById('escanear').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    ev.currentTarget.textContent = 'Buscando…';
    try {
      const e = await api('/admin/escaneo', { metodo: 'POST' });
      avisar(e.nuevos.length ? `Añadido: ${e.nuevos.map((n) => n.titulo).join(', ')}` : e.errores.length ? 'Hay vídeos que no se han podido importar' : 'No hay contenido nuevo');
      verCatalogo();
    } catch (err) {
      avisar(err.message, true);
      verCatalogo();
    }
  };

  const filtro = document.getElementById('filtro');
  const filtroTipo = document.getElementById('filtro-tipo');
  const filtrar = () => {
    const q = filtro.value.toLowerCase();
    const f = filtroTipo.value;
    for (const tr of contenido.querySelectorAll('tbody tr')) {
      const pasa = !f || (f.startsWith('cat:') ? tr.dataset.cat === f.slice(4) : f === 'sin-video' ? tr.dataset.video === '0' : tr.dataset.destacado === '1');
      tr.hidden = !pasa || !tr.dataset.texto.includes(q);
    }
  };
  filtro.oninput = filtrar;
  filtroTipo.onchange = filtrar;

  // Selección múltiple: acciones sobre varios títulos a la vez
  const lote = document.getElementById('lote');
  const marcados = () => [...contenido.querySelectorAll('.marcar:checked')].map((c) => c.value);
  const pintarLote = () => {
    const n = marcados().length;
    lote.hidden = !n;
    document.getElementById('lote-total').textContent = `${n} ${n === 1 ? 'marcado' : 'marcados'}`;
  };
  contenido.addEventListener('change', (ev) => {
    if (ev.target.id === 'marcar-todos') {
      for (const c of contenido.querySelectorAll('tbody tr:not([hidden]) .marcar')) c.checked = ev.target.checked;
    }
    if (ev.target.matches('.marcar, #marcar-todos')) pintarLote();
  });
  lote.onclick = async (ev) => {
    const b = ev.target.closest('[data-lote]');
    if (!b) return;
    const ids = marcados();
    if (b.dataset.lote === 'ninguno') {
      for (const c of contenido.querySelectorAll('.marcar, #marcar-todos')) c.checked = false;
      return pintarLote();
    }
    if (b.dataset.lote === 'borrar' && !confirm(`¿Borrar ${ids.length} títulos del catálogo? Los vídeos se quedan en el bucket.`)) return;
    try {
      await api('/admin/titulos/lote', { metodo: 'POST', cuerpo: { ids, accion: b.dataset.lote } });
      avisar({ destacar: 'Destacados', 'quitar-destacado': 'Quitados de destacados', borrar: 'Borrados' }[b.dataset.lote] + `: ${ids.length}`);
      verCatalogo();
    } catch (err) {
      avisar(err.message, true);
    }
  };

  contenido.querySelector('tbody')?.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-accion]');
    if (!b) return;
    const id = b.closest('tr').dataset.id;
    const t = lista.find((x) => x.id === id);
    if (b.dataset.accion === 'destacar') {
      try {
        await api(`/admin/titulos/${id}`, { metodo: 'PATCH', cuerpo: { destacado: !t.destacado } });
        avisar(t.destacado ? 'Quitado de destacados' : '★ Destacado: saldrá en grande en la portada');
        verCatalogo();
      } catch (err) { avisar(err.message, true); }
      return;
    }
    if (b.dataset.accion === 'videos') dialogoVideos(t);
    if (b.dataset.accion === 'editar') dialogoEditar(t);
    if (b.dataset.accion === 'refrescar') {
      b.disabled = true;
      try { await api(`/admin/titulos/${id}/refrescar`, { metodo: 'POST' }); avisar('Datos actualizados desde TMDB'); verCatalogo(); }
      catch (err) { avisar(err.message, true); b.disabled = false; }
    }
    if (b.dataset.accion === 'telegram') {
      if (!confirm(`¿Publicar de nuevo en Telegram el aviso de «${t.titulo}»?`)) return;
      b.disabled = true;
      try { await api(`/admin/telegram/avisar/${id}`, { metodo: 'POST' }); avisar('Aviso enviado a Telegram'); }
      catch (err) { avisar(err.message, true); }
      b.disabled = false;
    }
    if (b.dataset.accion === 'borrar') {
      if (!confirm(`¿Borrar «${t.titulo}» del catálogo?`)) return;
      const tambien = confirm(`¿Borrar también sus vídeos de IDrive e2 (el original y la copia cifrada)?

Aceptar = sí, se borran para siempre.
Cancelar = se conservan en el bucket, pero el importador volverá a añadir el título en unos minutos.`);
      try { await api(`/admin/titulos/${id}${tambien ? '?borrarVideos=1' : ''}`, { metodo: 'DELETE' }); avisar('Título borrado'); verCatalogo(); }
      catch (err) { avisar(err.message, true); }
    }
  });
}

function abrirDialogo(titulo, cuerpo) {
  dialogo.innerHTML = `
    <div class="dialogo-cab"><h2>${esc(titulo)}</h2><button class="btn btn-secundario btn-icono" data-cerrar aria-label="Cerrar">✕</button></div>
    <div class="dialogo-cuerpo">${cuerpo}</div>`;
  dialogo.querySelector('[data-cerrar]').onclick = () => dialogo.close();
  dialogo.showModal();
  return dialogo;
}
dialogo.addEventListener('close', () => {
  if (document.querySelector('[data-pestana="catalogo"]').classList.contains('activo')) verCatalogo();
});

async function selectorBucket(contenedor, alElegir) {
  contenedor.innerHTML = '<span class="texto-3">Cargando archivos del bucket…</span>';
  try {
    const objetos = await api('/admin/almacenamiento');
    const porCarpeta = Map.groupBy(objetos, (o) => o.key.split('/').slice(0, -1).join('/') || '(raíz del bucket)');
    contenedor.innerHTML = `
      <div class="fila-form">
        <select class="entrada">
          <option value="">— o elige un vídeo que ya esté en e2 —</option>
          ${[...porCarpeta].map(([carpeta, lista]) => `
            <optgroup label="${esc(carpeta)}">
              ${lista.map((o) => `<option value="${esc(o.key)}">${esc(o.key.split('/').pop())} · ${tamHumano(o.tamano)}${o.enlazado ? ' · (en uso)' : ''}</option>`).join('')}
            </optgroup>`).join('')}
        </select>
        <button class="btn btn-secundario">Enlazar</button>
      </div>`;
    const sel = contenedor.querySelector('select');
    contenedor.querySelector('button').onclick = () => sel.value && alElegir(sel.value);
  } catch (err) {
    contenedor.innerHTML = `<span class="texto-3">${esc(err.message)}</span>`;
  }
}

async function enlazar(t, key, temporada, episodio) {
  const r = await api(`/admin/titulos/${t.id}/video`, { metodo: 'PUT', cuerpo: { key, temporada, episodio } });
  avisar(key ? 'Vídeo enlazado' : 'Vídeo quitado');
  return r;
}

function dialogoVideos(t) {
  if (t.tipo === 'pelicula') {
    const d = abrirDialogo(`Vídeo · ${t.titulo}`, `
      <div>Estado: ${estadoVideos(t)} ${t.videoKey ? `<div class="mono texto-3" style="margin-top:6px">${esc(t.videoKey)}</div>` : ''}</div>
      <div id="zona"></div>
      <div id="bucket"></div>
      ${t.videoKey ? '<div><button class="btn btn-peligro btn-chico" id="quitar">Quitar vídeo</button></div>' : ''}`);
    const refrescar = (nuevo) => { Object.assign(t, nuevo); dialogoVideos(t); };
    zonaSubida(d.querySelector('#zona'), async (key) => refrescar(await enlazar(t, key)));
    selectorBucket(d.querySelector('#bucket'), async (key) => refrescar(await enlazar(t, key)));
    d.querySelector('#quitar')?.addEventListener('click', async () => refrescar(await enlazar(t, null)));
    return;
  }

  const temporadas = t.temporadas ?? [];
  const d = abrirDialogo(`Episodios · ${t.titulo}`, `
    <div class="fila-form">
      <label class="campo"><span>Temporada</span>
        <select id="sel-t">${temporadas.map((s) => `<option value="${s.numero}">${esc(s.nombre || `Temporada ${s.numero}`)}</option>`).join('')}</select>
      </label>
      <label class="campo" style="flex:0 1 110px"><span>Nueva temp.</span><input id="nueva-t" type="number" min="1" placeholder="Nº" /></label>
      <label class="campo" style="flex:0 1 110px"><span>Nuevo ep.</span><input id="nuevo-e" type="number" min="1" placeholder="Nº" /></label>
      <button class="btn btn-secundario" id="crear">Crear</button>
    </div>
    <div class="ep-lista" id="eps"></div>
    <div class="caja" id="destino" hidden style="margin:0">
      <h2 id="destino-titulo"></h2>
      <div id="zona"></div>
      <div id="bucket" style="margin-top:12px"></div>
    </div>`);

  const selT = d.querySelector('#sel-t');
  const destino = d.querySelector('#destino');

  function pintar() {
    const s = temporadas.find((x) => x.numero === Number(selT.value));
    d.querySelector('#eps').innerHTML = s?.episodios.length
      ? s.episodios.map((e) => `
        <div class="ep-item">
          <span class="num">T${s.numero}·E${e.numero}</span>
          <span>${esc(e.titulo)} ${e.videoKey ? '<span class="pildora ok">vídeo</span>' : ''}</span>
          <span>
            <button class="btn btn-${e.videoKey ? 'secundario' : 'primario'} btn-chico" data-e="${e.numero}">${e.videoKey ? 'Cambiar' : 'Añadir vídeo'}</button>
            ${e.videoKey ? `<button class="btn btn-peligro btn-chico" data-quitar="${e.numero}">Quitar</button>` : ''}
          </span>
        </div>`).join('')
      : '<p class="texto-3">Sin episodios en esta temporada.</p>';
  }

  function elegir(temporada, episodio) {
    destino.hidden = false;
    d.querySelector('#destino-titulo').textContent = `Vídeo para T${temporada}:E${episodio}`;
    const alTerminar = async (key) => {
      const nuevo = await enlazar(t, key, temporada, episodio);
      t.temporadas = nuevo.temporadas;
      temporadas.splice(0, temporadas.length, ...nuevo.temporadas);
      destino.hidden = true;
      pintar();
    };
    zonaSubida(d.querySelector('#zona'), alTerminar);
    selectorBucket(d.querySelector('#bucket'), alTerminar);
    destino.scrollIntoView({ behavior: 'smooth' });
  }

  d.querySelector('#eps').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const temporada = Number(selT.value);
    if (b.dataset.e) elegir(temporada, Number(b.dataset.e));
    if (b.dataset.quitar) {
      const nuevo = await enlazar(t, null, temporada, Number(b.dataset.quitar));
      temporadas.splice(0, temporadas.length, ...nuevo.temporadas);
      pintar();
    }
  });
  d.querySelector('#crear').onclick = () => {
    const nt = Number(d.querySelector('#nueva-t').value) || Number(selT.value) || 1;
    const ne = Number(d.querySelector('#nuevo-e').value);
    if (!ne) return avisar('Pon el número de episodio', true);
    elegir(nt, ne);
  };
  selT.onchange = pintar;
  pintar();
}

function dialogoEditar(t) {
  const d = abrirDialogo(`Editar · ${t.titulo}`, `
    <form id="form-editar" style="display:grid;gap:14px">
      <div class="fila-form">
        <label class="campo"><span>Título</span><input name="titulo" value="${esc(t.titulo)}" required /></label>
        <label class="campo" style="flex:0 1 120px"><span>Año</span><input name="anio" value="${esc(t.anio ?? '')}" /></label>
      </div>
      <label class="campo"><span>Sinopsis</span><textarea name="sinopsis">${esc(t.sinopsis ?? '')}</textarea></label>
      <label class="campo"><span>Géneros (separados por comas)</span><input name="generos" value="${esc((t.generos ?? []).join(', '))}" /></label>
      <label class="campo"><span>URL del cartel</span><input name="poster" value="${esc(t.poster ?? '')}" /></label>
      <label class="campo"><span>URL de la imagen de fondo</span><input name="fondo" value="${esc(t.fondo ?? '')}" /></label>
      <label class="campo"><span>Categoría (dónde sale en la web y la app)</span>
        <select name="categoria">
          ${(t.tipo === 'serie' ? ['serie', 'docuserie', 'anime-serie', 'programa', 'novela-turca'] : ['pelicula', 'documental', 'anime-pelicula'])
            .map((k) => `<option value="${k}" ${t.categoria === k ? 'selected' : ''}>${CATEGORIAS_PLURAL[k]}</option>`).join('')}
        </select>
      </label>
      <div><button class="btn btn-primario">Guardar</button></div>
    </form>`);
  d.querySelector('form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.currentTarget));
    // La categoría se guarda como género: «Documental» o «Anime» al principio, o ninguno
    const generos = f.generos.split(',').map((g) => g.trim()).filter((g) => g && !/^(documental|documentary|anime|programa de tv|novela turca)$/i.test(g));
    const extra = { documental: 'Documental', docuserie: 'Documental', 'anime-pelicula': 'Anime', 'anime-serie': 'Anime', programa: 'Programa de TV', 'novela-turca': 'Novela turca' }[f.categoria];
    f.generos = extra ? [extra, ...generos] : generos;
    delete f.categoria;
    try { await api(`/admin/titulos/${t.id}`, { metodo: 'PATCH', cuerpo: f }); avisar('Guardado'); dialogo.close(); }
    catch (err) { avisar(err.message, true); }
  };
}

// ---------- Añadir ----------
async function verAnadir() {
  contenido.innerHTML = `
    <div class="contenido-cab"><h1>Añadir título</h1></div>
    <div class="caja">
      <h2>Desde TMDB</h2>
      <form class="fila-form" id="form-tmdb">
        <input class="entrada" name="q" placeholder="Título de la película o serie" required />
        <select class="entrada" name="tipo" style="flex:0 1 160px">
          <option value="">Todo</option><option value="pelicula">Películas</option><option value="serie">Series</option>
        </select>
        <button class="btn btn-primario">Buscar</button>
      </form>
      <div class="resultados" id="resultados"></div>
    </div>
    <div class="caja">
      <h2>Manual (sin TMDB)</h2>
      <form id="form-manual" style="display:grid;gap:14px">
        <div class="fila-form">
          <label class="campo"><span>Título</span><input name="titulo" required /></label>
          <label class="campo" style="flex:0 1 160px"><span>Tipo</span><select name="tipo"><option value="pelicula">Película</option><option value="serie">Serie</option></select></label>
          <label class="campo" style="flex:0 1 110px"><span>Año</span><input name="anio" /></label>
        </div>
        <label class="campo"><span>Sinopsis</span><textarea name="sinopsis"></textarea></label>
        <div class="fila-form">
          <label class="campo"><span>URL del cartel</span><input name="poster" /></label>
          <label class="campo"><span>URL del fondo</span><input name="fondo" /></label>
        </div>
        <div><button class="btn btn-secundario">Crear título</button></div>
      </form>
    </div>`;

  document.getElementById('form-tmdb').onsubmit = async (ev) => {
    ev.preventDefault();
    const { q, tipo } = Object.fromEntries(new FormData(ev.currentTarget));
    const caja = document.getElementById('resultados');
    caja.innerHTML = '<div class="spinner"></div>';
    try {
      const r = await api(`/admin/tmdb/buscar?q=${encodeURIComponent(q)}${tipo ? `&tipo=${tipo}` : ''}`);
      caja.innerHTML = r.length ? r.map((x) => `
        <div class="resultado">
          ${x.poster ? `<img src="${esc(x.poster)}" alt="" loading="lazy" />` : '<div class="sin"></div>'}
          <div>
            <span><b>${esc(x.titulo)}</b><br /><span class="texto-3">${esc(x.anio)} · ${x.tipo === 'serie' ? 'Serie' : 'Película'}</span></span>
            <button class="btn ${x.yaAnadido ? 'btn-secundario' : 'btn-primario'} btn-chico" data-tmdb="${x.tmdbId}" data-tipo="${x.tipo}" ${x.yaAnadido ? 'disabled' : ''}>${x.yaAnadido ? 'Ya añadido' : 'Añadir'}</button>
          </div>
        </div>`).join('') : '<p class="texto-3">Sin resultados.</p>';
    } catch (err) {
      caja.innerHTML = `<p class="error-texto">${esc(err.message)}</p>`;
    }
  };

  document.getElementById('resultados').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-tmdb]');
    if (!b) return;
    b.disabled = true;
    b.textContent = b.dataset.tipo === 'serie' ? 'Importando temporadas…' : 'Añadiendo…';
    try {
      const t = await api('/admin/titulos', { metodo: 'POST', cuerpo: { tmdbId: Number(b.dataset.tmdb), tipo: b.dataset.tipo } });
      b.textContent = 'Añadido';
      avisar(`«${t.titulo}» añadido. Ahora súbele el vídeo desde Catálogo.`);
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Añadir';
      avisar(err.message, true);
    }
  });

  document.getElementById('form-manual').onsubmit = async (ev) => {
    ev.preventDefault();
    const { tipo, ...manual } = Object.fromEntries(new FormData(ev.currentTarget));
    try {
      const t = await api('/admin/titulos', { metodo: 'POST', cuerpo: { tipo, manual } });
      avisar(`«${t.titulo}» creado`);
      ev.currentTarget.reset();
    } catch (err) { avisar(err.message, true); }
  };
}

// ---------- Almacenamiento ----------
// ---------- Resumen ----------
// Gráfica de barras de las reproducciones por día (SVG, sin librerías)
function grafica(dias) {
  const max = Math.max(1, ...dias.map((d) => d.total));
  const ancho = 100 / dias.length;
  const etiqueta = (d) => new Date(`${d.dia}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `
    <div class="grafica">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Reproducciones por día">
        ${dias.map((d, i) => {
          const alto = (d.total / max) * 36;
          return `<rect x="${i * ancho + ancho * 0.15}" y="${40 - alto}" width="${ancho * 0.7}" height="${Math.max(alto, 0.4)}" rx="0.6"><title>${etiqueta(d)}: ${d.total}</title></rect>`;
        }).join('')}
      </svg>
      <div class="grafica-eje"><span>${etiqueta(dias[0])}</span><span>máx. ${max}/día</span><span>Hoy</span></div>
    </div>`;
}

async function verResumen() {
  const r = await api('/admin/resumen');
  const fecha = (f) => (f ? new Date(f).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const c = r.catalogo;
  const cifra = (num, txt, extra = '') => `<div class="cifra"><b>${num}</b><span>${txt}</span>${extra}</div>`;
  const servicio = (ok, nombre, detalle = '') => `<div class="servicio"><span class="${ok ? 'ok' : ''}"></span><b>${nombre}</b><small>${detalle}</small></div>`;
  const top = (lista, unidad) => lista.length
    ? `<ol class="top">${lista.map((x) => `<li><span>${esc(x.titulo)}</span><b>${x.total} ${unidad}</b></li>`).join('')}</ol>`
    : '<p class="texto-3">Todavía no hay datos.</p>';
  const imp = r.servicios.importador;
  contenido.innerHTML = `
    <div class="contenido-cab"><h1>Resumen</h1><span class="texto-3">Versión publicada: ${esc(r.servicios.version)}</span></div>

    <div class="cifras">
      ${cifra(c.total, 'títulos', `<small>${Object.entries(CATEGORIAS_PLURAL).map(([k, n]) => `${c.porCategoria[k] ?? 0} ${n.toLowerCase()}`).join(' · ')}</small>`)}
      ${cifra(r.almacenamiento ? r.almacenamiento.videos : '—', 'vídeos en e2', r.almacenamiento ? `<small>${tamHumano(r.almacenamiento.bytes)} ocupados</small>` : '<small>No se pudo consultar</small>')}
      ${cifra(r.usuarios.total, 'usuarios', `<small>${r.usuarios.nuevos7} nuevos esta semana · ${r.usuarios.activos24} activos hoy</small>`)}
      ${cifra(r.usuarios.dispositivos, 'dispositivos conectados', `<small>${c.destacados} títulos destacados</small>`)}
      ${cifra(r.reproducciones.total30, 'reproducciones (30 días)', `<small>${r.reproducciones.hoy} hoy</small>`)}
    </div>

    <div class="caja">
      <h2>Reproducciones de los últimos 30 días</h2>
      ${grafica(r.reproducciones.dias)}
    </div>

    <div class="rejilla-2">
      <div class="caja">
        <h2>Estado</h2>
        <div class="servicios">
          ${servicio(r.servicios.e2, 'IDrive e2', r.servicios.e2 ? 'Conectado' : 'Sin configurar')}
          ${servicio(r.servicios.tmdb, 'TMDB', r.servicios.tmdb ? 'Conectado' : 'Sin configurar')}
          ${servicio(r.servicios.telegram, 'Avisos de Telegram', r.servicios.telegram ? 'Activos' : 'Apagados o sin configurar')}
          ${servicio(imp.cadaMinutos > 0, 'Importador automático', imp.cadaMinutos ? `Cada ${imp.cadaMinutos} min · última revisión ${fecha(imp.fecha)}` : 'Apagado en este servidor')}
        </div>
        ${imp.errores?.length ? `<p class="texto-3" style="margin-top:12px">⚠ Vídeos sin importar: ${imp.errores.map((e) => esc(e.key ?? e.error)).join(', ')}</p>` : ''}
      </div>
      <div class="caja">
        <h2>Pendiente</h2>
        <p class="texto-2" style="margin-bottom:10px">${c.sinVideo.length ? `${c.sinVideo.length} títulos todavía no tienen vídeo:` : 'Todos los títulos tienen vídeo. 👌'}</p>
        ${c.sinVideo.length ? `<p>${c.sinVideo.slice(0, 12).map((t) => `<span class="pildora no">${esc(t.titulo)}</span>`).join(' ')}${c.sinVideo.length > 12 ? ` <span class="texto-3">y ${c.sinVideo.length - 12} más</span>` : ''}</p>` : ''}
        ${c.episodios ? `<p class="texto-3" style="margin-top:12px">Episodios con vídeo: ${c.episodiosConVideo} de ${c.episodios}</p>` : ''}
      </div>
      <div class="caja">
        <h2>Lo más guardado en «Mi lista»</h2>
        ${top(r.usuarios.enListas, 'listas')}
      </div>
      <div class="caja">
        <h2>Lo más reproducido</h2>
        ${top(r.reproducciones.top, 'veces')}
      </div>
      <div class="caja">
        <h2>Actividad reciente</h2>
        ${r.actividad.length ? `<ul class="actividad">${r.actividad.map((a) => `
          <li><span class="act-icono">${{ usuario: '👤', importado: '📥', titulo: '🎬', aviso: '📣', error: '⚠️' }[a.tipo] ?? '•'}</span><span>${esc(a.texto)}</span><small>${fecha(a.fecha)}</small></li>`).join('')}</ul>`
          : '<p class="texto-3">Aquí irán apareciendo las cuentas nuevas, lo importado, los cambios del catálogo…</p>'}
      </div>
    </div>

    <div class="caja">
      <h2>Últimos añadidos</h2>
      <div class="ultimos">
        ${c.ultimos.map((t) => `<div class="ultimo">${t.poster ? `<img src="${esc(t.poster)}" alt="" loading="lazy" />` : '<div></div>'}<b>${esc(t.titulo)}</b><small>${fecha(t.creado)}</small></div>`).join('') || '<p class="texto-3">El catálogo está vacío.</p>'}
      </div>
    </div>`;
}

// ---------- Ajustes: aviso en la web y copia de seguridad ----------
async function verAjustes() {
  const a = await api('/admin/aviso');
  contenido.innerHTML = `
    <div class="contenido-cab"><h1>Ajustes</h1></div>

    <div class="caja">
      <h2>Aviso en la web</h2>
      <p class="texto-2" style="margin-bottom:14px">Un mensaje que sale arriba en morvehtv.es (portada y catálogo): novedades, un estreno, una parada por mantenimiento… Cada visitante puede cerrarlo, y vuelve a salir si cambias el texto.</p>
      <form id="form-aviso" style="display:grid;gap:12px">
        <label class="campo"><span>Texto (máximo 240 caracteres)</span><textarea name="texto" maxlength="240" style="min-height:70px">${esc(a.texto ?? '')}</textarea></label>
        <div class="fila-form">
          <label class="campo"><span>Tipo</span>
            <select name="tipo">
              <option value="info" ${a.tipo === 'info' ? 'selected' : ''}>ℹ️ Información (azul)</option>
              <option value="novedad" ${a.tipo === 'novedad' ? 'selected' : ''}>🎉 Novedad (verde)</option>
              <option value="importante" ${a.tipo === 'importante' ? 'selected' : ''}>⚠️ Importante (rojo)</option>
            </select>
          </label>
          <label class="campo"><span>Enlace opcional (https://…)</span><input name="enlace" value="${esc(a.enlace ?? '')}" placeholder="https://t.me/…" /></label>
        </div>
        <label class="casilla"><input type="checkbox" name="activo" ${a.activo ? 'checked' : ''} /> Mostrar el aviso en la web</label>
        <div><button class="btn btn-primario">Guardar aviso</button></div>
      </form>
    </div>

    <div class="caja">
      <h2>Copia de seguridad</h2>
      <p class="texto-2" style="margin-bottom:14px">Descarga un archivo con todo lo que guarda MorvehTV: el catálogo, las cuentas de los usuarios (con sus contraseñas cifradas), sus listas y los ajustes. Los vídeos no van incluidos: siguen en tu bucket de e2. Guárdala en un sitio seguro y no la compartas.</p>
      <button class="btn btn-secundario" id="descargar-copia">Descargar copia (.json)</button>
    </div>`;

  document.getElementById('form-aviso').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    try {
      const r = await api('/admin/aviso', { metodo: 'PUT', cuerpo: { texto: f.texto.value, tipo: f.tipo.value, enlace: f.enlace.value.trim(), activo: f.activo.checked } });
      avisar(r.activo ? 'Aviso publicado en la web' : 'Aviso guardado (no se muestra)');
    } catch (err) {
      avisar(err.message, true);
    }
  };
  document.getElementById('descargar-copia').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const r = await fetch(`${window.FOTOGRAMA_API ?? ''}/api/admin/copia`, { headers: { 'x-api-key': clave } });
      if (!r.ok) throw new Error(`Error ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `morvehtv-copia-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      avisar(err.message, true);
    }
    ev.currentTarget.disabled = false;
  };
}

// ---------- Usuarios registrados ----------
// Ficha de un usuario: dispositivos, su lista y lo que está viendo
async function fichaUsuario(id) {
  let u;
  try { u = await api(`/admin/usuarios/${id}`); } catch (err) { return avisar(err.message, true); }
  const fecha = (f) => (f ? new Date(f).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  abrirDialogo(u.nombre, `
    <p class="texto-2">${esc(u.email)} · alta ${fecha(u.creado)} · última vez ${fecha(u.ultimo)}${u.suspendido ? ' · <span class="pildora medio">Suspendida</span>' : ''}</p>
    <h3 class="ficha-titulo">Dispositivos (${u.sesiones.length})</h3>
    ${u.sesiones.length ? `<ul class="ficha-lista">${u.sesiones.map((s) => `<li><span>${esc(s.dispositivo)}</span><small>activo ${fecha(s.ultimo)}</small></li>`).join('')}</ul>` : '<p class="texto-3">Ninguno con la sesión abierta.</p>'}
    <h3 class="ficha-titulo">En su lista (${u.lista.length})</h3>
    ${u.lista.length ? `<p>${u.lista.map((t) => `<span class="pildora no">${esc(t.titulo)}</span>`).join(' ')}</p>` : '<p class="texto-3">Su lista está vacía.</p>'}
    <h3 class="ficha-titulo">Viendo (${u.viendo.length})</h3>
    ${u.viendo.length ? `<ul class="ficha-lista">${u.viendo.map((v) => `<li><span>${esc(v.titulo)}</span><small>${v.porcentaje != null ? `${v.porcentaje}% · ` : ''}${fecha(v.fecha)}</small></li>`).join('')}</ul>` : '<p class="texto-3">Todavía no ha visto nada.</p>'}`);
}

async function verUsuarios() {
  const lista = await api('/admin/usuarios');
  const fecha = (f) => (f ? new Date(f).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  contenido.innerHTML = `
    <div class="contenido-cab">
      <h1>Usuarios</h1>
      <span class="texto-2">${lista.length} ${lista.length === 1 ? 'cuenta' : 'cuentas'}</span>
      <input class="entrada" id="buscar-usuario" placeholder="Buscar por nombre o correo…" style="max-width:280px" />
    </div>
    <p class="texto-2" style="margin:-8px 0 20px">Cualquiera puede crear una cuenta en la web o en la app. Cada cuenta guarda en privado su lista y lo que está viendo. Las contraseñas se guardan cifradas y no se pueden ver: si alguien la olvida, pulsa «Nueva contraseña» y pásale la provisional.</p>
    ${lista.length ? `
      <div class="caja tabla-scroll">
        <table class="tabla">
          <thead><tr><th>Nombre</th><th>Correo</th><th>Dispositivos</th><th>En su lista</th><th>Vistos</th><th>Alta</th><th>Última vez</th><th class="min"></th></tr></thead>
          <tbody>
            ${lista.sort((a, b) => (b.ultimo ?? b.creado).localeCompare(a.ultimo ?? a.creado)).map((u) => `
              <tr data-texto="${esc(`${u.nombre} ${u.email}`.toLowerCase())}">
                <td><b>${esc(u.nombre)}</b>${u.suspendido ? ' <span class="pildora medio">Suspendida</span>' : ''}</td>
                <td>${esc(u.email)}</td>
                <td class="min">${u.dispositivos ?? 0}</td>
                <td class="min">${u.enLista}</td>
                <td class="min">${u.vistos}</td>
                <td class="min texto-3">${fecha(u.creado)}</td>
                <td class="min texto-3">${fecha(u.ultimo)}</td>
                <td class="min">
                  <button class="btn btn-primario btn-chico" data-ver="${esc(u.id)}">Ver</button>
                  <button class="btn btn-secundario btn-chico" data-restablecer="${esc(u.id)}" data-email="${esc(u.email)}">Nueva contraseña</button>
                  <button class="btn btn-secundario btn-chico" data-suspender="${esc(u.id)}" data-email="${esc(u.email)}" data-estado="${u.suspendido ? 1 : 0}">${u.suspendido ? 'Reactivar' : 'Suspender'}</button>
                  <button class="btn btn-peligro btn-chico" data-borrar="${esc(u.id)}" data-email="${esc(u.email)}">Borrar</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="vacio"><h2>Todavía no hay usuarios</h2><p>Las cuentas aparecerán aquí en cuanto alguien se registre.</p></div>'}`;

  const buscar = document.getElementById('buscar-usuario');
  buscar.oninput = () => {
    const q = buscar.value.toLowerCase().trim();
    for (const tr of contenido.querySelectorAll('tbody tr')) tr.hidden = !tr.dataset.texto.includes(q);
  };

  contenido.querySelector('tbody')?.addEventListener('click', async (ev) => {
    const ver = ev.target.closest('[data-ver]');
    if (ver) return fichaUsuario(ver.dataset.ver);
    const sus = ev.target.closest('[data-suspender]');
    if (sus) {
      const suspender = sus.dataset.estado !== '1';
      if (suspender && !confirm(`¿Suspender la cuenta ${sus.dataset.email}? No podrá entrar y se cerrarán todas sus sesiones.`)) return;
      try {
        await api(`/admin/usuarios/${sus.dataset.suspender}`, { metodo: 'PATCH', cuerpo: { suspendido: suspender } });
        avisar(suspender ? 'Cuenta suspendida' : 'Cuenta reactivada');
        verUsuarios();
      } catch (err) { avisar(err.message, true); }
      return;
    }
    // Para quien ha olvidado su contraseña: se le pone una provisional para que entre y la cambie
    const r = ev.target.closest('[data-restablecer]');
    if (r) {
      if (!confirm(`¿Dar una contraseña nueva a ${r.dataset.email}? La actual dejará de funcionar.`)) return;
      try {
        const { provisional } = await api(`/admin/usuarios/${r.dataset.restablecer}/contrasena`, { metodo: 'POST' });
        prompt(`Contraseña provisional de ${r.dataset.email}. Pásasela y dile que la cambie en «Mi cuenta»:`, provisional);
      } catch (err) {
        avisar(err.message, true);
      }
      return;
    }
    const b = ev.target.closest('[data-borrar]');
    if (!b || !confirm(`¿Borrar la cuenta ${b.dataset.email}? Perderá su lista y su progreso.`)) return;
    try {
      await api(`/admin/usuarios/${b.dataset.borrar}`, { metodo: 'DELETE' });
      avisar('Cuenta borrada');
      verUsuarios();
    } catch (err) {
      avisar(err.message, true);
    }
  });
}

// ---------- Notificaciones en Telegram ----------
let temasVistos = []; // temas encontrados con «Buscar temas»

async function verNotificaciones() {
  const t = await api('/admin/telegram');
  // Opciones de los desplegables de temas: General + los guardados + los encontrados
  const opcionesTema = (elegido) => {
    const lista = new Map(temasVistos.map((x) => [x.id, x]));
    for (const x of Object.values(t.temas)) if (x) lista.set(x.id, x);
    return ['<option value="">General</option>', ...[...lista.values()].map((x) => `<option value="${esc(x.id)}" ${elegido?.id === x.id ? 'selected' : ''}>${esc(x.nombre)}</option>`)].join('');
  };
  const fecha = (f) => new Date(f).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  contenido.innerHTML = `
    <div class="contenido-cab">
      <h1>Notificaciones</h1>
      <span class="pildora ${t.configurado && t.activo ? 'ok' : 'medio'}">${t.configurado ? (t.activo ? 'Avisos activados' : 'Avisos en pausa') : 'Sin configurar'}</span>
    </div>
    <p class="texto-2" style="margin:-8px 0 20px">Cada vez que una película o un episodio nuevo se puede ver (al subirlo al bucket o al enlazarlo aquí), el bot lo publica en tu grupo de Telegram con su cartel y un botón para verlo.</p>

    <div class="caja">
      <h2>1. Bot de Telegram</h2>
      <ol class="pasos">
        <li>En Telegram abre <b>@BotFather</b>, escribe <code>/newbot</code> y sigue los pasos.</li>
        <li>Copia el <b>token</b> que te da (algo como <code>123456789:AA…</code>) y pégalo aquí.</li>
      </ol>
      <form class="fila-form" id="form-token">
        <label class="campo"><span>Token del bot ${t.token ? `(guardado: ${esc(t.token)})` : ''}</span>
          <input name="token" type="password" autocomplete="off" placeholder="${t.token ? 'Déjalo vacío para mantener el actual' : '123456789:AA…'}" />
        </label>
        <button class="btn btn-primario">Guardar token</button>
      </form>
      ${t.bot ? `<p class="texto-3" style="margin-top:10px">Bot conectado: <b>@${esc(t.bot)}</b></p>` : ''}
    </div>

    <div class="caja">
      <h2>2. Grupo</h2>
      <ol class="pasos">
        <li>Añade ${t.bot ? `<b>@${esc(t.bot)}</b>` : 'el bot'} a tu grupo (o canal, como administrador).</li>
        <li>Escribe cualquier mensaje en el grupo y pulsa <b>Buscar grupos</b>.</li>
      </ol>
      <p style="margin-bottom:12px">Grupo actual: ${t.chatId ? `<b>${esc(t.chatNombre ?? t.chatId)}</b> <span class="texto-3">(${esc(t.chatId)})</span>` : '<span class="texto-3">ninguno</span>'}</p>
      <div class="fila-form">
        <button class="btn btn-secundario" id="buscar-grupos" ${t.bot ? '' : 'disabled'}>Buscar grupos</button>
      </div>
      <div id="grupos" style="margin-top:12px"></div>
      <details style="margin-top:12px"><summary class="texto-3">Poner el ID del grupo a mano</summary>
        <form class="fila-form" id="form-chat" style="margin-top:10px">
          <label class="campo"><span>ID del grupo (p. ej. -1001234567890)</span><input name="chatId" value="${esc(t.chatId ?? '')}" /></label>
          <button class="btn btn-secundario">Guardar</button>
        </form>
      </details>
    </div>

    ${t.chatId ? `
    <div class="caja">
      <h2>3. Temas del grupo ${t.esForo ? '' : '<span class="texto-3" style="font-size:13px;font-weight:400">(solo si tu grupo tiene temas)</span>'}</h2>
      <p class="texto-2" style="margin-bottom:12px">Elige en qué tema se publica cada sección. «General» es el tema principal del grupo. Los documentales y docuseries son los títulos con el género «Documental»; si no les pones tema, van al de películas o series.</p>
      <div class="fila-form" id="temas">
        ${Object.entries(t.secciones).map(([clave, s]) => `
          <label class="campo"><span>${esc(s.tema)}</span><select name="${clave}">${opcionesTema(t.temas[clave])}</select></label>`).join('')}
      </div>
      <div class="fila-form" style="margin-top:12px">
        <button class="btn btn-secundario" id="buscar-temas">Buscar temas</button>
        <button class="btn btn-secundario" id="crear-temas">Crear los temas que faltan</button>
      </div>
      <p class="texto-3" style="margin-top:10px">Para que un tema aparezca en la lista, escribe un mensaje dentro de él y pulsa <b>Buscar temas</b>. Para crearlos automáticamente, el bot tiene que ser administrador con permiso para <b>gestionar temas</b>.</p>
    </div>` : ''}

    <div class="caja">
      <h2>${t.chatId ? '4' : '3'}. Avisos</h2>
      <form class="fila-form" id="form-downloader" style="margin-bottom:14px">
        <label class="campo"><span>Código Downloader de la app (botón «📲 APP MOVIL/TV»; vacío = sin botón)</span><input name="downloader" inputmode="numeric" value="${esc(t.downloader ?? '')}" /></label>
        <button class="btn btn-secundario">Guardar código</button>
      </form>
      <label class="casilla" style="margin-bottom:14px"><input type="checkbox" id="activo" ${t.activo ? 'checked' : ''} ${t.configurado ? '' : 'disabled'} /> Avisar en Telegram de cada contenido nuevo</label>
      <div class="fila-form"><button class="btn btn-primario" id="prueba" ${t.configurado ? '' : 'disabled'}>Enviar mensaje de prueba</button></div>
      <h3 style="margin:18px 0 8px;font-size:15px">Últimos avisos</h3>
      ${t.historial.length ? `<table class="tabla"><tbody>${t.historial.map((h) => `
        <tr><td class="min">${h.ok ? '✅' : '❌'}</td><td><b>${esc(h.titulo)}</b>${h.error ? `<div class="texto-3">${esc(h.error)}</div>` : ''}</td><td class="min texto-3">${fecha(h.fecha)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="texto-3">Todavía no se ha enviado ninguno desde que arrancó el servidor.</p>'}
    </div>`;

  const guardar = async (cuerpo, mensaje) => {
    try {
      await api('/admin/telegram', { metodo: 'PUT', cuerpo });
      avisar(mensaje);
      verNotificaciones();
    } catch (err) {
      avisar(err.message, true);
    }
  };

  document.getElementById('form-token').onsubmit = (ev) => {
    ev.preventDefault();
    const token = new FormData(ev.currentTarget).get('token').trim();
    if (token) guardar({ token }, 'Bot conectado');
  };
  document.getElementById('form-chat').onsubmit = (ev) => {
    ev.preventDefault();
    guardar({ chatId: new FormData(ev.currentTarget).get('chatId').trim(), chatNombre: null }, 'Grupo guardado');
  };
  document.getElementById('form-downloader').onsubmit = (ev) => {
    ev.preventDefault();
    const codigo = new FormData(ev.currentTarget).get('downloader').trim();
    guardar({ downloader: codigo }, codigo ? `Botón de la app con el código ${codigo}` : 'Botón de la app quitado');
  };
  document.getElementById('activo').onchange = (ev) => guardar({ activo: ev.target.checked }, ev.target.checked ? 'Avisos activados' : 'Avisos en pausa');
  document.getElementById('buscar-grupos').onclick = async (ev) => {
    const caja = document.getElementById('grupos');
    ev.currentTarget.disabled = true;
    try {
      const grupos = await api('/admin/telegram/grupos');
      caja.innerHTML = grupos.length
        ? grupos.map((g) => `<div class="fila-form" style="align-items:center;margin-bottom:6px"><span><b>${esc(g.nombre)}</b> <span class="texto-3">${g.esForo ? 'con temas' : esc(g.tipo)} · ${esc(g.id)}</span></span><button class="btn btn-primario btn-chico" data-id="${esc(g.id)}" data-nombre="${esc(g.nombre)}" data-foro="${g.esForo ? 1 : ''}">Usar este</button></div>`).join('')
        : '<p class="texto-3">No aparece ningún grupo. Comprueba que el bot está en el grupo, escribe un mensaje allí y vuelve a buscar.</p>';
      caja.onclick = (e) => {
        const b = e.target.closest('[data-id]');
        if (b) { temasVistos = []; guardar({ chatId: b.dataset.id, chatNombre: b.dataset.nombre, esForo: Boolean(b.dataset.foro) }, `Avisos irán a «${b.dataset.nombre}»`); }
      };
    } catch (err) {
      avisar(err.message, true);
    } finally {
      ev.currentTarget.disabled = false;
    }
  };
  const temas = document.getElementById('temas');
  if (temas) {
    temas.onchange = (ev) => {
      const sel = ev.target;
      const tema = sel.value ? { id: sel.value, nombre: sel.selectedOptions[0].textContent } : null;
      guardar({ temas: { [sel.name]: tema } }, `${t.secciones[sel.name].nombre} → ${tema?.nombre ?? 'General'}`);
    };
    document.getElementById('buscar-temas').onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        temasVistos = await api('/admin/telegram/temas');
        avisar(temasVistos.length ? `${temasVistos.length} temas encontrados: elígelos en los desplegables` : 'No aparece ningún tema: escribe un mensaje dentro de cada tema y vuelve a buscar');
        verNotificaciones();
      } catch (err) {
        avisar(err.message, true);
        ev.currentTarget.disabled = false;
      }
    };
    document.getElementById('crear-temas').onclick = async (ev) => {
      const faltan = Object.entries(t.secciones).filter(([clave]) => !t.temas[clave]).map(([, s]) => `«${s.tema}»`);
      if (!faltan.length) return avisar('Todas las secciones ya tienen tema');
      if (!confirm(`¿Crear en el grupo los temas ${faltan.join(', ')}?`)) return;
      ev.currentTarget.disabled = true;
      try {
        await api('/admin/telegram/temas', { metodo: 'POST' });
        avisar('Temas creados: cada sección irá a su tema');
        verNotificaciones();
      } catch (err) {
        avisar(err.message, true);
        ev.currentTarget.disabled = false;
      }
    };
  }

  document.getElementById('prueba').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api('/admin/telegram/prueba', { metodo: 'POST' });
      avisar('Mensajes de prueba enviados: míralos en el grupo');
    } catch (err) {
      avisar(err.message, true);
    } finally {
      ev.currentTarget.disabled = false;
    }
  };
}

async function verAlmacenamiento() {
  const objetos = await api('/admin/almacenamiento');
  const total = objetos.reduce((s, o) => s + o.tamano, 0);
  contenido.innerHTML = `
    <div class="contenido-cab">
      <h1>Almacenamiento e2</h1>
      <span class="texto-2">${objetos.length} vídeos · ${tamHumano(total)}</span>
    </div>
    <div class="caja"><h2>Subir vídeo suelto</h2><div id="zona"></div><p class="texto-3">Luego enlázalo a una película o episodio desde Catálogo → Vídeos.</p></div>
    <div class="caja tabla-scroll">
      ${objetos.length ? `
        <table class="tabla">
          <thead><tr><th>Archivo</th><th>Tamaño</th><th>Fecha</th><th>Estado</th><th class="min"></th></tr></thead>
          <tbody>
            ${objetos.map((o) => `
              <tr>
                <td class="mono">${esc(o.key)}</td>
                <td class="min">${tamHumano(o.tamano)}</td>
                <td class="min">${new Date(o.fecha).toLocaleDateString('es-ES')}</td>
                <td class="min">${o.enlazado ? '<span class="pildora ok">En uso</span>' : '<span class="pildora no">Sin usar</span>'}</td>
                <td class="min">${o.enlazado ? '' : `<button class="btn btn-peligro btn-chico" data-borrar="${esc(o.key)}">Borrar</button>`}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<p class="texto-3">El bucket no tiene vídeos todavía.</p>'}
    </div>`;
  zonaSubida(document.getElementById('zona'), async () => { avisar('Vídeo subido a e2'); verAlmacenamiento(); });
  contenido.querySelector('tbody')?.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-borrar]');
    if (!b || !confirm(`¿Borrar definitivamente ${b.dataset.borrar} de IDrive e2?`)) return;
    try { await api(`/admin/almacenamiento?key=${encodeURIComponent(b.dataset.borrar)}`, { metodo: 'DELETE' }); avisar('Borrado'); verAlmacenamiento(); }
    catch (err) { avisar(err.message, true); }
  });
}

if (clave) api('/admin/comprobar').then(entrar).catch(() => sessionStorage.removeItem('fg-admin'));
