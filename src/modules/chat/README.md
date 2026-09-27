# Hoomri Chat - backend module

Standalone customer ↔ seller messaging (spec: `design_handoff_hoomri_chat/`).
REST under `/api/chat/*`, realtime via Socket.IO (namespace `/chat`, path
`/api/chat-ws`).

## Auth

No login of its own - it accepts the platform's existing session tokens:

| Side | Token | Claim check |
|---|---|---|
| customer | buyer JWT (`typ: 'buyer'`, `JWT_SECRET`) | buyer id from `sub` |
| seller | admin-console JWT (`typ: 'admin'`, `ADMIN_JWT_SECRET`) | `twoFactorVerified` + `shopId` scope |

All token knowledge lives in **`chat-token.service.ts`** (REST guard and WS
gateway both call it). The rest of the module only sees `ChatActor`
(`chat-actor.ts`).

## Porting to another host

1. Re-implement `ChatTokenService.verify()` for the new host's tokens.
2. Point the two participant FKs in `src/database/schema/chat.schema.ts`
   (`buyers`, `shops`) at the new host's user/counterpart tables, and adjust
   the snapshot/context lookups in `conversations.service.ts` /
   `messages.service.ts` (products, orders, customers).
3. Register `ChatModule` and run the `chat_*` migration (`0019_chat.sql`,
   idempotent).

Everything else (gateway, unread accounting, receipts, quick replies) is
host-independent.

## Notable deviations from the api-spec

- No `POST /attachments`: images/files arrive as data URLs inside the send
  payload (image ≤ 6 MB, file ≤ 8 MB), so a retry replays one request under
  one idempotency key. The server stores the bytes in private object storage
  (`chat/{conversationId}/{sha256}.{ext}`) and keeps only their metadata on
  the message; participants read them from
  `GET /chat/conversations/:id/messages/:messageId/attachment`. The public
  `/media` proxy refuses `chat/` keys. With no S3 configured they stay inline
  as `dataUrl`, and clients render either shape.
- Quick replies are flat (`/chat/quick-replies`); the shop scope comes from
  the admin token instead of a path param.
- `GET /chat/conversations/:id/products` serves the product-picker catalogue
  so the module doesn't depend on the host's product controllers.
- Presence/last-seen is in-memory; a restart degrades "Online" to
  "Last seen recently".
