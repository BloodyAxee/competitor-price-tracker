FROM node:24-slim AS build

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src

ENV DATABASE_URL=postgresql://build:build@db:5432/build?schema=public
RUN pnpm run build

FROM node:24-slim AS runtime

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["node", "dist/main.js"]
