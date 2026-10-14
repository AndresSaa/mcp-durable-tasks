# mcp-durable-tasks — Plan de ejecución

> **Audiencia:** el autor y los agentes de código. Es un documento operativo, no contractual: [`contract.md`](./contract.md) es la autoridad pública de alcance e invariantes. El procedimiento de publicación vive en [`RELEASE.md`](./RELEASE.md).

---

## 0. Dónde estamos

Última revisión: 14 de octubre de 2026.

| Versión  | Estado                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.1.0` | Publicada. Primera publicación npm manual, sin provenance.                                                                                                                                              |
| `v0.2.0` | Publicada desde `release.yml` con OIDC y provenance (commit `f1154da`). Añadió la demo de crash recovery.                                                                                               |
| `v0.2.1` | Publicada. Solo corrigió el README en npm.                                                                                                                                                              |
| `v0.3.0` | Publicada. Endurecimiento tras la tercera auditoría y alineación con la spec estable `2026-07-28`. Rompe compatibilidad, así que por la regla pre-1.0 no podía salir como `0.2.2`.                      |
| `v0.4.0` | Ya fusionada en `main` (#42), sin tag. Cierra los problemas conocidos de `0.3.0` y aborta la `signal` del worker al vencer el TTL. Falta la auditoría que exige `AGENTS.md`, el PR de versión y el tag. |
| `v0.5.0` | Preferida: Fase 12, emisor de cambios para `notifications/tasks`. Bloqueada por A7.                                                                                                                     |
| `v0.6.0` | Preferida: Fase 13, `NodeSqliteTaskStore`.                                                                                                                                                              |

El orden de `0.5.0` y `0.6.0` es una decisión de [contrato de versiones](./contract.md#version-contract), no una reserva irrevocable. Cambiarlo exige antes un cambio contractual.

El driver de cliente (el antiguo F12) salió del roadmap por [decisión contractual](./contract.md#decision-no-client-follower): `@modelcontextprotocol/ext-tasks/client` cubre ese lado.

Pendiente a mano del mantenedor: configuración de cuenta del repo (F1.6, ver [`RELEASE.md`](./RELEASE.md)).

---

## Fases terminadas

Cada fase quedó en una línea o dos. Los números de tests y cobertura de entonces ya no importan: la suite actual es la referencia. Las decisiones que contradijeron el plan se dejan, porque son lo que un lector necesita.

### Fundaciones (F1)

Paquete, tooling, CI y `SECURITY.md`/`CONTRIBUTING.md`. Decidido por el camino:

- `attw` con `--profile node16` y la frontera "sin `node:*`" por eslint: ver [`AGENTS.md`](../AGENTS.md#commands).
- `release.yml` se niega a publicar automáticamente por debajo de `0.2.0`. Desde `0.2.0`, si falta la variable de Trusted Publishing, el workflow falla en vez de omitir npm: una versión de npm no se puede retirar.
- `tsup` arrastra `esbuild`, que necesita el override `^0.28.1` (advisory GHSA-g7r4-m6w7-qqqr). Es el mismo override que `process-wal`.
- Corrección al plan inicial: el Trusted Publisher no se puede configurar antes de la primera publicación, porque npm exige que el paquete exista. Por eso `v0.1.0` fue manual.
- `SECURITY.md` se escribió desde las invariantes, no se adaptó el de `process-wal`: su modelo de amenaza es de filesystem.

### Spike 0 y schema (R2)

Spike 0 está resuelto: el motor es puro estado y la costura de compatibilidad con el SDK queda en el host ([contrato](./contract.md#typescript-sdk-v2-compatibility)). El schema oficial se leyó entero, se vendorizó con su commit anotado y los tests lo anclan; `check:schema` avisa cuando upstream se mueve. R2.2 (leer las frases normativas de SEP-2663) resolvió A2, A3, A4 y A5.

### El motor (F3)

`TaskLifecycle`, `TaskHandle`, `MemoryTaskStore`, proyección al wire y errores. Decisiones que el plan no preveía:

- `TaskHandle.cancelled()` es API nueva. Sin ella el estado `cancelled` es inalcanzable: `tasks/cancel` solo levanta la señal, y solo el worker sabe cuándo para de verdad.
- `updateTask` sobre una task terminal devuelve ack, no error. Ninguna clave está viva y la spec dice ignorar las no vivas, así que un error sería un bug de conformidad. Se traga `TaskAlreadyTerminalError` ahí y solo ahí.
- `applyPatch` borra los `undefined` en vez de ignorarlos. Si no, una task completada arrastraría sus `inputRequests`.
- No existe `UnknownInputKeyError`: contradecía la spec.
- No hay API pública para "task aparcada" (`untilParked` es helper de tests). El cliente ve `input_required` por `tasks/get`. El bug real era que el waiter se registraba después del write durable; ahora se instala antes del CAS.

### `WalTaskStore` (F4)

Corrección de diseño: el borrador decía "checkpoint al llegar a terminal". Es incorrecto: `replay()` de `process-wal` solo devuelve entradas posteriores al checkpoint, así que una task completada desaparecería del arranque siguiente, y I8 exige conservar el resultado hasta que expire el TTL. La compactación es un snapshot con reescritura (se anexa el estado vivo, se marca procesado lo anterior y se compacta). Un test falla si alguien vuelve al diseño ingenuo.

Las reglas compartidas entre stores (`hasExpired`, `applyPatch`, `snapshot`) viven en `src/record.ts`, porque son contrato y el kit se las exige a cualquier store.

`WalTaskStore` expone `maxEntryBytes` (default razonado de 8 MiB). Un `result` grande hacía fallar `complete()` y perdía el trabajo; ahora falla antes de comprometer con `TaskEntryTooLargeError`/`ERR_ENTRY_TOO_LARGE` y el worker puede completar con un resultado truncado.

### Kit de conformidad (F5)

`runTaskStoreConformance`. Pasa contra los dos stores incluidos y detecta fallos en tres stores rotos a propósito. Dos decisiones que salieron al construirlo:

- La factory se invoca una vez por check y debe devolver un sujeto fresco, reloj incluido. El smoke del tarball lo descubrió: un reloj compartido acumulaba el tiempo avanzado por otro check.
- El runner se pasa explícito (`{ runner: { describe, it } }`), para no obligar a cada consumidor a activar `globals: true` en vitest.

### Crash tests (F6)

Cinco escenarios con proceso hijo real, `SIGKILL` real y puntos de sincronización explícitos, contra `dist/` y también en Windows. I8 pasó de estar demostrada frente a un cierre ordenado a estarlo frente a un kill real.

### Costura del SDK v2 (F7): cerrada sin feature

- R7.1 corrigió una premisa falsa: el Inspector no reescribe frames. Responde los POST de `tasks/*` en middleware HTTP antes de `createMcpHandler`. La afirmación contraria venía de un borrador y había llegado al contrato público; se corrigió allí.
- R7.2: la costura la implementa el host, no el paquete. No hay `/sdk-v2`, el paquete no importa el SDK y no convierte un defecto de una versión en API propia.
- R7.3: upstream readmitió los métodos en `server` 2.3.0 ([typescript-sdk#2599](https://github.com/modelcontextprotocol/typescript-sdk/pull/2599)). Re-medido en 2.3.1; el ejemplo perdió su workaround. Reabrir una costura en el paquete exigiría una discusión y un cambio contractual aparte.

### Documentación y `v0.1.0` (F8)

README, `api.md`, `durability.md`, `internals.md`, `SECURITY.md`. El tarball lleva `contract.md`, `api.md`, `durability.md` e `internals.md`; este plan, en castellano, no. Los umbrales de cobertura (90/90/87/78) se fijaron midiendo, después de cubrir `input.ts`, que estaba en 58%: fijarlos antes habría consagrado ese hueco, y esa validación es justo la que sustituye lo que el JSON Schema oficial pierde (A8). Se añadió una suite property-based con fast-check (secuencias de hasta 60 operaciones con TTL y reloj que retrocede, rondas de input parciales y duplicadas, cancelación, terminalidad y conflictos CAS).

### Demo y `v0.2.0` (F9)

`examples/crash-recovery/`: servidor MCP real con una task larga, `SIGKILL`, reinicio y el resultado completo en el siguiente `tasks/get`. Se asevera a sí misma con `assert`s y no usa sleeps. La [grabación](https://asciinema.org/a/U0DD3KWEttwhv5g5) sale de un clon limpio de `faf4943`.

### Conformidad upstream (F10)

Se publicaron tres informes separados, con reproducciones fijadas a commits de `main`. Un informe único habría mezclado propietarios y permitido cerrar tres hallazgos con una sola decisión.

- [ext-tasks#14](https://github.com/modelcontextprotocol/ext-tasks/issues/14): fidelidad del JSON Schema.
- [typescript-sdk#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637): validación de `CreateTaskResult` y default de `resultType`.
- [typescript-sdk#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598): reproducción independiente en el issue existente del era-gate.

La librería no se promociona dentro de los hallazgos; es la evidencia de que vienen de una implementación real.

### La decisión de `examples/`

La demo vive en este repo, no en uno aparte: un segundo repo es un segundo CI, README y protección de rama, y una demo que se pudre es peor que ninguna. Los no objetivos prohíben un segundo paquete, no un directorio de ejemplos privado. Son dos paquetes privados, a propósito:

```
examples/
  conformance-reproductions/   evidencia: versiones EXACTAS, sin rango
  crash-recovery/              documentación viva: sigue el rango soportado
```

- `conformance-reproductions/` fija `@modelcontextprotocol/*` sin rango porque los issues enlazan a un script en un commit concreto. Subir versiones no invalida esos enlaces; se hace solo como re-medición deliberada, con su resultado en `contract.md`. La medición de `2.0.0` queda en el tag `v0.2.1`.
- `crash-recovery/` representa la forma recomendada de usar la librería.
- `examples-pinned` en CI es bloqueante. Con versiones y lockfile fijos, si falla es porque un cambio de este repo rompió un ejemplo o invalidó una reproducción enlazada. Un `examples-sdk-current` no bloqueante podría avisar de deriva más adelante.
- Los paquetes son privados, sus dependencias no entran en `devDependencies` de raíz, `files` excluye `examples/` y `pnpm lint:package` demuestra que el consumidor no las recibe.

Cómo se citan en un issue: el caso mínimo, el resultado esperado y el real, y la salida van dentro del issue. El permalink al script lleva el SHA completo de un commit de `main`, nunca la rama. Los dos primeros reportes enlazaron un commit de la rama previo al squash: resolvía en el navegador, pero `git clone` + `git checkout <sha>` habría fallado al borrar la rama. Se comprueba clonando en limpio antes de publicar.

### Distribución (F11): pendiente, la primera en caerse

Un artículo bilingüe (canonical en craftender.dev), _«Implementando el Task Store de MCP: lo que la spec no te dice»_, con el hallazgo del Spike 0 como gancho. Empaquetar la demo como Agent Plugin pertenece más a la pieza `agent-plugin-lint`. Si hay que recortar, cae primero el artículo, después el plugin. Nunca se recortan los crash tests, el issue upstream ni la desambiguación del README. F11 no bloquea nada.

### Alineación con la spec estable y endurecimiento (hasta `0.3.0`)

Lo que contradijo al plan:

- **Schema repinchado a `2026-07-28`** (`main` en `899c1bb`, snapshot fijado por `0d0a6bd`). Incluye `spec.types.ts`, porque `schema.ts` importa de ahí las uniones de input. `check:schema` avisa, sin fallar, si `draft` diverge. El cierre del wire se prueba como garantía propia (allow-list por estado) y la salida del motor se valida con Ajv 8.20.0 (devDependency). A8 pasa a Settled. A1 (`-32021`), A6 y A9 (cabecera `Mcp-Name`) quedan cerradas; A7, A8 y A10 se actualizan.
- **Ejemplo y reproducciones sobre `server` 2.3.1.** Las reproducciones se actualizaron en vez de quedarse en `2.0.0`, como decía el plan. Dos hallazgos nuevos: sin `Mcp-Name`, el SDK responde `-32020` antes del era-gate, y mueve `params.inputResponses` de `tasks/update` a `ctx.mcpReq.inputResponses`. A10: el servidor sigue sellando `"complete"`, el cliente ya no rellena el discriminador ausente.
- **Validación de entrada del motor.** `ttlMs` y `pollIntervalMs` exigen entero seguro en `createTask()`, `progress()` y en las opciones `default*` (`TypeError`, no se escribe nada). `statusMessage` se comprueba en runtime. `input.ts` acepta tres formas que `2026-07-28` permite (URL elicitation sin `elicitationId`, `outputSchema` no rooted en `object`, `structuredContent` no objeto). Los records ya persistidos no se revalidan: un WAL antiguo con un hint fraccionario abre y se sirve tal cual. `input.ts` sigue siendo validación propia y no delega en el host, porque `inputRequests` se persiste y se reenvía.
- **Tercera auditoría.** Cada hallazgo se reprodujo con un test que fallaba antes de corregirlo. El contenido de sampling se limita a `SamplingMessageContentBlock`; `requestedSchema.$schema` no string se rechaza; un `status` desconocido en un record es corrupción y no admite escrituras; `sweepIntervalMs` y `compactEvery` se validan; `compact()` saca del índice lo que su snapshot excluye (I8 con reloj que retrocede); `WorkerCoordinator` libera el `AbortController` de una cancelación sin worker local al expirar. La expiración de estado local usa un único timer por tarea. `minLength`/`maxLength`/`minItems`/`maxItems` fraccionarios siguen aceptándose: el TypeScript dice `number` y el JSON Schema `integer`, y se sigue el TypeScript.
- **`0.3.0` en vez de `0.2.x`.** La revisión anterior del plan asumía que el endurecimiento saldría como `0.2.x` y que `0.3.0` sería el emisor. Como contiene cambios incompatibles, el propietario lo asignó a `0.3.0` y movió F12 y F13 un minor.

### Problemas conocidos de `0.3.0`, cerrados en `0.4.0`

Se mueven F12 a `0.5.0` y F13 a `0.6.0`: dos de estos cambios rechazan lo que antes se aceptaba, así que no cabían en `0.3.1`. El criterio de abortar la señal viene de [ext-tasks#11](https://github.com/modelcontextprotocol/ext-tasks/issues/11): la spec es estricta con el wire y deja al servidor cómo detener el trabajo.

- **`fail()`** exige un error JSON-RPC (`code` entero, `message` string, `data` opcional) y lanza `TypeError` sin escribir. Su tipo se estrecha a `TaskError`. `code` es entero aunque `spec.types.ts` diga `number`, porque JSON-RPC 2.0 y el schema generado lo exigen. Un `error` ya persistido no conforme se sirve tal cual hasta el TTL; `failed` es terminal, así que no se puede revisar después.
- **`$schema` no string** en `inputSchema`/`outputSchema` de una tool de sampling se rechaza, como ya ocurría con `requestedSchema.$schema`.
- **`execution`** de una tool deja de validarse más allá de JSON. La `Tool` de `2026-07-28` no lo define (ni `schema.json` ni `spec.types.ts`), y el texto de la spec hace al servidor el único que decide la ejecución como tarea. Es una relajación; el tipo exportado pasa a `JsonValue`.
- **Respuestas de input tras un reinicio** (diseño A, decisión del propietario): se guardan en el campo interno `unclaimedInputResponses`, que nunca llega al wire, y `TaskHandle.resumeInput()` las reclama una sola vez. Un store de terceros debe persistir ese campo y el kit lo comprueba. Queda una ventana estrecha documentada: si el worker en espera es rechazado después del commit de la respuesta, una segunda escritura las conserva; solo se pierden si el proceso muere, o el lifecycle se cierra, entre ambas escrituras.
- **La `signal` del worker se aborta al vencer el TTL.** Es política del motor, cooperativa y local al proceso.

---

## Fase 12 — Emisor de cambios para `notifications/tasks` · `v0.5.0` preferida · gated

### Qué es

La spec estable permite que el servidor empuje `notifications/tasks` además de atender polls. Cada notificación lleva un `DetailedTask` completo, idéntico a lo que `tasks/get` devolvería en ese momento. Solo el motor sabe cuándo cambia el estado, así que falta un hook de cambio en `TaskLifecycle`:

- **Emitir, no entregar.** Tras cada cambio confirmado a través de ese `TaskLifecycle`, se emite la misma proyección cerrada que ya calcula para `tasks/get`. `subscriptions/listen`, el acknowledgement, la lista de `taskIds` aceptados y la escritura en el stream son del host. Así no se implementa transporte.
- **Proceso local.** Solo ve los commits de su propio `TaskLifecycle`. Un cambio confirmado por otra instancia sobre un store compartido no se emite aquí. Se documenta, no se resuelve con un broker.
- **Nada de `notifications/progress` ni `notifications/message`**: la spec prohíbe enviarlos en el stream de `subscriptions/listen` de una task.
- **Tipos con nombre.** Valorar exportar `WorkingTask`, `InputRequiredTask`, `CompletedTask`, `FailedTask`, `CancelledTask` y su unión `DetailedTask`, alineados con `2026-07-28`.

La firma exacta se asienta en `api.md` antes del código.

### Qué se decidió no hacer

El driver de cliente (`mcp-durable-tasks/client`) se retiró, no se reprogramó. No se reabre como "F12.2". El razonamiento está en [la decisión del contrato](./contract.md#decision-no-client-follower).

### Puerta de readiness

1. A7 respondida upstream (seguimiento en ext-tasks#24: ¿se reemiten las notificaciones perdidas tras un crash o una desconexión, o el poll es siempre la autoridad?) **o** una decisión explícita del paquete registrada en `contract.md`.
2. Releer spec estable, schema y SDK instalado. Los fixtures ya están repinchados a `2026-07-28`.
3. Una integración real con el SDK del host demuestra que puede entregar la notificación sin APIs internas. Si no puede, se documenta como límite del host y no se compensa dentro del paquete.

```text
Work Item: F12.1
Tipo: feat
Slug: task-change-emitter
Base: main
Estado: blocked-by-readiness-gate
Orca identity: feat/f12-1-task-change-emitter
Relationship: no-parent
```

Los tracks (contrato, emisión después del commit y no antes, CAS perdido sin emisión, terminalidad, cierre, integración, docs y auditoría) se detallan al pasar la puerta, no antes.

F12 y F13 no se desbloquean entre sí. Si F12 sigue bloqueada cuando F13 cumple su readiness y hay necesidad real del store, un cambio documental separado puede reasignar SQLite al siguiente minor. Los números de versión expresan orden de entrega.

---

## Fase 13 — `NodeSqliteTaskStore` · `v0.6.0` preferida · tras F12 por defecto

No es una familia de conectores. Es **un** store de primer partido para un hueco local que `WalTaskStore` deja a propósito.

### El hueco que cubre, y el que no

`WalTaskStore` ya da durabilidad local a un proceso y un disco. Quien despliega varias réplicas detrás de un balanceador sigue implementando `TaskStore` sobre su base compartida y pasando el kit de conformidad. Ese caso (Postgres, Redis, D1, Turso remoto, libSQL) no es un hueco de este repositorio: es la razón de que el kit se publique.

El hueco cubrible aquí es más estrecho:

1. **Más de un proceso sobre el mismo disco.** Dos writers en un directorio de `process-wal` corrompen el log. SQLite sí arbitra writers.
2. **Una base inspectable** con herramientas ordinarias. En modo WAL existen sidecars `-wal` y `-shm` mientras hay conexiones activas, así que no se promete un único fichero físico en todo momento.
3. **Sin peer `process-wal` y sin addon nativo.** `node:sqlite` es builtin [desde Node 22.13, sin flag](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html).

Complementa a `WalTaskStore`, no lo sustituye. `WalTaskStore` sigue siendo el de un stdio de un solo proceso; `NodeSqliteTaskStore` es el de un host local que necesita CAS entre procesos en la misma máquina. En su primera versión posee un fichero dedicado: no se inyecta una conexión de la aplicación ni se cambia el journal mode de una base ajena.

Sigue siendo disco local y **no** resuelve la afinidad del worker. El CAS protege el registro; la promesa de `requestInput()` y la `AbortSignal` siguen siendo del proceso que ejecuta el trabajo. La spec lo resuelve con routing por la cabecera `Mcp-Name` (A9, cerrada).

### Fuera de alcance

- `better-sqlite3` y cualquier addon nativo.
- `@libsql/client`, Turso, un `TursoTaskStore`, réplicas embebidas o Turso Sync. Quien los quiera escribe cinco métodos y corre `mcp-durable-tasks/testing`.
- Postgres, Redis, D1 u otro driver de comunidad.
- Un executor SQL genérico, una abstracción `SqlTaskStore` o subpaths `/postgres`, `/libsql`, `/redis`.
- Autenticación, URLs, construcción de clientes o ownership de transporte.
- Subir el floor de Node del entry principal. `/sqlite` documenta 22.13+; `mcp-durable-tasks` y `/testing` siguen en Node 22.

### Superficie prevista

```ts
new NodeSqliteTaskStore({
  file: "./data/tasks.sqlite",
  busyTimeoutMs: 250,
  maxEntryBytes: 8 * 1024 * 1024,
  now: Date.now,
});
```

- `file: string` es obligatorio. El store abre y posee su conexión. Rechaza cadena vacía, `:memory:` y bases temporales; el directorio padre debe existir.
- Varias instancias y procesos pueden abrir el mismo fichero **en el mismo host**. Compartirlo por NFS/SMB, en serverless efímero o entre hosts no está soportado.
- `busyTimeoutMs` es un entero finito `>= 0`, default 250 ms. Se aplica con [`PRAGMA busy_timeout`](https://sqlite.org/pragma.html#pragma_busy_timeout), disponible en 22.13 (no se usa la opción de constructor de 22.16). Al agotarlo se propaga el error SQLite original, no un `ConcurrentUpdateError` ni un retry oculto.
- `maxEntryBytes` mide el UTF-8 de `record_json`, default 8 MiB. Se valida antes de abrir una transacción y reutiliza `TaskEntryTooLargeError` y su código estable. El mensaje de ese error deja de nombrar solo a `WalTaskStore` en el mismo cambio. El envelope de WAL y la fila SQLite no son byte a byte portables en el borde: quien alterne stores debe dejar margen.
- `now` es la costura de reloj para TTL y tests. `close()` es idempotente y solo cierra la conexión que el store posee.

[`DatabaseSync` es síncrono](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html#class-databasesync) y bloquea el event loop. Los métodos devuelven `Promise` porque `TaskStore` lo exige, pero el trabajo SQLite ocurre antes de resolver; no se presenta como off-thread. El timeout corto y el límite de payload acotan los dos bloqueos controlables. La documentación recomienda `WalTaskStore` o un store remoto cuando esa sincronía no sea aceptable.

### Contrato de durabilidad que hay que escribir, no inferir

Mismo listón que `WalTaskStore` en [`durability.md`](./durability.md). Antes de implementar, asentar y documentar:

- Fichero dedicado con tablas privadas `_mcp_durable_tasks_records` y `_mcp_durable_tasks_meta`. No usar `PRAGMA user_version`.
- Snapshot canónico en `record_json` más escalares indexados (`task_id`, `version`, `expires_at`). `expires_at` es `REAL`, para preservar el contrato numérico actual, con índice dedicado para `sweep`. Sin API de enumeración (I7).
- El schema v1 y cada migración futura se crean bajo `BEGIN IMMEDIATE`, con rollback ante error y rechazo de versiones futuras desconocidas. La primera release solo implementa vacío a v1, sin framework genérico de migraciones. Dos procesos que abren a la vez nunca ven medio schema.
- Al abrir: fijar el busy timeout, ejecutar y verificar `journal_mode=WAL` y `synchronous=FULL`, y solo entonces migrar y preparar statements. [WAL es una propiedad persistente](https://www.sqlite.org/wal.html#persistence_of_wal_mode) del fichero; por eso el fichero es propiedad de este store.
- `create` no resuelve hasta después del commit (I1). `get` no muta (I3).
- Toda escritura abre `BEGIN IMMEDIATE`. `update` normaliza y mide antes de esa transacción y escribe `record_json`, `version` y `expires_at` en un único `UPDATE ... WHERE task_id = ? AND version = ?`. Si afecta cero filas, consulta el estado actual **dentro de la misma transacción**, hace rollback y construye `ConcurrentUpdateError`: versión viva exacta si existe, `undefined` si falta o expiró. Así otro writer no cambia el diagnóstico entre el CAS y la lectura. `SQLITE_BUSY` nunca se disfraza de CAS perdido.
- `sweep` borra las caducadas y devuelve solo el recuento.
- Cada operación reutiliza statements preparados. `get` y `update` usan la primary key, `sweep` el índice de expiración. Ni scan para leer por id ni prepare por operación.
- Documentar la frontera exacta entre crash de proceso y pérdida de corriente, y que WAL + `synchronous=FULL` no corrige un filesystem que incumpla flush o locking.
- I8 pasa a ser específico por store: `WalTaskStore` sigue siendo single-writer y el store SQLite documenta writers concurrentes en el mismo fichero local. Las [fronteras de proceso](./contract.md#process-boundaries) se reescriben en el mismo cambio.

`node:sqlite` sigue en desarrollo activo en Node 22 y el subpath usa solo APIs presentes en 22.13. Si una API se mueve antes de 1.0, es un breaking menor con entrada de changelog.

### Work Item y puerta de readiness

No se invoca `$orca-start-work` hasta que se cumpla una de estas rutas y F13.1 se marque `ready` aquí:

1. F12.1 está publicada como `0.5.0`; o
2. F12 sigue bloqueada, hay una necesidad demostrada de SQLite y un cambio documental separado reasigna `NodeSqliteTaskStore` al siguiente minor. Ese cambio actualiza `contract.md`, `AGENTS.md`, este plan y el número objetivo antes de crear el worktree.

```text
Work Item: F13.1
Tipo: feat
Slug: node-sqlite-store
Base: main
Estado: blocked-by-strategic-readiness-gate
Orca identity: feat/f13-1-node-sqlite-store
Relationship: no-parent
```

F13.1 es la única Work Item. Los tracks F13.1a a F13.1f viven en el mismo worktree y salen en el mismo cambio. No se fusiona un `/sqlite` sin crash tests, sin kit en verde o con docs que describan un contrato distinto al código.

- **F13.1a — Superficie y motor.** Estrechar el non-goal de community stores en [`contract.md`](./contract.md#non-goals) a la excepción `node:sqlite`. Añadir `mcp-durable-tasks/sqlite` sin tocar las dependencias del entry principal. Schema, migración, snapshot canónico, CAS, TTL, `sweep`, `close` idempotente. `src/sqlite.ts` puede importar `node:*`; `src/index.ts` y `src/testing.ts` no.
  _Hecho cuando:_ el store crea, lee, actualiza con CAS y barre sobre un fichero real; prueba el borde exacto y Unicode multibyte de `maxEntryBytes`; rechaza schema futuro sin escribir y operaciones después de `close`; y el tarball exporta `/sqlite` en ESM y CJS.
- **F13.1b — Kit de conformidad.** Contra este store, con costuras de reloj y reopen, **sin checks saltados**. El kit debe pasar contra los tres stores incluidos antes de etiquetar.
  _Hecho cuando:_ `runTaskStoreConformance` está verde igual que en memoria y WAL, y un store roto a propósito sigue fallando.
- **F13.1c — Concurrencia real.** Dos conexiones y, aparte, dos procesos contra el mismo fichero: CAS perdido, read-after-write y cold-open simultáneo, más dos escenarios coordinados por IPC (lock liberado antes del timeout, y lock retenido hasta `SQLITE_BUSY`). Windows es target de primer orden para locking, checkpoints y sidecars. Nada de sleeps.
  _Hecho cuando:_ hay tests que fallan si el segundo writer corrompe o silencia el primero, y la versión `actual` del CAS perdido es exacta bajo contención.
- **F13.1d — Crash tests.** A la altura de la Fase 6: hijo real, `SIGKILL` real, puntos de sincronización explícitos, contra `dist/`. Cubren creación durable, input aparcado, terminal con payload y reopen tras kill.
  _Hecho cuando:_ I8 está demostrada para este store, con la frontera de `synchronous=FULL` escrita en `durability.md`.
- **F13.1e — Rendimiento y empaquetado.** Statements preparados una vez y `EXPLAIN QUERY PLAN` que demuestre primary key para `get`/`update` e índice de expiración para `sweep`, también con un dataset grande. Un stress de cuatro procesos, cien mutaciones confirmadas cada uno sobre una task propia y sin retries, debe conservar las cuatro versiones finales sin `SQLITE_BUSY`; el test de lock retenido demuestra el error al agotar el timeout. Ningún gate de milisegundos dependiente del runner. Un benchmark puede informar latencias, pero ninguna cifra entra en docs ni bloquea CI hasta medirse de forma estable.
  Añadir `exports`, `attw --profile node16` y `publint --strict`. El smoke del tarball sin `process-wal` sigue demostrando que `.` y `/testing` no lo necesitan e importa `/sqlite`, que es builtin y no un peer. La matriz de CI ejecuta los tests nuevos y una pierna `sqlite-floor` fija Node 22.13 en Linux, macOS y Windows, porque `22.x` actual no impide usar una API añadida en 22.16.
  _Hecho cuando:_ `pnpm lint:package` pasa y un consumidor sin `process-wal` puede importar `/sqlite`.
- **F13.1f — Docs y auditoría.** README (tercer store, cuándo usar cuál), `api.md`, `contract.md` (superficie, I8, fronteras de proceso, non-goals), `durability.md`, este plan y `CHANGELOG.md`. Auditoría independiente antes del merge, no solo antes del tag; cada hallazgo se verifica con un test que falla antes de corregirlo. El editor abre el PR; el auditor revisa el mismo worktree sin editar código de producto.

### Qué se decidió no hacer, para que no vuelva como "F13.2"

Un `LibsqlTaskStore` de cliente inyectado, después de auditar SQLite, se descarta para `0.6.0` y no queda como siguiente paso implícito. Un cliente remoto introduce CAS ambiguo de red, credenciales, un servicio reproducible y un contrato de durabilidad que este repositorio no puede demostrar con `SIGKILL` local. Eso es un store de comunidad, y el kit existe para eso.

---

## Después: `v1.0.0`

Cuando las [preguntas de conformidad](./contract.md#extension-conformance-questions) estén cerradas o registradas como decisiones del paquete, y `TaskStore` y `TaskLifecycle` estén congeladas. Entonces: reescribir la sección de API provisional de `AGENTS.md` al registro de "superficie cerrada" de `process-wal` y valorar si este plan sigue aportando valor. No se etiqueta `1.0.0` para "completar" F13.

## Orden de lo que queda

```
0.4.0 (problemas conocidos; falta auditoría y tag)
   │
   ▼
F12 (0.5.0 preferida, emisor, gated por A7) ──▶ F13 (0.6.0 preferida, node:sqlite)
                  │
                  └─ si sigue bloqueada y F13 está ready: decisión contractual
                     separada, F13 ocupa el siguiente minor y F12 se reprograma
```

F11 es distribución y puede ir en paralelo. F7 está cerrada sin feature, A6 está cerrada upstream y el driver de cliente está retirado, no pendiente. SQLite no se adelanta por novedad ni como palanca de audiencia: solo cambia el orden si F12 está realmente bloqueada, F13 cumple su puerta y el contrato público se actualiza antes de crear el worktree.

Dos reglas de secuencia que valieron para `0.1.0`–`0.2.0` y siguen siendo ciertas: el schema se lee antes de escribir el motor, y el issue upstream (F10) no espera al artículo (F11). Un artículo sin el issue detrás es marketing.
