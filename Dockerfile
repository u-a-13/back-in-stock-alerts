FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# No npm dependencies: Node's built-in http, fetch and SQLite only.
COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
# Data lives in /data: mount a volume there (docker run -v, or a Railway volume).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
