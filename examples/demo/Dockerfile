# The demo as a container, for hosting it publicly. Build from the repository root:
#   docker build -f examples/demo/Dockerfile -t bayarkit-demo .
#   docker run --rm -p 4317:4317 --read-only --cap-drop ALL --security-opt no-new-privileges bayarkit-demo
# Every gateway is a fake started inside the container (127.0.0.1); it needs no keys and makes no outbound calls.
FROM node:22.23.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.23.4-alpine
# npm, npx and corepack are never run here (CMD is node): removed so their bundled dependencies are not shipped.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317
WORKDIR /app
COPY --from=build /app/package.json ./
# @bayarkit/testing's index re-exports the conformance suite, which imports vitest (its peer dependency): keep it.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY gateways/registry.json ./gateways/registry.json
COPY scripts/smoke ./scripts/smoke
COPY examples/demo ./examples/demo
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4317/healthz || exit 1
CMD ["node", "examples/demo/server.mjs"]
