# mcp-durable-tasks — Plan de ejecución

> **Audiencia:** el autor y los agentes de código. Documento operativo, no
> contractual: [`contract.md`](./contract.md) es la autoridad pública de
> alcance e invariantes. Los dos borradores privados que originaron este plan
> se archivaron fuera del repositorio antes del primer push y se eliminaron;
> el historial se compactó para que tampoco viajen en commits anteriores.
>
> **Revisión 3** — 10 agosto 2026, auditoría de preparación de `v0.1.0` y
> operativa de apertura/publicación. El procedimiento ejecutable vive en
> [`RELEASE.md`](./RELEASE.md).

---

## 0. Dónde estamos

- ✅ Borradores privados actualizados y contrato público en inglés extraído a
  [`contract.md`](./contract.md).
- ✅ Prior art verificado: hueco vacío (npm libre, nada equivalente en
  `ext-tasks`).
- ✅ `CLAUDE.md` / `AGENTS.md` — escritos.
- ✅ **Spike 0 resuelto** (ver [compatibilidad del SDK](./contract.md#typescript-sdk-v2-compatibility)).
  El motor es puro estado; la costura de compatibilidad queda fuera de v0.1.0.
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
- ⬜ **Siguiente:** merge del PR de README, completar About/topics, ejecutar
  CodeQL, tag `v0.1.0`, publicación npm manual y configuración del Trusted
  Publisher, siguiendo
  [`RELEASE.md`](./RELEASE.md). `v0.2.0` será la primera publicación automática
  con OIDC y provenance.
- ⏸️ **Fase 7 no forma parte del DoD de `v0.1.0`.** La costura del SDK sigue
  sin construir y se declara así en los docs públicos. Se decide después de la
  respuesta upstream a A6; no se finge soporte de transporte en este tag.

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

## Fase 7 — Costura de compatibilidad con el SDK v2 · ~3h

Consecuencia del Spike 0. **Mantenerla pequeña es un requisito, no una
preferencia:** los [no objetivos](./contract.md#non-goals) excluyen implementar transporte.

- **R7.1 [1h] — Leer cómo lo hace el Inspector.** Localizar en
  `modelcontextprotocol/inspector` el punto exacto donde reescribe el frame
  y qué más tuvo que tocar. Si ellos tropezaron con algo que nosotros no
  hemos visto, sale aquí y no en producción.
- **F7.2 [1.5h]** La costura: renombrar `tasks/get` y `tasks/cancel` en
  `transport.onmessage` antes de `Protocol`. Con la prueba del Spike 0 como
  test de regresión — si una versión futura del SDK readmite esos métodos,
  queremos enterarnos por un test rojo.
- **F7.3 [0.5h]** Decidir A6: ¿cuarto entry point `/sdk-v2` o parte del
  principal? Criterio: si obliga a `@modelcontextprotocol/server` como peer,
  va en su propio entry point, por la misma razón que `process-wal`.

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

- **F9.1 [2.5h]** Repo `mcp-durable-tasks-crashtest`: servidor MCP con una
  task larga → `kill -9` → reinicio → el siguiente `tasks/get` devuelve el
  resultado. 40 segundos de asciinema.
  _Por qué esto y no un log de auditoría bonito:_ un log bonito no le duele a
  nadie; perder trabajo sí.
- **F9.2 [1h]** Publicar `v0.2.0` desde `release.yml` con Trusted Publishing,
  OIDC y provenance; verificar la atestación y que el workflow falla de forma
  segura si la variable de activación no está configurada.
- **F9.3 [0.5h]** Enlazar el asciinema desde el README.

---

## Fase 10 — El issue · ~3h · **la semana de mayor ROI, no se recorta**

- **R10.1 [1h] — Releer los PRs abiertos de `ext-tasks` antes de escribir.**
  Sobre todo el que corrige `MISSING_REQUIRED_CLIENT_CAPABILITY` a `-32021`:
  **es literalmente nuestra ambigüedad A1**, y preguntar algo que ya está en
  un PR abierto es la forma más rápida de parecer que no hiciste los deberes.
  Revisar también si #11 ("stalled tasks") toca nuestro A3/A4.
- **F10.2 [2h]** Escribir el issue en `modelcontextprotocol/ext-tasks`.
  Formato: **informe de conformidad de un implementador**, con A1–A6 como
  preguntas concretas. **A6 va primero** — es el hallazgo más fuerte: gap
  reproducible, causa localizada en el código, superficie de arreglo pequeña.
  La librería se menciona **una vez, al final**, como contexto de dónde
  salieron las preguntas. No "he hecho una librería, ¿os gusta?".

---

## Fase 11 — Distribución · ~5h · primera en caerse

- **F11.1 [4h]** Artículo bilingüe, canonical en craftender.dev:
  _«Implementando el Task Store de MCP: lo que la spec no te dice»_. El Spike 0
  ya le dio el mejor gancho que va a tener: dos de los tres métodos de la
  extensión no se pueden servir con el SDK oficial, y aquí está el porqué.
- **F11.2 [1h]** Empaquetar el demo como Agent Plugin. **Pertenece más a la
  Pieza 2** (`agent-plugin-lint`); si el tiempo aprieta, va allí.

---

## Fase 12 — Después · sin comprometer

- **F12.1** v0.3.0, driver de cliente. **No se toca hasta que v0.2.0 esté
  publicado** (ver [contrato de versiones](./contract.md#version-contract)). Está listado para que nadie lo proponga como si
  fuera nuevo.
- **F12.2** v1.0.0 cuando las
  [preguntas de conformidad](./contract.md#conformance-questions) estén cerradas y `TaskStore` /
  `TaskLifecycle` congeladas. Entonces: reescribir la sección de API
  provisional de `AGENTS.md` al registro de "superficie cerrada" de
  `process-wal`; valorar si este plan operativo sigue aportando valor.

---

## Orden de ataque

```
F1 ──▶ R2 ──▶ F3 ──▶ F4 ──▶ F5 ──┬─▶ F6 ──▶ F8 ──▶ F9 ──▶ F10
       (schema  (motor) (stores) (kit) │  (crash)  (docs) (demo)  (issue)
        antes                          └─▶ F7 (costura SDK, en paralelo)
        que el
        motor)
```

Dos reglas de secuencia que no son negociables:

1. **R2 antes que F3.** El schema decide la forma de los tipos; el motor se
   escribe contra tipos ya validados.
2. **F10 no espera a F11.** Si en la semana 3 el artículo no está, el issue se
   manda igual. Al revés no: un artículo sin el issue detrás es marketing.
