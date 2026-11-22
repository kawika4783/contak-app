# Contak.App architecture brief

## Product boundary

Contak.App is a mobile-first private communication platform with a React/Vite web client and self-hosted services. The Midnight Glass visual system is implemented as centralized CSS tokens and reusable component families in `src/styles.css` and `src/main.tsx`.

## Runtime boundaries

- Browser UI: React + TypeScript + Vite, PWA shell, responsive CSS, local Web Audio ringtone preview.
- API: NestJS REST for account, contacts, conversations, messages, attachments, calls, notifications, admin.
- Realtime: Socket.IO for presence, typing, receipt acknowledgements, and the authoritative call state machine.
- Durable data: PostgreSQL with migrations and indexes.
- Ephemeral coordination: Redis for presence leases, typing TTLs, reconnect coordination, and pub/sub.
- Media: LiveKit rooms for WebRTC media; Coturn for TURN fallback; browser camera effects remain device-side.

## Call state machine

`initiating -> ringing -> connecting -> connected -> ended` with terminal outcomes `declined`, `busy`, `unavailable`, `missed`, and `failed`. The server must issue a durable call id, idempotency key, timeout, device acknowledgements, and fan-out cancellation when one device answers.

## Security rules

- Hash passwords with Argon2id and rotate refresh tokens.
- Authorize every conversation and attachment access server-side.
- Validate uploads by MIME, magic bytes, size, and antivirus policy.
- Use HTTPS/WSS, signed LiveKit tokens, rate limits, revocable sessions, and admin audit logs.
- Do not describe the messaging layer as end-to-end encrypted until an audited protocol is integrated.
