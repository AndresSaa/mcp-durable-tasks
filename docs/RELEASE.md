# Operativa de lanzamiento

Documento interno: secuencia reproducible para abrir el repositorio, publicar `v0.1.0` a mano y sacar las versiones siguientes con el workflow. Qué entra en cada versión lo decide el [contrato de versiones](./contract.md#version-contract). El estado de cada versión está en [`EXECUTION-PLAN.md`](./EXECUTION-PLAN.md).

Los pasos de `v0.1.0` (squash previo, primer PR, bootstrap de npm) ya se ejecutaron y se conservan como registro de lo que hay que repetir si algún día se rehace el repo. Las versiones nuevas solo usan el [gate local](#gate-local-antes-de-subir) y [las releases automatizadas](#releases-automatizadas-desde-v020).

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

- `check:schema` usa la red. Confirma que los fixtures vendorizados (`schema/2026-07-28/`) no derivaron e informa, sin fallar nunca, si el `draft` de upstream ya difiere del snapshot. No corre en CI.
- `lint:package` analiza los tipos, empaqueta e instala el tarball real sin `process-wal`, en ESM y en CJS.

Para auditar solo la atribución de los commits. La salida correcta es vacía:

```powershell
$forbidden = '(?i)(co-authored-by:.*(claude|anthropic|codex|openai)|generated (with|by).*(claude|codex|openai)|ai[- ]generated)'
foreach ($sha in (git rev-list --all)) {
  $metadata = git show -s --format='%H%n%an%n%ae%n%B' $sha
  if ($metadata -match $forbidden) { $metadata }
}
```

Las referencias editoriales a herramientas o clientes en `AGENTS.md`, `docs/contract.md` o el README no son atribución de autoría.

## Solo `v0.1.0`: archivo privado y squash previo al push

Los dos borradores personales no se publican, ni en el árbol ni en el historial alcanzable. Antes de ejecutar estos comandos, el mantenedor confirma que ya guardó fuera del repositorio las copias actualizadas.

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

`reset --soft` compacta la rama local sobre el `main` remoto. El segundo `git add --all` incluye lo que era untracked. Antes de cualquier push deben pasar estas tres comprobaciones:

```powershell
git rev-list --count origin/main..HEAD
git log --format='%h %an <%ae> %s' origin/main..HEAD
git rev-list --objects origin/main..HEAD | Select-String 'docs/(VISION|SPEC)\.md'
```

La primera debe dar `1`, la segunda solo el commit de lanzamiento y la tercera nada. No se crea rama de backup: los commits anteriores quedan solo en el reflog local.

## Push, PR y merge

No se publica directamente desde la rama local:

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

El cuerpo del PR lleva resultados reales, no texto de plantilla sin editar. El título no lleva `!`: no hay versión pública anterior cuyo contrato se rompa.

Con la matriz en verde, squash-merge desde GitHub o con:

```powershell
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only origin main
```

## About, features y topics

La descripción debe diferenciar la librería del namespace de gestores de tareas. La homepage queda vacía hasta publicar `v0.1.0` en npm.

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

Solo squash merge, porque el título del PR es el commit de `main` y CI lo valida. No hacen falta Projects ni Wiki. Issues y Discussions siguen activos: Q&A para integración e Ideas para discutir alcance antes de abrir una feature; las plantillas del repo enlazan ambas categorías.

Con el repositorio ya público, activar los controles de seguridad y ejecutar CodeQL (su ejecución se omite mientras el repo es privado):

```powershell
gh api --method PUT repos/AndresSaa/mcp-durable-tasks/vulnerability-alerts
gh api --method PUT repos/AndresSaa/mcp-durable-tasks/automated-security-fixes
gh repo edit AndresSaa/mcp-durable-tasks --enable-secret-scanning --enable-secret-scanning-push-protection
gh workflow run codeql.yml --repo AndresSaa/mcp-durable-tasks
$codeqlRun = gh run list --repo AndresSaa/mcp-durable-tasks --workflow codeql.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $codeqlRun --repo AndresSaa/mcp-durable-tasks --exit-status
```

Discusión inicial en Announcements:

```powershell
gh discussion create -R AndresSaa/mcp-durable-tasks --category Announcements --title "v0.1.0: first public release" --body "The engine, both stores, conformance kit and crash tests are available in the first public release. The npm bootstrap is published manually; later versions use trusted publishing with provenance."
```

## Protección de `main`

El ruleset `main` (`20643761`) prohíbe borrados y non-fast-forward, exige PR con squash y rama al día. Son obligatorios los seis checks estables de Node 22/24 y `lint-title`. Node 26 es informativo; CodeQL y Socket Security no bloquean.

```powershell
gh api repos/AndresSaa/mcp-durable-tasks/rulesets/20643761 `
  --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
```

`lint-title` solo pudo añadirse después de fusionar el primer PR: `pull_request_target` carga el workflow desde la rama base, y hasta entonces no existía en `main`.

## Tag y GitHub Release `v0.1.0`

`main` debe tener `package.json` en `0.1.0` y la sección correspondiente de `CHANGELOG.md`.

```powershell
git switch main
git pull --ff-only origin main
if (git status --porcelain) { throw "main must be clean before tagging" }
if ((node -p "require('./package.json').version") -ne "0.1.0") { throw "package.json is not 0.1.0" }
git tag v0.1.0
git push origin v0.1.0
$runId = gh run list --workflow release.yml --branch v0.1.0 --event push --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --exit-status
gh release view v0.1.0
```

El workflow ejecuta todos los gates, registra que la publicación npm de esta versión es manual y crea una GitHub Release marcada pre-release. Un workflow rojo bloquea el tag.

## Primera publicación npm: `v0.1.0`, manual

Es manual porque npm no permite vincular un Trusted Publisher a un paquete que aún no existe. Se publica desde el tag exacto, con cuenta protegida por 2FA y provenance desactivado: una máquina local no puede producir la atestación de GitHub Actions. pnpm sigue siendo dueño de la instalación y de los scripts; este bootstrap usa el CLI de npm solo para el login web y para sobrescribir `publishConfig.provenance: true`.

```powershell
git switch main
git pull --ff-only origin main
if ((git rev-parse HEAD) -ne (git rev-list -n 1 v0.1.0)) { throw "main is not the tagged v0.1.0 commit" }
if (git status --porcelain) { throw "main must be clean before publishing" }
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm test
corepack pnpm lint:package
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami
npm publish --dry-run --access public --provenance=false
npm publish --access public --provenance=false
npm view mcp-durable-tasks@0.1.0 name version dist-tags repository --json
```

- No pasar `--otp`. Con security key/WebAuthn, npm abre el enlace de autorización y el reto se confirma en el navegador. Si la cuenta solo tiene TOTP, el registro pide el código igualmente.
- `--provenance=false` es obligatorio en ambos comandos de publicación. Sin él, `publishConfig` intenta generar una atestación local y falla porque no hay proveedor CI.
- No guardar tokens en GitHub ni en ficheros del repo.

Cuando `0.1.0` exista en el registro:

1. npmjs.com → package → Settings/Access → Trusted Publisher.
2. Vincular GitHub Actions con owner `AndresSaa`, repo `mcp-durable-tasks`, workflow `release.yml`, sin environment.
3. Activar la automatización:

   ```powershell
   npm trust github mcp-durable-tasks --file release.yml --repo AndresSaa/mcp-durable-tasks --allow-publish --yes
   gh variable set NPM_TRUSTED_PUBLISHING --repo AndresSaa/mcp-durable-tasks --body enabled
   ```

4. Tras una publicación OIDC verde (`v0.2.0`), restringir o revocar las credenciales de automatización antiguas, si queda alguna.
5. Cerrar la sesión local revoca el token del login web:

   ```powershell
   npm logout --registry=https://registry.npmjs.org/
   ```

6. Completar el About:

   ```powershell
   gh repo edit AndresSaa/mcp-durable-tasks --homepage https://www.npmjs.com/package/mcp-durable-tasks
   ```

`v0.1.0` no tiene provenance y es la única excepción.

## Releases automatizadas desde `v0.2.0`

Desde `v0.2.0` el tag dispara `release.yml`, que cambia el token OIDC por acceso al registro, y npm genera la atestación de procedencia. No hay ningún paso manual de publicación. Si hiciera falta uno, la variable `NPM_TRUSTED_PUBLISHING` estaría mintiendo.

### Requisito previo que el workflow no puede comprobar

El Trusted Publisher tiene que estar vinculado en npm antes del tag. La variable de repositorio solo declara la intención; quien autoriza es el registro.

```powershell
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm trust list mcp-durable-tasks
npm logout --registry=https://registry.npmjs.org/
```

Debe aparecer owner `AndresSaa`, repositorio `mcp-durable-tasks`, workflow `release.yml` y sin environment. Si no aparece, el tag falla al publicar con la versión ya registrada en el historial de tags, y hay que borrar el tag y repetir.

### PR de versión

Cada versión se prepara en un PR ordinario `chore: release X.Y.Z` que actualiza `package.json`, cierra su sección de `CHANGELOG.md` y sincroniza cualquier versión visible en los docs. No se crea el tag desde la rama del PR ni se publica a mano en npm. El [contrato de versiones](./contract.md#version-contract) decide si toca patch o minor: antes de `1.0.0`, un cambio incompatible es minor aunque no añada features.

Antes de abrirlo, el [gate local](#gate-local-antes-de-subir) completo tiene que estar en verde sobre la rama, incluido `check:schema`.

### Tag y publicación

Tras fusionar el PR de versión, la secuencia es la misma para cada versión; solo cambia `$releaseVersion`:

```powershell
git switch main
git pull --ff-only origin main
if (git status --porcelain) { throw "main must be clean before tagging" }
$releaseVersion = "0.4.0"  # la versión que se publica
if ((node -p "require('./package.json').version") -ne $releaseVersion) { throw "package.json version mismatch" }
if (-not (Select-String -Quiet -LiteralPath CHANGELOG.md -SimpleMatch "## [$releaseVersion]")) { throw "CHANGELOG section missing" }
$releaseTag = "v$releaseVersion"
git tag $releaseTag
git push origin $releaseTag
$releaseRunId = gh run list --workflow release.yml --branch $releaseTag --event push --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $releaseRunId --exit-status
corepack pnpm view "mcp-durable-tasks@$releaseVersion" version dist-tags --json
gh release view $releaseTag
```

El workflow vuelve a ejecutar lint, cobertura y validación del tarball antes de publicar. La página del paquete en npmjs.com debe mostrar el enlace de provenance al run de `release.yml` del tag exacto. `npm audit signatures` no se ejecuta aquí: necesita un lockfile de npm y este workspace es de pnpm. Para verificar desde fuera, instalar el paquete con npm en un directorio temporal.
