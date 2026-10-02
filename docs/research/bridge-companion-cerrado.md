# Reference Brief: error accionable cuando Companion no esta abierto

Slug: bridge-companion-cerrado | Nivel: quick | Fecha: 2026-10-02 | Estado: ESCALADO
Versiones: @types/node=22, @modelcontextprotocol/sdk=1
Verificador: research-verifier 2026-10-02 ESCALATE

## 1. Pregunta y decisiones abiertas

Cuando Companion (la app de macOS) no esta corriendo, una llamada a una tool por este shim stdio devuelve el error crudo de Node "connect ECONNREFUSED .../Companion/bridge/bridge.sock" (QA de ATOM, 2026-10-02), que no dice que hacer.
Casos que hoy salen crudos: token ausente (ENOENT de readFileSync antes de conectar), socket ausente (connect ENOENT), nadie escucha (ECONNREFUSED), ruta del socket que es un archivo regular sobrante (ENOTSOCK segun el reporte; ver seccion 9).
Todos esos casos se vuelven un unico BridgeError('companion_unavailable', mensaje) construido en UN solo lugar, para que un auto-arranque futuro se enganche ahi [KAREN:orquestador 2026-10-02]
Mensaje decidido: "Companion is not running, or its bridge is off. Open Companion (for example: open -a Companion), check Ajustes › Agentes › \"Prestar las manos a otros agentes\", then retry. open_app cannot start it: it runs inside Companion." [KAREN:orquestador 2026-10-02]
Fuera de alcance: que el shim arranque Companion por su cuenta; es una decision pendiente de Karen [KAREN:orquestador 2026-10-02]
Lo que este brief fija: donde vive la traduccion, que codigos de error entran y cuales NO, y como llega al modelo.
Patron de referencia (referencia local, ~/Desktop/incredible-ref/accessibility-helper.md, solo lectura): el helper de accesibilidad de Incredible hace que cada error nombre la siguiente accion: elemento obsoleto lleva a volver a escanear la ventana, un lanzamiento de app con resultado desconocido pide inspeccionar las ventanas antes de reintentar, y un permiso faltante dice exactamente donde activarlo en Ajustes del Sistema.

## 2. Estado actual

