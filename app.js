(() => {
  'use strict';

  const CFG = window.PORRA_CONFIG || {};
  const TZ = 'America/Bogota';
  const CIERRE_MIN = 5; // debe coincidir con config.minutos_cierre en Supabase

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  if (CFG.TITULO) $('#titulo').textContent = CFG.TITULO;
  if (CFG.SUBTITULO) $('#subtitulo').textContent = CFG.SUBTITULO;

  if (!window.supabase || !CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('TU-PROYECTO')) {
    $('#lista').innerHTML = `<div class="card"><h2>Falta configurar</h2>
      <p>Edita el archivo <code>config.js</code> con la URL y la llave de tu proyecto de Supabase (ver README).</p></div>`;
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, { auth: { persistSession: false } });

  // ------------------------------------------------------------------ estado
  const st = {
    partidos: [],
    mios: {},          // partido_id -> {l, v}
    draft: {},         // partido_id -> {l: '2', v: '1'} (texto de los inputs)
    sesion: null,      // {cedula, pin, nombre}
    publicos: null,    // pronósticos de todos (partidos cerrados)
    publicosAt: 0,
    verOtros: new Set(),
    gruposAbiertos: null, // {"Fecha 1": true/false} lo que el usuario abrió/cerró a mano
    filtro: 'todos',
    tab: 'partidos',
    modoCuenta: 'ingresar',
    admin: null,       // clave admin
    adminPart: [],
    adminSocios: [],
    socios: null,      // lista pública para el desplegable de inscripción
  };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
    sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* */ } },
  };

  async function rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message || 'Error de conexión');
    if (data && data.ok === false) throw new Error(data.error || 'Operación rechazada');
    return data;
  }

  function toast(msg, tipo = 'ok', ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast' + (tipo === 'error' ? ' error' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  async function conBoton(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'error', 5000); } finally { if (btn) btn.disabled = false; }
  }

  // ------------------------------------------------------------------ fechas y puntos
  const fmtFecha = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const fechaTxt = (iso) => { const d = new Date(iso); return `${fmtFecha.format(d)} · ${fmtHora.format(d)}`; };
  const cierreDe = (p) => new Date(p.inicio).getTime() - CIERRE_MIN * 60000;
  const tieneRes = (p) => p.goles_local != null && p.goles_visitante != null;
  const estado = (p) => (tieneRes(p) ? 'final' : Date.now() >= cierreDe(p) ? 'cerrado' : 'abierto');

  // Colombia no tiene horario de verano: UTC-5 fijo.
  const aInputBogota = (iso) => new Date(new Date(iso).getTime() - 5 * 3600000).toISOString().slice(0, 16);
  const deInputBogota = (v) => (v ? `${v.trim().replace(' ', 'T').slice(0, 16)}:00-05:00` : null);

  function faltan(ms) {
    const min = Math.floor(ms / 60000);
    const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (min >= 1) return `${m} min`;
    return `${Math.max(0, Math.ceil(ms / 1000))} s`;
  }

  function puntos(pl, pv, rl, rv) {
    if (rl == null || pl == null) return null;
    if (pl === rl && pv === rv) return 3;
    return Math.sign(pl - pv) === Math.sign(rl - rv) ? 1 : 0;
  }

  function badge(p) {
    const e = estado(p);
    if (e === 'final') return ['Final', 'b-final'];
    if (e === 'cerrado') return [Date.now() >= new Date(p.inicio).getTime() ? 'En juego' : 'Cerrado', 'b-cerrado'];
    const ms = cierreDe(p) - Date.now();
    return ['Cierra en ' + faltan(ms), ms < 3600000 ? 'b-urgente' : 'b-abierto'];
  }

  // ------------------------------------------------------------------ datos
  async function cargarPartidos() {
    const { data, error } = await sb.from('partidos').select('*').order('inicio').order('id');
    if (error) throw new Error(error.message);
    st.partidos = data || [];
  }

  function aplicarMios(lista) {
    st.mios = {};
    for (const x of lista || []) st.mios[x.partido_id] = { l: x.goles_local, v: x.goles_visitante };
  }

  async function cargarPublicos(forzar = false) {
    if (!forzar && st.publicos && Date.now() - st.publicosAt < 60000) return;
    st.publicos = (await rpc('pronosticos_cerrados')) || [];
    st.publicosAt = Date.now();
  }

  // ------------------------------------------------------------------ cuenta
  function opcionesSocios() {
    if (st.socios === null) return '<option value="">Cargando…</option>';
    return '<option value="">Elige una opción…</option>' +
      '<option value="socio">Soy socio(a) de FAINCO</option>' +
      (st.socios.length
        ? `<optgroup label="Me invitó:">${st.socios.map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}</optgroup>`
        : '');
  }

  function renderCuenta() {
    const box = $('#cuenta');
    if (st.sesion) {
      box.innerHTML = `<div class="card hola">
        <div><strong>Hola, ${esc(st.sesion.nombre)}</strong><span class="muted">Cédula ${esc(st.sesion.cedula)}</span></div>
        <button class="btn ghost sm" id="salir">Salir</button></div>`;
      $('#salir').onclick = () => {
        if (pendientes().length && !confirm('Tienes cambios sin guardar. ¿Salir de todos modos?')) return;
        st.sesion = null; st.mios = {}; st.draft = {};
        store.set('porra_sesion', null);
        renderTodo();
      };
      return;
    }
    const abiertas = CFG.INSCRIPCIONES_ABIERTAS !== false;
    const reg = abiertas && st.modoCuenta === 'registro';
    box.innerHTML = `<div class="card">
      ${abiertas ? `<div class="seg">
        <button data-modo="ingresar" aria-pressed="${!reg}">Ingresar</button>
        <button data-modo="registro" aria-pressed="${reg}">Inscribirme</button>
      </div>` : '<h2>Ingresar</h2>'}
      <form id="f-cuenta" autocomplete="on" novalidate>
        <div class="grid c2">
          <div><label for="c-ced">Cédula</label><input id="c-ced" name="cedula" inputmode="numeric" autocomplete="username" required></div>
          ${reg ? `<div><label for="c-nom">Nombre completo</label><input id="c-nom" name="nombre" autocomplete="name" required></div>
          <div><label for="c-tel">Teléfono / WhatsApp</label><input id="c-tel" name="telefono" type="tel" inputmode="tel" autocomplete="tel" required></div>
          <div><label for="c-inv">¿Quién te invitó?</label>
            <select id="c-inv" name="invitado" required>${opcionesSocios()}</select></div>` : ''}
          <div><label for="c-pin">${reg ? 'Crea un PIN (4 a 6 números)' : 'PIN'}</label>
            <input id="c-pin" name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
        </div>
        <div class="acciones">
          <button class="btn" type="submit">${reg ? 'Inscribirme' : 'Ingresar'}</button>
          <span class="muted">${reg ? 'El PIN protege tus marcadores. No lo compartas.' : (abiertas ? '¿Primera vez? Toca “Inscribirme”.' : 'Las inscripciones están cerradas.')}</span>
        </div>
      </form></div>`;
    $$('[data-modo]', box).forEach((b) => (b.onclick = () => { st.modoCuenta = b.dataset.modo; renderCuenta(); }));
    if (reg && st.socios === null) {
      rpc('listar_socios')
        .then((s) => { st.socios = s || []; const sel = $('#c-inv'); if (sel) sel.innerHTML = opcionesSocios(); })
        .catch((e) => toast('No se pudo cargar la lista de socios: ' + e.message, 'error'));
    }
    $('#f-cuenta').onsubmit = (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const cedula = f.cedula.value.replace(/\D/g, '');
      const pin = f.pin.value.trim();
      conBoton(f.querySelector('button[type=submit]'), async () => {
        let r;
        if (reg) {
          if (!f.invitado.value) throw new Error('Elige de la lista quién te invitó.');
          r = await rpc('registrar', {
            p_cedula: cedula, p_nombre: f.nombre.value, p_telefono: f.telefono.value, p_pin: pin, p_invitado: f.invitado.value,
          });
          toast('¡Inscripción lista! Ya puedes pronosticar.');
        } else {
          r = await rpc('ingresar', { p_cedula: cedula, p_pin: pin });
        }
        st.sesion = { cedula, pin, nombre: r.nombre };
        store.set('porra_sesion', st.sesion);
        aplicarMios(r.pronosticos);
        st.draft = {};
        renderTodo();
      });
    };
  }

  // ------------------------------------------------------------------ partidos
  function valor(p, lado) {
    const d = st.draft[p.id];
    if (d && d[lado] !== undefined) return d[lado];
    const m = st.mios[p.id];
    return m ? String(m[lado]) : '';
  }

  function cardPartido(p) {
    const e = estado(p);
    const [txt, cls] = badge(p);
    const mio = st.mios[p.id];
    let centro;
    if (e === 'final') {
      centro = `<div class="marcador">${p.goles_local}<span>–</span>${p.goles_visitante}</div>`;
    } else if (e === 'abierto' && st.sesion) {
      const inp = (lado, eq) => {
        const v = valor(p, lado);
        const cambio = mio ? v !== String(mio[lado]) : v !== '';
        return `<input type="number" inputmode="numeric" min="0" max="30" data-id="${p.id}" data-lado="${lado}"
          value="${esc(v)}" class="${cambio ? 'cambio' : ''}" aria-label="Goles ${esc(eq)}">`;
      };
      centro = `<div class="goles">${inp('l', p.local)}<span>–</span>${inp('v', p.visitante)}</div>`;
    } else {
      centro = '<div class="marcador vs">vs</div>';
    }

    let pie = '';
    if (st.sesion) {
      if (mio) {
        const pts = puntos(mio.l, mio.v, p.goles_local, p.goles_visitante);
        pie = `Tu pronóstico: <b>${mio.l}–${mio.v}</b>` +
          (pts != null ? ` <span class="pts p${pts}">+${pts}</span>` : e === 'abierto' ? ' <span class="ok">✓</span>' : '');
      } else {
        pie = `<span class="muted">${e === 'abierto' ? 'Sin pronóstico' : 'No pronosticaste'}</span>`;
      }
    } else if (e === 'abierto') {
      pie = '<span class="muted">Ingresa para pronosticar</span>';
    }
    const abierto = st.verOtros.has(p.id);
    const ver = e !== 'abierto' ? `<button class="link" data-ver="${p.id}">${abierto ? 'Ocultar' : 'Ver'} pronósticos</button>` : '';

    return `<article class="match e-${e}" data-pid="${p.id}" data-estado="${e}">
      <header><span class="fase">${esc(p.fase)}</span><span class="badge ${cls}" data-badge>${txt}</span></header>
      <div class="teams"><span class="team">${esc(p.local)}</span>${centro}<span class="team away">${esc(p.visitante)}</span></div>
      <footer><span class="when">${fechaTxt(p.inicio)}</span><span class="mine">${pie}</span>${ver}</footer>
      ${abierto ? otrosHTML(p) : ''}
    </article>`;
  }

  function otrosHTML(p) {
    if (!st.publicos) return '<div class="otros muted">Cargando…</div>';
    const filas = st.publicos.filter((x) => Number(x.partido_id) === Number(p.id));
    if (!filas.length) return '<div class="otros muted">Nadie pronosticó este partido.</div>';
    return `<div class="otros"><ul>${filas.map((f) => `<li><span>${esc(f.nombre)}</span><b>${f.goles_local}–${f.goles_visitante}</b>${
      tieneRes(p) ? `<span class="pts p${f.puntos}">+${f.puntos}</span>` : ''}</li>`).join('')}</ul></div>`;
  }

  function renderPartidos() {
    const cont = $('#lista');
    $$('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === st.filtro)));
    if (!st.partidos.length) {
      cont.innerHTML = '<div class="card vacio">Todavía no hay partidos cargados. ¡Vuelve pronto!</div>';
      return;
    }
    const lista = st.partidos.filter((p) => {
      const e = estado(p);
      return st.filtro === 'todos' || (st.filtro === 'abiertos' ? e === 'abierto' : e !== 'abierto');
    });
    if (!lista.length) {
      cont.innerHTML = `<div class="card vacio">${st.filtro === 'abiertos' ? 'No hay partidos abiertos para pronosticar.' : 'Aún no hay partidos cerrados.'}</div>`;
      return;
    }
    const grupos = new Map();
    for (const p of lista) {
      const k = p.jornada ? `Fecha ${p.jornada}` : p.fase;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(p);
    }
    // Por defecto se abren las fechas con partidos sin terminar; las ya jugadas quedan contraídas.
    if (!st.gruposAbiertos) st.gruposAbiertos = store.get('porra_grupos') || {};
    const claves = [...grupos.keys()];
    const pendiente = (ps) => ps.some((p) => estado(p) !== 'final');
    const hayPendiente = claves.some((k) => pendiente(grupos.get(k)));
    let html = '';
    for (const [k, ps] of grupos) {
      const porDefecto = hayPendiente ? pendiente(ps) : k === claves[claves.length - 1];
      const abierto = st.gruposAbiertos[k] ?? porDefecto;
      const nAb = ps.filter((p) => estado(p) === 'abierto').length;
      const nJu = ps.filter((p) => estado(p) === 'cerrado').length;
      const info = nAb ? `${nAb} por pronosticar` : nJu ? 'En juego' : ps.every((p) => estado(p) === 'final') ? 'Terminada' : '';
      html += `<details class="grupo" data-grupo="${esc(k)}"${abierto ? ' open' : ''}>
        <summary class="grupo-tit"><span>${esc(k)}</span><span class="grupo-info">${ps.length} partido${ps.length > 1 ? 's' : ''}${info ? ' · ' + info : ''}</span></summary>
        ${ps.map(cardPartido).join('')}</details>`;
    }
    cont.innerHTML = html;
    $$('details.grupo > summary', cont).forEach((sm) => sm.addEventListener('click', () => {
      const d = sm.parentElement; // el clic ocurre antes de que cambie "open"
      st.gruposAbiertos[d.dataset.grupo] = !d.open;
      store.set('porra_grupos', st.gruposAbiertos);
    }));
    actualizarSavebar();
  }

  function pendientes() {
    const out = [];
    for (const [id, d] of Object.entries(st.draft)) {
      const p = st.partidos.find((x) => String(x.id) === id);
      if (!p || estado(p) !== 'abierto') continue;
      const l = valor(p, 'l'), v = valor(p, 'v');
      if (!/^\d{1,2}$/.test(l) || !/^\d{1,2}$/.test(v)) continue;
      const m = st.mios[id];
      if (m && String(m.l) === l && String(m.v) === v) continue;
      out.push({ partido_id: Number(id), goles_local: Number(l), goles_visitante: Number(v) });
    }
    return out;
  }

  function incompletos() {
    return Object.entries(st.draft).filter(([id]) => {
      const p = st.partidos.find((x) => String(x.id) === id);
      if (!p || estado(p) !== 'abierto') return false;
      const l = valor(p, 'l'), v = valor(p, 'v');
      return (l === '') !== (v === '');
    }).length;
  }

  function actualizarSavebar() {
    const n = pendientes().length, inc = incompletos();
    const bar = $('#savebar');
    bar.hidden = !st.sesion || st.tab !== 'partidos' || (n === 0 && inc === 0);
    $('#savebar-txt').textContent =
      (n ? `${n} pronóstico${n > 1 ? 's' : ''} sin guardar` : '') +
      (inc ? `${n ? ' · ' : ''}${inc} incompleto${inc > 1 ? 's' : ''}` : '');
    $('#btn-guardar').disabled = n === 0;
  }

  async function guardar() {
    const items = pendientes();
    if (!items.length || !st.sesion) return;
    await conBoton($('#btn-guardar'), async () => {
      const r = await rpc('guardar_pronosticos', { p_cedula: st.sesion.cedula, p_pin: st.sesion.pin, p_items: items });
      for (const it of items) delete st.draft[it.partido_id];
      const yo = await rpc('ingresar', { p_cedula: st.sesion.cedula, p_pin: st.sesion.pin });
      aplicarMios(yo.pronosticos);
      if (r.guardados) toast(`✓ ${r.guardados} pronóstico${r.guardados > 1 ? 's' : ''} guardado${r.guardados > 1 ? 's' : ''}`);
      if (r.rechazados && r.rechazados.length) toast('No se guardó: ' + r.rechazados.join(', '), 'error', 7000);
    });
    renderPartidos();
  }

  // ------------------------------------------------------------------ tabla
  // Partidos que ya cerraron pronósticos y aún no tienen resultado.
  const partidosEnJuego = () => st.partidos.filter((p) => estado(p) === 'cerrado');
  const firmaEnJuego = () => partidosEnJuego().map((p) => p.id).join(',');
  let tablaFirma = '';
  let ultimaTabla = [];

  // Dibuja la tabla de posiciones en un PNG (canvas, sin librerías) para compartir por WhatsApp.
  async function compartirTablaImagen() {
    const filas = ultimaTabla;
    if (!filas.length) throw new Error('La tabla está vacía.');
    const W = 1080, PAD = 48, CAB = 230, FILA = 64, TH = 56, PIE = 90;
    const H = CAB + 70 + TH + filas.length * FILA + PIE;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const F = (peso, px) => `${peso} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    const C = { bg: '#f3f5f2', top: '#0b3d22', topInk: '#f2f7f3', brand: '#0f7a3d', soft: '#dcefe2', text: '#15201a', muted: '#5d6b62', line: '#dbe2d9', alt: '#f7f9f6', gold: '#c99a06' };
    const recorta = (txt, max) => {
      if (g.measureText(txt).width <= max) return txt;
      while (txt.length > 1 && g.measureText(txt + '…').width > max) txt = txt.slice(0, -1);
      return txt + '…';
    };

    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    // Encabezado
    g.fillStyle = C.top; g.fillRect(0, 0, W, CAB);
    let xTit = PAD;
    try {
      const logo = await new Promise((ok, mal) => { const im = new Image(); im.onload = () => ok(im); im.onerror = mal; im.src = 'logo-fondo.png'; });
      g.save(); g.beginPath(); g.arc(PAD + 60, 100, 60, 0, Math.PI * 2); g.clip();
      g.drawImage(logo, PAD, 40, 120, 120); g.restore();
      xTit = PAD + 150;
    } catch { /* sin logo */ }
    g.fillStyle = C.topInk; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.font = F(800, 50); g.fillText(recorta(CFG.TITULO || 'Porra', W - xTit - PAD), xTit, 92);
    g.globalAlpha = 0.85; g.font = F(500, 30); g.fillText(CFG.SUBTITULO || '', xTit, 136);
    g.globalAlpha = 1; g.font = F(700, 34); g.fillText('Tabla de posiciones', xTit, 188);

    const jugados = st.partidos.filter(tieneRes).length;
    g.fillStyle = C.muted; g.font = F(500, 26);
    g.fillText(`${jugados} de ${st.partidos.length} partidos con resultado · ${filas.length} participantes`, PAD, CAB + 44);

    // Columnas: # | Participante | Exactos | Aciertos | Pts
    const x0 = PAD, x1 = W - PAD;
    const cols = { n: x0 + 40, nom: x0 + 100, ex: x1 - 330, ac: x1 - 190, pts: x1 - 50 };
    let y = CAB + 70;
    g.fillStyle = C.top; g.fillRect(x0, y, x1 - x0, TH);
    g.fillStyle = C.topInk; g.font = F(700, 24); g.textBaseline = 'middle';
    const cy = y + TH / 2;
    g.textAlign = 'center'; g.fillText('#', cols.n, cy);
    g.textAlign = 'left'; g.fillText('PARTICIPANTE', cols.nom, cy);
    g.textAlign = 'center'; g.fillText('EXACTOS', cols.ex, cy); g.fillText('ACIERTOS', cols.ac, cy); g.fillText('PTS', cols.pts, cy);
    y += TH;

    filas.forEach((f, i) => {
      const pos = Number(f.posicion), pts = Number(f.puntos);
      g.fillStyle = pos <= 3 && pts > 0 ? C.soft : i % 2 ? C.alt : '#ffffff';
      g.fillRect(x0, y, x1 - x0, FILA);
      g.fillStyle = C.line; g.fillRect(x0, y + FILA - 1, x1 - x0, 1);
      const m = y + FILA / 2;
      g.textAlign = 'center';
      if (pos <= 3 && pts > 0) { g.font = F(400, 34); g.fillText(['🥇', '🥈', '🥉'][pos - 1], cols.n, m + 2); }
      else { g.fillStyle = C.muted; g.font = F(700, 28); g.fillText(String(pos), cols.n, m); }
      g.textAlign = 'left'; g.fillStyle = C.text; g.font = F(600, 30);
      g.fillText(recorta(f.nombre, cols.ex - cols.nom - 90), cols.nom, m);
      g.textAlign = 'center'; g.fillStyle = C.muted; g.font = F(500, 28);
      g.fillText(String(f.exactos), cols.ex, m); g.fillText(String(f.aciertos), cols.ac, m);
      g.fillStyle = C.brand; g.font = F(800, 32); g.fillText(String(pts), cols.pts, m);
      y += FILA;
    });

    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = C.muted; g.font = F(500, 24);
    const hoy = new Date().toLocaleString('es-CO', { timeZone: TZ, day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
    g.fillText(`Actualizada: ${hoy}  ·  Exacto = 3 pts · Ganador o empate = 1 pt`, W / 2, y + PIE / 2);

    const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
    const nombre = `tabla-posiciones-${new Date().toISOString().slice(0, 10)}.png`;
    const file = new File([blob], nombre, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Tabla de posiciones' }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Imagen descargada');
  }

  async function renderTabla(silencioso = false) {
    const box = $('#tabla');
    if (!silencioso) box.innerHTML = '<div class="card cargando">Cargando posiciones…</div>';
    try {
      const enJuego = partidosEnJuego();
      // Si la base de datos aún no tiene pronosticos_en_juego, se usa pronosticos_cerrados
      // (sin cedula_corta: se cruza solo por nombre). Así la tabla nunca deja de cargar.
      const cargarPicks = () => rpc('pronosticos_en_juego')
        .catch(() => rpc('pronosticos_cerrados'))
        .catch(() => []);
      const [filasR, picksR] = await Promise.all([
        rpc('ranking'),
        enJuego.length ? cargarPicks() : Promise.resolve([]),
      ]);
      const filas = filasR || [];
      ultimaTabla = filas;
      tablaFirma = firmaEnJuego();
      const jugados = st.partidos.filter(tieneRes).length;
      if (!filas.length) { box.innerHTML = '<div class="card vacio">Aún no hay participantes inscritos.</div>'; return; }

      // partido_id -> (nombre|cedula_corta -> "2–1")
      const picks = new Map(enJuego.map((p) => [Number(p.id), new Map()]));
      for (const x of picksR || []) {
        const k = x.cedula_corta ? `${x.nombre}|${x.cedula_corta}` : x.nombre;
        picks.get(Number(x.partido_id))?.set(k, `${x.goles_local}–${x.goles_visitante}`);
      }
      const varios = enJuego.length > 1;
      const etiqueta = (i) => (varios ? `P${i + 1}` : 'Pronóst.');

      const enJuegoHTML = enJuego.length ? `<div class="en-juego">
          <div class="en-juego-tit"><span class="live" aria-hidden="true"></span>${varios ? 'Partidos en juego' : 'Partido en juego'}</div>
          <ul>${enJuego.map((p, i) => {
            const [txt] = badge(p);
            return `<li>${varios ? `<b class="pn">P${i + 1}</b>` : ''}<span>${esc(p.local)} <span class="muted">vs</span> ${esc(p.visitante)}</span>
              <span class="badge b-cerrado">${txt}</span></li>`;
          }).join('')}</ul>
          <p class="muted">Pronósticos cerrados: así quedó cada participante.</p>
        </div>` : '';

      const yoCorta = st.sesion ? '•••' + st.sesion.cedula.slice(-3) : null;
      const medalla = (n, pts) => (pts > 0 && n <= 3 ? `<span class="medalla">${['🥇', '🥈', '🥉'][n - 1]}</span>` : n);
      box.innerHTML = `<div class="card">
        <div class="tabla-cab"><h2>Tabla de posiciones</h2>
          <button class="btn ghost sm" id="btn-img-tabla">📷 Compartir imagen</button></div>
        <p class="muted">${jugados} de ${st.partidos.length} partidos con resultado · ${filas.length} participantes</p>
        ${enJuegoHTML}
        <div class="scroll-x"><table class="tabla">
          <thead><tr><th class="n">#</th><th>Participante</th>
            ${enJuego.map((p, i) => `<th class="n pick-col" title="${esc(p.local)} vs ${esc(p.visitante)}">${etiqueta(i)}</th>`).join('')}
            <th class="n" title="Marcadores exactos (3 pts)">Exactos</th>
            <th class="n" title="Ganador o empate (1 pt)">Aciertos</th><th class="n">Pts</th></tr></thead>
          <tbody>${filas.map((f) => {
            const yo = yoCorta && f.cedula_corta === yoCorta && f.nombre === st.sesion.nombre;
            const k = `${f.nombre}|${f.cedula_corta}`;
            return `<tr class="${yo ? 'yo' : ''}"><td class="n">${medalla(Number(f.posicion), Number(f.puntos))}</td>
              <td>${esc(f.nombre)}<span class="ced">${esc(f.cedula_corta)}</span></td>
              ${enJuego.map((p) => {
                const m = picks.get(Number(p.id));
                const v = m?.get(k) ?? m?.get(f.nombre);
                return v ? `<td class="n pick-col"><span class="pick">${v}</span></td>` : '<td class="n pick-col muted">—</td>';
              }).join('')}
              <td class="n">${f.exactos}</td><td class="n">${f.aciertos}</td><td class="n pts-col">${f.puntos}</td></tr>`;
          }).join('')}</tbody>
        </table></div></div>`;
      $('#btn-img-tabla').onclick = (ev) => conBoton(ev.currentTarget, compartirTablaImagen);
    } catch (e) {
      if (!silencioso) box.innerHTML = `<div class="card vacio">No se pudo cargar la tabla: ${esc(e.message)}</div>`;
    }
  }

  // ------------------------------------------------------------------ admin
  function renderAdmin() {
    const box = $('#admin-box');
    if (!st.admin) {
      box.innerHTML = `<div class="card"><h2>Administrador</h2>
        <form id="f-adm"><label for="a-clave">Clave de administrador</label>
        <input id="a-clave" type="password" autocomplete="current-password" required>
        <div class="acciones"><button class="btn" type="submit">Entrar</button></div></form></div>`;
      $('#f-adm').onsubmit = (ev) => {
        ev.preventDefault();
        const clave = $('#a-clave').value;
        conBoton(ev.target.querySelector('button'), async () => {
          await rpc('admin_login', { p_clave: clave });
          st.admin = clave; store.sset('porra_admin', clave);
          renderAdmin();
        });
      };
      return;
    }
    box.innerHTML = `
      <div class="card"><h3>Faltan por pronosticar</h3>
        <p class="muted">Participantes que todavía no han guardado su marcador para el partido elegido.</p>
        <select id="pend-partido" aria-label="Partido"></select>
        <div id="adm-pend" style="margin-top:12px"></div></div>
      <div class="card">
        <h2 id="fp-tit">Nuevo partido</h2>
        <form id="f-partido">
          <input type="hidden" name="id">
          <div class="grid c3">
            <div><label>Fase</label><input name="fase" list="fases" value="Grupo A" required>
              <datalist id="fases"><option>Grupo A</option><option>Grupo B</option><option>Final ida</option><option>Final vuelta</option></datalist></div>
            <div><label>Fecha (jornada)</label><input name="jornada" type="number" min="1" max="10" placeholder="1 a 6"></div>
            <div><label>Inicio (hora Colombia)</label><input name="inicio" type="datetime-local" required></div>
          </div>
          <div class="grid c2" style="margin-top:12px">
            <div><label>Local</label><input name="local" required></div>
            <div><label>Visitante</label><input name="visitante" required></div>
          </div>
          <div class="acciones"><button class="btn" type="submit">Guardar partido</button>
            <button class="btn ghost" type="button" id="fp-limpiar">Limpiar</button></div>
        </form>
      </div>
      <div class="card">
        <h3>Cargar varios partidos</h3>
        <p class="muted">Un partido por línea: <code>Fase;Fecha;AAAA-MM-DD HH:MM;Local;Visitante</code></p>
        <textarea id="imp" placeholder="Grupo A;1;2026-11-22 15:30;Equipo 1;Equipo 2&#10;Grupo B;1;2026-11-22 18:00;Equipo 5;Equipo 6"></textarea>
        <div class="acciones"><button class="btn" id="btn-imp">Importar</button></div>
      </div>
      <div class="card"><h3>Partidos y resultados</h3>
        <p class="muted">Escribe el marcador al minuto 90 (sin goles de reposición) y toca “Guardar”. Deja ambos vacíos para borrar el resultado.</p>
        <div id="adm-partidos"></div></div>
      <div class="card"><h3 id="adm-soc-tit">Socios del Fondo</h3>
        <p class="muted">Aparecen en la lista “¿Quién te invitó?” al inscribirse. Escribe un nombre por línea.</p>
        <textarea id="soc-nuevos" placeholder="Nombre Apellido&#10;Nombre Apellido"></textarea>
        <div class="acciones"><button class="btn" id="btn-soc">Agregar socios</button></div>
        <div id="adm-soc" class="scroll-x" style="margin-top:12px"></div></div>
      <div class="card"><h3 id="adm-part-tit">Participantes</h3>
        <div class="acciones" style="margin:0 0 8px"><button class="btn ghost sm" id="btn-csv">Descargar CSV</button>
          <button class="btn ghost sm" id="btn-salir-adm">Cerrar sesión admin</button></div>
        <div id="adm-part" class="scroll-x"></div></div>
      <div class="card"><h3>Respaldo y Excel</h3>
        <p class="muted">Descarga todos los pronósticos en Excel, o un respaldo completo de la base de datos (archivo .json) para guardarlo en tu computador.</p>
        <div class="acciones" style="margin:0"><button class="btn sm" id="btn-xlsx">Descargar pronósticos (Excel)</button>
          <button class="btn ghost sm" id="btn-respaldo">Descargar respaldo (.json)</button></div></div>`;

    const f = $('#f-partido');
    const limpiar = () => { f.reset(); f.id.value = ''; $('#fp-tit').textContent = 'Nuevo partido'; };
    $('#fp-limpiar').onclick = limpiar;
    f.onsubmit = (ev) => {
      ev.preventDefault();
      conBoton(f.querySelector('button[type=submit]'), async () => {
        await rpc('admin_guardar_partido', {
          p_clave: st.admin, p_id: f.id.value ? Number(f.id.value) : null, p_fase: f.fase.value,
          p_jornada: f.jornada.value ? Number(f.jornada.value) : null,
          p_local: f.local.value, p_visitante: f.visitante.value, p_inicio: deInputBogota(f.inicio.value),
        });
        toast('Partido guardado');
        limpiar();
        await refrescarAdmin();
      });
    };

    $('#btn-imp').onclick = (ev) => conBoton(ev.target, async () => {
      const lineas = $('#imp').value.split('\n').map((l) => l.trim()).filter(Boolean);
      let ok = 0; const errores = [];
      for (const [i, l] of lineas.entries()) {
        const [fase, jor, fecha, local, visitante] = l.split(';').map((x) => (x || '').trim());
        if (!fase || !fecha || !local || !visitante || !/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/.test(fecha)) { errores.push(i + 1); continue; }
        const [d, h] = fecha.split(/[ T]/);
        try {
          await rpc('admin_guardar_partido', {
            p_clave: st.admin, p_id: null, p_fase: fase, p_jornada: jor ? Number(jor) : null,
            p_local: local, p_visitante: visitante, p_inicio: deInputBogota(`${d}T${h.padStart(5, '0')}`),
          });
          ok++;
        } catch { errores.push(i + 1); }
      }
      toast(`${ok} partido(s) importado(s)`);
      if (errores.length) toast('Revisa las líneas: ' + errores.join(', '), 'error', 7000);
      else $('#imp').value = '';
      await refrescarAdmin();
    });

    $('#btn-soc').onclick = (ev) => conBoton(ev.target, async () => {
      const nombres = $('#soc-nuevos').value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!nombres.length) throw new Error('Escribe al menos un nombre.');
      const r = await rpc('admin_agregar_socios', { p_clave: st.admin, p_nombres: nombres });
      toast(`${r.agregados} socio(s) agregado(s)`);
      $('#soc-nuevos').value = '';
      st.socios = null; // refrescar el desplegable público
      await refrescarAdmin();
    });

    $('#btn-csv').onclick = descargarCSV;
    $('#btn-xlsx').onclick = (ev) => conBoton(ev.target, descargarExcel);
    $('#btn-respaldo').onclick = (ev) => conBoton(ev.target, descargarRespaldo);
    $('#btn-salir-adm').onclick = () => { st.admin = null; store.sset('porra_admin', null); renderAdmin(); };
    refrescarAdmin();
  }

  async function refrescarAdmin() {
    try {
      await cargarPartidos();
      renderAdminPartidos();
      const r = await rpc('admin_participantes', { p_clave: st.admin });
      st.adminPart = r.participantes || [];
      renderAdminParticipantes();
      renderAdminPendientes();
      const s = await rpc('admin_socios', { p_clave: st.admin });
      st.adminSocios = s.socios || [];
      renderAdminSocios();
    } catch (e) {
      toast(e.message, 'error');
      if (/clave/i.test(e.message)) { st.admin = null; store.sset('porra_admin', null); renderAdmin(); }
    }
  }

  function renderAdminPartidos() {
    const box = $('#adm-partidos');
    if (!box) return;
    if (!st.partidos.length) { box.innerHTML = '<p class="muted">No hay partidos.</p>'; return; }
    box.innerHTML = st.partidos.map((p) => `<div class="adm-row" data-pid="${p.id}">
      <small>${esc(p.fase)}${p.jornada ? ' · Fecha ' + p.jornada : ''} · ${fechaTxt(p.inicio)}</small>
      <div class="linea">
        <span class="eq">${esc(p.local)}</span>
        <span class="goles"><input type="number" min="0" max="30" data-r="l" value="${p.goles_local ?? ''}" aria-label="Goles local">–<input type="number" min="0" max="30" data-r="v" value="${p.goles_visitante ?? ''}" aria-label="Goles visitante"></span>
        <span class="eq">${esc(p.visitante)}</span>
      </div>
      <div class="linea"><button class="btn sm" data-acc="res">Guardar resultado</button>
        <button class="btn ghost sm" data-acc="edit">Editar</button>
        <button class="btn danger sm" data-acc="del">Eliminar</button></div>
    </div>`).join('');

    $$('.adm-row', box).forEach((row) => {
      const p = st.partidos.find((x) => String(x.id) === row.dataset.pid);
      row.querySelector('[data-acc=res]').onclick = (ev) => conBoton(ev.target, async () => {
        const l = row.querySelector('[data-r=l]').value.trim(), v = row.querySelector('[data-r=v]').value.trim();
        if ((l === '') !== (v === '')) throw new Error('Escribe ambos goles (o deja ambos vacíos).');
        await rpc('admin_resultado', { p_clave: st.admin, p_id: p.id, p_gl: l === '' ? null : Number(l), p_gv: v === '' ? null : Number(v) });
        toast(l === '' ? 'Resultado borrado' : `Resultado guardado: ${p.local} ${l}–${v} ${p.visitante}`);
        await refrescarAdmin();
      });
      row.querySelector('[data-acc=edit]').onclick = () => {
        const f = $('#f-partido');
        f.id.value = p.id; f.fase.value = p.fase; f.jornada.value = p.jornada ?? '';
        f.inicio.value = aInputBogota(p.inicio); f.local.value = p.local; f.visitante.value = p.visitante;
        $('#fp-tit').textContent = `Editando: ${p.local} vs ${p.visitante}`;
        f.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      row.querySelector('[data-acc=del]').onclick = (ev) => {
        if (!confirm(`¿Eliminar ${p.local} vs ${p.visitante}? También se borran sus pronósticos.`)) return;
        conBoton(ev.target, async () => {
          await rpc('admin_eliminar_partido', { p_clave: st.admin, p_id: p.id });
          toast('Partido eliminado');
          await refrescarAdmin();
        });
      };
    });
  }

  function renderAdminSocios() {
    const box = $('#adm-soc');
    if (!box) return;
    $('#adm-soc-tit').textContent = `Socios del Fondo (${st.adminSocios.length})`;
    if (!st.adminSocios.length) { box.innerHTML = '<p class="muted">Todavía no hay socios en la lista.</p>'; return; }
    box.innerHTML = `<table class="tbl-mini"><thead><tr><th>Socio</th><th>Invitados</th><th></th></tr></thead>
      <tbody>${st.adminSocios.map((s) => `<tr data-sid="${s.id}"><td>${esc(s.nombre)}</td><td>${s.invitados}</td>
        <td class="acc"><button class="btn danger sm">Quitar</button></td></tr>`).join('')}</tbody></table>`;
    $$('tr[data-sid]', box).forEach((tr) => {
      const s = st.adminSocios.find((x) => String(x.id) === tr.dataset.sid);
      tr.querySelector('button').onclick = (ev) => {
        if (!confirm(`¿Quitar a ${s.nombre} de la lista? Sus invitados ya inscritos no se ven afectados.`)) return;
        conBoton(ev.target, async () => {
          await rpc('admin_quitar_socio', { p_clave: st.admin, p_id: s.id });
          st.socios = null;
          await refrescarAdmin();
        });
      };
    });
  }

  const invitadoTxt = (x) => (x.tipo === 'socio' ? 'Socio(a)' : x.invitado_por || '—');
  const waNum = (tel) => (tel.length === 10 ? '57' : '') + tel;

  // Quién falta por pronosticar: por defecto, el próximo partido en cerrar.
  function renderAdminPendientes() {
    const sel = $('#pend-partido'), box = $('#adm-pend');
    if (!sel || !box) return;
    const abiertos = st.partidos.filter((p) => estado(p) === 'abierto').sort((a, b) => cierreDe(a) - cierreDe(b));
    if (!abiertos.length) { sel.hidden = true; box.innerHTML = '<p class="muted">No hay partidos abiertos.</p>'; return; }
    sel.hidden = false;
    const previo = sel.value;
    sel.innerHTML = abiertos.map((p) => `<option value="${p.id}">${esc(p.local)} vs ${esc(p.visitante)} · ${fechaTxt(p.inicio)}</option>`).join('');
    if (abiertos.some((p) => String(p.id) === previo)) sel.value = previo;
    sel.onchange = pintar;
    pintar();

    function pintar() {
      const p = abiertos.find((x) => String(x.id) === sel.value);
      if (!p) return;
      const faltanP = st.adminPart.filter((x) => !(x.partidos_pron || []).map(Number).includes(Number(p.id)));
      const cierre = cierreDe(p);
      const horaCierre = fmtHora.format(new Date(cierre));
      const msg = (nom) => `Hola ${nom.split(' ')[0]}, te recordamos que aún no has puesto tu marcador para ${p.local} vs ${p.visitante}. `
        + `Se cierra a las ${horaCierre} (${fmtFecha.format(new Date(cierre))}). ¡No te quedes por fuera!`;
      const cab = `<p><b>${faltanP.length}</b> de ${st.adminPart.length} sin marcador · cierra en <b>${faltan(cierre - Date.now())}</b> (${horaCierre})</p>`;
      if (!faltanP.length) { box.innerHTML = cab + '<p class="muted">¡Todos ya pronosticaron este partido!</p>'; return; }
      box.innerHTML = cab + `<div class="acciones" style="margin:0 0 8px"><button class="btn ghost sm" id="btn-pend-copiar">Copiar lista</button></div>
        <div class="scroll-x"><table class="tbl-mini"><thead><tr><th>Nombre</th><th>Teléfono</th><th>Invitado por</th><th></th></tr></thead>
        <tbody>${faltanP.map((x) => `<tr><td>${esc(x.nombre)}</td><td>${esc(x.telefono)}</td><td>${esc(invitadoTxt(x))}</td>
          <td class="acc"><a class="btn sm" target="_blank" rel="noopener"
            href="https://wa.me/${esc(waNum(x.telefono))}?text=${encodeURIComponent(msg(x.nombre))}">Avisar</a></td></tr>`).join('')}</tbody></table></div>`;
      $('#btn-pend-copiar').onclick = async () => {
        const txt = `Faltan por poner marcador en ${p.local} vs ${p.visitante} (cierra ${horaCierre}):\n`
          + faltanP.map((x) => `- ${x.nombre} · ${x.telefono}`).join('\n');
        try { await navigator.clipboard.writeText(txt); toast('Lista copiada'); }
        catch { prompt('Copia la lista:', txt); }
      };
    }
  }

  function renderAdminParticipantes() {
    const box = $('#adm-part');
    if (!box) return;
    $('#adm-part-tit').textContent = `Participantes (${st.adminPart.length})`;
    if (!st.adminPart.length) { box.innerHTML = '<p class="muted">Nadie se ha inscrito aún.</p>'; return; }
    box.innerHTML = `<table class="tbl-mini"><thead><tr><th>Nombre</th><th>Cédula</th><th>Teléfono</th><th>Invitado por</th><th>Pron.</th><th>Pts</th><th></th></tr></thead>
      <tbody>${st.adminPart.map((x) => `<tr data-ced="${esc(x.cedula)}">
        <td>${esc(x.nombre)}</td><td>${esc(x.cedula)}</td>
        <td><a href="https://wa.me/${esc(waNum(x.telefono))}" target="_blank" rel="noopener">${esc(x.telefono)}</a></td>
        <td>${esc(invitadoTxt(x))}</td>
        <td>${x.pronosticos}</td><td><b>${x.puntos}</b></td>
        <td class="acc"><button class="btn ghost sm" data-acc="pin">PIN</button> <button class="btn danger sm" data-acc="del">✕</button></td></tr>`).join('')}</tbody></table>`;
    $$('tr[data-ced]', box).forEach((tr) => {
      const ced = tr.dataset.ced;
      const nom = st.adminPart.find((x) => x.cedula === ced)?.nombre;
      tr.querySelector('[data-acc=pin]').onclick = (ev) => {
        const pin = prompt(`Nuevo PIN para ${nom} (4 a 6 números):`);
        if (!pin) return;
        conBoton(ev.target, async () => {
          await rpc('admin_reset_pin', { p_clave: st.admin, p_cedula: ced, p_pin: pin.trim() });
          toast(`PIN de ${nom} actualizado`);
        });
      };
      tr.querySelector('[data-acc=del]').onclick = (ev) => {
        if (!confirm(`¿Eliminar a ${nom} y todos sus pronósticos? No se puede deshacer.`)) return;
        conBoton(ev.target, async () => {
          await rpc('admin_eliminar_participante', { p_clave: st.admin, p_cedula: ced });
          toast('Participante eliminado');
          await refrescarAdmin();
        });
      };
    });
  }

  // ------------------------------------------------------------------ respaldo / excel
  const sello = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date()).replace(' ', '_').replace(':', 'h');
  const fechaLocal = (iso) => (iso ? new Date(iso).toLocaleString('es-CO', { timeZone: TZ }) : '');

  function bajar(blob, nombre) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function descargarRespaldo() {
    const d = await rpc('admin_exportar', { p_clave: st.admin });
    delete d.ok;
    bajar(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), `respaldo-porra-${sello()}.json`);
    toast(`Respaldo descargado: ${d.participantes.length} participantes, ${d.pronosticos.length} pronósticos`);
  }

  let xlsxCarga = null;
  function cargarXLSX() {
    if (window.XLSX) return Promise.resolve();
    xlsxCarga = xlsxCarga || new Promise((ok, mal) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      sc.onload = ok;
      sc.onerror = () => { xlsxCarga = null; mal(new Error('No se pudo cargar el generador de Excel. Revisa tu conexión.')); };
      document.head.appendChild(sc);
    });
    return xlsxCarga;
  }

  const ptsDe = (pl, pv, rl, rv) => {
    if (rl == null || rv == null) return '';
    if (pl === rl && pv === rv) return 3;
    return Math.sign(pl - pv) === Math.sign(rl - rv) ? 1 : 0;
  };

  async function descargarExcel() {
    const [d] = await Promise.all([rpc('admin_exportar', { p_clave: st.admin }), cargarXLSX()]);
    const X = window.XLSX;
    const socios = Object.fromEntries(d.socios.map((s) => [s.id, s.nombre]));
    const pers = Object.fromEntries(d.participantes.map((x) => [x.cedula, x]));
    const parts = Object.fromEntries(d.partidos.map((m) => [m.id, m]));
    const nomPartido = (m) => `${m.local} vs ${m.visitante}`;
    const resTxt = (m) => (m.goles_local == null ? '' : `${m.goles_local}-${m.goles_visitante}`);

    // 1) Pronósticos: una fila por participante y partido
    const filas = d.pronosticos.map((pr) => {
      const m = parts[pr.partido_id] || {}, pa = pers[pr.cedula] || {};
      return {
        Participante: pa.nombre, 'Cédula': pr.cedula, Fase: m.fase, Fecha: m.jornada ?? '',
        Partido: nomPartido(m), Inicio: fechaLocal(m.inicio),
        'Pron. local': pr.goles_local, 'Pron. visitante': pr.goles_visitante,
        Resultado: resTxt(m), Puntos: ptsDe(pr.goles_local, pr.goles_visitante, m.goles_local, m.goles_visitante),
        'Guardado': fechaLocal(pr.actualizado),
      };
    }).sort((a, b) => String(a.Participante).localeCompare(String(b.Participante), 'es') || 0);

    // 2) Matriz: participantes x partidos
    const cols = d.partidos.map((m) => ({ m, k: `${nomPartido(m)} (${fmtFecha.format(new Date(m.inicio))})` }));
    const idx = {};
    d.pronosticos.forEach((pr) => { idx[pr.cedula + '|' + pr.partido_id] = pr; });
    const matriz = d.participantes.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map((pa) => {
      const r = { Participante: pa.nombre, 'Cédula': pa.cedula };
      let tot = 0;
      cols.forEach(({ m, k }) => {
        const pr = idx[pa.cedula + '|' + m.id];
        r[k] = pr ? `${pr.goles_local}-${pr.goles_visitante}` : '';
        if (pr) tot += Number(ptsDe(pr.goles_local, pr.goles_visitante, m.goles_local, m.goles_visitante)) || 0;
      });
      r.Puntos = tot;
      return r;
    });
    if (matriz.length) {
      const fr = { Participante: 'RESULTADO', 'Cédula': '' };
      cols.forEach(({ m, k }) => { fr[k] = resTxt(m); });
      fr.Puntos = '';
      matriz.unshift(fr);
    }

    // 3) Partidos y 4) Participantes
    const partidos = d.partidos.map((m) => ({
      ID: m.id, Fase: m.fase, Fecha: m.jornada ?? '', Local: m.local, Visitante: m.visitante,
      Inicio: fechaLocal(m.inicio), 'Goles local': m.goles_local ?? '', 'Goles visitante': m.goles_visitante ?? '',
      Pronósticos: d.pronosticos.filter((pr) => pr.partido_id === m.id).length,
    }));
    const participantes = d.participantes.map((x) => ({
      Nombre: x.nombre, 'Cédula': x.cedula, 'Teléfono': x.telefono,
      Tipo: x.tipo || '', 'Invitado por': x.tipo === 'socio' ? 'Socio(a)' : (socios[x.invitado_por] || ''),
      Inscrito: fechaLocal(x.creado),
    }));

    const wb = X.utils.book_new();
    const hoja = (datos, nombre, anchos) => {
      const ws = X.utils.json_to_sheet(datos.length ? datos : [{ '(sin datos)': '' }]);
      if (anchos) ws['!cols'] = anchos.map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, ws, nombre);
    };
    hoja(filas, 'Pronósticos', [28, 12, 12, 7, 34, 20, 11, 14, 10, 7, 20]);
    hoja(matriz, 'Matriz', [28, 12, ...cols.map(() => 18), 8]);
    hoja(partidos, 'Partidos', [6, 12, 7, 18, 18, 20, 11, 14, 12]);
    hoja(participantes, 'Participantes', [28, 12, 12, 9, 26, 20]);
    X.writeFile(wb, `pronosticos-porra-${sello()}.xlsx`);
    toast(`Excel descargado: ${d.pronosticos.length} pronósticos`);
  }

  function descargarCSV() {
    const filas = [['Nombre', 'Cedula', 'Telefono', 'Invitado por', 'Pronosticos', 'Puntos', 'Inscrito']]
      .concat(st.adminPart.map((x) => [x.nombre, x.cedula, x.telefono, invitadoTxt(x), x.pronosticos, x.puntos, new Date(x.creado).toLocaleString('es-CO', { timeZone: TZ })]));
    const csv = filas.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'participantes-porra.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ navegación
  function mostrarTab(tab) {
    st.tab = tab;
    $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.vista').forEach((v) => (v.hidden = v.id !== 'v-' + tab));
    if (tab === 'tabla') renderTabla();
    if (tab === 'admin') renderAdmin();
    if (tab === 'partidos') renderPartidos();
    actualizarSavebar();
    window.scrollTo({ top: 0 });
  }

  function renderTodo() {
    renderCuenta();
    renderPartidos();
    actualizarSavebar();
  }

  function adminVisible() {
    const v = location.hash === '#admin' || !!st.admin;
    $('.tab[data-tab=admin]').hidden = !v;
    return v;
  }

  // ------------------------------------------------------------------ eventos
  $$('.tab').forEach((b) => (b.onclick = () => mostrarTab(b.dataset.tab)));
  $$('[data-filtro]').forEach((b) => (b.onclick = () => { st.filtro = b.dataset.filtro; renderPartidos(); }));
  $('#btn-guardar').onclick = guardar;

  $('#lista').addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el.matches('input[data-id]')) return;
    if (el.value.length > 2) el.value = el.value.slice(0, 2);
    const id = el.dataset.id;
    st.draft[id] = { ...(st.draft[id] || {}), [el.dataset.lado]: el.value.replace(/\D/g, '') };
    const m = st.mios[id];
    el.classList.toggle('cambio', m ? el.value !== String(m[el.dataset.lado]) : el.value !== '');
    actualizarSavebar();
  });

  $('#lista').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-ver]');
    if (!b) return;
    const id = Number(b.dataset.ver);
    if (st.verOtros.has(id)) { st.verOtros.delete(id); renderPartidos(); return; }
    st.verOtros.add(id);
    renderPartidos();
    try { await cargarPublicos(); } catch (e) { toast(e.message, 'error'); }
    renderPartidos();
  });

  window.addEventListener('beforeunload', (ev) => {
    if (pendientes().length) { ev.preventDefault(); ev.returnValue = ''; }
  });
  window.addEventListener('hashchange', () => { if (adminVisible() && location.hash === '#admin') mostrarTab('admin'); });

  // Reloj: actualiza los contadores y bloquea los partidos que llegan al cierre.
  setInterval(() => {
    // En Posiciones: cuando un partido cierra (o recibe resultado) se recarga la tabla.
    if (st.tab === 'tabla') {
      if (firmaEnJuego() !== tablaFirma) renderTabla(true);
      return;
    }
    if (st.tab !== 'partidos') return;
    let cambio = false;
    for (const el of $$('#lista .match')) {
      const p = st.partidos.find((x) => String(x.id) === el.dataset.pid);
      if (!p) continue;
      if (estado(p) !== el.dataset.estado) { cambio = true; break; }
      const [txt, cls] = badge(p);
      const bd = el.querySelector('[data-badge]');
      bd.textContent = txt; bd.className = 'badge ' + cls;
    }
    if (cambio) { renderPartidos(); toast('Un partido acaba de cerrar sus pronósticos.'); }
  }, 10000);

  // Refresca resultados cada 2 minutos (sin interrumpir si alguien está escribiendo).
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const antes = JSON.stringify(st.partidos);
      await cargarPartidos();
      const escribiendo = document.activeElement && document.activeElement.matches('#lista input');
      if (JSON.stringify(st.partidos) !== antes && st.tab === 'partidos' && !escribiendo) renderPartidos();
      if (JSON.stringify(st.partidos) !== antes && st.tab === 'tabla') renderTabla(true);
      if (st.publicos) st.publicosAt = 0;
    } catch { /* sin conexión: se intenta de nuevo luego */ }
  }, 120000);

  // ------------------------------------------------------------------ inicio
  (async function iniciar() {
    st.admin = store.sget('porra_admin');
    adminVisible();
    try {
      await cargarPartidos();
    } catch (e) {
      $('#lista').innerHTML = `<div class="card vacio">No se pudieron cargar los partidos: ${esc(e.message)}</div>`;
    }
    const s = store.get('porra_sesion');
    if (s && s.cedula && s.pin) {
      try {
        const r = await rpc('ingresar', { p_cedula: s.cedula, p_pin: s.pin });
        st.sesion = { ...s, nombre: r.nombre };
        aplicarMios(r.pronosticos);
      } catch (e) {
        store.set('porra_sesion', null);
        toast('Vuelve a ingresar: ' + e.message, 'error');
      }
    }
    renderTodo();
    if (location.hash === '#admin') mostrarTab('admin');
  })();
})();
