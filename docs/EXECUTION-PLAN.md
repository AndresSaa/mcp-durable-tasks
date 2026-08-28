# mcp-durable-tasks — Plan de ejecución

> **Audiencia:** el autor y los agentes de código. Documento operativo, no
> contractual: [`contract.md`](./contract.md) es la autoridad pública de
> alcance e invariantes. Los dos borradores privados que originaron este plan
> se archivaron fuera del repositorio antes del primer push y se eliminaron;
> el historial se compactó para que tampoco viajen en commits anteriores.
>
> **Revisión 5** — 28 agosto 2026. `v0.2.1` es la publicación actual. El
> orden preferido es `v0.3.0` (Fase 12, driver de cliente) y `v0.4.0` (Fase
> 13, `NodeSqliteTaskStore`). Si F12 sigue bloqueada upstream, una puerta
> explícita permite reasignar el siguiente minor; no se hace en silencio. F13
> no es una familia de conectores SQL. El procedimiento de publicación vive en
> [`RELEASE.md`](./RELEASE.md).

---

## 0. Dónde estamos

- ✅ Borradores privados actualizados y contrato público en inglés extraído a
  [`contract.md`](./contract.md).
- ✅ Prior art verificado: hueco vacío (npm libre, nada equivalente en
  `ext-tasks`).
