FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
COPY buyback/requirements.txt /tmp/buyback-requirements.txt
RUN python3 -m venv /opt/buyback-venv \
    && /opt/buyback-venv/bin/pip install --no-cache-dir -r /tmp/buyback-requirements.txt

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV BUYBACK_PYTHON=/opt/buyback-venv/bin/python
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 monitor
COPY --from=build /opt/buyback-venv /opt/buyback-venv
COPY --from=build --chown=monitor:monitor /app/node_modules ./node_modules
COPY --from=build --chown=monitor:monitor /app/dist ./dist
COPY --chown=monitor:monitor package.json ./
COPY --chown=monitor:monitor public ./public
COPY --chown=monitor:monitor config ./config
COPY --chown=monitor:monitor buyback ./buyback
RUN mkdir -p /app/data && chown monitor:monitor /app/data
USER monitor
EXPOSE 8787
CMD ["node", "dist/index.js"]