- connect() lee el token con readFileSync ANTES de abrir el socket, asi que sin bridge.token lanza ENOENT sincrono que no es BridgeError [repo:src/bridge/client.ts:103]
- connect() abre el socket con createConnection(socketPath) [repo:src/bridge/client.ts:107]
- El handler de 'error' previo a 'connect' destruye el socket y rechaza con el Error crudo de Node, sin traducirlo [repo:src/bridge/client.ts:113]
- Ese handler se registra con socket.once('error', onError) y se quita al conectar [repo:src/bridge/client.ts:157]
- call() pasa siempre por ensureConnected(), asi que tras perder Companion la siguiente llamada reintenta connect() y hereda su error crudo [repo:src/bridge/client.ts:162]
- ensureConnected() solo llama a connect() si no esta conectado; es el unico camino de reconexion de las tools [repo:src/bridge/client.ts:213]
- Los errores del protocolo del bridge (p. ej. bad_token en hello) ya llegan como BridgeError con el codigo del servidor [repo:src/bridge/client.ts:319]
- El codigo companion_unavailable ya existe en el cliente para socket cerrado con peticiones pendientes [repo:src/bridge/client.ts:363]
- BridgeError es una clase con code publico y message [repo:src/bridge/errors.ts:4]
- runTool convierte un BridgeError en errorResult(code, message) [repo:src/core/tool-result.ts:30]
- Cualquier otro error sale como tool_failed con err.message: asi llego al modelo el "connect ECONNREFUSED ..." de QA [repo:src/core/tool-result.ts:32]
- errorResult devuelve el texto "error[code]: message" con isError: true [repo:src/core/tool-result.ts:17]
- La descripcion de las tools de escritura ya nombra companion_unavailable y pide mirar antes de reintentar [repo:src/server.ts:82]
- companion_status no reintenta conectar: solo lee client.isConnected y client.session [repo:src/server.ts:112]
- Su texto de "no disponible" nombra el ajuste "Prestar las manos a otros agentes" [repo:src/server.ts:117]
- Las tools de Companion (incluida open_app) se registran desde client.tools solo despues de un connect() exitoso [repo:src/server.ts:141]
- Si el connect() inicial falla, attachBridge solo escribe el mensaje a stderr y deja companion_status como unica tool [repo:src/server.ts:171]
- Las instrucciones del server le dicen al modelo que llame open_app primero, que es una tool de Companion [repo:src/server.ts:14]
- La ruta por defecto es ~/Library/Application Support/Companion/bridge [repo:src/bridge/paths.ts:21]
- COMPANION_BRIDGE_DIR sobreescribe el directorio (lo usan los tests) [repo:src/bridge/paths.ts:13]
- El README declara que el token se regenera en cada arranque de Companion, asi que debe leerse en cada connect y no cachearse [repo:README.md:62]
- El README afirma que companion_status "retries on each call", lo que el codigo de server.ts no hace [repo:README.md:121]
- Los tests RED esperan name BridgeError, code companion_unavailable y un mensaje que case /Companion is not running.*open -a Companion.*open_app cannot start it/s [repo:src/bridge/client.test.ts:486]
- RED 1: sin token, call('look') debe rechazar con ese error [repo:src/bridge/client.test.ts:490]
- RED 2: con token y sin socket debe rechazar igual [repo:src/bridge/client.test.ts:495]
- RED 3: con token y bridge.sock como archivo regular vacio debe rechazar igual [repo:src/bridge/client.test.ts:501]
- El test 15 existente solo exige que connect() sin servidor lance algo, asi que sigue pasando con el cambio [repo:src/bridge/client.test.ts:87]
- Versiones instaladas: @types/node 22.20.4 desde el especificador ^22.0.0 [repo:pnpm-lock.yaml:23]
- @modelcontextprotocol/sdk instalado 1.30.1 desde ^1.0.0 [repo:pnpm-lock.yaml:13]
- Esa version del SDK fija LATEST_PROTOCOL_VERSION = '2025-11-25', la revision de spec que se cita abajo [ref:https://github.com/modelcontextprotocol/typescript-sdk/blob/289ac2c3af7e1536160e80414296b175171a1a87/src/types.ts#L4@289ac2c3af7e1536160e80414296b175171a1a87]
- El runtime local es Node v22.23.2 (node --version en esta corrida); el target de TypeScript es ES2022, asi que Error cause esta disponible [repo:tsconfig.json:3]
Contextos: shim en produccion (proceso stdio lanzado por Claude Code en macOS, ruta real ~/Library/Application Support/Companion/bridge); vitest local en macOS con COMPANION_BRIDGE_DIR en un tmpdir; no hay CI en el repo (sin .github)

## 3. Fuentes primarias

- net.createConnection(path) inicia una conexion IPC y devuelve el Socket que empieza a conectar; los fallos llegan por evento, no por throw [doc:https://nodejs.org/docs/latest-v22.x/api/net.html#netcreateconnection@22.x]
- El evento 'error' del Socket se emite cuando ocurre un error y 'close' se emite justo despues [doc:https://nodejs.org/docs/latest-v22.x/api/net.html#event-error_1@22.x]
- El evento 'connect' se emite solo cuando la conexion se establece [doc:https://nodejs.org/docs/latest-v22.x/api/net.html#event-connect@22.x]
- En IPC Unix la ruta es un pathname del sistema de archivos, truncado a 103 bytes en macOS [doc:https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support@22.x]
- ECONNREFUSED: no se pudo conectar porque el destino lo rechazo activamente, normalmente porque el servicio esta inactivo [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#common-system-errors@22.x]
- ENOENT: un componente de la ruta no existe; lo levantan comunmente las operaciones de fs [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#common-system-errors@22.x]
- EACCES: permiso denegado por los permisos del archivo [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#common-system-errors@22.x]
- ENOTSOCK no esta en la lista de errores comunes de Node; la pagina remite a errno(3) para la lista completa [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#common-system-errors@22.x]
- error.code es el string del codigo de sistema y error.syscall nombra la llamada que fallo: se compara por code, no por texto del mensaje [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#class-systemerror@22.x]
- Las APIs sincronas de fs lanzan la excepcion de inmediato y se manejan con try/catch: readFileSync sin archivo lanza antes de cualquier Promise [doc:https://nodejs.org/docs/latest-v22.x/api/fs.html#synchronous-example@22.x]
- En connect(2) de BSD, ECONNREFUSED es intento rechazado, ENOENT es socket nombrado inexistente, EACCES es sin permiso de escritura sobre el socket, y ENOTSOCK se describe para el descriptor (no para la ruta) [doc:https://man.freebsd.org/cgi/man.cgi?query=connect&sektion=2@FreeBSD-current]
- MCP 2025-11-25: los errores de ejecucion de tools van en el resultado con isError: true y llevan feedback accionable para que el modelo se autocorrija [doc:https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling@2025-11-25]
- MCP 2025-11-25: los clientes SHOULD pasar los errores de ejecucion al modelo; los errores de protocolo son para tools desconocidas o peticiones malformadas [doc:https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling@2025-11-25]
- El SDK 1.30.1 documenta que los errores que nacen en la tool SHOULD reportarse dentro del resultado con isError, no como error de protocolo, para que el LLM lo vea y se autocorrija [ref:https://github.com/modelcontextprotocol/typescript-sdk/blob/289ac2c3af7e1536160e80414296b175171a1a87/src/types.ts#L1466@289ac2c3af7e1536160e80414296b175171a1a87]

## 4. Implementaciones de referencia

- moby/moby (cliente Go de Docker, mantenido por Docker y la comunidad, el cliente de socket Unix mas usado) centraliza la traduccion de fallos de conexion en doRequest [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/request.go#L130@c8e265787b0a89d161f34c3920f73f136974744b]
- moby separa permiso denegado ("permission denied while trying to connect...") de daemon apagado: EACCES NO se reescribe como "no esta corriendo" [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/request.go#L168@c8e265787b0a89d161f34c3920f73f136974744b]
- moby trata ruta inexistente como "check if the path is correct and if the daemon is running" [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/request.go#L173@c8e265787b0a89d161f34c3920f73f136974744b]
- moby traduce connection refused y fallos de dial unix al mensaje unico "Is the docker daemon running?" [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/request.go#L190@c8e265787b0a89d161f34c3920f73f136974744b]
- Ese mensaje unico se construye en una sola funcion, connectionFailed(host), con un tipo propio consultable (IsErrConnectionFailed) [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/errors.go#L35@c8e265787b0a89d161f34c3920f73f136974744b]
- El tipo de moby conserva el error original con Unwrap, asi que la causa no se pierde aunque el texto cambie [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/errors.go#L24@c8e265787b0a89d161f34c3920f73f136974744b]

## 5. Opciones

| Opcion | Pros | Contras | Complejidad | Recomendacion |
|---|---|---|---|---|
| A. Una funcion privada en client.ts (p. ej. unavailable(cause)) que construye el BridgeError; connect() la usa al fallar la lectura del token y en el 'error' previo a 'connect', solo para una lista cerrada de codigos (ENOENT, ECONNREFUSED, ENOTSOCK) | Un solo lugar, el que pidio Karen y donde se engancharia el auto-arranque; cubre tools y attachBridge; no toca runTool | Hay que mantener la lista de codigos | baja | Recomendada |
| B. Traducir en runTool (tool-result.ts) mirando err.code | Un solo punto para todas las tools | Capa equivocada: runTool no sabe que el fallo fue del bridge; attachBridge no pasa por runTool; aleja el gancho del auto-arranque | baja | No |
| C. Cualquier fallo de connect() es companion_unavailable | Lo mas simple | Disfraza EACCES, bad_token y busy como "no esta abierto" y manda al usuario a un paso que no arregla nada | baja | No |
| D. Mensaje de texto distinto por codigo | Diagnostico fino | Contradice la decision de un mensaje unico; el usuario hace lo mismo en los tres casos | media | No |

## 6. Evidencia en contra

- ECONNREFUSED tambien puede darse con Companion abierto y el ajuste del bridge apagado; se acepta porque el mensaje decidido cubre ambos ("or its bridge is off" y la ruta del ajuste) [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#common-system-errors@22.x]
- EACCES sobre el socket o el token es otro problema (permisos del archivo, otro usuario) y NO debe reescribirse como "not running": la referencia de moby lo separa explicitamente; se resuelve dejando EACCES fuera de la lista y conservando su error [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/request.go#L168@c8e265787b0a89d161f34c3920f73f136974744b]
- connect(2) documenta EACCES tanto para un componente de la ruta sin permiso de busqueda como para el socket sin permiso de escritura, asi que ninguno de los dos significa app cerrada [doc:https://man.freebsd.org/cgi/man.cgi?query=connect&sektion=2@FreeBSD-current]
- Un mensaje fijo pierde el codigo original y dificulta el diagnostico; se resuelve conservando la causa (Error cause de ES2022, mismo papel que Unwrap en moby) y escribiendo a stderr solo el err.code, sin la ruta [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/errors.go#L24@c8e265787b0a89d161f34c3920f73f136974744b]
- Un error tras el 'connect' (bad_token, busy, timeout del hello) no es "Companion cerrado"; se resuelve aplicando la traduccion solo en el handler previo a 'connect' (que se quita al conectar) y en la lectura del token [repo:src/bridge/client.ts:117]

## 7. Ejemplares y anti-ejemplos

- Bien hecho: un tipo de error propio, construido en una funcion, con mensaje que nombra el siguiente paso y la causa conservada [ref:https://github.com/moby/moby/blob/c8e265787b0a89d161f34c3920f73f136974744b/client/errors.go#L35@c8e265787b0a89d161f34c3920f73f136974744b]
- Bien hecho: el resultado de error MCP lleva texto accionable con isError: true, como el ejemplo de validacion de la spec [doc:https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling@2025-11-25]
- Anti-ejemplo: el Error crudo de Node rechazado tal cual desde onError, que termina como error[tool_failed] con la ruta del socket [repo:src/bridge/client.ts:113]
- Anti-ejemplo: un mensaje que sugiere open_app para arrancar Companion, cuando open_app solo existe despues de conectar [repo:src/server.ts:141]

## 8. Trampas

- readFileSync lanza sincrono antes del new Promise: si la traduccion solo vive en onError, el caso sin token se escapa (RED 1) [doc:https://nodejs.org/docs/latest-v22.x/api/fs.html#synchronous-example@22.x]
- El token no se puede cachear entre conexiones: se regenera en cada arranque de Companion [repo:README.md:62]
- Comparar por err.code y no por el texto del mensaje: el texto lleva la ruta del socket, que incluye el home del usuario y cambia con COMPANION_BRIDGE_DIR [doc:https://nodejs.org/docs/latest-v22.x/api/errors.html#class-systemerror@22.x]
- 'close' sigue a 'error': el handler previo a 'connect' no debe dejar listeners que luego rechacen pendientes con otro codigo [doc:https://nodejs.org/docs/latest-v22.x/api/net.html#event-error_1@22.x]
- En produccion, si Companion no corria al arrancar el shim, solo existe companion_status y no reintenta conectar, asi que el nuevo mensaje solo lo ve quien perdio Companion despues de arrancar [repo:src/server.ts:112]
- En vitest, el afterEach del primer describe asigna undefined a process.env.COMPANION_BRIDGE_DIR, lo que deja el string "undefined"; el beforeEach lo pisa, pero un test nuevo fuera de esos describe leeria una ruta falsa [repo:src/bridge/client.test.ts:22]
- El texto de companion_status ("not reachable") y el nuevo mensaje dicen cosas parecidas con palabras distintas; si se alinean es otra decision, no parte de este cambio [repo:src/server.ts:116]

## 9. Incertidumbre

- ASSUMPTION: en macOS, connect a una ruta que es un archivo regular devuelve ENOTSOCK (asi lo reporto la corrida RED de Companion1 y lo confirmo el verificador; la doc de Node no lista ENOTSOCK y la de BSD lo describe para el descriptor). prueba: correr el RED 3 de client.test.ts:498 con el err.code impreso a stderr antes de traducir; si sale ECONNREFUSED, la lista igual lo cubre.
- ASSUMPTION: con Companion abierto y el ajuste apagado, Companion borra o deja de escuchar el socket (ENOENT o ECONNREFUSED) en vez de aceptar y cerrar. prueba: con Companion abierto y el toggle apagado, ls -l del directorio bridge y una llamada a look desde el shim, anotando el err.code.
- [NEEDS CLARIFICATION: el README promete que companion_status reintenta en cada llamada y el codigo no lo hace; se arregla aqui o en otra rama?]
- [NEEDS CLARIFICATION: EACCES (socket o token de otro usuario o con permisos rotos) se deja como error propio sin reescribir, o merece su propio codigo con un mensaje accionable?]

## 10. Checklist de estandar

- [ ] Los tres RED de client.test.ts (sin token, sin socket, socket que es archivo) pasan con code companion_unavailable y el mensaje decidido literal
- [ ] El BridgeError companion_unavailable de "no disponible" se construye en una sola funcion de client.ts, y connect() es su unico llamador
- [ ] La lectura del token y el 'error' previo a 'connect' pasan por esa funcion; los errores despues de 'connect' (bad_token, busy, timeouts) conservan su codigo
- [ ] Solo ENOENT, ECONNREFUSED y ENOTSOCK se traducen; EACCES y cualquier otro codigo NO se reescriben como "not running"
- [ ] Un test cubre que un codigo fuera de la lista (p. ej. EACCES) no se convierte en companion_unavailable
- [ ] La comparacion es por err.code, nunca por el texto del mensaje
- [ ] La causa original se conserva (cause) y stderr registra solo el codigo, sin la ruta ni el token
- [ ] El token se sigue leyendo en cada connect(), sin cache
- [ ] Por runTool el modelo recibe "error[companion_unavailable]: ..." con isError: true, no error[tool_failed]
- [ ] Ningun texto sugiere open_app como forma de arrancar Companion
- [ ] El shim no intenta lanzar Companion (fuera de alcance)
- [ ] Los tests existentes de client.test.ts y server.test.ts siguen en verde

## 11. Fuentes

| n | Titulo | Editor | Version o fecha | Consultado | Confianza |
|---|---|---|---|---|---|
| 1 | net (createConnection, eventos error/connect, IPC) | Node.js | v22.x docs | 2026-10-02 | high |
| 2 | Errors: common system errors, SystemError | Node.js | v22.x docs | 2026-10-02 | high |
| 3 | fs.readFileSync y ejemplo sincrono | Node.js | v22.x docs | 2026-10-02 | high |
| 4 | connect(2) | FreeBSD Project | current (proxy de BSD, no la pagina de macOS) | 2026-10-02 | medium |
| 5 | MCP spec, Server Tools, Error Handling | Model Context Protocol | 2025-11-25 | 2026-10-02 | high |
| 6 | typescript-sdk src/types.ts (LATEST_PROTOCOL_VERSION, isError) | modelcontextprotocol | 1.30.1 @289ac2c | 2026-10-02 | high |
| 7 | moby client/request.go y client/errors.go | moby/Docker | @c8e2657 | 2026-10-02 | high |
| 8 | accessibility-helper.md (referencia local, solo lectura) | extracto local de Incredible | 2026-10-02 | 2026-10-02 | medium |
| 9 | Codigo del proyecto (client.ts, errors.ts, tool-result.ts, server.ts, paths.ts, client.test.ts, README.md) | companion-mcp | f3b5c8d + RED sin commitear (escrito por Companion1) | 2026-10-02 | high |

## 12. Propuesta de decisiones (pendiente de firma de Karen)

Propuesta del orquestador 2026-10-02, leida de la referencia local de Incredible (fuente 8 y su host nativo del bridge; solo comportamiento, nada copiado). No es aprobacion: el `Estado` lo cambia Karen.

- 1a. Opcion A: una sola funcion privada en client.ts que traduce cada fallo a un codigo snake_case propio con un mensaje accionable. Es el patron de la referencia local.
- 1b. EACCES deja de quedar crudo y recibe su propio codigo con un mensaje que dice como arreglarlo; la referencia local separa el permiso faltante en un codigo aparte, con la ruta de Ajustes donde se concede. El nombre y el texto los firma Karen.
- 1c. La referencia local no lo cubre. Default del orquestador: corregir en este PR el README, que dice que companion_status reintenta (README:121 contra server.ts:112).
- 1d. Sin auto-arranque: el host nativo de la referencia local solo prepara el secreto y nunca abre la app.
