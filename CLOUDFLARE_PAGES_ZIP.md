# Despliegue Cloudflare Pages con Functions

Este proyecto necesita Cloudflare Pages Functions para que `/api/*` escriba en D1 y R2.

## Punto critico

Cloudflare no compila la carpeta `functions` cuando se sube un ZIP por drag and drop desde el dashboard. Ese metodo publica solo archivos estaticos. Si se usa ese flujo, `/api/health` volvera a responder `index.html` en vez de JSON.

Para conservar un flujo manual sin Git, usa Wrangler Direct Upload contra la carpeta exportada:

```powershell
powershell -ExecutionPolicy Bypass -File .\cloudflare\export-pages-functions.ps1
npx wrangler pages deploy .\dist\pages --project-name copiloto-8kr --branch production
powershell -ExecutionPolicy Bypass -File .\cloudflare\verify-production.ps1 -BaseUrl https://copiloto-8kr.pages.dev
```

El exportador tambien genera `dist/copiloto-pages-functions.zip` con `functions` en la raiz para auditoria y respaldo. No lo subas por drag and drop esperando que ejecute Functions; Cloudflare requiere Wrangler para desplegar una carpeta `functions`.

El ZIP se genera con rutas compatibles con Cloudflare:

```text
index.html
_routes.json
_redirects
functions/_lib/data.js
functions/api/health.js
functions/api/assets.js
functions/api/models.js
functions/api/config.js
functions/api/prospects.js
functions/api/agenda.js
```

Si despues de publicar `https://copiloto-8kr.pages.dev/api/health` responde `404`, HTML o cuerpo vacio, la version publicada no contiene Pages Functions activas aunque el ZIP local tenga la carpeta `functions`.

## Bindings existentes requeridos

Configuralos en el proyecto Cloudflare Pages, no dentro del ZIP:

- D1 database: `copiloto`
- D1 binding: `DB`
- R2 bucket: `copiloto`
- R2 binding: `ASSETS`

## Verificacion esperada

Despues del despliegue correcto, esta ruta debe devolver JSON:

```text
https://copiloto-8kr.pages.dev/api/health
```

Respuesta esperada minima:

```json
{
  "ok": true,
  "d1": true,
  "r2": true,
  "r2Binding": "ASSETS",
  "source": "cloudflare-pages-functions"
}
```

Si devuelve HTML, el despliegue fue estatico y Functions no se ejecutaron.
