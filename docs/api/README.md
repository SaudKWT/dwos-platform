# API contract

`openapi.json` is the API surface as Swashbuckle generates it, committed so a
release's contract is reviewable as a diff rather than by reading controllers.

Refresh it whenever the API changes, from a running dev instance:

```bash
curl -s http://127.0.0.1:5280/swagger/v1/swagger.json | python3 -m json.tool > docs/api/openapi.json
```

Swagger UI itself is development-only (`/swagger` on the dev server, 404 in
production) — deliberate, since the API currently ships without authentication.
