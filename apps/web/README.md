# Doc-Agent Web

React + Vite + Ant Design frontend for the Doc-Agent monorepo.

## Run

From the repository root:

```bash
pnpm dev:web
```

The app runs at http://localhost:5173 and calls the backend at http://localhost:3000 by default.
Override `VITE_API_BASE_URL` in `apps/web/.env` if the backend runs elsewhere.

## Build

```bash
pnpm --filter @doc-agent/web build
```
