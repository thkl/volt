# Volt

Volt is a read-only UPS dashboard for homelabs using Network UPS Tools (NUT). It has an Angular 22 frontend and a Node.js, TypeScript and Express backend. Demo mode starts without hardware; NUT hosts can be managed in Settings.

## Run Volt locally

Requirements: Node.js 24.15 or newer and pnpm 12.18.0. Start the backend and frontend in separate terminals:

```sh
pnpm install
pnpm server:dev
```

```sh
pnpm start
```

Open [http://localhost:4200](http://localhost:4200). The frontend connects to the backend at `http://localhost:8080` through the Angular development proxy. Demo mode is enabled by default and stores data in `.data/volt.sqlite`.

Open Settings to add, edit or remove NUT hosts. Each host has a display name, address, port and TLS option. Authentication works with or without TLS. Without TLS, NUT sends the username and password unencrypted over the network; Volt still encrypts saved credentials in SQLite, and never returns them from the API. By default, Volt creates `.data/credentials.key` with owner-only file permissions; back it up separately from the database. You can instead set `CREDENTIALS_ENCRYPTION_KEY` to a 32-byte hex or base64 key managed by your deployment. The environment variables `NUT_HOST`, `NUT_PORT`, `NUT_TLS`, `NUT_USERNAME` and `NUT_PASSWORD` remain available to provision one host at server startup.

The API exposes host management, collector types, device snapshots, bounded history, paginated events and `WebSocket /api/ws`. `GET /api/health` reports per-source diagnostics; `GET /api/hosts/:id/health` returns one host's connection phase, discovered UPS names, last poll and error code. The UI distinguishes devices by host and updates as collectors discover or lose UPS devices. NUT and demo collectors are implemented; MQTT, Home Assistant and UniFi UPS HTTP are listed as future source types. Adding the first NUT host replaces the demo source. The demo state selector controls the backend simulator while it is connected, and continues using local fixtures if the server is unavailable.

## Optional sign-in

Authentication is disabled when the auth environment variables are empty. For password sign-in, set `AUTH_EMAIL` and `AUTH_PASSWORD`. For OIDC, set `AUTH_EMAIL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI`; register that exact redirect URI with the identity provider. The OIDC account must return a verified email matching `AUTH_EMAIL` (case-insensitive). OIDC ID tokens signed with RS256 are supported. Set `OIDC_CLIENT_AUTH_METHOD=client_secret_post` if the identity provider requires credentials in the token request body; it defaults to `client_secret_basic`.

The OIDC redirect URI must end in `/api/auth/oidc/callback`. For local development through Angular's proxy, it can be `http://localhost:4200/api/auth/oidc/callback`; for a built app, use its public origin. OIDC issuer and redirect URLs must use HTTPS outside localhost. The backend validates state, nonce, PKCE and the ID token signature and claims. Local sign-in sessions use an HttpOnly, SameSite=Lax cookie and expire after eight hours; they are held in memory and are cleared when the backend restarts. Sign-in attempts are rate-limited by client IP.

When serving Volt over HTTPS, set `AUTH_COOKIE_SECURE=true`; it defaults to true in production and when the OIDC redirect URI uses HTTPS. Password sign-in over plain HTTP exposes the password and session cookie to anyone who can observe that network connection, so use HTTPS outside local development.

## Screens

- **Overview** — reported power-flow illustration, battery charge and runtime, history preview, electrical readings and read-only sample variables.
- **History** — power draw or load percentage and input voltage across 1-hour, 24-hour, 7-day and 30-day ranges.
- **Events** — fixture examples of power-source, battery and connectivity transitions.

The demo badge appears when the simulator is the active source. The grid, UPS and server rack use the images provided in `docs/`; SVG is used for the connecting lines and flow particles. Grid-to-UPS particles stop when the UPS is on battery. Motion is hidden when reduced motion is enabled.

## Development and verification

```sh
pnpm run build
pnpm test
pnpm server:build
pnpm server:test
pnpm format
pnpm format:check
```

The default server test run skips local TCP and HTTP/WebSocket integration cases. Run `pnpm --filter @volt/server test:network` in an environment that allows loopback listeners to exercise those cases against a simulated NUT server.

The workspace uses Angular 22's zoneless change detection. Components keep TypeScript, HTML and CSS in separate files. Prettier formats application and server sources.

The backend uses Node's built-in `node:sqlite` API with WAL and schema migrations. This API is still marked release candidate in the Node 24 line, so the backend targets Node 24 or newer.

Docker packaging, production hardening and setup screens remain later MVP work. See [docs/VOLT-MVP.md](docs/VOLT-MVP.md) for the requirements and deployment design.

Volt does not send UPS commands. Host settings can be changed in the UI; polling intervals, retention and server settings remain environment-configured.
