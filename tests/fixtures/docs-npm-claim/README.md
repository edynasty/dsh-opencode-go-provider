# dsh-opencode-go-provider (negative fixture)

This fixture is a deliberately WRONG README used by the docs-contract negative
test: it claims npm availability and otherwise looks superficially plausible.
It must FAIL the docs contract (`forbidden README.md npm-install availability`).

## Installation

The package is available on npm:

```sh
npm install dsh-opencode-go-provider
```

Or install from Git:

```sh
dsh plugin --profile web add github:edynasty/dsh-opencode-go-provider#d2a447610a5dff4006ac966525effd9669342a78
```

## Features

- Route `opencode-go` with `OPENCODE_GO_API_KEY` resolved through DSH
  credentials at operation time.
- Protocols: `openai-responses`, `openai-completions`, `anthropic-messages`
  selected from catalog metadata, never guessed from model-name prefixes.
- Stale-while-revalidate cache: 5 minutes freshness, 60 minutes background
  refresh, 10 seconds network timeout, atomic cache, offline fallback,
  quarantine and a 14-day deprecated grace.

## Status

This is community software, not affiliated with DeepSeek or OpenCode.
