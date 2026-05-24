FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=4001
EXPOSE 4001

CMD ["node", "--experimental-strip-types", "src/server.ts"]
