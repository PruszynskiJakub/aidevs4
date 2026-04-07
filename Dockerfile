FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Final image
FROM base
COPY --from=install /app/node_modules node_modules
COPY . .

# Install Playwright browsers (Chromium only)
RUN bunx playwright install --with-deps chromium

ENV NODE_ENV=production

EXPOSE 3000
CMD ["sh", "-c", "bun run server & bun run slack & wait"]
