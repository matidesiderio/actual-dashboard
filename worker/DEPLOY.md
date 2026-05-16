# Deploy del Worker — Paso a paso

## 1) Crear cuenta de Cloudflare (5 min)

1. Ir a https://dash.cloudflare.com/sign-up
2. Email + contraseña → confirmar email.
3. Saltarte el onboarding (link "Skip" abajo). No hace falta cargar dominio.

## 2) Crear el Worker (5 min)

1. Dashboard de Cloudflare → menú **Compute** → **Workers & Pages**.
2. Botón **Create** → elegir **Hello World** template.
3. Nombre: `actual-proxy` (queda como `https://actual-proxy.TU-SUBDOMINIO.workers.dev`).
4. Click **Deploy**.
5. Click **Edit code** (arriba a la derecha).
6. Borrar TODO el contenido del editor.
7. Pegar el contenido de `worker.js`.
8. Click **Deploy**.

## 3) Cargar los secrets (10 min)

En la página del Worker → tab **Settings** → sección **Variables and Secrets** → **+ Add variable**.

Para cada uno: **Type: Secret**, nombre exacto, pegar el valor desde tu archivo local de credenciales (`credentials.json` o donde lo tengas).

| Nombre | De dónde sacar el valor |
|---|---|
| `META_TOKEN` | `credentials.json` → `meta.access_token` |
| `GOOGLE_CLIENT_ID` | `credentials.json` → `google.client_id` |
| `GOOGLE_CLIENT_SECRET` | `credentials.json` → `google.client_secret` |
| `GOOGLE_REFRESH_TOKEN` | `credentials.json` → `google.refresh_token` |
| `GOOGLE_DEVELOPER_TOKEN` | `credentials.json` → `google.developer_token` |
| `ANTHROPIC_KEY` | https://console.anthropic.com/settings/keys (crear nueva) |
| `ALLOWED_ORIGIN` | Por ahora `*` (después cerrar al dominio de GH Pages) |

## 4) Verificar (2 min)

Abrir en browser (reemplazar `TU-SUBDOMINIO`):

- `https://actual-proxy.TU-SUBDOMINIO.workers.dev/health` → `{"ok":true,...}`
- `https://actual-proxy.TU-SUBDOMINIO.workers.dev/meta/me/adaccounts?fields=id,name&limit=3` → JSON con 3 cuentas Meta
- `https://actual-proxy.TU-SUBDOMINIO.workers.dev/unknown` → `{"error":"Unknown route",...}`

## Configurar el HTML

En `actual_dashboard.html` editar la línea:

```js
const API_BASE = 'https://actual-proxy.TU-SUBDOMINIO.workers.dev';
```

Reemplazar con la URL real del Worker.

## Si algo falla

- `META_TOKEN secret not configured` → falta agregar ese secret en paso 3.
- Error OAuth Google → revisar CLIENT_ID/SECRET/REFRESH_TOKEN (sin espacios al copiar).
- Error genérico → Worker → tab **Logs** → **Begin log stream** → repetir request → ver el error real.
