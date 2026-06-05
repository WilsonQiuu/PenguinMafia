FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fontconfig \
        fonts-dejavu-core \
        fonts-liberation \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV FONTCONFIG_FILE=/etc/fonts/fonts.conf
ENV FONTCONFIG_PATH=/etc/fonts

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]

