# VibeKeep

**Build freely. Keep the context.**

Un framework de vibe coding con chat en la terminal y memoria local del proyecto. Conversa, cambia de idea y sigue construyendo; VibeKeep conserva decisiones y registra lo que modifica.

Esta es la primera versión funcional, **0.1.0**. Puede adoptar un repo existente, conversar con un modelo, leer y editar archivos, ejecutar scripts npm con autorización y recuperar memoria en otra sesión. No necesitas escribir una especificación para comenzar.

## Empezar

Requisitos: **Node.js 24.13 o superior**, npm y, para funciones de repositorio, Git. La combinación se ha probado localmente con Node 24.19 en Windows. Usa una versión LTS compatible.

```bash
git clone https://github.com/Mapacheee/vibekeep.git
cd vibekeep
npm ci
npm run build
```

Inspeccionar otro proyecto, sin modelo ni llamadas de red:

```bash
node dist/src/cli.js adopt /ruta/a/tu/proyecto
node dist/src/cli.js remember "Conservar la navegación actual" --cwd /ruta/a/tu/proyecto --area ui.navigation
node dist/src/cli.js memory navegación --cwd /ruta/a/tu/proyecto
```

En Windows puedes usar una ruta entre comillas, por ejemplo `"C:\proyectos\mi-app"`.

Para disponer del comando desde cualquier carpeta, opcionalmente ejecuta `npm link` dentro del repo. Después entra a tu proyecto y ejecuta:

```bash
vibekeep
```

Sin instalación global, abre el mismo chat con:

```bash
node dist/src/cli.js --cwd /ruta/a/tu/proyecto
```

## Configurar el modelo

El chat usa el proveedor que configures. Necesita un modelo con **tool calling** para editar archivos y usar herramientas. La memoria, la adopción y los comandos locales funcionan sin configurar uno.

### Endpoint compatible, incluido un servidor local

PowerShell:

```powershell
$env:VIBEKEEP_PROVIDER = "compatible"
$env:VIBEKEEP_BASE_URL = "http://localhost:1234/v1"
$env:VIBEKEEP_MODEL = "id-del-modelo-con-herramientas"
# Solo si tu proveedor requiere autenticación:
$env:VIBEKEEP_API_KEY = "tu-clave"
node dist/src/cli.js --cwd "C:\proyectos\mi-app"
```

macOS/Linux:

```bash
export VIBEKEEP_PROVIDER=compatible
export VIBEKEEP_BASE_URL=http://localhost:1234/v1
export VIBEKEEP_MODEL=id-del-modelo-con-herramientas
# export VIBEKEEP_API_KEY=tu-clave
node dist/src/cli.js --cwd /ruta/a/tu/proyecto
```

El endpoint es un ejemplo de configuración: VibeKeep no instala ni inicia ese servidor de modelos. Para un proveedor remoto, usa su URL y credenciales.

### Anthropic

Configura `VIBEKEEP_PROVIDER=anthropic`, `VIBEKEEP_MODEL` con el ID del modelo y `VIBEKEEP_API_KEY` con tu clave. `VIBEKEEP_BASE_URL` no se usa en ese modo.

También puedes cargar un archivo privado de variables mediante Node:

```bash
node --env-file=/ruta/privada/vibekeep.env dist/src/cli.js --cwd /ruta/al/proyecto
```

VibeKeep no carga automáticamente el `.env` de la aplicación y no guarda claves de proveedor en su memoria. El contexto seleccionado del proyecto se envía al proveedor que configures.

## Así se usa

```text
You › Revisa esta aplicación y agrega un botón para favoritos.
→ list_files
→ read_file
→ edit_file
VibeKeep › Agregué el botón. Puedo ejecutar el script de comprobación…

You › Me gusta el diseño claro; conservémoslo para móvil.
→ propose_decision

You › /memory
[proposed] Conservar el diseño claro para móvil
  <id completo> · ui.mobile

You › /accept <id completo>
You › /changes
You › /undo
You › /exit
```

El diálogo es ilustrativo; las herramientas elegidas dependen del modelo. Al regresar, se reconstruye contexto con decisiones y mensajes recientes de la misma rama, y se vuelve a inspeccionar el código.

El agente puede proponer memoria automáticamente, con una cita del mensaje actual. En esta versión, **aceptar** es una acción explícita mediante `/accept` o `/remember`; el modelo no puede atribuirse una confirmación tuya. Las propuestas permanecen disponibles como contexto provisional, sin obligarte a resolverlas para seguir construyendo.

## Comandos

