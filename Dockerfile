FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HUB_DATA_DIR=/data
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true
COPY src ./src
COPY public ./public
COPY scraper ./scraper
VOLUME ["/data"]
EXPOSE 3900
USER node
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
