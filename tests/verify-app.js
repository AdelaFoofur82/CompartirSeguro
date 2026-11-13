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
  setVal(w, w.document.querySelector('input[placeholder="Mínimo 4 caracteres"]'), 'clave-segura-123');
  if (nombre) setVal(w, w.document.querySelector('input[placeholder="Ej: Clave WiFi casa"]'), nombre);
  setVal(w, w.document.querySelector('textarea'), texto);
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
  for (let i = 0; i < 120; i++) { await sleep(100); pre = B.document.querySelector('pre'); if (pre && pre.textContent.length > 20) break; }
  check('texto descomprimido identico', pre && pre.textContent.trim() === texto.trim(), pre ? pre.textContent.length + ' chars' : 'sin <pre>');
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
  check('no muestra el contenido caducado', !D.document.querySelector('pre'));
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
  for (let i = 0; i < 120; i++) { await sleep(100); if (G.document.querySelector('pre')) break; }
  check('enlace sin caducidad abre igual', !!G.document.querySelector('pre') && G.document.body.textContent.includes('Sin caducidad.'));

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' comprobaciones OK');
  process.exit(failed.length ? 1 : 0);
})();
