ARG NODE_VERSION=24.18.0
FROM node:${NODE_VERSION}-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @xxyy/web build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pnpm", "run", "api:dev"]
