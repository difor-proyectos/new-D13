# DIFOR Chiloé - Copiloto Comercial

App comercial automotriz premium para uso interno de ejecutivos DIFOR.

## Probar localmente

- Abrir `index.html` en la vista previa de Open Design o servir la carpeta como sitio estático.
- La app funciona con datos locales si `/api/*` no está disponible.
- En Cloudflare Pages, publicar la raíz del proyecto sin build command.

## Cloudflare Pages

- Build command: vacío
- Output directory: `/` o vacío
- D1 binding: `DB`
- R2 binding recomendado: `BUCKET`

Verificar `/api/health`: debe devolver JSON con `r2Binding`.

## Asistente IA

El frontend no contiene API keys. La ruta segura preparada es `/api/assistant`.

Para activar IA real:

- Crear variable de entorno `OPENAI_API_KEY` en Cloudflare.
- Implementar la llamada server-side dentro de `handleAssistant`.
- Responder solo con datos cargados en Administración.
