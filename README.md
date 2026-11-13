# 🔒 Compartir Seguro

Manda un secreto dentro de un enlace. Sin servidores, sin cuentas y sin base de datos:
el contenido cifrado viaja en la propia URL, así que nada se guarda en ningún sitio.

**App:** https://adelafoofur82.github.io/CompartirSeguro/

## Qué hace

- Eliges el tipo de contenido: **campos con nombre** (email, contraseña, URL…), **texto libre** o **archivo**.
- En modo campos cada campo es solo **nombre y valor**: añades y quitas los que quieras (hasta 10).
  Si un valor es una URL (`http://` o `https://`) se detecta solo y al abrirlo sale como enlace, con
  botón «Abrir», sin dejar de poder copiarse. Cada campo tiene su botón de copiar y arriba hay un
  «Copiar todo».
- Le pones una **contraseña** y una **caducidad**.
- La app comprime, cifra y empaqueta todo en el fragmento (`#...`) del enlace.
- Le pasas el enlace por donde quieras (cabe en un mensaje de Telegram) y la contraseña **por otro canal**.
- Quien lo recibe abre el enlace, mete la contraseña y ve el texto o descarga el archivo.

Extra: botón de copiar en cada campo (y «Copiar todo»), ojo 🙈/👁️ para ver la contraseña mientras la escribes,
historial local de lo que has compartido y aviso si un enlace ya caducó. La app se puede **instalar**
(botón 📲 Instálame cuando el navegador lo permite) y la página de ver invita a quien recibe el secreto
a crear el suyo. El logo y el favicon son el mismo monito con los ojos cerrados de la contraseña.

## Cómo funciona por dentro

Todo ocurre en el navegador, con Web Crypto:

1. **Comprimir** — el contenido pasa por `gzip` (si el navegador lo soporta y de verdad ahorra bytes).
2. **Cifrar** — `AES-GCM 256` con clave derivada de la contraseña con `PBKDF2-SHA256`, 600.000 iteraciones,
   `salt` de 16 bytes e `iv` de 12 bytes nuevos en cada enlace.
3. **Empaquetar** — el blob final es `salt (16) | iv (12) | ciphertext`, en Base64 URL-safe, detrás de `#`.

Lo que va cifrado por dentro:

```
0x01                  versión del formato
uint32 big-endian     longitud de la cabecera
JSON metadatos        {"v":1,"type":"fields","compressed":true,"exp":1763000000000}
payload               texto, JSON de campos o archivo (comprimido si "compressed" es true)
```

El payload de tipo `fields` es una lista JSON:

```json
[{"label":"Email","value":"adela@ejemplo.com"},
 {"label":"Contraseña","value":"P@ssw0rd"},
 {"label":"Web","value":"https://ejemplo.com"}]
```

Los enlaces antiguos se siguen abriendo: los de payload de texto plano se muestran como un único campo,
y los que llevaban `kind: "password"` o `autoUrl: false` mantienen ese comportamiento (valor oculto
tras el ojo, sin convertir a enlace) aunque la interfaz ya no ofrezca esas opciones.

`exp` es la fecha de caducidad en milisegundos. Va **cifrada**, así que nadie sabe cuándo caduca
un enlace sin la contraseña.

## Límites de tamaño

El enlace tiene que caber en un solo mensaje de Telegram (4.096 caracteres), así que el hash se corta
en **3.900 caracteres**. Eso deja un payload útil de unos **2.900 bytes ya cifrados**.

| Contenido | Tamaño | Cabe |
|---|---|---|
| Unas líneas de texto normal | ~500 B | Sí, de sobra |
| Texto largo y repetitivo | 3.800 B | Sí: gzip lo deja en ~100 B |
| Texto aleatorio (claves, base64) | 4.000 B | No: no comprime, lo bloquea |
| Texto normal de ~5.000 caracteres | ~5 KB | Según lo compresible que sea |

La app te avisa antes de generar: la barra muestra el tamaño real ya comprimido y desactiva el botón
si no cabe, con el motivo visible. En modo campos, los nombres y el JSON de estructura también ocupan
(unos 30-40 bytes por campo), así que con campos muy cortos pesa más la estructura que el contenido.

## Seguridad: lo que protege y lo que no

**Protege:**

