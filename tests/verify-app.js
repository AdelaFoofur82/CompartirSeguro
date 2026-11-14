// Pruebas de la app real montada en jsdom: crear enlace, desbloquear, copiar,
// caducidad y registro de aperturas. Uso: node tests/verify-app.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { JSDOM, VirtualConsole } = require('jsdom');
const { webcrypto } = require('node:crypto');
const { Blob } = require('node:buffer');

const html0 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const vueSrc = fs.readFileSync(path.join(ROOT, 'node_modules/vue/dist/vue.global.js'), 'utf8');
const appSrc = html0.match(/<script>([\s\S]*?)<\/script>/)[1];
const html = html0
  .replace('<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js"></script>', '')
  .replace(/<script>[\s\S]*?<\/script>/, '');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Construye un enlace a mano con el formato real: [0x01][len meta][meta JSON][payload]
async function makeLink(payloadText, password, metaExtra = {}) {
  const enc = new TextEncoder();
  const meta = Object.assign({ v: 1, type: 'fields' }, metaExtra);
  const metaBytes = enc.encode(JSON.stringify(meta));
  const payload = enc.encode(payloadText);
  const raw = new Uint8Array(1 + 4 + metaBytes.length + payload.length);
  raw[0] = 0x01;
  new DataView(raw.buffer).setUint32(1, metaBytes.length);
  raw.set(metaBytes, 5);
  raw.set(payload, 5 + metaBytes.length);

  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await webcrypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw));
  const out = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  const b64 = Buffer.from(out).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'https://adelafoofur82.github.io/CompartirSeguro/?s=' + b64;
}
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (info ? ' :: ' + info : '')); };

function makePage(url, seedShares, ua, withShare) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.log('JSDOM ERROR:', e.message));
  const opts = { url, runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true };
  const dom = new JSDOM(html, opts);
  const w = dom.window;
  if (ua) Object.defineProperty(w.navigator, 'userAgent', { value: ua, configurable: true });
  const shared = [];
  if (withShare) {
    Object.defineProperty(w.navigator, 'share', {
      value: async (data) => { shared.push(data); }, configurable: true
    });
  }
  Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
  w.Blob = Blob;
  w.Response = globalThis.Response;
  w.CompressionStream = globalThis.CompressionStream;
  w.DecompressionStream = globalThis.DecompressionStream;
  const clip = { text: null };
  Object.defineProperty(w.navigator, 'clipboard', {
    value: { writeText: async t => { clip.text = t; }, readText: async () => clip.text }, configurable: true
  });
  w.alert = msg => console.log('ALERT:', msg);
  w.confirm = () => true;
  if (seedShares) w.localStorage.setItem('secure_share_history_v1', JSON.stringify(seedShares));
  w.eval(vueSrc);
  w.eval(appSrc);
  return { w, clip, shared };
}

const setVal = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

async function generar(w, { texto, expValue, nombre }) {
  const selTipo = [...w.document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'file'));
  selTipo.value = 'text';
  selTipo.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(120);
  setVal(w, w.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  if (nombre) setVal(w, w.document.querySelector('input[placeholder="Ej: Clave WiFi casa"]'), nombre);
  setVal(w, [...w.document.querySelectorAll('textarea')].find(t => t.placeholder === 'Escribe el secreto...') || w.document.querySelector('textarea'), texto);
  await sleep(500); // debounce de la estimación + gzip
  const btn = [...w.document.querySelectorAll('button')].find(b => b.textContent.includes('Generar Enlace'));
  btn.click();
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const inp = [...w.document.querySelectorAll('input[readonly]')].find(x => x.value.startsWith('http'));
    if (inp && inp.value.length > 50) return { url: inp.value, disabled: btn.disabled };
  }
  return { url: '', disabled: btn.disabled };
}

