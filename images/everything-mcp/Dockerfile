# Official MCP reference server ("everything"), pinned, served over Streamable HTTP.
# Third-party code we did not write: used as the "untrusted upstream" in the demo.
FROM node:24-alpine
ARG EVERYTHING_VERSION=2026.8.31
ENV NODE_ENV=production PORT=3001
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund @modelcontextprotocol/server-everything@${EVERYTHING_VERSION}
USER node
EXPOSE 3001
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
