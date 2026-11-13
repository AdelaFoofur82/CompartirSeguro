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
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (info ? ' :: ' + info : '')); };

function makePage(url, seedShares) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => console.log('JSDOM ERROR:', e.message));
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', virtualConsole: vc, pretendToBeVisual: true });
  const w = dom.window;
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
  return { w, clip };
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
  if (expValue !== undefined) {
    const sel = [...w.document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.includes('Sin caducidad')));
    sel.value = String(expValue);
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
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
  const { url: urlA } = await generar(A, { texto, expValue: 600000, nombre: 'Gzip + caducidad' });
  check('enlace grande comprimido generado', urlA.length > 50, urlA.length + ' chars');
  check('enlace cabe en Telegram', urlA.length <= 4096, urlA.length);
  const entrada = JSON.parse(A.localStorage.getItem('secure_share_history_v1'))[0] || {};
  check('historial marca comprimido', entrada.compressed === true, 'raw=' + entrada.size + ' B, empaquetado=' + entrada.packedSize + ' B');
  check('compresion real (>=2x)', entrada.packedSize * 2 < entrada.size, (entrada.size / entrada.packedSize).toFixed(1) + 'x');
  check('historial guarda caducidad', entrada.exp > Date.now() + 500000 && entrada.exp < Date.now() + 700000, new Date(entrada.exp).toISOString());
  check('caducidad por defecto NO es la elegida', entrada.exp - Date.now() < 11 * 60 * 1000);

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
  check('aviso de caducidad al abrir', B.document.body.textContent.includes('Caduca el'));

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
  check('badge "Caduca" en historial', /Caduca: /.test(histTxt));
  check('badge "Abierto 1 vez" en historial', /Abierto 1 vez/.test(histTxt));
  check('aviso de que solo ve este navegador', histTxt.includes('solo ve las que ocurren en este mismo navegador'));

  // ---------- D. Enlace caducado (reloj +11 min) ----------
  const { w: D } = makePage(urlA, [abierta]);
  const realNow = Date.now.bind(Date);
  await sleep(500);
  D.Date.now = () => realNow() + 11 * 60 * 1000;
  setVal(D, D.document.querySelector('input[type="password"]'), 'clave-segura-123');
  [...D.document.querySelectorAll('button')].find(b => b.textContent.includes('Desbloquear')).click();
  await sleep(2500);
  const dTxt = D.document.body.textContent.replace(/\s+/g, ' ');
  check('aviso de caducado', /Este secreto caducó el /.test(dTxt), dTxt.slice(0, 90));
  check('no muestra el contenido caducado', !D.document.querySelector('.border.rounded.p-2'));
  check('oculta el formulario tras caducar', ![...D.document.querySelectorAll('button')].some(b => b.textContent.includes('Desbloquear')));

  // ---------- E. Contenido incompresible demasiado grande: boton bloqueado ----------
  const { w: E } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(400);
  const azar = Array.from(webcrypto.getRandomValues(new Uint8Array(4000))).map(b => (b % 26 + 10).toString(36)).join('');
  setVal(E, E.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  setVal(E, E.document.querySelector('textarea'), azar);
  await sleep(900);
  const eBtn = [...E.document.querySelectorAll('button')].find(b => b.textContent.includes('Generar Enlace'));
  check('texto aleatorio de 4000 chars bloquea el boton', eBtn.disabled === true, 'disabled=' + eBtn.disabled);

  // ---------- F. Sin caducidad ----------
  const { w: F } = makePage('https://adelafoofur82.github.io/CompartirSeguro/');
  await sleep(400);
  const { url: urlF } = await generar(F, { texto: 'solo un texto corto sin caducidad', expValue: 0 });
  const entradaF = JSON.parse(F.localStorage.getItem('secure_share_history_v1'))[0] || {};
  check('opcion sin caducidad no fija exp', urlF.length > 50 && !entradaF.exp, 'exp=' + entradaF.exp);
  const { w: G } = makePage(urlF, [entradaF]);
  await sleep(500);
  setVal(G, G.document.querySelector('input[type="password"]'), 'clave-segura-123');
  [...G.document.querySelectorAll('button')].find(b => b.textContent.includes('Desbloquear')).click();
  for (let i = 0; i < 120; i++) { await sleep(100); if (G.document.querySelector('.border.rounded.p-2')) break; }
  check('enlace sin caducidad abre igual', !!G.document.querySelector('.border.rounded.p-2') && G.document.body.textContent.includes('Sin caducidad.'),
    G.document.body.textContent.replace(/\s+/g, ' ').slice(0, 160));

  // ---------- H. Banner "Úsame" en la página de ver ----------
  const { w: H } = makePage(urlF, [entradaF]);
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
  check('detecta la URL al escribirla', K.document.body.textContent.includes('detectada ✓'));
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
  // marcar el segundo como contraseña
  const kinds = [...K.document.querySelectorAll('select')].filter(s => [...s.options].some(o => o.value === 'password'));
  check('selector de tipo por campo', kinds.length === 4, 'selects=' + kinds.length);
  const k2 = kinds[1];
  k2.value = 'password';
  k2.dispatchEvent(new K.Event('change', { bubbles: true }));
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
  check('campo password llega oculto', !!L.document.querySelector('input[type="password"][readonly]'));
  const linkAbrir = [...L.document.querySelectorAll('a')].find(a => a.textContent.includes('Abrir'));
  check('boton Abrir para la URL', !!linkAbrir && linkAbrir.getAttribute('href') === 'https://ejemplo.com/login?x=1',
    linkAbrir && linkAbrir.getAttribute('href'));
  check('URL tambien como enlace clicable', !!L.document.querySelector('a.text-break[href^="https://ejemplo.com"]'));
  check('aviso de contraseña oculta', txtL.includes('Contraseña oculta por si alguien mira la pantalla'));

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

  // Mostrar la contraseña del campo
  const rowPwd = bloqueDe('Contraseña');
  [...rowPwd.querySelectorAll('button')].find(b => b.textContent.includes('👁️')).click();
  await sleep(120);
  const visible = [...rowPwd.querySelectorAll('input')].some(i => i.type === 'text' && i.value === 'P@ssw0rd-ñ-123');
  check('ojo revela la contrasena del campo', visible);

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

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' comprobaciones OK');
  process.exit(failed.length ? 1 : 0);
})();
