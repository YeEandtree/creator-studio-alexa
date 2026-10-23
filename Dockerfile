# ---- build stage: install (dev deps incl. tsc) and compile ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- runtime stage: production deps only ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml .npmrc ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 8787
CMD ["node", "dist/src/index.js"]