- ✅ `CLAUDE.md` / `AGENTS.md` — escritos.
- ✅ **Spike 0 resuelto** (ver [compatibilidad del SDK](./contract.md#typescript-sdk-v2-compatibility)).
  El motor es puro estado; la costura de compatibilidad permanece en el host,
  fuera del paquete.
- ✅ **Fase 1 completa** salvo F1.6, que es configuración de cuenta y la hace
  el mantenedor a mano. `SECURITY.md` (F8.3) se adelantó, porque
  `CONTRIBUTING.md` lo enlaza y un enlace roto en el repo no es aceptable.
- ✅ **Fase 2 completa** salvo R2.2 (leer SEP-2663 buscando las frases
  normativas de I1/A2/A3). El schema está leído, vendorizado y anclado por
  tests; el contrato público refleja lo que dice de verdad, con A7 y A8 entre
  las preguntas de conformidad.
- ✅ **R2.2 hecha.** Las citas normativas resolvieron A2, A3, A4 y A5 (ver
  [`contract.md`](./contract.md#extension-conformance-questions)). A1 sigue
  abierta y en movimiento upstream.
- ✅ **Fase 3 completa: el motor.** `TaskLifecycle`, `TaskHandle`,
  `MemoryTaskStore`, la proyección al wire y los errores. 71 tests, 93,6% de
  sentencias.
- ✅ **Primera auditoría independiente procesada.** Diez hallazgos, los diez tratados;
  verificados uno a uno con tests independientes antes de aceptarlos.
- ✅ **Fase 4 completa: `WalTaskStore`.** 104 tests, 93,2% de sentencias.
- ✅ **Fase 5 completa: el kit de conformidad.** 141 tests. Pasa contra los dos
  stores incluidos y se demuestra que detecta fallos con tres stores rotos a
  propósito.
- ✅ **Segunda auditoría procesada.** Diez hallazgos más, los diez cerrados y
  verificados con tests independientes escritos antes de ver la solución.
- ✅ **Fase 6 completa: crash tests.** 178 tests. I8 pasa de estar demostrada
  frente a un cierre ordenado a estarlo frente a `SIGKILL` real, contra
  `dist/`.
- ✅ **Fase 8 completa: documentación y umbrales.** `docs/api.md`,
  `durability.md` e `internals.md` escritos y empaquetados; umbrales de
  cobertura fijados **midiendo** (90/90/87/78) tras cubrir `input.ts`, que
  estaba al 58% y es justo la validación que sustituye a lo que el JSON Schema
  oficial pierde (A8).
- ✅ **Suite property-based de §8.4 implementada.** fast-check genera
  secuencias de hasta 60 operaciones con TTL y rollback de reloj, rondas de
  input parciales/mixtas/duplicadas, claves de prototipo, cancelación,
  terminalidad y conflictos CAS; compara modelo, record, wire y efectos tras
  cada paso.
- ✅ **Auditoría previa al tag completada.** Historial sin atribuciones de IA,
  documentación y tarball revisados, y gates locales ejecutados con pnpm. Los
  resultados finales y el procedimiento reproducible están en `RELEASE.md`.
- ✅ **Migración a pnpm 11.21.0.** Lockfile único, instalación congelada en CI,
  cache sólo en CI y scripts de dependencias denegados salvo `esbuild`. El
  cliente npm queda exclusivamente para publicar/verificar el registro.
- ✅ **Historial público preparado.** Los borradores privados están fuera del
  árbol y de cualquier objeto alcanzable; la rama contiene un único commit
  sobre `origin/main`.
- ✅ **PR #1 fusionado y matriz remota verde.** Node 22/24 pasa en Linux, macOS y
  Windows; Node 26 también pasa. El repo ya es público y el ruleset `main`
  exige los seis checks estables y `lint-title` con política strict. El PR #1
  ya está mergeado y el README final se prepara en un segundo PR.
- ✅ **Property suite estabilizada para el gate local.** Se mantienen las 150
  ejecuciones y todos los invariantes; las esperas de input se comprueban como
  efectos de microtarea acotados y el presupuesto del fichero sube a 60 s para
  no competir artificialmente con los crash tests en hosts Windows lentos.
- ✅ **Bootstrap npm verificado.** La publicación inicial usa autenticación web
  del CLI npm y `--provenance=false` explícito; pnpm conserva instalación y
  scripts, y desde `v0.2.0` el workflow publica con OIDC y provenance.
- ✅ **`v0.1.0` publicada y bootstrap de npm cerrado.** La publicación inicial
  fue manual, se configuró el Trusted Publisher y no quedó ningún token de npm
  en GitHub.
- ✅ **Fase 9 y `v0.2.0` completas.** Demo real, asciinema, tag, GitHub Release
  y publicación npm sobre OIDC con attestations de provenance ligadas al commit
  `f1154da`.
- ✅ **`v0.2.1` publicada como mantenimiento documental.** Republicó en npm el
  README corregido después de `v0.2.0`; no cambió motor, API ni dependencias.
  Su tag salió del PR de versión ya fusionado y usó `release.yml`, OIDC y
  provenance.
- ✅ **Fase 10 completa.** Los hallazgos se dividieron por componente y
  propietario: schema en `ext-tasks`, `resultType` en `typescript-sdk` y una
  reproducción independiente en el issue existente del era-gate.
- ⏸️ **Prioridad: Fase 12 / `v0.3.0` (driver de cliente).** Sigue gated por
  una revisión actual de A6/A10 o por necesidad de usuario documentada. No se
  convierte un workaround provisional del SDK en API pública. La Fase 7 quedó
  cerrada como investigación sin feature; A6 permanece como gate de regresión.
- 📋 **Fase 13 / `v0.4.0` preferida está en el roadmap.** Un
  `NodeSqliteTaskStore` de primer partido y fichero dedicado; no arrastra
  libSQL, Turso, Postgres ni `better-sqlite3`. Si F12 continúa bloqueada y F13
  demuestra necesidad/readiness, un cambio contractual separado puede
  reasignarle el siguiente minor. El detalle está más abajo.

### Decisiones de la Fase 8

- **El tarball lleva `contract.md`, `api.md`, `durability.md` e
  `internals.md`.** El contrato público en inglés sustituye a los borradores
  privados y sí viaja con el paquete; este plan operativo en castellano no.
- **Los umbrales se fijaron después de tapar el hueco, no antes.** `input.ts`
  estaba al 58% de sentencias; fijar el umbral con ese número lo habría
  consagrado. Con 46 tests de forma añadidos sube a 68% y el total a 92,8%.

### Lo que salió de la Fase 5

- **La factory del kit se invoca una vez por check** y tiene que devolver un
  sujeto fresco, reloj incluido. Lo descubrió el smoke test del tarball al
  fallar dos checks de TTL — el reloj compartido acumulaba el tiempo que otro
  check había avanzado. Es contrato, y ahora está documentado en el tipo.
- **El runner se pasa explícito** (`{ runner: { describe, it } }`). La primera
  versión leía `describe`/`it` de los globales, lo que obligaría a cada
  consumidor a poner `globals: true` en su vitest sólo para correr esta suite.
- **`maxEntryBytes` expuesto en `WalTaskStore`** (venía de la fase 4): un
  `result` grande puede hacer fallar `complete()`. La capa de task usa un
  default razonado de 8 MiB, conserva el límite configurable y lo expone como
  `TaskEntryTooLargeError`/`ERR_ENTRY_TOO_LARGE` antes de comprometer, para que
  el worker pueda completar de nuevo con un resultado truncado.

### La corrección de diseño de la Fase 4

El borrador privado inicial decía «checkpoint cuando la task alcanza estado
terminal». **Es incorrecto y de forma silenciosa:** `replay()` de `process-wal` solo devuelve
entradas _posteriores_ al checkpoint, así que marcar una task completada la
borraría del arranque siguiente — y I8 exige que una task terminal conserve su
resultado hasta que expire su TTL. Completarse no es el momento en que una task
deja de hacer falta; expirar sí.

La compactación es por tanto un **snapshot con reescritura**: se anexa el
estado actual de todo lo vivo, se marca procesado todo lo anterior y se
compacta. Hay un test que falla si alguien vuelve al diseño ingenuo.

También se extrajo `src/record.ts` con las reglas que ambos stores comparten
(`hasExpired`, `applyPatch`, `snapshot`). Antes `wal.ts` importaba de
`memory-store.ts`, que leía como si el store durable dependiera del de
memoria; son contrato compartido, y el kit de conformidad las va a exigir a
cualquier store de terceros.

### Decisiones y correcciones de la Fase 3

- **`TaskHandle.cancelled()` es API nueva**, no estaba en el boceto inicial.
  Sin ella el estado `cancelled` es **inalcanzable**:
  `tasks/cancel` solo levanta la señal, porque la cancelación es cooperativa y
  la task puede acabar de otra forma. Alguien tiene que escribir el estado
  terminal cuando el worker efectivamente para, y solo el worker sabe cuándo.
- **`updateTask` sobre una task terminal devuelve ack, no error.** En una task
  terminal ninguna clave está viva, y la spec dice ignorar las claves no vivas
  — así que responder con error a un cliente conforme que llega tarde sería un
  bug de conformidad. Se traga `TaskAlreadyTerminalError` ahí y solo ahí.
- **`applyPatch` borra, no ignora, los `undefined`.** Primera versión los
  descartaba, lo que habría dejado a una task completada arrastrando sus
  `inputRequests` — y el schema los rechaza con `additionalProperties: false`.
- **No hay `UnknownInputKeyError`.** Estaba en el borrador inicial y contradice la
  spec. Eliminado.
- **El helper `untilParked` no implica API pública nueva.** El cliente observa
  `input_required` mediante `tasks/get`; exponer otro momento del scheduler
  duplicaría el contrato. El bug real era que el waiter se registraba después
  del write durable. La coordinación local ahora instala el waiter antes del
  CAS, y los tests conservan el poll helper como observador del wire.

### El presupuesto, dicho antes que el plan

El presupuesto inicial era de ~30h para esta pieza, a ~8h/semana. La suma honesta
de lo que viene son **~43h**. No cabe. Antes de empezar, la decisión de recorte
—porque tomarla ahora es barato y tomarla en la semana 3 significa abandonar a
medias:

| Si hay que recortar | Qué se cae                                                                                                | Qué NO se cae nunca                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Primero             | El artículo de la semana 4 (F11) — 5h, y es lo único que se puede publicar meses después sin perder valor |                                                                                                       |
| Segundo             | El empaquetado como Agent Plugin (parte de F11) — pertenece más a la Pieza 2                              |                                                                                                       |
| Tercero             | `docs/` completo → README sólido + `docs/api.md`, el resto después de v0.2.0                              |                                                                                                       |
|                     |                                                                                                           | **F6 (crash tests), F10 (el issue), y la desambiguación del README.** Son, en ese orden, el producto. |

El criterio de programa sitúa el ROI en la semana 3, no en la 1. Cualquier
recorte que retrase el issue está mal hecho.

### Cómo leer las tareas

Cada tarea lleva **[Xh]** estimadas y un **hecho-cuando** verificable. Las
tareas de investigación van marcadas **R#** y son bloqueantes de lo que
sigue: existen porque esta spec es de julio de 2026 y trabajar de memoria
sobre ella produce código que parece correcto y no lo es.

---

## Fase 1 — Fundaciones del repo · ~4h

Nada de esto es interesante y todo es prerequisito. Se hace de una sentada.

- **F1.1 [0.5h]** `package.json`: nombre, descripción y keywords alineados con
  [`contract.md`](./contract.md) (incluida la frase "Not a to-do manager"),
  `engines: >=22`, `type: module`, `exports` con los entry points, `files`,
  `publishConfig` con `provenance: true`.
  _Hecho cuando:_ `npm publish --dry-run` corre limpio y el tarball no lleva
  tests ni configuración.
  _Ojo:_ si el dry-run se queja por similitud de nombre, el fallback es
  `@craftender/mcp-durable-tasks`, nunca `mcp-ext-tasks`; ver
  [alcance](./contract.md#scope-and-authority).
- **F1.2 [0.5h]** `tsconfig.json`, `eslint.config.js`, `.editorconfig`,
  `.gitattributes`, `prettier` — copiados de `process-wal` y ajustados. Añadir
  `.ai/` y `dist/` al `.gitignore`.
- **F1.3 [1h]** `tsup` con los entry points. **Ésta es la única parte con
  criterio real:** `.` no puede arrastrar `process-wal` ni siquiera en los
  tipos, o la promesa de cero dependencias se rompe en `attw`.
  _Hecho cuando:_ `pnpm lint:package` pasa y un proyecto que instala el
  paquete **sin** `process-wal` importa `.` y `/testing` sin warnings.
- **F1.4 [1h]** Workflows: `ci.yml` (matriz 22/24 × 3 SOs + pierna Node
  Current no bloqueante), `pr-title.yml`, `codeql.yml`, `scorecard.yml`,
  `release.yml`. Se heredan de `process-wal` **quitando** todo lo de
  `PUPPETEER_SKIP_DOWNLOAD` y `check:diagrams`, que aquí no existen.
- **F1.5 [0.5h]** `CHANGELOG.md` con `[Unreleased]`, `LICENSE` (MIT),
  `CONTRIBUTING.md` adaptado — su sección de alcance sale de los
  [no objetivos](./contract.md#non-goals),
  no de la de `process-wal`.
- **F1.6 [0.5h] — ⬜ PENDIENTE, la hace el mantenedor.** Es configuración de
  cuenta/remote, no del working tree. Estado comprobado el 10 de agosto: el
  repo es privado, sin descripción, homepage ni topics; Discussions e Issues
  ya están activos, con Q&A e Ideas disponibles. La secuencia correcta está en
  `RELEASE.md`: merge primero, metadatos, hacer público, aplicar protección de
  `main` y taguear. Los checks requeridos son las seis piernas Node 22/24 y
  `lint-title`; Node 26 sigue siendo informativo.

  El plan anterior decía configurar Trusted Publisher antes de la primera
  publicación. **Era incorrecto:** npm necesita que el paquete exista. `v0.1.0`
  se publica manualmente con 2FA y provenance desactivado; después se vincula
  `AndresSaa/mcp-durable-tasks`/`release.yml` y se activa la variable del repo.

### Lo que la Fase 1 dejó decidido y no estaba en el plan

- `attw` corre con `--profile node16`: el modo legacy `node10` no ve subpaths
  de `exports`, así que `/wal` y `/testing` fallan por construcción.
  Soportarlo exigiría directorios proxy para un modo que ningún Node soportado
  usa. `publint` sigue en `--strict`.
- La frontera "sin `node:*`" en `.` y `/testing` la impone **eslint por
  fichero**, no `tsc`: `tsc` tiene un solo `types` para todo el proyecto y no
  puede decir "éstos sí y aquéllos no".
- `release.yml` **se niega a publicar automáticamente por debajo de 0.2.0**:
  `0.1.0` es el bootstrap manual. Desde `0.2.0`, una variable de Trusted
  Publishing ausente hace fallar el workflow en vez de omitir npm
  silenciosamente. Una versión de npm no se puede retirar.
- El `esbuild` que arrastra `tsup` necesita el override `^0.28.1` (advisory
  GHSA-g7r4-m6w7-qqqr). Mismo override que `process-wal`, misma razón.

---

## Fase 2 — Conformidad con el schema oficial · ~4h

**Esta fase va antes que el motor, a propósito.** Escribir la máquina de
estados y después descubrir que `GetTaskResult` tiene otra forma es
exactamente el trabajo tirado que el Spike 0 nos ahorró en la otra dimensión.

- **R2.1 [1.5h] — Leer el schema oficial, entero.**
  Fuente: `github.com/modelcontextprotocol/ext-tasks/tree/main/schema` —
  `schema.json` y `generated/schema.ts`. **No está publicado en npm**
  (`@modelcontextprotocol/ext-tasks` da 404, verificado 9 ago 2026), así que
  hay que decidir cómo consumirlo (F2.2).
  _Qué extraer, campo por campo:_ forma exacta de `CreateTaskResult`,
  `GetTaskResult`, `Task`, el discriminador `resultType: "task"`, la forma de
  `inputRequests` y de los `inputResponses` de `tasks/update`, y el ack de
  `tasks/update` / `tasks/cancel`.
  _Hecho cuando:_ existe una tabla en el
  [contrato público](./contract.md#wire-contract) con cada campo, su tipo y si
  es opcional, citando el schema. Cualquier divergencia se corrige ahí, no en
  la cabeza.
- **R2.2 [0.5h] — Leer SEP-2663 y el spec HTML de la extensión** buscando
  específicamente las frases normativas (MUST/SHOULD/MAY) sobre: durabilidad
  antes del `CreateTaskResult` (I1), unicidad de claves (I5), parciales de
  `inputRequests` (A2) y semántica de `ttlMs` mutable (A3).
  _Hecho cuando:_ cada [invariante I1–I8](./contract.md#invariants) tiene al lado la cita
  normativa que lo respalda, o la marca "decisión nuestra, la spec no lo dice"
  — que es material del issue.
- **F2.3 [1h]** Decidir y ejecutar el consumo del schema: **vendorizar** el
  `schema.json` bajo `test/fixtures/ext-tasks-schema.json` con su commit SHA
  anotado, y validar nuestros tipos contra él en test. No como dependencia:
  cero-dependencias es innegociable y el schema no está en npm.
  _Hecho cuando:_ un test falla si nuestros tipos y el schema divergen, y el
  fichero dice de qué commit salió.
- **F2.4 [1h]** Un script `pnpm check:schema` que rebaje el fixture contra
  upstream y falle si cambió. Barato, y convierte "la spec se movió" en una
  señal de CI en vez de un descubrimiento tardío.

---

## Fase 3 — El motor · ~7h

El valor del paquete se documenta primero en el README.

- **R3.1 [1h] — Casos estudiados de máquinas de estado durables.**
  No para copiar arquitectura —esto no es un workflow engine y los
  [no objetivos](./contract.md#non-goals) lo prohíben— sino para tomar dos cosas concretas: cómo modelan el
  _waiting-for-input_ con reanudación (Temporal signals, Restate awakeables,
  Inngest `waitForEvent`) y cómo evitan el doble-completado bajo reintentos.
  El round-trip de `requestInput()` es la pieza con más filo del
  [modelo de input](./contract.md#input-rounds)
  y ya está resuelta en la literatura.
  _Hecho cuando:_ hay 5–10 líneas en `docs/internals.md` (borrador) diciendo
  qué patrón se adoptó y cuál se descartó, con enlaces.
- **F3.2 [2h]** `TaskLifecycle`: `createTask`, `getTask`, `updateTask`,
  `cancelTask`, `close`. Con I1 e I3 como criterio de diseño, no como test a
  posteriori: `createTask` no resuelve hasta que `store.create()` resolvió, y
  `getTask` no escribe **nada**.
- **F3.3 [2h]** `TaskHandle`: `progress`, `complete`, `fail`, `signal`, y
  `requestInput()`. Ésta última es la que se lleva el tiempo: registra claves
  únicas (I5), pasa a `input_required`, y devuelve una promesa que resuelve
  solo cuando llegan **todas**, aceptando parciales por el camino.
- **F3.4 [1h]** Errores de [`api.md`](./api.md) + el TTL y el sweeper. `sweep()`
  interno, sin payloads (I7).
- **F3.5 [1h]** Generación de `taskId` (I6): `crypto.randomUUID()`, y un test
  que falle si alguien lo cambia por algo derivable. Es una invariante de
  seguridad, no un detalle.

---

## Fase 4 — Stores · ~5h

- **F4.1 [1h]** `MemoryTaskStore`. Debe correr sin `node:fs` — es el que
  prueba que el motor vale en Workers/Deno.
- **R4.2 [0.5h]** Releer `process-wal/docs/api.md` y `docs/durability.md`:
  frontera de durabilidad real de `append` sin `fsync`, semántica de
  `checkpoint`, y qué garantiza `replay()` tras un tail roto.
  _Por qué:_ I1 dice "no resuelve hasta que es durable". Si `WalTaskStore`
  usa el default `fsync: false`, la frontera es la page cache — que sobrevive
  a `SIGKILL` pero no a pérdida de corriente. **Eso hay que decirlo en el
  README, no descubrirlo en una issue.**
- **F4.3 [2.5h]** `WalTaskStore`: índice en memoria, append por mutación,
  replay al abrir, checkpoint al llegar a terminal, compactación periódica.
- **F4.4 [1h]** CAS (`version` + `ConcurrentUpdateError`). `WalTaskStore` es
  single-writer y siempre gana, pero cumple el contrato para que la interfaz
  sea una sola (ver [package surface](./contract.md#package-surface)).

---

## Fase 5 — Kit de conformidad · ~3h

Tercer producto, no utilidad interna (ver [verification](./contract.md#verification)).

- **F5.1 [2h]** `runTaskStoreConformance(name, factory)` cubriendo los cinco
  métodos, CAS, TTL, y las invariantes que son responsabilidad del store.
- **F5.2 [0.5h]** Pasarlo contra **ambos** stores incluidos. Si no pasa contra
  los dos, no sale.
- **F5.3 [0.5h]** Su ejemplo de uso, que es lo que se enlaza cuando alguien
  diga "voy a hacer el de Redis".

---

## Fase 6 — Crash tests · ~4h · **no se recorta**

El corazón del proyecto y el material del demo (ver [verification](./contract.md#verification)).

- **F6.1 [3h]** Los cinco escenarios, cada uno con proceso hijo real y
  `SIGKILL` real, con puntos de sincronización explícitos. Nada de simular el
  crash con un flag, nada de `sleep`.
- **F6.2 [1h]** Que pasen en Windows igual que en Linux. Es donde el
  mantenedor desarrolla y donde `rename` sobre fichero abierto falla.

---

## Fase 7 — Investigación de la costura del SDK v2 · cerrada sin feature

Consecuencia del Spike 0. **Mantenerla pequeña es un requisito, no una
preferencia:** los [no objetivos](./contract.md#non-goals) excluyen implementar transporte.

- **R7.1 — HECHA, y corrigió una premisa falsa del plan.** Este paso decía
  «localizar el punto donde el Inspector reescribe el frame». **El Inspector no
  reescribe frames.** Responde los POST de `tasks/*` en middleware HTTP _antes_
  de que `createMcpHandler` los vea (`test-servers/src/modern-tasks.ts`) y en
  cliente los manda como frames crudos con `transport.send()`
  (`core/mcp/inspectorClient.ts`). La afirmación venía del borrador original,
  se repitió sin verificar y llegó a decir «la única vía verificada» en el
  contrato público. Corregido allí.

  La consecuencia que se evaluó para F7.2 fue que hay **dos** vías, y la del
  Inspector —interceptar por encima del SDK— esquiva el era-gate en vez de
  sortearlo. R7.2 registra abajo por qué no se convirtió ninguna en feature.

- **R7.2 — CERRADA fuera del paquete.** El ejemplo de crash recovery verificó
  la costura HTTP de host, que no requiere imports internos ni renombrado bajo
  `Protocol`. El paquete no publica `/sdk-v2`, no importa el SDK y no convierte
  un defecto de una versión concreta en API propia.
- **R7.3 — Gate de regresión, no Work Item.** Antes de F12 se vuelve a medir A6
  con el SDK instalado. Si upstream readmite los métodos, se elimina el
  workaround del ejemplo/host que ya no haga falta; si no, permanece fuera de
  `/client`. Reabrir una costura dentro del paquete requeriría una discusión y
  un cambio contractual independientes.

---

## Fase 8 — Documentación y v0.1.0 · ~5h

- **F8.1 [2h]** README. **La primera pantalla, en este orden:** (1) qué es y
  que se importa, no se añade a `mcp.json`; (2) que no es un gestor de tareas;
  (3) el [límite de procesos](./contract.md#process-boundaries) de forma
  explícita. Registro de voz:
  el de `process-wal` — empezar diciendo qué no hace.
  _Filtro antes de commitear:_ si un párrafo cabría en el README de Trello,
  fuera.
- **F8.2 [2h]** `docs/api.md` (referencia completa) + borradores de
  `internals.md` y `durability.md`. `examples.md` y `alternatives.md` pueden
  esperar a v0.2.0.
- **F8.3 [0.5h]** `SECURITY.md` reescrito desde las
  [invariantes](./contract.md#invariants): entropía del
  `taskId` como bearer token, no-enumeración, colisión de claves, CAS races.
  **No adaptar** el de `process-wal`: su modelo de amenaza es de filesystem.
- **F8.4 [0.5h]** Umbrales de cobertura, fijados midiendo, no inventando.
- **F8.5 [0.5h]** **v0.1.0: primera publicación npm manual.** Tag, GitHub
  Release, publicación local con 2FA y provenance desactivado, y configuración
  posterior del Trusted Publisher (ver
  [contrato de versiones](./contract.md#version-contract)).

---

## Fase 9 — Demo y v0.2.0 · ~4h

- **F9.1 — ✅ HECHA. `examples/crash-recovery/` en ESTE repo**, no un
  repositorio aparte: servidor MCP real con una task larga → `SIGKILL` →
  reinicio → el siguiente `tasks/get` devuelve el resultado completo.
  _Por qué esto y no un log de auditoría bonito:_ un log bonito no le duele a
  nadie; perder trabajo sí.

  **Cambio de decisión — el plan decía repositorio separado.** Ver abajo.

  Tres cosas que salieron al construirla:

  - **`server.mts` tuvo que implementar la costura de A6.** `tasks/get` y
    `tasks/cancel` no se pueden servir por el registro de handlers del SDK, así
    que responde esos POST en middleware HTTP **antes** de `createMcpHandler`.
    Es la vía del Inspector, y **eso responde de facto a R7.1/F7.2**: la
    interceptación por encima del SDK resultó más simple que el renombrado en
    `transport.onmessage`, no toca nada interno y es cosa del host, no de la
    librería. Este resultado cerró F7 como investigación: el patrón pertenece
    al host y no se convierte en un entry point del paquete.
  - **El demo se asevera a sí mismo.** `demo.mts` termina con `assert`s sobre
    el estado y el resultado recuperados, así que falla en vez de imprimir una
    historia feliz. Es requisito para poder grabarlo sin mentir.
  - **Sin sleeps.** El driver espera la línea `listening` del servidor y el
    estado observable de la task. Los tiempos que se ven en la grabación son
    trabajo, no relleno.

- **F9.3 — ✅ HECHA.** La
  [grabación de crash recovery](https://asciinema.org/a/U0DD3KWEttwhv5g5)
  ejecuta
  `pnpm --filter mcp-durable-tasks-example-crash-recovery run demo` desde un
  clon limpio de `faf4943`, el commit fusionado de la Fase 9. El README enlaza
  la reproducción y conserva el bloque de salida como alternativa textual.

- **F9.2 — ✅ HECHA.** `v0.2.0` se publicó desde `release.yml` mediante Trusted
  Publishing, OIDC y provenance. El
  [run de publicación](https://github.com/AndresSaa/mcp-durable-tasks/actions/runs/31440098853)
  terminó verde; npm expone attestations de publicación y SLSA ligadas al tag,
  al workflow y al commit `f1154da`. La secuencia reproducible queda en
  [`RELEASE.md`](./RELEASE.md#v020-primera-publicación-automática-con-provenance).

---

### La decisión de `examples/` (sustituye al repo separado de F9.1)

El plan original sacaba el demo a `mcp-durable-tasks-crashtest`. Se descarta:
un segundo repositorio es un segundo dependabot, CI, README y protección de
rama, con 8h/semana; y **un demo que se pudre es peor que ninguno**, porque su
valor entero es credibilidad. Dentro del repo cae bajo el mismo CI y las mismas
auditorías. Los no objetivos prohíben un segundo **paquete**, no un directorio
de ejemplos privado.

**Dos paquetes privados, no uno**, y la razón importa:

```
examples/
  README.md
  conformance-reproductions/   evidencia histórica  — versiones EXACTAS, congeladas
  crash-recovery/              documentación viva   — se actualiza con lo soportado
```

- `conformance-reproductions/` fija `@modelcontextprotocol/*` en `2.0.0` sin
  rango, **y sigue fijado incluso después de que upstream lo arregle**. Un
  issue enlaza a un script en un commit concreto como su evidencia; ese enlace
  tiene que seguir significando lo que significaba cuando lo revisaron.
- `crash-recovery/` es lo contrario: tiene que seguir el rango soportado y
  representar la forma recomendada de usar la librería.

Un solo `package.json` obligaría algún día a elegir entre actualizar el demo o
conservar reproducibles los hallazgos. Por eso son dos.

**CI: `examples-pinned` es bloqueante.** Con versiones y lockfile fijados,
upstream no puede romperlos por su cuenta — si ese job falla es porque un
cambio de este repo rompió un ejemplo publicado o invalidó una reproducción
que un issue enlaza, y ambas cosas son defectos del repositorio. No se equipara
a la pierna de Node 26, que explora un entorno móvil; esto es determinista.
Un `examples-sdk-current` opcional y no bloqueante puede avisar de deriva más
adelante.

Aislamiento verificado: los paquetes son privados, sus dependencias no entran
en los `devDependencies` de raíz, `files` excluye `examples/` por lista
explícita, y `pnpm lint:package` sigue demostrando que el consumidor no las
recibe. El lockfile crece; es coste de desarrollo, no de runtime ni del
paquete publicado.

**Cómo se citan en los issues:** el caso mínimo, expected/actual y la salida
relevante van **dentro** del issue; el permalink al script ejecutable va con
SHA completo del commit, nunca a `main`. Aunque el ejemplo vivo cambie después,
el issue conserva la evidencia revisada.

**Y el SHA tiene que ser alcanzable desde `main`.** Los dos primeros reportes
se enlazaron al commit de la rama _antes_ del squash. Resolvía en el navegador
—la rama seguía en origin— pero las instrucciones del propio issue
(`git clone` + `git checkout <sha>`) habrían dejado de funcionar en cuanto la
rama se borrara: un clon nuevo no trae ese objeto. Se corrigieron a los commits
fusionados. La regla completa es **SHA completo del commit de `main`**, y se
comprueba clonando en limpio antes de publicar, no después.

---

## Fase 10 — Conformidad upstream · ✅ HECHA

- **R10.1 — ✅ HECHA.** Se revisaron los PRs e issues abiertos antes de
  publicar. A1 ya estaba en movimiento; en #11 se respondió sobre enumeración y
  TTL sin desviar el hilo hacia esta librería.
- **F10.2 — ✅ HECHA, con cambio de estrategia.** Un informe único habría
  mezclado propietarios y permitido cerrar tres hallazgos con una sola decisión.
  Se publicaron por separado y con reproducciones fijadas a commits de `main`:
  - [ext-tasks#14](https://github.com/modelcontextprotocol/ext-tasks/issues/14):
    fidelidad del JSON Schema;
  - [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637):
    validación de `CreateTaskResult` y default de `resultType`;
  - [typescript-sdk#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598):
    reproducción independiente añadida al issue existente del era-gate.

  La librería no se promociona dentro de los hallazgos; funciona como la
  evidencia de que provienen de una implementación real.

---

## Fase 11 — Distribución · ~5h · primera en caerse

- **F11.1 [4h]** Artículo bilingüe, canonical en craftender.dev:
  _«Implementando el Task Store de MCP: lo que la spec no te dice»_. El Spike 0
  ya le dio el mejor gancho que va a tener: dos de los tres métodos de la
  extensión no se pueden servir con el SDK oficial, y aquí está el porqué.
- **F11.2 [1h]** Empaquetar el demo como Agent Plugin. **Pertenece más a la
  Pieza 2** (`agent-plugin-lint`); si el tiempo aprieta, va allí.

---

## Fase 12 — Driver de cliente para Tasks · v0.3.0 preferida · gated

El siguiente trabajo de producto por prioridad, no por dependencia técnica.
`v0.2.1` ya está publicada, pero
[A6 y A10](./contract.md#extension-conformance-questions) siguen abiertas en
la versión medida del SDK. F12 no se inicia hasta pasar la puerta de readiness
descrita abajo.

### Límite: seguir una task, no implementar un cliente MCP

El candidato es `mcp-durable-tasks/client`, un driver web-standard y sin
dependencias de runtime que empieza cuando el host ya tiene un
`CreateTaskResult` o un `taskId`. No abre conexiones, no hace `tools/call`, no
negocia protocolo, no construye headers, no autentica y no importa el SDK
oficial. Esas responsabilidades permanecen en el cliente MCP del host.

El driver recibe un adaptador estructural normalizado con tres operaciones:

```ts
interface TaskClientAdapter {
  getTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<GetTaskResult>;
  updateTask(
    taskId: string,
    inputResponses: InputResponses,
    options?: { signal?: AbortSignal },
  ): Promise<UpdateTaskResult>;
  cancelTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<CancelTaskResult>;
}
```

La firma pública exacta se asienta en `api.md` antes del código, pero el
comportamiento queda cerrado aquí:

- `follow()` parte de un `CreateTaskResult`; `resume()` recibe un `taskId` y
  hace un `tasks/get` inmediato. El seed solo contiene el `Task` base:
  nunca se devuelve como resultado detallado. Si llega `working`, el primer
  get respeta su hint; si llega ya `input_required` o terminal, el get es
  inmediato para obtener `inputRequests`, `result` o `error`. Ambos métodos
  resuelven con la variante terminal completa (`completed`, `failed` o
  `cancelled`), sin reinterpretar `error` ni extraer un resultado que pierda
  metadatos.
- Solo hay un `tasks/get` en vuelo por task. El siguiente delay empieza después
  de recibir la respuesta anterior y usa el `pollIntervalMs` más reciente.
  Cuando no hay hint, el default es 1.000 ms; un mínimo configurable, 50 ms por
  defecto, impide hot loops. El driver puede esperar más que el hint, nunca
  menos que `max(hint, minimumPollIntervalMs)`.
- `resolveInput({ taskId, key, request, signal })` es responsabilidad del host.
  Se invoca una sola vez por key durante una ejecución del driver. Cada promesa
  queda memoizada; las respuestas asentadas en el mismo turno de microtasks se
  envían en un único `tasks/update`, y las pendientes permiten updates
  parciales sin volver a presentar el mismo request. Mientras espera input no
  hace polling vacío. Si una key ya respondida reaparece en una ronda posterior,
  falla como violación de la unicidad vitalicia de la extensión.
- Un `AbortSignal` antes o durante el seguimiento aborta waits y requests,
  envía como máximo un `tasks/cancel` si ya se conoce el id y termina con la
  razón original después del acknowledgement. Si `cancelTask` falla, propaga
  ese error operativo; la razón original sigue en `signal.reason`. No espera a
  observar `cancelled`, porque la extensión no lo garantiza.
- Un error de adaptador, resolver o validación se propaga sin retry ni backoff.
  El `taskId` sigue siendo reanudable por el host. No hay persistencia cliente,
  suscripciones ni deduplicación durable después de reiniciar el proceso.
- El driver valida cada seed y respuesta recibida; un adaptador tipado no
  convierte tráfico no confiable en un valor válido. No acepta métodos de la
  task vocabulary retirada de `2025-11-25`.

El paquete no incluye un adaptador específico del SDK. La documentación podrá
mostrar uno cuando la API pública del SDK permita obtener el
`CreateTaskResult` y enviar los tres métodos sin `transport.send()`, miembros
protegidos, casts ni imports internos.

### Puerta de readiness de F12

Antes de cambiar el estado a `ready`:

1. Releer spec, schema, SDK instalado e issues A6/A10; actualizar las
   reproducciones fijadas, sin reescribir su evidencia histórica.
2. A10 debe estar resuelta upstream **o** debe existir necesidad de usuario
   documentada que acepte explícitamente que el host inyecte el seed obtenido
   por otra vía pública. El driver no intercepta el response funnel del SDK.
3. A6 debe estar resuelta upstream **o** la integración usa la costura HTTP de
   host ya verificada. Ningún workaround de servidor entra en `/client`.
4. Probar una integración real de `tools/call` → `CreateTaskResult` →
   `working` → `input_required` → `completed` con APIs públicas. Un fake prueba
   el algoritmo, no la compatibilidad con el SDK.
5. Registrar en `contract.md` cuál de las dos rutas abrió cada gate antes de
   crear el worktree.

```text
Work Item: F12.1
Tipo: feat
Slug: task-client-driver
Base: main
Estado: blocked-by-readiness-gate
Orca identity: feat/f12-1-task-client-driver
Relationship: no-parent
```

Una sola Work Item y un solo PR. Sus tracks obligatorios son:

- **F12.1a — Contrato y validación.** Superficie `/client`, adaptador
  estructural, shapes runtime y errores; main sigue sin dependencias.
- **F12.1b — Polling.** Timers falsos, intervalos dinámicos, ausencia de
  overlap, seed base frente a respuesta detallada, terminalidad, resume y
  abort durante espera/request.
- **F12.1c — Input rounds.** Dedupe por key, respuestas parciales, varias keys
  resueltas en distinto orden y en el mismo turno, reaparición ilegal de una
  key ya respondida, resolver que falla y cancelación con prompts pendientes.
- **F12.1d — Integración.** SDK real sobre HTTP, headers/routing propiedad del
  SDK/host, resultados `complete` y `task`, A6 y A10 cubiertas por regresiones.
- **F12.1e — Rendimiento y empaquetado.** Una ejecución retiene O(keys vistas)
  y O(1) estado de polling; no acumula timers, listeners ni requests tras
  terminal/abort. Tests con timers falsos recorren 10.000 polls sin tiempo real,
  verifican una sola request y un solo timer activos, y cubren la carrera entre
  terminalidad y abort sin enviar un cancel tardío. ESM/CJS, tarball sin SDK
  instalado, cobertura y matriz completa.
- **F12.1f — Docs y auditoría.** README, `api.md`, `contract.md`, este plan y
  changelog en el mismo PR. Auditoría independiente antes de merge; cada
  defecto confirmado empieza por un test rojo.

F12 y F13 no se desbloquean entre sí. El orden es una decisión de producto con
una salida explícita: si F12 sigue bloqueada cuando F13 cumple su readiness y
hay necesidad real del store, un cambio documental separado puede reasignar
SQLite al siguiente minor. Los números de versión expresan orden de entrega,
no reservas irrevocables.

---

## Fase 13 — `NodeSqliteTaskStore` · v0.4.0 preferida · tras F12 por defecto

No es una familia de conectores. Es **un** store de primer partido que cubre
el único hueco local que `WalTaskStore` deja a propósito.

### El hueco que cubre, y el que no

`WalTaskStore` ya da durabilidad local a un proceso y un disco. Quien despliega
varias réplicas detrás de un balanceador **sigue** implementando `TaskStore`
sobre su base compartida y pasando el kit de conformidad. Ese caso —Postgres,
Redis, D1, Turso remoto, libSQL— no es un hueco de este repositorio: es el
motivo por el que el kit se publica.

El hueco cubrible aquí es más estrecho, y es real:

1. **Más de un proceso sobre el mismo disco.** Dos writers en un directorio
   de `process-wal` corrompen el log. SQLite sí arbitra writers.
2. **Una base inspectable** con herramientas ordinarias, no un log propio. En
   WAL existen sidecars `-wal` y `-shm` mientras hay conexiones activas; no se
   promete un único fichero físico en todo momento.
3. **Sin peer `process-wal` y sin addon nativo.** `node:sqlite` es builtin
   [desde Node 22.13, sin flag](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html).

Eso complementa a `WalTaskStore`; no lo sustituye. `WalTaskStore` sigue siendo
el almacén de un stdio de un solo proceso que quiere el contrato de
`process-wal`. `NodeSqliteTaskStore` es el de un host local que necesita CAS
entre procesos en la misma máquina. En su primera versión posee un fichero
dedicado: no se inyecta una conexión de la aplicación y no cambia el journal
mode de una base ajena.

Sigue siendo disco local. **No** resuelve la afinidad del worker (A9): el CAS
protege el registro; la promesa de `requestInput()` y el `AbortSignal` siguen
siendo del proceso que ejecuta el trabajo. Un SQLite compartido sin sticky
routing no convierte esto en un motor de colas.

### Fuera de alcance — no se reabre en esta fase

- `better-sqlite3` y cualquier addon nativo.
- `@libsql/client`, Turso, un `TursoTaskStore`, réplicas embebidas o Turso
  Sync. Quien los quiera escribe cinco métodos y corre
  `mcp-durable-tasks/testing`.
- Postgres, Redis, D1 u otro driver de comunidad.
- Un executor SQL genérico, una abstracción `SqlTaskStore`, o subpaths
  `/postgres` / `/libsql` / `/redis`.
- Autenticación, URLs, construcción de clientes o ownership de transporte.
- Subir el floor de Node del entry principal. `/sqlite` documenta 22.13+;
  `mcp-durable-tasks` y `/testing` siguen en Node 22.

### Superficie cerrada antes de implementar

La API prevista es deliberadamente pequeña:

```ts
new NodeSqliteTaskStore({
  file: "./data/tasks.sqlite",
  busyTimeoutMs: 250,
  maxEntryBytes: 8 * 1024 * 1024,
  now: Date.now,
});
```

- `file: string` es obligatorio. El store abre y posee su conexión. Rechaza
  cadena vacía, `:memory:` y bases temporales; el directorio padre debe existir.
- Varias instancias y procesos pueden abrir el mismo fichero **en el mismo
  host**. Compartirlo por NFS/SMB, serverless efímero o varios hosts es
  configuración no soportada.
- `busyTimeoutMs` es un entero finito `>= 0`, default 250 ms. Se aplica mediante
  [`PRAGMA busy_timeout`](https://sqlite.org/pragma.html#pragma_busy_timeout),
  disponible en Node 22.13; no se usa la opción de constructor añadida en
  22.16. Agotarlo propaga el error SQLite original, no un
  `ConcurrentUpdateError` ni un retry oculto.
- `maxEntryBytes` mide UTF-8 de `record_json`, default 8 MiB. Se valida antes de
  abrir una transacción y reutiliza `TaskEntryTooLargeError` y su código
  estable. El mensaje de ese error deja de nombrar solo a `WalTaskStore` en el
  mismo cambio. Es un límite del encoding de cada store: el envelope de WAL y
  la fila SQLite no son byte a byte portables en el borde; los consumidores
  que alternen stores deben dejar margen.
- `now` es la costura de reloj para TTL y tests. `close()` es idempotente y solo
  cierra la conexión que el store posee.

[`DatabaseSync` ejecuta sus APIs de forma síncrona](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html#class-databasesync)
y bloquea el event loop. Los métodos conservan el `Promise` exigido por
`TaskStore`, pero el trabajo SQLite ocurre síncronamente antes de resolverlo;
no se presenta como off-thread. El timeout corto y el límite de payload acotan
los dos bloqueos controlables, y la documentación recomienda `WalTaskStore` o
un store remoto cuando esa sincronía no sea aceptable.

### Contrato de durabilidad que hay que escribir, no inferir

El mismo listón que `WalTaskStore` en [`durability.md`](./durability.md). Antes
de implementar, asentar y documentar:

- Fichero dedicado con tablas privadas `_mcp_durable_tasks_records` y
  `_mcp_durable_tasks_meta`. No usar `PRAGMA user_version`.
- Snapshot canónico en `record_json` más escalares indexados (`task_id`,
  `version`, `expires_at`). `expires_at` usa `REAL` para preservar el contrato
  numérico actual; índice dedicado para `sweep`. Sin API de enumeración (I7).
- Creación del schema v1 y cada migración futura explícita bajo
  `BEGIN IMMEDIATE`, con rollback ante error y rechazo de versiones futuras
  desconocidas. La primera release solo implementa vacío -> v1: no incorpora
  un framework genérico para migraciones que aún no existen. Dos procesos que
  abren a la vez nunca observan medio schema.
- Al abrir, fijar primero el busy timeout, ejecutar y verificar después
  `journal_mode=WAL` y `synchronous=FULL`, y solo entonces migrar y preparar
  statements. [WAL es una propiedad persistente](https://www.sqlite.org/wal.html#persistence_of_wal_mode)
  del fichero; por eso el fichero es propiedad de este store.
- `create` no resuelve hasta después del commit (I1). `get` no muta (I3).
- Toda escritura abre `BEGIN IMMEDIATE`. `update` normaliza y mide antes de esa
  transacción, y escribe `record_json`, `version` y `expires_at` en un único
  `UPDATE ... WHERE task_id = ? AND version = ?`. Si afecta cero filas, consulta
  el estado actual **dentro de la misma transacción**, hace rollback y construye
  `ConcurrentUpdateError`: versión viva exacta si existe, `undefined` si falta
  o expiró. Así otro writer no puede cambiar el diagnóstico entre el CAS y la
  lectura. `SQLITE_BUSY` nunca se disfraza de CAS perdido.
- `sweep` borra caducadas y devuelve solo el recuento.
- Cada operación reutiliza statements preparados; `get`/`update` usan la
  primary key y `sweep` el índice de expiración. No hay scan para una lectura
  por id ni prepare por operación.
- Documentar la frontera exacta proceso-crash vs pérdida de corriente y que
  WAL + `synchronous=FULL` no corrige un filesystem que incumpla flush/locking.
- I8 se vuelve específico por store: `WalTaskStore` sigue siendo
  single-writer; el store SQLite documenta writers concurrentes en el mismo
  fichero local. Las [fronteras de proceso](./contract.md#process-boundaries)
  se reescriben en el mismo cambio, no como nota a posteriori.

`node:sqlite` sigue en desarrollo activo en Node 22. El subpath usa solo APIs
presentes en 22.13. Si una API se mueve antes de 1.0, es un breaking menor
pre-1.0 con entrada de changelog, no una sorpresa.

### Work Item y puerta de readiness

No se invoca `$orca-start-work` hasta que se cumpla una de estas rutas y F13.1
se marque `ready` en este plan:

1. F12.1 está publicada como `0.3.0`; o
2. F12 sigue bloqueada, existe una necesidad demostrada de SQLite y un cambio
   documental separado reasigna `NodeSqliteTaskStore` al siguiente minor.

La segunda ruta no cambia el orden en silencio: actualiza `contract.md`,
`AGENTS.md`, este plan y el número objetivo antes de crear el worktree.

```text
Work Item: F13.1
Tipo: feat
Slug: node-sqlite-store
Base: main
Estado: blocked-by-strategic-readiness-gate
Orca identity: feat/f13-1-node-sqlite-store
Relationship: no-parent
```

F13.1 es la única Work Item. Los tracks F13.1a–F13.1f viven en el mismo
worktree y salen en el mismo cambio. Un `/sqlite` sin crash tests, sin kit en
verde o con docs que describan un contrato distinto al código no se fusiona.

- **F13.1a — Superficie y motor.** Estrechar el non-goal de community stores en
  [`contract.md`](./contract.md#non-goals) a la excepción `node:sqlite`.
  Añadir `mcp-durable-tasks/sqlite` sin tocar dependencias del entry
  principal. Schema, migración, snapshot canónico, CAS, TTL, `sweep`,
  `close` idempotente. `src/sqlite.ts` puede importar `node:*`; `src/index.ts`
  y `src/testing.ts` siguen sin Node built-ins.
  _Hecho cuando:_ el store crea, lee, actualiza con CAS y barre sobre un
  fichero real, prueba el borde exacto y Unicode multibyte de `maxEntryBytes`,
  rechaza schema futuro sin escribir, rechaza operaciones después de `close`,
  y el tarball exporta `/sqlite` en ESM y CJS.
- **F13.1b — Kit de conformidad.** Ejecutarlo contra este store, con costuras
  de reloj y reopen, **sin checks saltados**. El kit pasa contra los tres stores
  incluidos antes de etiquetar.
  _Hecho cuando:_ `runTaskStoreConformance` está verde aquí igual que en
  memoria y WAL, y un store roto a propósito sigue fallando.
- **F13.1c — Concurrencia real.** Dos conexiones y, aparte, dos
  procesos contra el mismo fichero. CAS perdido, read-after-write y
  cold-open simultáneo, además de dos escenarios coordinados por IPC: lock
  liberado antes del timeout y lock retenido hasta obtener `SQLITE_BUSY`.
  Windows es target de primer orden para locking, checkpoints y sidecars. Nada
  de sleeps.
  _Hecho cuando:_ hay tests que fallan si el segundo writer corrompe o
  silencia el primero, y la versión `actual` del CAS perdido es exacta bajo
  contención; no un comentario que dice que WAL mode basta.
- **F13.1d — Crash tests.** A la altura de la Fase 6: hijo real, `SIGKILL` real,
  puntos de sincronización explícitos, contra `dist/`. Cubrir creación
  durable, input parked, terminal con payload y reopen tras kill.
  _Hecho cuando:_ I8 está demostrada para este store igual que para
  `WalTaskStore`, con la frontera de `synchronous=FULL` escrita en
  `durability.md`.
- **F13.1e — Rendimiento y empaquetado.** Statements preparados una vez y
  `EXPLAIN QUERY PLAN` demostrando primary key para `get`/`update` e índice de
  expiración para `sweep`; un dataset grande de test no cambia esos planes.
  Un stress de cuatro procesos, cien mutaciones confirmadas sobre una task
  propia por proceso y sin retries debe conservar las cuatro versiones finales
  sin `SQLITE_BUSY`; aparte, el test de lock retenido demuestra el error al
  agotar el timeout. Límite de payload y timeout prueban los límites sin un gate
  de milisegundos dependiente del runner. Un benchmark reproducible puede
  informar latencias, pero ninguna cifra entra en docs ni bloquea CI hasta
  medirse de forma estable.

  Añadir `exports`, `attw --profile node16`, `publint --strict`. El smoke del
  tarball sin `process-wal` sigue demostrando que `.` y
  `/testing` no lo necesitan; `/sqlite` se importa en ese smoke porque es
  builtin de Node, no un peer. La matriz CI (Linux/macOS/Windows × 22/24, más
  Node Current informativo) ejecuta los tests nuevos. Además, una pierna
  `sqlite-floor` fija Node 22.13 en Linux/macOS/Windows: `22.x` actual no prueba
  el floor ni impide usar por accidente una API añadida en 22.16.
  _Hecho cuando:_ `pnpm lint:package` pasa y un consumer que no instaló
  `process-wal` puede `import` de `/sqlite`.

- **F13.1f — Docs y auditoría.** README (tercer store, cuándo usar cuál),
  `api.md`, `contract.md` (superficie, I8, fronteras de proceso, non-goals),
  `durability.md`, este plan, `CHANGELOG.md`. Auditoría independiente antes de
  merge, no solo antes del tag; cada hallazgo se verifica con un test que falla
  antes de corregirlo. El editor abre el PR; el auditor revisa el mismo
  worktree sin editar código de producto.

### Qué se decidió no hacer, para que no vuelva como “F13.2”

Una propuesta anterior contemplaba un `LibsqlTaskStore` de cliente inyectado
después de auditar SQLite. Se descarta para `0.4.0` y no queda como siguiente
paso implícito. Un cliente remoto introduce CAS ambiguo de red, credenciales,
un servicio reproducible y un contrato de durabilidad que este repositorio no
puede demostrar con `SIGKILL` local. Eso es un store de comunidad, y el kit
existe para eso.

---

## Después — v1.0.0

Cuando las
[preguntas de conformidad](./contract.md#extension-conformance-questions)
estén cerradas o registradas como decisiones explícitas del paquete, y
`TaskStore` / `TaskLifecycle` congeladas. Entonces: reescribir la sección de
API provisional de `AGENTS.md` al registro de “superficie cerrada” de
`process-wal`; valorar si este plan operativo sigue aportando valor. No se
etiqueta `1.0.0` para “completar” F13.

---

## Orden de ataque

Cómo se construyó `v0.1.0`–`v0.2.0` (historia, no el siguiente sprint):

```
F1 ──▶ R2 ──▶ F3 ──▶ F4 ──▶ F5 ──┬─▶ F6 ──▶ F8 ──▶ F9 ──▶ F10
       (schema  (motor) (stores) (kit) │  (crash)  (docs) (demo)  (issue)
        antes                          └─▶ F7 (investigación SDK, sin feature)
        que el
        motor)
```

Dos reglas de secuencia de esa etapa, que siguen siendo ciertas:

1. **R2 antes que F3.** El schema decide la forma de los tipos; el motor se
   escribe contra tipos ya validados.
2. **F10 no espera a F11.** Si en la semana 3 el artículo no está, el issue se
   manda igual. Al revés no: un artículo sin el issue detrás es marketing.

Lo que queda, con la prioridad preferida y su escape explícito:

```
F12 (v0.3.0 preferida, cliente, gated) ──▶ F13 (v0.4.0 preferida, node:sqlite)
                  │
                  └─ si sigue bloqueada + F13 está ready: decisión contractual
                     separada, F13 ocupa el siguiente minor y F12 se reprograma
F11 (artículo) es distribución y puede ir en paralelo; no bloquea F12.
F7 está cerrada sin feature; A6 se vuelve a medir como gate de F12.
```

SQLite no se adelanta por novedad ni como palanca de audiencia. Solo cambia el
orden preferido si F12 está realmente bloqueada, F13 satisface su puerta y el
contrato público se actualiza antes de crear el worktree.