- El contenido no viaja en claro: ni el servidor de GitHub, ni el navegador por el que pasa el enlace,
  ni Telegram ven el secreto ni la contraseña.
- La contraseña nunca se envía ni se guarda: solo se usa en tu navegador para derivar la clave.
- `salt` e `iv` aleatorios por enlace, así que dos enlaces con el mismo texto y contraseña son distintos.

**No protege:**

- Si alguien tiene **el enlace y la contraseña**, tiene el secreto. El enlace *es* el secreto: no lo pegues
  en sitios públicos.
- Una contraseña débil se puede probar por fuerza bruta contra el propio enlace. 600.000 iteraciones de
  PBKDF2 encarecen cada intento, pero no lo hacen imposible.
- **No hay revocación real.** Los datos están dentro del enlace: nadie puede borrarlos de un servidor
  porque no hay servidor. La caducidad se comprueba en el cliente al desbloquear, y alguien con
  conocimientos podría saltársela editando el código de la página (aunque seguiría sin poder leer el
  contenido sin la contraseña).
- **El registro de aperturas es local.** El historial marca "abierto" cuando *ese* enlace se abre en
  *este* navegador. Para saber si otra persona lo abrió haría falta un servidor que lo apunte, y eso
  rompería la promesa de "sin servidores".
- El historial vive en el `localStorage` del navegador: si borras los datos del sitio, pierdes los enlaces.

## Cómo usarla

1. Abre la app y escribe el secreto (o elige el archivo).
2. Pon una contraseña de verdad (mínimo 4 caracteres; mejor una frase larga) y elige caducidad.
3. Pulsa **Generar Enlace** y copia el resultado.
4. Manda el enlace por un canal y la contraseña por otro distinto.
5. Quien lo recibe abre el enlace, escribe la contraseña y listo.

La app funciona como PWA: se puede instalar y abrir sin conexión (los secretos se generan en local;
solo la primera carga necesita red).

## Desarrollo

Sin build, sin dependencias instaladas: tres archivos y ya.

```
index.html      toda la app (Vue 3 + Bootstrap desde CDN)
manifest.json   metadatos de la PWA
sw.js           service worker (caché de los archivos)
icon.svg        logo/favicon: el monito con los ojos cerrados
icons/          PNG 192/512/maskable + apple-touch, mismo dibujo
tools/          make-icons.py, el generador de iconos (sin dependencias)
tests/          pruebas automatizadas con jsdom
```

Servirla en local:

```bash
python3 -m http.server 8099
# http://127.0.0.1:8099
```

**Importante al publicar:** `sw.js` es cache-first. Cada vez que cambies `index.html` hay que subir
`CACHE_NAME` (`share-secure-v4` → `v5`), o quien ya la haya abierto seguirá viendo la versión vieja.

### Instalación como app

El botón 📲 Instálame solo aparece si el navegador ofrece la instalación: Chrome y Edge disparan
`beforeinstallprompt` cuando la PWA cumple los requisitos (manifest con iconos de 192 y 512, service
worker y HTTPS). Firefox no lo soporta, así que ahí el botón no se muestra. En iPhone/iPad y en el
Chrome de iOS tampoco: allí se instala a mano desde *Compartir → Añadir a pantalla de inicio*.

Los iconos son PNG generados con `tools/make-icons.py` (matemática pura, sin Pillow) a partir del mismo
dibujo que `icon.svg`:

```bash
python3 tools/make-icons.py
```

Si cambias el monito, cambia el SVG y el generador a la vez, o el icono instalado y el favicon no
coincidirán.

### Pruebas

Las pruebas montan la página real en jsdom y la manejan como un usuario: rellenan el formulario,
pulsan los botones y comprueban lo que se ve (texto descifrado, portapapeles, avisos de caducidad,
historial).

```bash
npm install --no-save jsdom vue@3
node tests/verify-app.js
```

Requieren Node 18+ (usan `CompressionStream` y `crypto.subtle`, igual que el navegador).

### Publicación

GitHub Pages sirve la rama `main` en la raíz. Un `push` a `main` publica solo; el build tarda
alrededor de un minuto.

## Navegadores

Chrome/Edge 80+, Firefox 113+, Safari 16.4+. Necesita Web Crypto, `CompressionStream` y
`navigator.clipboard` (el portapapeles solo funciona en HTTPS o `localhost`; en el resto la app te pide
copiar a mano).
