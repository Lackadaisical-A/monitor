FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --create-home --uid 10001 monitor
COPY --from=build --chown=monitor:monitor /app/node_modules ./node_modules
COPY --from=build --chown=monitor:monitor /app/dist ./dist
COPY --chown=monitor:monitor package.json ./
COPY --chown=monitor:monitor public ./public
COPY --chown=monitor:monitor config ./config
RUN mkdir -p /app/data && chown monitor:monitor /app/data
USER monitor
EXPOSE 8787
CMD ["node", "dist/index.js"]
