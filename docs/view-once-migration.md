# View Once migration and rollback

The API applies `apps/api/schema.sql` idempotently on startup. The Phase 3 statements add `contacts.favorite_order`, `contacts.nickname`, presence preferences, private owner-side `contact_groups` / `contact_group_members`, `schema_migrations`, `ephemeral_media`, and the singleton `admin_ephemeral_settings` row. They do not reset, truncate, or recreate existing production tables. Groups organize existing contacts only; they do not change the existing one-to-one conversation model.

## Production backup before deploy

From `/opt/contak-app` on the VPS, create a timestamped database backup and verify it exists before rebuilding:

```sh
mkdir -p backups
docker compose --env-file .env -p contak-app exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "backups/contak-$(date -u +%Y%m%dT%H%M%SZ).dump"
ls -lh backups
```

The `contak_uploads` Docker volume is also part of the rollback set. Do not delete it during deployment.

## Apply

```sh
docker compose --env-file .env -p contak-app build api web
docker compose --env-file .env -p contak-app up -d api web
docker compose --env-file .env -p contak-app ps
curl -fsS https://contak-app.srv1831469.hstgr.cloud/api/health
```

The API startup applies the idempotent schema additions before serving traffic. Existing regular attachments continue using `messages.attachment_path`; View Once attachments are kept in the same private volume but are never exposed by the regular attachment route.

## Rollback

First redeploy the previous application image/commit. The additive columns and tables are backward-compatible with the previous API. If a database rollback is required, stop the API, restore the custom-format dump into a fresh temporary database for verification, then restore the production database during a maintenance window:

```sh
docker compose --env-file .env -p contak-app stop api
cat backups/contak-YYYYMMDDTHHMMSSZ.dump | docker compose --env-file .env -p contak-app exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner
docker compose --env-file .env -p contak-app up -d api
```

Do not run the restore command until the exact backup file and maintenance window have been verified. A restore can remove data written after the backup.

