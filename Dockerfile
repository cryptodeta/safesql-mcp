# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/server/package.json ./package.json
COPY --from=build /app/examples/shop.db ./examples/shop.db
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# Streamable HTTP by default. Pass databases with DATABASE_URL / SAFESQL_DB_<NAME>, or as arguments.
# Set SAFESQL_HTTP_TOKEN when the port is reachable by anyone else.
# stdio instead: docker run -i --rm IMAGE node dist/cli.js <database>
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--http"]
