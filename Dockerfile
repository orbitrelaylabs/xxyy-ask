ARG NODE_VERSION=24.18.0
FROM node:${NODE_VERSION}-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
ARG PNPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app

COPY . .

RUN --mount=type=cache,id=xxyy-pnpm-store,target=/pnpm/store \
    pnpm config set registry "$PNPM_REGISTRY" --location=global && \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store && \
    pnpm config delete registry --location=global
RUN pnpm --filter @xxyy/web build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pnpm", "run", "api:dev"]