(async () => {
  // ---------- A. Crear con texto compresible y caducidad de 10 min ----------
  const { w: A } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(500);
  check('aviso de compresion visible', A.document.body.textContent.includes('Se comprime antes de cifrar'));

  const texto = 'Clave del WiFi: correcto-caballo-bateria-grapa. '.repeat(80); // ~3.900 chars comprimibles
  const { url: urlA } = await generar(A, { texto, nombre: 'Gzip sin caducidad' });
  check('enlace grande comprimido generado', urlA.length > 50, urlA.length + ' chars');
  check('el enlace usa ?s= (no hash)', /\?s=[A-Za-z0-9_-]+$/.test(urlA), urlA.slice(0, 70));
  check('enlace por debajo del limite del servidor (8192)', urlA.length <= 8192, urlA.length);
  const entrada = JSON.parse(A.localStorage.getItem('secure_share_history_v1'))[0] || {};
  check('historial marca comprimido', entrada.compressed === true, 'raw=' + entrada.size + ' B, empaquetado=' + entrada.packedSize + ' B');
  check('compresion real (>=2x)', entrada.packedSize * 2 < entrada.size, (entrada.size / entrada.packedSize).toFixed(1) + 'x');

  // ---------- B. Abrir el enlace antes de caducar ----------
  const { w: B, clip } = makePage(urlA, [entrada]);
  await sleep(500);
  setVal(B, B.document.querySelector('input[type="password"]'), 'clave-segura-123');
  [...B.document.querySelectorAll('button')].find(b => b.textContent.includes('Desbloquear')).click();
  let pre = null;
  for (let i = 0; i < 120; i++) { await sleep(100); const bl = B.document.querySelector('.border.rounded.p-2'); pre = bl ? (bl.querySelector('pre') || bl.querySelector('input')) : null; if (pre) break; }
  const bloqueA = B.document.querySelector('.border.rounded.p-2');
  const valorA = bloqueA ? (bloqueA.querySelector('pre') || bloqueA.querySelector('input')) : null;
  const textoA = valorA ? (valorA.value !== undefined ? valorA.value : valorA.textContent) : '';
  check('texto descomprimido identico', textoA.trim() === texto.trim(), textoA.length + ' chars');

  const copyBtn = [...B.document.querySelectorAll('button')].find(b => b.textContent.includes('Copiar'));
  copyBtn.click(); await sleep(150);
  check('copiar texto comprimido', clip.text === texto, clip.text ? clip.text.length + ' chars' : 'nada');

  const abierta = JSON.parse(B.localStorage.getItem('secure_share_history_v1'))[0] || {};
  check('apertura registrada en historial', abierta.openCount === 1 && !!abierta.openedAt, 'openCount=' + abierta.openCount);

  // ---------- C. Historial: badges de caducidad y apertura ----------
  const { w: C } = makePage('https://adelafoofur82.github.io/CompartirSeguro/', [abierta]);
  await sleep(500);
  [...C.document.querySelectorAll('button')].find(b => b.textContent.includes('Mis compartidos')).click();
  await sleep(100);
  const histTxt = C.document.body.textContent.replace(/\s+/g, ' ');
  check('badge "Abierto 1 vez" en historial', /Abierto 1 vez/.test(histTxt));
  check('aviso de que solo ve este navegador', histTxt.includes('solo ve las que ocurren en este mismo navegador'));

  // ---------- D. Un enlace antiguo con fecha de caducidad se abre igual ----------
  const viejoConExp = await makeLink(JSON.stringify([{ label: 'Email', value: 'viejo@ejemplo.com' }]),
    'clave-segura-123', { type: 'fields', exp: Date.now() - 86400000 });
  const { w: D } = makePage(viejoConExp, []);
  await sleep(500);
  setVal(D, D.document.querySelector('input[type="password"]'), 'clave-segura-123');
  [...D.document.querySelectorAll('button')].find(b => b.textContent.includes('Desbloquear')).click();
  for (let i = 0; i < 120; i++) { await sleep(100); if (D.document.querySelectorAll('.campo-label').length) break; }
  check('enlace antiguo con exp caducada sigue abriendo', D.document.body.textContent.includes('viejo@ejemplo.com'));
  check('ya no se habla de caducidad en la interfaz', !/caduc/i.test(D.document.body.textContent));

  // ---------- E. Contenido incompresible demasiado grande: boton bloqueado ----------
  const { w: E } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(400);
  const azar = Array.from(webcrypto.getRandomValues(new Uint8Array(9000))).map(b => (b % 26 + 10).toString(36)).join('');
  setVal(E, E.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  setVal(E, E.document.querySelector('textarea'), azar);
  await sleep(900);
  const eBtn = [...E.document.querySelectorAll('button')].find(b => b.textContent.includes('Generar Enlace'));
  check('texto aleatorio de 9000 chars bloquea el boton', eBtn.disabled === true,
    'disabled=' + eBtn.disabled + ' | ' + E.document.body.textContent.replace(/\s+/g, ' ').match(/[\d.,]+ [KMB]+ \/ [\d.,]+ [KMB]+/));

  // ---------- H. Banner "Úsame" en la página de ver ----------
  const { w: H } = makePage(urlA, [entrada]);
  await sleep(500);
  const banner = [...H.document.querySelectorAll('.alert')].find(a => a.textContent.includes('Úsame para compartir tus secretos'));
  check('banner "Úsame" en la pagina de ver', !!banner);
  const cta = banner && banner.querySelector('a');
  check('CTA del banner lleva a crear (sin hash)',
    cta && cta.getAttribute('href') === 'https://adelafoofur82.github.io/CompartirSeguro/',
    cta && cta.getAttribute('href'));

  // ---------- I. Botón "Instálame" ----------
  const { w: I } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(500);
  const hayBoton = () => [...I.document.querySelectorAll('button')].some(b => b.textContent.includes('Instálame'));
  check('boton Instalame oculto sin evento del navegador', !hayBoton());
  let prompted = 0;
  const ev = new I.Event('beforeinstallprompt');
  ev.prompt = async () => { prompted++; };
  ev.userChoice = Promise.resolve({ outcome: 'accepted' });
  I.dispatchEvent(ev);
  await sleep(120);
  check('boton Instalame aparece con beforeinstallprompt', hayBoton());
  [...I.document.querySelectorAll('button')].find(b => b.textContent.includes('Instálame')).click();
  await sleep(250);
  check('lanza el prompt nativo', prompted === 1, 'prompt()=' + prompted);
  check('se oculta tras lanzar la instalacion', !hayBoton());

  // ---------- J. Logo y favicon del monito ----------
  const { w: J } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(400);
  const favs = [...J.document.querySelectorAll('link[rel="icon"]')].map(l => l.getAttribute('href'));
  check('favicon SVG del monito', favs.includes('icon.svg'), JSON.stringify(favs));
  const logo = J.document.querySelector('img[src="icon.svg"]');
  check('logo del monito en la cabecera', !!logo && logo.getAttribute('width') === '40');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const srcs = manifest.icons.map(i => i.src);
  check('manifest declara el SVG', srcs.includes('icon.svg'), JSON.stringify(srcs));
  check('manifest declara PNG 192 y 512', srcs.includes('icons/icon-192.png') && srcs.includes('icons/icon-512.png'));
  for (const f of ['icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']) {
    const p = path.join(ROOT, f);
    const ok = fs.existsSync(p) && (f.endsWith('.svg') || fs.readFileSync(p).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    check('existe y es valido: ' + f, ok);
  }

  const elegirTipo = (w, valor) => {
    const sel = [...w.document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'file'));
    sel.value = valor;
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  };

  // ---------- K. Varios campos: email + contraseña + URL ----------
  const { w: K } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(500);
  const setK = (el, v) => { el.value = v; el.dispatchEvent(new K.Event('input', { bubbles: true })); };
  check('dos campos por defecto', K.document.querySelectorAll('textarea').length === 2,
    'textareas=' + K.document.querySelectorAll('textarea').length);
  setK(K.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  const labels = K.document.querySelectorAll('input[placeholder^="Nombre"]');
  const tAs = K.document.querySelectorAll('textarea');
  setK(labels[0], 'Email');
  setK(tAs[0], 'adela@ejemplo.com');
  setK(labels[1], 'Contraseña');
  setK(tAs[1], 'P@ssw0rd-ñ-123');
  // tercer campo de tipo texto
  [...K.document.querySelectorAll('button')].find(b => b.textContent.includes('Añadir campo')).click();
  await sleep(80);
  check('añadir campo crea un tercero', K.document.querySelectorAll('textarea').length === 3,
    'textareas=' + K.document.querySelectorAll('textarea').length);
  // (se comprueba después de escribir la URL)
  const labels3 = K.document.querySelectorAll('input[placeholder^="Nombre"]');
  setK(labels3[2], 'Nota');
  setK(K.document.querySelectorAll('textarea')[2], 'válido hasta el viernes');
  [...K.document.querySelectorAll('button')].find(b => b.textContent.includes('Añadir campo')).click();
  await sleep(80);
  const labels4 = K.document.querySelectorAll('input[placeholder^="Nombre"]');
  setK(labels4[3], 'Web');
  setK(K.document.querySelectorAll('textarea')[3], 'https://ejemplo.com/login?x=1');
  await sleep(120);
  check('detecta la URL al escribirla', K.document.body.textContent.includes('🔗 enlace'));
  // limite de campos: no se puede pasar de MAX_FIELDS
  const addBtnK = () => [...K.document.querySelectorAll('button')].find(b => b.textContent.includes('Añadir campo'));
  for (let n = 0; n < 12; n++) { if (!addBtnK().disabled) { addBtnK().click(); await sleep(30); } }
  check('tope de campos respetado', K.document.querySelectorAll('textarea').length === 10,
    'textareas=' + K.document.querySelectorAll('textarea').length);
  check('aviso de maximo alcanzado', K.document.body.textContent.includes('Máximo alcanzado'));
  // quitar campos extra hasta dejar los 4 con datos
  for (let n = 0; n < 6; n++) {
    const dels = [...K.document.querySelectorAll('button')].filter(b => b.title === 'Quitar este campo');
    dels[dels.length - 1].click();
    await sleep(30);
  }
  check('quitar campos deja los 4 con datos', K.document.querySelectorAll('textarea').length === 4,
    'textareas=' + K.document.querySelectorAll('textarea').length);
  check('sin selector de tipo por campo', ![...K.document.querySelectorAll('select')].some(s => s.textContent.includes('Contraseña')));
  check('sin checkbox de URL manual', !K.document.querySelector('input[type="checkbox"]'));
  await sleep(700);
  let urlK = '';
  [...K.document.querySelectorAll('button')].find(b => b.textContent.includes('Generar Enlace')).click();
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const inp = [...K.document.querySelectorAll('input[readonly]')].find(x => x.value.startsWith('http'));
    if (inp && inp.value.length > 50) { urlK = inp.value; break; }
  }
  check('enlace multi-campo generado', urlK.length > 50, urlK.length + ' chars');
  const entradaK = (JSON.parse(K.localStorage.getItem('secure_share_history_v1')) || []).pop() || {};
  check('historial guarda 4 campos', entradaK.fieldCount === 4, 'fieldCount=' + entradaK.fieldCount);
  check('historial marca tipo fields', entradaK.type === 'fields', 'type=' + entradaK.type);
  const camposLimpiados = K.document.querySelectorAll('textarea').length;
  check('el formulario se vacia tras generar', camposLimpiados === 2 &&
    [...K.document.querySelectorAll('textarea')].every(t => t.value === ''), 'textareas=' + camposLimpiados);

  const { w: L, clip: clipL } = makePage(urlK, [entradaK]);
  await sleep(500);
  setK.call(null, L.document.querySelector('input[type="password"]'), 'clave-segura-123');
  [...L.document.querySelectorAll('button')].find(b => b.textContent.includes('Desbloquear')).click();
  for (let i = 0; i < 120; i++) { await sleep(100); if (L.document.querySelectorAll('.campo-label').length) break; }
  const txtL = L.document.body.textContent.replace(/\s+/g, ' ');
  check('campos descifrados', !!txtL.includes('válido hasta el viernes'), txtL.slice(txtL.indexOf('Mensaje:'), txtL.indexOf('Mensaje:') + 160));
  check('etiqueta Email visible', txtL.includes('Email'));
  check('etiqueta Contraseña visible', txtL.includes('Contraseña'));
  check('etiqueta Nota visible', txtL.includes('Nota'));
  check('los campos no llegan enmascarados', !L.document.querySelector('input[type="password"][readonly]'));
  const linkAbrir = [...L.document.querySelectorAll('a')].find(a => a.textContent.includes('Abrir'));
  check('boton Abrir para la URL', !!linkAbrir && linkAbrir.getAttribute('href') === 'https://ejemplo.com/login?x=1',
    linkAbrir && linkAbrir.getAttribute('href'));
  check('URL tambien como enlace clicable', !!L.document.querySelector('a.text-break[href^="https://ejemplo.com"]'));
  check('URL automatica sin marcar nada', txtL.includes('Abrir'));

  // Copiar cada campo por separado
  const rows = [...L.document.querySelectorAll('.campo-label')];
  check('cuatro bloques de campo', rows.length === 4, 'bloques=' + rows.length);
  const filaDe = (nombre) => [...L.document.querySelectorAll('.campo-label')]
    .find(r => r.textContent.trim() === nombre);
  const bloqueDe = (nombre) => filaDe(nombre) && filaDe(nombre).closest('.border.rounded.p-2');
  const botonDe = (nombre) => {
    const row = bloqueDe(nombre);
    return row && [...row.querySelectorAll('button')].find(b => b.textContent.includes('Copiar'));
  };
  botonDe('Email').click(); await sleep(150);
  check('copiar solo el email', clipL.text === 'adela@ejemplo.com', JSON.stringify(clipL.text));
  const fbEmail = bloqueDe('Email') ? bloqueDe('Email').querySelector('button.btn-success') : null;
  check('feedback en el boton del campo', !!fbEmail && fbEmail.textContent.includes('Copiado'),
    fbEmail && fbEmail.textContent.trim());
  botonDe('Contraseña').click(); await sleep(150);
  check('copiar solo la contrasena', clipL.text === 'P@ssw0rd-ñ-123', JSON.stringify(clipL.text));
  botonDe('Nota').click(); await sleep(150);
  check('copiar solo la nota', clipL.text === 'válido hasta el viernes', JSON.stringify(clipL.text));

  // Copiar todo
  [...L.document.querySelectorAll('button')].find(b => b.textContent.includes('Copiar todo')).click();
  await sleep(150);
  const todo = clipL.text || '';
  check('copiar todo junta los campos',
    todo.includes('Email: adela@ejemplo.com') && todo.includes('Contraseña: P@ssw0rd-ñ-123') &&
    todo.includes('Nota: válido hasta el viernes') && todo.includes('Web: https://ejemplo.com/login?x=1'),
    JSON.stringify(todo));

  // ---------- L. Compatibilidad con un enlace viejo de un solo texto ----------
  const { w: M } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(500);
  const setM = (el, v) => { el.value = v; el.dispatchEvent(new M.Event('input', { bubbles: true })); };
  elegirTipo(M, 'text');
  await sleep(150);
  setM(M.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  const taTexto = [...M.document.querySelectorAll('textarea')].find(t => t.placeholder === 'Escribe el secreto...');
  check('modo texto libre tiene su textarea', !!taTexto);
  setM(taTexto, 'texto suelto sin etiqueta');
  await sleep(700);
  [...M.document.querySelectorAll('button')].find(b => b.textContent.includes('Generar Enlace')).click();
  let urlM = '';
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const inp = [...M.document.querySelectorAll('input[readonly]')].find(x => x.value.startsWith('http'));
    if (inp && inp.value.length > 50) { urlM = inp.value; break; }
  }
  const { w: N } = makePage(urlM, []);
  await sleep(500);
  setM.call(null, N.document.querySelector('input[type="password"]'), 'clave-segura-123');
  [...N.document.querySelectorAll('button')].find(b => b.textContent.includes('Desbloquear')).click();
  for (let i = 0; i < 120; i++) { await sleep(100); if (N.document.body.textContent.includes('texto suelto')) break; }
  const txtN = N.document.body.textContent.replace(/\s+/g, ' ');
  const preN = N.document.querySelector('pre');
  const campoN = [...N.document.querySelectorAll('input[type="password"][readonly]')].map(i => i.value).join('');
  check('texto unico se ve como bloque unico',
    (preN && preN.textContent.includes('texto suelto sin etiqueta')) || campoN.includes('texto suelto sin etiqueta'),
    (preN && preN.textContent.slice(0, 40)) + ' | ' + campoN.slice(0, 40));
  check('texto unico ofrece copiar', [...N.document.querySelectorAll('button')].some(b => b.textContent.includes('Copiar')));
  check('texto unico no dice "Copiar todo"', !txtN.includes('Copiar todo'));

  // ---------- P. Selector de archivo (escritorio y Android) ----------
  const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

  const { w: P } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(400);
  const selTipoP = [...P.document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'file'));
  selTipoP.value = 'file';
  selTipoP.dispatchEvent(new P.Event('change', { bubbles: true }));
  await sleep(150);
  const fileInput = P.document.querySelector('input[type="file"]');
  check('escritorio: selector de archivo visible', !!fileInput && !fileInput.classList.contains('d-none'));
  check('escritorio: sin filtro de tipo',
    !!fileInput && (!fileInput.hasAttribute('accept') || fileInput.getAttribute('accept') === 'null'),
    fileInput && fileInput.getAttribute('accept'));
  check('escritorio: sin botones de Android',
    ![...P.document.querySelectorAll('button')].some(b => b.textContent.includes('Elegir desde Archivos')));
  check('explica que el limite es el tamano', P.document.body.textContent.includes('Cualquier tipo de archivo, sin filtro de extensión'));

  const { w: Q } = makePage('https://adelafoofur82.github.io/CompartirSeguro/', [], UA_ANDROID);
  await sleep(500);
  const selTipoQ = [...Q.document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'file'));
  selTipoQ.value = 'file';
  selTipoQ.dispatchEvent(new Q.Event('change', { bubbles: true }));
  await sleep(150);
  const btnArchivos = [...Q.document.querySelectorAll('button')].find(b => b.textContent.includes('Elegir desde Archivos'));
  check('Android: boton "Elegir desde Archivos"', !!btnArchivos);
  check('Android: alternativa de galeria',
    [...Q.document.querySelectorAll('button')].some(b => b.textContent.includes('galería')));

  // El click real tiene que acabar en un input habilitado (uno disabled ignora click())
  let clicks = [];
  Q.HTMLInputElement.prototype.click = function () {
    clicks.push({ accept: this.getAttribute('accept'), disabled: this.disabled, hidden: this.classList.contains('d-none') });
  };
  const inputQ = () => Q.document.querySelector('input[type="file"]');
  check('Android: el input esta oculto pero habilitado',
    inputQ().classList.contains('d-none') && inputQ().disabled === false,
    'hidden=' + inputQ().classList.contains('d-none') + ' disabled=' + inputQ().disabled);

  btnArchivos.click();
  await sleep(150);
  check('Android: pulsar "Archivos" abre el selector', clicks.length === 1, 'clicks=' + clicks.length);
  check('Android: con accept */*', clicks[0] && clicks[0].accept === '*/*', clicks[0] && clicks[0].accept);
  check('Android: input habilitado en el click', clicks[0] && clicks[0].disabled === false);
  check('Android: el input visible ya lleva accept */*', inputQ().getAttribute('accept') === '*/*', inputQ().getAttribute('accept'));

  // Elegir fichero de verdad: adjuntar uno al input y comprobar que la app lo recoge
  const file = new Q.File(['hola'], 'nota.txt', { type: 'text/plain' });
  Object.defineProperty(inputQ(), 'files', { value: [file], configurable: true });
  inputQ().dispatchEvent(new Q.Event('change', { bubbles: true }));
  await sleep(200);
  check('Android: el archivo elegido se muestra', Q.document.body.textContent.includes('nota.txt'),
    Q.document.body.textContent.match(/[^ ]+\.(txt|pdf)[^ ]*/));

  [...Q.document.querySelectorAll('button')].find(b => b.textContent.includes('galería')).click();
  await sleep(150);
  check('Android: "galeria" relanza el input', clicks.length === 2, 'clicks=' + clicks.length);
  check('Android: galeria sin accept', clicks[1] && (clicks[1].accept === null || clicks[1].accept === 'null'),
    clicks[1] && clicks[1].accept);

  // ---------- S. Compartir con Web Share ----------
  const { w: S, shared } = makePage('https://adelafoofur82.github.io/CompartirSeguro/', [], null, true);
  await sleep(500);
  setVal(S, S.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  setVal(S, S.document.querySelectorAll('textarea')[0], 'comparte esto');
  await sleep(600);
  [...S.document.querySelectorAll('button')].find(b => b.textContent.includes('Generar Enlace')).click();
  let urlS = '';
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const inp = [...S.document.querySelectorAll('input[readonly]')].find(x => x.value.startsWith('http'));
    if (inp) { urlS = inp.value; break; }
  }
  const btnCompartir = () => [...S.document.querySelectorAll('button')].find(b => b.textContent.includes('Compartir'));
  check('con Web Share: boton Compartir visible junto al enlace', !!btnCompartir());
  btnCompartir().click();
  await sleep(200);
  check('compartir envia la url por navigator.share', shared.length === 1 && shared[0].url === urlS,
    shared.length ? shared[0].url.slice(0, 50) : 'no se llamó');
  check('compartir manda texto ademas de la url', !!(shared[0] && shared[0].text), shared[0] && shared[0].text);
  check('compartir conserva el enlace en el campo', [...S.document.querySelectorAll('input[readonly]')].some(i => i.value === urlS));

  // En el historial tambien hay boton de compartir
  [...S.document.querySelectorAll('button')].find(b => b.textContent.includes('Mis compartidos')).click();
  await sleep(120);
  check('historial: boton compartir por enlace',
    [...S.document.querySelectorAll('button')].some(b => b.title === 'Compartir'));

  // Sin soporte: no se muestra nada
  const { w: T } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(400);
  check('sin Web Share: no hay boton Compartir',
    ![...T.document.querySelectorAll('button')].some(b => b.textContent.includes('Compartir')));

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' comprobaciones OK');
  process.exit(failed.length ? 1 : 0);
})();