| Comando | Función |
|---|---|
| `vibekeep` o `vibekeep chat [ruta]` | Inicializar si hace falta y abrir el chat. |
| `vibekeep init [ruta]` / `vibekeep adopt [ruta]` | Inspeccionar y guardar un inventario; no instalar ni ejecutar el proyecto. |
| `vibekeep status` | Detectar stack y cambios desde la inspección anterior. |
| `vibekeep remember "texto" --area ui.theme` | Registrar una decisión explícita aceptada. |
| `vibekeep memory [consulta]` | Consultar decisiones vigentes de la rama. |
| `vibekeep accept <id> --supersedes <id-anterior>` | Aceptar una propuesta y, opcionalmente, reemplazar otra decisión. |
| `vibekeep ask "petición"` | Ejecutar un turno sin abrir el chat interactivo. |
| `vibekeep changes` | Ver escrituras propias registradas y si el contenido coincide. |
| `vibekeep undo` | Revertir la última escritura propia si el archivo sigue coincidiendo. |
| `vibekeep run test` | Ejecutar explícitamente el script npm `test`. |
| `vibekeep checks` | Ver resultados de scripts y si siguen correspondiendo al código actual. |
| `vibekeep export` | Emitir JSON con memoria de decisiones; no incluye la conversación. |
| `vibekeep import memoria.json` | Importar memoria del mismo proyecto sin duplicar IDs. |

Todos admiten `--cwd <ruta>`. `--json` genera salida estructurada en comandos no interactivos. `--help` muestra las opciones completas.

Dentro del chat: `/status`, `/memory [consulta]`, `/remember <texto>`, `/accept <id>`, `/changes`, `/checks`, `/undo`, `/run <script>`, `/help` y `/exit`. El chat usa los mismos datos que la CLI.

## Ejecución y archivos

- La adopción lee archivos del proyecto y escribe únicamente metadatos en `.vibe/`.
- Se excluyen `.git`, `.vibe`, dependencias, salidas generadas, archivos `.env`, claves con extensiones conocidas, bases de datos y logs. No es un detector universal de secretos: revisa qué contiene el proyecto antes de usar un proveedor remoto.
- En repos Git se respetan sus exclusiones, incluso al leer una ruta directamente. En carpetas sin Git se aplican `.gitignore` raíz y anidados de forma conservadora: una exclusión de un ancestro no se revoca mediante reglas anidadas.
- Se omiten symlinks. El inventario tiene límites de 5.000 archivos de texto, 256 KiB por archivo y 32 MiB en total, e informa si es parcial.
- Las lecturas para el modelo están paginadas. Las ediciones requieren el hash del archivo y guardan el contenido anterior; la sustitución parcial exige una coincidencia única.
- `/undo` revierte una escritura cada vez y se detiene si hay ediciones posteriores. No revierte efectos de scripts, bases de datos ni servicios externos. Las comprobaciones previas reducen conflictos, pero no bloquean otros editores a nivel de sistema de archivos.
- Los scripts se ejecutan con permisos del usuario local. VibeKeep no es un sandbox. El agente pide autorización para ejecutar scripts; `--allow-scripts` los autoriza para esa sesión. `vibekeep run` y `/run` son peticiones explícitas de ejecución.
- Los scripts tienen un límite de tiempo y salida. **El proceso se detiene al agotar el tiempo**: esta versión no administra servidores de desarrollo persistentes. Abre el servidor en otra terminal para ver los cambios mientras conversas.
- Se detectan otros gestores de paquetes, pero la ejecución automática inicial admite npm. No reemplaza lockfiles ni instala dependencias automáticamente.

## Memoria y privacidad

```text
tu-proyecto/
  .vibe/
    project.json          # Identidad del proyecto
    .gitignore            # Excluye local/ de Git
    local/
      memory.sqlite       # Conversación, decisiones, inventario y diario de acciones
      session.lock        # Impide dos escritores CLI simultáneos
```

La base usa SQLite con WAL y FTS5. Las decisiones están separadas por rama, con procedencia y autoridad explícitas. Las reemplazadas conservan su historial y no aparecen como vigentes. Un resultado de script se vincula a la huella del inventario; `checks` lo marca no vigente cuando cambia esa huella.

Los datos locales **no están cifrados**. La exclusión de `local/` evita su incorporación habitual a Git; conserva la configuración de exclusiones. No copies una base SQLite activa como si fuera un archivo aislado. Para compartir decisiones, usa `export`, revisa su contenido y guarda el resultado fuera de `local/`. El import exige la misma identidad de proyecto; no resuelve divergencias semánticas de decisiones compartidas.

Tras una interrupción, las acciones inciertas permanecen visibles y no se ejecutan de nuevo automáticamente. Esta versión aún no reconcilia todos sus efectos de forma automática. Los worktrees independientes tienen su propio almacén local; la coordinación entre ellos es futura.

## Desarrollo y comprobaciones

```bash
npm ci
npm run check
npm test
npm start -- --help
```

Las pruebas usan repos y archivos temporales, memoria real SQLite y un transporte simulado del proveedor para probar el ciclo de herramientas sin claves, consumo de API ni conexiones externas. Incluyen persistencia, aislamiento de ramas, importación, reemplazo de decisiones, fallos de scripts, evidencia obsoleta y preservación de cambios al deshacer. La prueba de symlinks se omite si el entorno no permite crearlos.

El chat con un proveedor real requiere una prueba manual con tus credenciales; las pruebas simuladas no evalúan la calidad del modelo.

Consulta [la arquitectura](docs/architecture.md) y [el roadmap](docs/roadmap.md) para ver qué está implementado y qué viene después. No se ha publicado un paquete npm.
