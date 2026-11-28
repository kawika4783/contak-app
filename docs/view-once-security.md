# View Once security notes

- Media is stored in the private `/app/uploads` volume and is never returned through the ordinary attachment URL.
- Only the authenticated recipient can atomically claim an unopened message. The claim changes the row to `viewing` inside a PostgreSQL transaction, so two devices cannot both receive a session.
- The session token is stored only as a SHA-256 digest. The content endpoint requires the authenticated conversation participant and the short-lived `X-View-Once-Session` header.
- Closing a session transitions it to `opened`, removes the stored file, clears the session hash, and leaves only the minimal status metadata needed to show “Opened”. Abandoned sessions are expired by the cleanup worker.
- View Once photos are normalized to WebP with Sharp before storage, which removes source EXIF metadata and GPS fields. Regular attachments retain their existing behavior.
- Push notifications use the generic text “Sent a View Once photo”; they do not include the file name or media URL.
- Service-worker caching explicitly bypasses `/api/`, and the viewer uses `cache: no-store` plus no-store response headers. Temporary object URLs are revoked when the viewer closes.
- The UI does not offer application-level forwarding, saving, downloading, or shared-media indexing for View Once media.
- Screenshots, screen recording, browser developer tools, and external cameras cannot be reliably prevented or detected by a browser application; Contak.App makes no such claim.

