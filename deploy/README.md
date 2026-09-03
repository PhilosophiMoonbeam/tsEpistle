# Deploying tsEpistle

Deployment identity is intentionally independent from public hostnames. A temporary validation hostname such as `canary.example.com` should not become the name of the application, database volume, or repository layout.

- [`compose/`](./compose/) contains the reusable Docker Compose deployment.
- [`migrations/from-wikijs-v2/`](./migrations/from-wikijs-v2/) contains the additional safety procedure for cloning an existing Wiki.js v2 installation.

Keep host-specific values in an ignored `.env` file or an operator-owned file outside the repository. Keep passwords, Agent keyrings, database data, copied Wiki data, and backups outside the repository.
