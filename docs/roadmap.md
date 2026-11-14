# Roadmap

## 0.1 — Primer ciclo funcional

- [x] CLI con inicialización automática y chat en la terminal.
- [x] Adopción de proyectos vacíos y existentes sin ejecutar scripts.
- [x] Inventario de paquetes, comandos, instrucciones y cambios por hashes.
- [x] SQLite, FTS5, decisiones por rama y procedencia explícita.
- [x] Chat con Anthropic o un proveedor compatible configurable.
- [x] Lectura paginada, sustitución parcial y escritura con precondiciones.
- [x] Snapshots por escritura y undo que detecta cambios posteriores.
- [x] Scripts npm autorizados, timeouts, salida acotada y resultados.
- [x] Resultados marcados no vigentes cuando cambia el código indexado.
- [x] Persistencia entre procesos y export/import con rechazo de conflictos.
- [x] Pruebas deterministas sin depender de una API de pago.

## Próximo incremento — Ver el proyecto funcionando

- Administración de servidores de desarrollo: iniciar, verificar disponibilidad, mostrar logs y detener.
- Autorización por perfil de proyecto, sin repetir preguntas para el mismo alcance concedido.
- Diffs de contenido en la conversación y agrupación de escrituras en experimentos.
- Aceptación conversacional de decisiones con evidencia y evaluación de ambigüedades.
- Recuperación guiada de acciones inciertas y cancelación coordinada de procesos.

## Después — Comprender y ampliar

- Tree-sitter y adaptadores por lenguaje; LSP para consultas semánticas específicas.
- Worktrees para variantes completas y memoria con herencia y conflictos de ramas explícitos.
- Perfiles de React/Vite, APIs, CLI y Python con comandos comprobados.
- Investigación de documentación oficial ligada a la versión del repo.
- Mejor recuperación multilingüe; evaluar embeddings frente al baseline textual.
- Servidor MCP para agentes externos, con límites de integración declarados por cliente.
- Panel opcional con conversación, preview y timeline.

## Criterio de prioridad

Cada incremento debe mejorar este recorrido: abrir un repo real, cambiar algo mediante conversación, comprobarlo, cerrar y retomar con memoria correcta. La interacción no debe exigir convertir cada idea en documentos o completar fases de planificación.
