# One Dockerfile for both Node services.
#
# `apps/api` and `apps/worker` are the same shape — a NestJS process compiled to
# `dist/main.js`, depending on the same workspace packages and the same
# generated Prisma client. Two files would be two files to keep in step, and the
# thing they would drift on is exactly the part that matters: which build stage
# the runtime copies from.
#
# Pick one with `--build-arg APP=api` or `--build-arg APP=worker`.
#
# The build is staged so the runtime image carries no compiler, no test files
# and no dev dependencies. That is a supply-chain decision more than a size one:
# every package present at runtime is a package that can execute if something
# goes wrong, and a production image has no reason to ship `vitest`.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# deps — the full workspace install, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /repo

RUN corepack enable

# Manifests only, before any source. Docker caches this layer on their contents,
# so editing a TypeScript file does not re-run a two-minute install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/mail/package.json packages/mail/
COPY packages/whatsapp/package.json packages/whatsapp/
COPY packages/ai/package.json packages/ai/

# `--frozen-lockfile` refuses to silently resolve something the lockfile does
# not name, which is the whole reason a lockfile is committed.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile the workspace
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY . .

# Turbo builds `packages/*` before the app that depends on them, and
# `@wea/db`'s build step is what generates the Prisma client the runtime needs.
RUN pnpm build

# The production install, resolved against the same lockfile. `pnpm deploy`
# flattens the workspace links into a real `node_modules`, because a symlink
# farm pointing outside the copied directory does not survive being moved into
# a fresh image.
ARG APP
RUN pnpm --filter "@wea/${APP}" deploy --prod --legacy /deploy

# `pnpm deploy` prunes dev dependencies, and Prisma's generated client lives in
# a package directory rather than in node_modules — so it has to be carried over
# explicitly or the app starts and fails on its first query.
RUN cp -r /repo/packages/db/generated /deploy/node_modules/@wea/db/generated

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ARG APP
ENV NODE_ENV=production
# Read by the healthcheck and by the app's own config; the compose file and the
# Kubernetes manifests both override it.
ENV PORT=3001

# OpenSSL is a runtime dependency of Prisma's query engine. The slim image does
# not carry it, and the failure without it is a linker error at first query
# rather than at boot — long after a deploy looks successful.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# An unprivileged user, and not the `node` user that comes with the image: a
# uid nobody shares is one less thing to reason about when a volume is mounted.
RUN groupadd --system --gid 1001 wea \
  && useradd --system --uid 1001 --gid wea --no-create-home wea

COPY --from=build --chown=wea:wea /deploy /app

USER wea

EXPOSE 3001

# `dumb-init` is deliberately absent. Node 22 handles SIGTERM correctly as PID 1
# provided nothing spawns children, and neither service does — adding an init
# shim would be cargo, and it would swallow the signal handling the worker uses
# to drain BullMQ before it exits.
STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]
