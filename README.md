# kelley-ai-systems-internal

## Direct Notion CRM sync

Phoenix reads the Kelley AI Systems prospect CRM through the protected
`rapid-function` Supabase Edge Function. The browser never receives or stores
the Notion integration secret.

Required Edge Function secrets:

- `NOTION_TOKEN` — an internal Notion integration secret with read access only
  to the original prospect CRM database
- `NOTION_DATA_SOURCE_ID` — the CRM data source ID, without `collection://`
- `PHOENIX_ALLOWED_EMAIL` — the single Phoenix owner email allowed to sync
- `PHOENIX_ALLOWED_ORIGIN` — `https://roberta-kelley.github.io`

Deploy from an authenticated Supabase CLI:

```sh
supabase secrets set \
  NOTION_TOKEN='set-this-directly-in-the-terminal' \
  NOTION_DATA_SOURCE_ID='set-the-crm-data-source-id' \
  PHOENIX_ALLOWED_EMAIL='set-the-owner-email' \
  PHOENIX_ALLOWED_ORIGIN='https://roberta-kelley.github.io'

supabase functions deploy rapid-function
```

The function performs its own owner-session validation because
`verify_jwt = false` avoids incompatibility between Supabase's legacy gateway
verification and newer asymmetric Auth JWTs. Never remove the in-function
authentication check.

The direct-sync interface is enabled in TEST MODE first. Keep production pages
unchanged until the protected preview, duplicate detection, and human approval
flow pass the focused retest.
