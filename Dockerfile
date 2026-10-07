# Cloud Run image: Node + puppeteer's own Chrome + the system libraries that Chrome build lists in deb.deps
FROM node:22-bookworm-slim
WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/app/.cache PUBLIC=1 MAX_RS=1.5
COPY package.json package-lock.json ./
# unzip first: puppeteer's postinstall needs it to unpack Chrome on Linux, and only warns if it can't
# (a missing deb.deps below then fails the build loudly instead of shipping an image without Chrome)
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip fonts-liberation fonts-noto-color-emoji \
 && npm ci --omit=dev \
 && apt-get satisfy -y --no-install-recommends "$(paste -sd, .cache/chrome/*/chrome-linux64/deb.deps)" \
 && rm -rf /var/lib/apt/lists/*
COPY server.js index.html ./
# non-root: Chrome keeps its sandbox
USER node
CMD ["node", "server.js"]
