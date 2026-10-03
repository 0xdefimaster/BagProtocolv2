# Robinhood `/rhj` API fixtures

Trimmed copies of live captures of `api.robinhood.com/rhj/assets`,
`/rhj/prices/AAPL` and `/rhj/corporate-actions` (captured 2026-09-03/04).
Source: [arcus-agent-gateway](https://github.com/alekskram/arcus-agent-gateway)
`tests/fixtures/`, MIT License, Copyright (c) 2026 arcus-agent-gateway
contributors. Only the asset list and the corporate-action list were trimmed; no
values were edited.

These pin the response SHAPES BAG parses (e.g. the `{"quotes":[…]}` wrapper,
18-dp multiplier strings, `pendingMultiplier: ""`, protobuf-style
`processDate`). They are not a statement about current prices.
