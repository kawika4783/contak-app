# Contak.App — Midnight Glass

This is the runnable Phase 1 frontend foundation for the Contak.App communication platform. It implements the product shell from the approved Midnight Glass direction and keeps the primary workflows interactive locally:

- responsive desktop / mobile app shell
- chats, calls, contacts, camera, and settings navigation states
- chat selection and local message sending
- presence and typing states
- incoming / outgoing call state UI with accept, decline, cancel, connect, and animated pulse rings
- original Web Audio “Contak Pulse” ringtone preview generated locally in the browser
- privacy and notification settings surfaces

## Run

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## Hostinger Docker deployment

The repository includes a production `Dockerfile`, `nginx.conf`, and `compose.yaml` for Hostinger's managed Traefik Docker Manager. The default router is `contak-app.srv1831469.hstgr.cloud`; change the host rule in `compose.yaml` before deployment if you want a different DNS name. Phase 2 adds PostgreSQL, Redis, and the NestJS API behind the same origin.

Before running Compose, create a local `.env` from `.env.example` with unique secrets. Never commit `.env`.

The static frontend is served by Nginx with SPA fallback and `/healthz`. The container does not claim the backend features described below; it is the safe Phase 1 web deployment.

## Architecture notes

The supplied master prompt describes a full monorepo with NestJS, PostgreSQL, Redis, Socket.IO, LiveKit, Coturn, WebRTC, Web Push, authentication, media uploads, and administration. This delivery is the frontend foundation and interaction prototype for that architecture. The current local app intentionally does not claim to provide secure multi-user persistence, authenticated APIs, or real media calls yet.

Recommended next services:

1. `apps/api` — NestJS REST + Socket.IO signaling, DTO validation, rate limits, refresh-token rotation, call state machine.
2. `packages/db` — PostgreSQL migrations and normalized tables from the prompt; Redis for ephemeral presence / typing.
3. `apps/media` — LiveKit and Coturn configuration with authenticated room tokens.
4. `apps/web` — move this frontend into the web workspace and wire TanStack Query / Zustand to the API.
5. `infra/` — Docker Compose, Traefik labels, health checks, backups, and `.env.example`.

No end-to-end encryption claim is made by this frontend.
