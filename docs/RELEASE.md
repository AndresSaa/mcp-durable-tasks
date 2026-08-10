# Operativa de lanzamiento

Documento interno para abrir el repositorio, taguear `v0.1.0` y preparar la
primera publicación en npm. El
[contrato de versiones](./contract.md#version-contract) decide qué entra en
cada versión; este fichero sólo convierte esa decisión en una secuencia
reproducible.

## Qué contiene `v0.1.0`

- El motor server-side de la extensión MCP Tasks: lifecycle, handles, TTL,
  hints de polling, cancelación cooperativa y rondas parciales de input.
- `MemoryTaskStore` y `WalTaskStore`, con CAS, replay, compactación y límites
  de entrada observables.
- El kit público `mcp-durable-tasks/testing` para stores de terceros.
- Tests unitarios, de conformidad, property-based y crash tests con procesos
  reales y `SIGKILL`.
- Tres entry points ESM/CJS con tipos, y contrato/documentación de
  API/durabilidad/internals dentro del tarball.

No contiene la costura del SDK v2, un driver de cliente, adaptadores de
framework, stores compartidos ni transporte. `v0.1.0` es una GitHub Release
pre-release y también la primera versión npm, publicada manualmente después del
tag.

## Resultado de la auditoría previa al tag

Ejecutada el 10 de agosto de 2026 sobre la rama de preparación:

- `pnpm test`: 10 ficheros, 256 tests en verde y 2 skips de capacidades
  opcionales declarados por el kit.
- Coverage: 93,66% statements, 84,17% branches, 91,62% functions y 94,47%
  lines; supera los cuatro umbrales del repo.
- `pnpm lint:package`: publint strict, ESM/CJS/tipos y smoke del tarball en
  verde; 24 entradas, incluido el contrato público, y ningún source, test,
  workflow o documento interno incluido.
- `pnpm check:schema`: `schema.json` y `schema.ts` siguen alineados con
  `modelcontextprotocol/ext-tasks`.
- `pnpm audit --audit-level high`: ninguna vulnerabilidad conocida. No hay
  dependencias de producción en el entry point principal; `process-wal` sigue
  siendo peer opcional.
- actionlint `1.7.12`: los cinco workflows son válidos.
- Historial completo: sólo Andres Saa como autor, sin trailers ni mensajes de
  atribución a modelos de IA, y sin tags o git notes ocultos.
- README: enlaces locales resueltos, cinco referencias oficiales comprobadas
  con HTTP 200 y navegación completa desde el índice.

## Estado remoto comprobado el 10 de agosto de 2026

- `AndresSaa/mcp-durable-tasks` existe, es privado y `main` sólo contiene el
  commit inicial.
- Issues y Discussions están activos; existen las categorías Q&A e Ideas que
  enlazan las plantillas del repo.
- Faltan descripción, topics, homepage y protección de `main`.
- No existe ningún tag y `mcp-durable-tasks` sigue libre en el registro npm.
- GitHub no permite activar branch protection en este repo mientras siga
  privado con la cuenta actual; se aplica inmediatamente después de hacerlo
  público.
- CodeQL también se omite mientras el repo sea privado: GitHub Free no permite
  subir resultados de Code Scanning en ese estado. El workflow tiene trigger
  manual para ejecutarlo justo después de hacerlo público.

## Gate local antes de subir

Desde una rama limpia y con Node 22.13 o posterior:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm test
corepack pnpm coverage
corepack pnpm lint:package
corepack pnpm check:schema
corepack pnpm audit --audit-level high
git status --short
```

`check:schema` toca red y confirma que los dos fixtures vendorizados no han
derivado. `lint:package` analiza los tipos, empaqueta e instala el tarball real
sin `process-wal`, tanto en ESM como en CJS.

Para volver a auditar sólo la atribución de los commits:

```powershell
$forbidden = '(?i)(co-authored-by:.*(claude|anthropic|codex|openai)|generated (with|by).*(claude|codex|openai)|ai[- ]generated)'
foreach ($sha in (git rev-list --all)) {
  $metadata = git show -s --format='%H%n%an%n%ae%n%B' $sha
  if ($metadata -match $forbidden) { $metadata }
}
```

La salida correcta es vacía. Las referencias editoriales a herramientas o
clientes en `AGENTS.md`, `docs/contract.md` o el README no son atribución de
autoría.

## Archivo privado y squash previo al push

Los dos borradores personales se actualizan para el archivo del mantenedor,
pero no se publican ni en el árbol ni en el historial alcanzable de la rama.
Antes de ejecutar estos comandos, el mantenedor debe confirmar que ya guardó
fuera del repositorio las copias actualizadas.

```powershell
git fetch origin
git rm -- docs/VISION.md docs/SPEC.md
git add --all
git reset --soft origin/main
git add --all
git status --short
git diff --cached --name-only
git commit -m "feat: ship the v0.1.0 durable task engine"
```

El `reset --soft` compacta toda la rama local sobre el `main` remoto. La
segunda ejecución de `git add --all` incluye ficheros que antes eran untracked
y conserva únicamente el estado final. Antes de cualquier push, estas tres
comprobaciones deben pasar:

```powershell
git rev-list --count origin/main..HEAD
git log --format='%h %an <%ae> %s' origin/main..HEAD
git rev-list --objects origin/main..HEAD | Select-String 'docs/(VISION|SPEC)\.md'
```

La primera salida debe ser `1`; la segunda debe mostrar sólo el commit de
lanzamiento; la tercera debe quedar vacía. No se crea una rama de backup: los
commits anteriores quedan sólo en el reflog local y no se sube ninguna ref que
los alcance.

## Push, PR y merge

No se publica directamente desde la rama local. Primero:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm test
corepack pnpm lint:package
git push -u origin chore/repo-foundations
Copy-Item .github/PULL_REQUEST_TEMPLATE.md .ai/temp/v0.1.0-pr.md
# Editar .ai/temp/v0.1.0-pr.md con el resumen y los resultados reales.
gh pr create --base main --head chore/repo-foundations --title "feat: ship the v0.1.0 durable task engine" --body-file .ai/temp/v0.1.0-pr.md
gh pr checks --watch
```

Antes de ejecutar `gh pr create`, completar el template con resultados reales;
no enviar un cuerpo vacío ni texto de plantilla sin editar. No lleva `!`: no
existe una versión pública anterior cuyo contrato esté rompiendo.

Tras la matriz verde, squash-merge desde GitHub o con:

```powershell
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only origin main
```

## About, features y topics

La descripción debe diferenciar la librería del namespace de gestores de
tareas. La homepage queda vacía hasta completar la publicación manual de
`v0.1.0` en npm y se añade inmediatamente después.

```powershell
gh repo edit AndresSaa/mcp-durable-tasks `
  --description "Durable task state machine and TaskStore implementations for the MCP Tasks extension (SEP-2663)." `
  --enable-issues `
  --enable-discussions `
  --enable-projects=false `
  --enable-wiki=false `
  --enable-squash-merge `
  --enable-merge-commit=false `
  --enable-rebase-merge=false `
  --squash-merge-commit-message pr-title-description `
  --delete-branch-on-merge `
  --allow-update-branch `
  --add-topic mcp `
  --add-topic model-context-protocol `
  --add-topic sep-2663 `
  --add-topic durable-tasks `
  --add-topic task-store `
  --add-topic crash-recovery `
  --add-topic write-ahead-log `
  --add-topic typescript `
  --add-topic esm `
  --add-topic zero-dependency
```

`process-wal` mantiene Issues y Discussions, y este repo también: Q&A sirve
para integración y Ideas para discutir alcance antes de abrir una feature. La
diferencia intencionada es dejar sólo squash merge, porque aquí el título del
PR es el commit de `main` y lo valida CI. No hacen falta Projects ni Wiki; el
roadmap y la documentación ya tienen dueños claros dentro del repo.

Al abrirlo:

```powershell
gh repo edit AndresSaa/mcp-durable-tasks --visibility public --accept-visibility-change-consequences
gh api --method PUT repos/AndresSaa/mcp-durable-tasks/vulnerability-alerts
gh api --method PUT repos/AndresSaa/mcp-durable-tasks/automated-security-fixes
gh repo edit AndresSaa/mcp-durable-tasks --enable-secret-scanning --enable-secret-scanning-push-protection
gh workflow run codeql.yml --repo AndresSaa/mcp-durable-tasks
$codeqlRun = gh run list --repo AndresSaa/mcp-durable-tasks --workflow codeql.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $codeqlRun --repo AndresSaa/mcp-durable-tasks --exit-status
```

Una discusión inicial en Announcements es útil; Q&A e Ideas ya están enlazadas
desde las plantillas:

```powershell
gh discussion create -R AndresSaa/mcp-durable-tasks --category Announcements --title "v0.1.0: first public release" --body "The engine, both stores, conformance kit and crash tests are available in the first public release. The npm bootstrap is published manually; later versions use trusted publishing with provenance."
```

## Protección de `main`

Aplicar después de hacer público el repo y antes de empezar la siguiente fase.
Node 26 no es requerido: es una señal informativa. El count de approvals queda
en cero porque el repo tiene un único mantenedor; siguen siendo obligatorios el
PR, la conversación resuelta y todos los gates estables.

```powershell
$protection = @'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Node 22 / ubuntu-latest",
      "Node 22 / macos-latest",
      "Node 22 / windows-latest",
      "Node 24 / ubuntu-latest",
      "Node 24 / macos-latest",
      "Node 24 / windows-latest",
      "lint-title"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
'@
$protection | gh api --method PUT repos/AndresSaa/mcp-durable-tasks/branches/main/protection --input -
```

## Tag y GitHub Release `v0.1.0`

Comprobar que `main` contiene `package.json` en `0.1.0` y la sección
`CHANGELOG.md` correspondiente. Luego:

```powershell
git tag v0.1.0
git push origin v0.1.0
$runId = gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --exit-status
gh release view v0.1.0
```

El workflow debe ejecutar todos los gates, registrar que la publicación npm de
esta versión es manual y crear una GitHub Release marcada pre-release. Un
workflow rojo aquí es bloqueo del tag, no un resultado aceptable.

## Primera publicación npm: `v0.1.0`, manual

La primera versión del registro es manual por decisión del mantenedor y porque
npm no permite vincular un Trusted Publisher a un paquete que aún no existe.
Se publica desde el tag exacto, con cuenta protegida por 2FA y provenance
desactivado explícitamente: una máquina local no puede producir la atestación
de GitHub Actions.

```powershell
git switch --detach v0.1.0
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm test
corepack pnpm lint:package
npm whoami
$env:NPM_CONFIG_PROVENANCE = "false"
npm publish --access public
Remove-Item Env:NPM_CONFIG_PROVENANCE
npm view mcp-durable-tasks@0.1.0 name version dist-tags repository --json
```

No guardar tokens en GitHub ni en ficheros del repo. Tras comprobar que
`0.1.0` existe:

1. npmjs.com → package → Settings/Access → Trusted Publisher.
2. Vincular GitHub Actions con owner `AndresSaa`, repo
   `mcp-durable-tasks`, workflow `release.yml`, sin environment.
3. Activar la automatización posterior:

   ```powershell
   gh variable set NPM_TRUSTED_PUBLISHING --repo AndresSaa/mcp-durable-tasks --body enabled
   ```

4. `v0.2.0` usa el cliente npm fijado en `release.yml`, OIDC y provenance
   automática. El workflow falla, en vez de omitir npm silenciosamente, si la
   variable no está activa. Sólo después de una publicación OIDC verde se
   restringen/revocan credenciales de automatización antiguas.

`v0.1.0` no tendrá provenance y queda documentada como la única excepción. Para
`v0.2.0` y versiones posteriores, verificar la atestación en npmjs.com o desde un
directorio temporal instalado con npm; `npm audit signatures` necesita el
lockfile de npm y por eso no se ejecuta sobre este workspace pnpm.

Al publicar `v0.1.0`, completar el About:

```powershell
gh repo edit AndresSaa/mcp-durable-tasks --homepage https://www.npmjs.com/package/mcp-durable-tasks
```
