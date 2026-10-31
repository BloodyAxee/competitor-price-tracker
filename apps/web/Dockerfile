FROM node:24-slim AS build

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src

ARG VITE_API_BASE_URL=http://localhost:3000/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm run build

FROM node:24-slim AS runtime

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["pnpm", "preview", "--host", "0.0.0.0", "--port", "5173"]
