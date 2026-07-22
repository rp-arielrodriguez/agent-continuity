FROM golang:1.24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nodejs npm procps \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
  && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

WORKDIR /workspace/agent-continuity
COPY . .
RUN npm ci && npm run build
RUN install -m 0755 docker/.cluster-bin/continuityd /usr/local/bin/continuityd

ENV PATH="/root/.local/bin:${PATH}"
CMD ["sleep", "infinity"]
