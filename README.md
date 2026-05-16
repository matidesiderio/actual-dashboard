# Actual Dashboard

Dashboard de gestión de campañas para Actual Comunicaciones.

## Stack
- Frontend: HTML+JS plano (single file `actual_dashboard.html`)
- Proxy: Cloudflare Worker (`worker/worker.js`)
- APIs: Meta Marketing API, Google Ads API, Anthropic Claude

## Deploy
- HTML servido vía GitHub Pages
- Tokens almacenados como secrets en Cloudflare Workers
- Sin credenciales en el repo
