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

The static frontend is served by Nginx with SPA fallback and `/healthz`. The API is self-hosted in the same Compose stack with PostgreSQL, Redis, Socket.IO signaling, private uploads, Web Push, profile privacy, and the administration panel.

## Architecture notes

The current application includes the existing authenticated messaging and calling flows plus the Phase 3 contact redesign, compact mobile navigation, persistent favorites with reordering, private contact groups, presence preferences, and backend-enforced View Once photo messaging. View Once migration and rollback details are in `docs/view-once-migration.md`; security limitations are in `docs/view-once-security.md`.

Recommended next services:

1. `apps/api` — NestJS REST + Socket.IO signaling, DTO validation, rate limits, refresh-token rotation, call state machine.
2. `packages/db` — PostgreSQL migrations and normalized tables from the prompt; Redis for ephemeral presence / typing.
3. `apps/media` — LiveKit and Coturn configuration with authenticated room tokens.
4. `apps/web` — move this frontend into the web workspace and wire TanStack Query / Zustand to the API.
5. `infra/` — Docker Compose, Traefik labels, health checks, backups, and `.env.example`.

No end-to-end encryption claim is made by this frontend.
